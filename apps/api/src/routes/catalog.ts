import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  CreateProductSchema,
  getBahrainToday,
  simulateNextDay,
  ProductDetailWithHistorySchema,
  ProductListQuerySchema,
  ProductListResponseSchema,
  StoreProductListSchema,
  StoreProductSchema,
  ProductSchema,
  UpdateProductSchema,
} from "@stockflow/core";
import type { AuthContext } from "../plugins/auth.js";
import type { Env } from "../config/env.js";
import { listImportLogs, listSalesEntries, recordImportLog, recomputeForSku, upsertSalesEntry } from "../db.js";
import type { StockServices } from "../services/index.js";
import { handleDomainRouteError, sendApiError } from "./helpers.js";

const PathSkuSchema = z.object({
  sku: z.string().min(1),
});

export function registerCatalogRoutes(
  app: FastifyInstance,
  services: StockServices,
  authGuards: AuthContext,
  env: Env,
): void {
  // RBAC: Admin, manager, staff (catalog:view; non-admin queries exclude archived products).
  app.get(
    "/catalog/products",
    { preHandler: [authGuards.requirePermission("catalog:view")] },
    async (request, reply) => {
      const parsed = ProductListQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendApiError(reply, 400, parsed.error.issues[0]?.message || "Invalid query parameters");
      }
      try {
        const result = await services.catalog.listCatalogProducts(parsed.data, request.currentUser);
        return request.currentUser.role === "staff" ? StoreProductListSchema.parse(result) : ProductListResponseSchema.parse(result);
      } catch (err) {
        return handleDomainRouteError(err, reply);
      }
    },
  );

  // RBAC: Admin, manager, staff (catalog:view; single SKU catalog metadata and history).
  app.get(
    "/catalog/products/:sku",
    { preHandler: [authGuards.requirePermission("catalog:view")] },
    async (request, reply) => {
      const pathParsed = PathSkuSchema.safeParse(request.params);
      if (!pathParsed.success) {
        return sendApiError(reply, 400, "Invalid SKU in path");
      }
      const result = await services.catalog.getCatalogProduct(pathParsed.data.sku);
      if (!result) {
        return sendApiError(reply, 404, "Product not found");
      }
      if (request.currentUser.role === "staff") {
        if (result.product.status === "archived") return sendApiError(reply, 404, "Product not found");
        return { product: StoreProductSchema.parse(result.product) };
      }
      return ProductDetailWithHistorySchema.parse(result);
    },
  );

  // Admin-only mutation routes (products:manage)
  app.register(async (adminScope) => {
    adminScope.addHook("preHandler", authGuards.requirePermission("products:manage"));

    let running = false;
    adminScope.post("/catalog/simulate-next-day", {
      preHandler: async (request, reply) => {
        if (!env.ALLOW_SYNTHETIC_DATA || !env.AUTH_ENABLED) return sendApiError(reply, 403, "Sales simulation is disabled");
        if (request.body != null || Object.keys(request.query as object).length) {
          return sendApiError(reply, 400, "The server chooses the next dataset date. Send no parameters.");
        }
        return;
      },
      config: {
        rateLimit: {
          hook: "preHandler",
          max: 1,
          keyGenerator: () => getBahrainToday(services.runtime.now()).isoDate,
          timeWindow: () => {
            const now = services.runtime.now();
            const today = getBahrainToday(now).isoDate;
            return Date.parse(`${today}T00:00:00+03:00`) + 86_400_000 - now;
          },
        },
      },
      errorHandler(error, _request, reply) {
        if (error instanceof Error && "statusCode" in error && error.statusCode === 429) {
          return sendApiError(reply, 429, "Sales can be simulated once per Bahrain calendar day");
        }
        throw error;
      },
    }, async (request, reply) => {
      if (running) return sendApiError(reply, 429, "A sales simulation is in progress");
      running = true;
      try {
        const now = services.runtime.now();
        const today = getBahrainToday(now).isoDate;
        const mongo = services.repositoryKind() === "mongo";
        await services.ensureFreshPlan();
        const data = services.runtime.data;
        const lastDate = data.dates.at(-1);
        if (!lastDate) return sendApiError(reply, 409, "The dataset has no opening stock date");
        const nextDate = new Date(Date.parse(lastDate + "T00:00:00Z") + 86_400_000).toISOString().slice(0, 10);
        // The first sale is the durable marker for the run. A new API process can see it
        // even if the previous process stopped between writing rows and logging completion.
        const [anchor] = (await listSalesEntries({ simulationAnchor: true, page: 1, limit: 1 }, mongo)).entries;
        const runDay = anchor?.simulationDay;
        const [receipt] = runDay ? await listImportLogs({ id: `synthetic-sales-${runDay}`, limit: 1 }, mongo) : [];
        const unfinished = runDay && !receipt ? anchor : undefined;
        if (runDay === today || (receipt && getBahrainToday(new Date(receipt.importedAt)).isoDate === today)
          || (await listImportLogs({ id: `synthetic-sales-${today}`, limit: 1 }, mongo)).length) {
          return sendApiError(reply, 429, "Sales have already been simulated this Bahrain calendar day");
        }
        const targetDate = unfinished?.date ?? nextDate;
        const runId = `synthetic-sales-${unfinished?.simulationDay ?? today}`;
        const skus = new Set(data.products.filter(p => p.status !== "archived").map(p => p.sku));
        const branches = data.branches.filter(b => b.status !== "archived").map(b => b.id);
        const activeBranches = new Set(branches);
        const rows = simulateNextDay(data, targetDate).filter(row => skus.has(row.sku) && activeBranches.has(row.branchId));
        if (!rows.length) return sendApiError(reply, 409, "There are no active products and branches to simulate");

        let inserted = 0;
        let updated = 0;
        const existing = (await listSalesEntries({ from: targetDate, to: targetDate, page: 1, limit: rows.length }, mongo)).entries;
        if (!unfinished && existing.length) {
          return sendApiError(reply, 409, "Sales for this date have already started. Refresh the catalog.");
        }
        const savedRows = new Map(existing.map(row => [`${row.sku}::${row.branchId}`, row]));
        for (const row of rows) {
          const prior = savedRows.get(`${row.sku}::${row.branchId}`);
          if (prior) {
            row.sales = prior.unitsSold;
            row.onHand = prior.onHand;
            continue;
          }
          const claim = !unfinished && row === rows[0];
          const input = { branchId: row.branchId, sku: row.sku, date: targetDate, unitsSold: row.sales, onHand: row.onHand };
          const saved = await upsertSalesEntry(input, mongo, "sample", claim ? { firstRowOn: today } : {}).catch(async error => {
            // A real submission can win the unique sale key while the batch is running.
            const [entry] = (await listSalesEntries({
              branchId: row.branchId, sku: row.sku, from: targetDate, to: targetDate, page: 1, limit: 1,
            }, mongo)).entries;
            if (!entry) throw error;
            return { entry, created: false };
          });
          if (claim && !saved.created) return sendApiError(reply, 429, "Another sales simulation already claimed this day");
          if (saved.created) inserted++;
          else updated++;
          row.sales = saved.entry.unitsSold;
          row.onHand = saved.entry.onHand;
        }
        // Publish to the live dataset only after the entire batch has been written.
        for (const row of rows) {
          services.catalog.applySalesEntryToDataset(row.branchId, row.sku, targetDate, row.sales, row.onHand);
        }
        const lastSku = rows.at(-1)!.sku;
        for (const sku of skus) {
          await recomputeForSku(branches[0]!, sku);
          // Appending a date also changes network KPIs and the historical trend.
          await services.catalog.recomputeSingleSku(sku, { bumpVersion: false, fullPlanRecompute: sku === lastSku });
        }
        await services.commitPlanVersion();
        await recordImportLog({
          id: runId, importedAt: new Date(now).toISOString(), fileName: `Synthetic sales · ${targetDate}`,
          user: { userId: request.currentUser.id, name: request.currentUser.name, role: request.currentUser.role },
          inserted, updated, errorCount: 0, minDate: targetDate, maxDate: targetDate,
          branchIds: branches,
        }, mongo);
        return { targetDate, branches: branches.length, rows: inserted };
      } finally {
        running = false;
      }
    });

    // RBAC: Admin only (products:manage via adminScope hook).
    adminScope.post("/catalog/products", async (request, reply) => {
      const parsed = CreateProductSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendApiError(reply, 400, parsed.error.issues[0]?.message || "Invalid product input");
      }
      try {
        const created = await services.catalog.createCatalogProduct(parsed.data, request.currentUser);
        return reply.code(201).send(ProductSchema.parse(created));
      } catch (err) {
        return handleDomainRouteError(err, reply);
      }
    });

    // RBAC: Admin only (products:manage via adminScope hook).
    adminScope.patch("/catalog/products/:sku", async (request, reply) => {
      const pathParsed = PathSkuSchema.safeParse(request.params);
      if (!pathParsed.success) {
        return sendApiError(reply, 400, "Invalid SKU in path");
      }
      const parsed = UpdateProductSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendApiError(reply, 400, parsed.error.issues[0]?.message || "Invalid update input");
      }
      try {
        const updated = await services.catalog.updateCatalogProduct(
          pathParsed.data.sku,
          parsed.data,
          request.currentUser,
        );
        return ProductSchema.parse(updated);
      } catch (err) {
        return handleDomainRouteError(err, reply);
      }
    });

    // RBAC: Admin only (products:manage via adminScope hook).
    adminScope.patch("/catalog/products/:sku/archive", async (request, reply) => {
      const pathParsed = PathSkuSchema.safeParse(request.params);
      if (!pathParsed.success) {
        return sendApiError(reply, 400, "Invalid SKU in path");
      }
      try {
        const result = await services.catalog.archiveCatalogProduct(pathParsed.data.sku, request.currentUser);
        return {
          product: ProductSchema.parse(result.product),
          removedPendingActionsCount: result.removedPendingActionsCount,
        };
      } catch (err) {
        return handleDomainRouteError(err, reply);
      }
    });

    // RBAC: Admin only (products:manage via adminScope hook).
    adminScope.patch("/catalog/products/:sku/restore", async (request, reply) => {
      const pathParsed = PathSkuSchema.safeParse(request.params);
      if (!pathParsed.success) {
        return sendApiError(reply, 400, "Invalid SKU in path");
      }
      try {
        const restored = await services.catalog.restoreCatalogProduct(pathParsed.data.sku, request.currentUser);
        return ProductSchema.parse(restored);
      } catch (err) {
        return handleDomainRouteError(err, reply);
      }
    });

    // RBAC: Admin only (products:manage via adminScope hook).
    adminScope.delete("/catalog/products/:sku", async (request, reply) => {
      const pathParsed = PathSkuSchema.safeParse(request.params);
      if (!pathParsed.success) {
        return sendApiError(reply, 400, "Invalid SKU in path");
      }
      try {
        await services.catalog.deleteCatalogProduct(pathParsed.data.sku, request.currentUser);
        return { ok: true };
      } catch (err) {
        return handleDomainRouteError(err, reply);
      }
    });

    // RBAC: Admin only (products:manage via adminScope hook).
    adminScope.post("/catalog/products/:sku/sample-history", async (request, reply) => {
      const pathParsed = PathSkuSchema.safeParse(request.params);
      if (!pathParsed.success) {
        return sendApiError(reply, 400, "Invalid SKU in path");
      }
      try {
        const result = await services.catalog.generateSampleHistory(pathParsed.data.sku, request.currentUser);
        return { ok: true, salesEntriesCount: result.salesEntriesCount };
      } catch (err) {
        return handleDomainRouteError(err, reply);
      }
    });
  });
}

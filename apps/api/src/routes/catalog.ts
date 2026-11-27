import { randomUUID } from "node:crypto";
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
import { claimSimulationDay, fillMissingSampleSales, listImportLogs, listSalesEntries, recordImportLog, recomputeForSku, releaseSimulationDay } from "../db.js";
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

    const mongo = services.repositoryKind() === "mongo";
    const simulationEnabled = env.ALLOW_SYNTHETIC_DATA && env.AUTH_ENABLED;
    const todayInBahrain = () => getBahrainToday(services.runtime.now()).isoDate;
    const dailyReceipt = async (day: string) => (await listImportLogs({ simulationOn: day, limit: 1 }, mongo))[0];

    adminScope.get("/catalog/simulate-today", async (_request, reply) => {
      if (!simulationEnabled) return sendApiError(reply, 403, "Sales simulation is disabled");
      await services.pingDb();
      const day = todayInBahrain();
      const receipt = await dailyReceipt(day);
      reply.header("Cache-Control", "private, no-store");
      return { day, result: receipt ? { targetDate: receipt.minDate, branches: receipt.branchIds.length, rows: receipt.inserted } : null };
    });

    for (const mode of ["simulate-today", "simulate-next-day"] as const) {
      adminScope.post(`/catalog/${mode}`, async (request, reply) => {
        if (!simulationEnabled) return sendApiError(reply, 403, "Sales simulation is disabled");
        if (request.body != null || Object.keys(request.query as object).length) {
          return sendApiError(reply, 400, "The server chooses the sales date. Send no parameters.");
        }
        const now = services.runtime.now();
        const day = getBahrainToday(now).isoDate;
        await services.ensureFreshPlan();
        const data = services.runtime.data;
        const lastDate = data.dates.at(-1);
        if (!lastDate) return sendApiError(reply, 409, "The dataset has no opening stock date");
        const nextDate = new Date(Date.parse(lastDate + "T00:00:00Z") + 86_400_000).toISOString().slice(0, 10);
        // Resume an interrupted historical catalog run. The dashboard always targets today.
        const [anchor] = mode === "simulate-next-day"
          ? (await listSalesEntries({ simulationAnchor: true, page: 1, limit: 1 }, mongo)).entries : [];
        const unfinished = anchor?.simulationDay &&
          !(await listImportLogs({ id: `synthetic-sales-${anchor.simulationDay}`, limit: 1 }, mongo)).length ? anchor : undefined;
        const proposedDate = mode === "simulate-today" ? day : unfinished?.date ?? nextDate;
        const token = randomUUID();
        if (await dailyReceipt(day)) return sendApiError(reply, 429, "Sales have already been simulated this Bahrain calendar day");
        const claim = await claimSimulationDay(day, proposedDate, token, mongo);
        if (!claim) return sendApiError(reply, 429, "A sales simulation is in progress");
        try {
          if (await dailyReceipt(day)) return sendApiError(reply, 429, "Sales have already been simulated this Bahrain calendar day");
          const targetDate = claim.targetDate;
          if (mode === "simulate-today" && targetDate !== day) {
            return sendApiError(reply, 409, "Resume the interrupted next-day simulation from the catalog.");
          }
          if (targetDate <= data.dates[0]!) return sendApiError(reply, 409, "Simulation needs stock history before the target date");
          const skus = new Set(data.products.filter(p => p.status !== "archived").map(p => p.sku));
          const branches = data.branches.filter(b => b.status !== "archived").map(b => b.id);
          const activeBranches = new Set(branches);
          const rows = simulateNextDay(data, targetDate)
            .filter(row => skus.has(row.sku) && activeBranches.has(row.branchId))
            .map(row => ({ branchId: row.branchId, sku: row.sku, date: targetDate, unitsSold: row.sales, onHand: row.onHand }));
          if (!rows.length) return sendApiError(reply, 409, "There are no active products and branches to simulate");

          const inserted = await fillMissingSampleSales(rows, mongo, row => {
            services.catalog.applySalesEntryToDataset(row.branchId, row.sku, row.date, row.unitsSold, row.onHand);
          }, mode === "simulate-next-day" ? unfinished?.simulationDay ?? day : undefined);
          // Mongo reloads the persisted observations on version change. In memory the
          // batch above applied the authoritative value for each key synchronously.
          if (inserted || unfinished || mongo) {
            const lastSku = rows.at(-1)!.sku;
            for (const sku of skus) {
              await recomputeForSku(branches[0]!, sku);
              await services.catalog.recomputeSingleSku(sku, { bumpVersion: false, fullPlanRecompute: sku === lastSku });
            }
            await services.commitPlanVersion();
          }
          await recordImportLog({
            id: `synthetic-sales-${unfinished?.simulationDay ?? day}`, importedAt: new Date(now).toISOString(),
            fileName: `Synthetic sales · ${targetDate}`,
            user: { userId: request.currentUser.id, name: request.currentUser.name, role: request.currentUser.role },
            inserted, updated: 0, errorCount: 0, minDate: targetDate, maxDate: targetDate, branchIds: branches,
          }, mongo);
          return { targetDate, branches: branches.length, rows: inserted };
        } finally {
          await releaseSimulationDay(day, token, mongo);
        }
      });
    }

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

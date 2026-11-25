import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  CreateProductSchema,
  ProductDetailWithHistorySchema,
  ProductListQuerySchema,
  ProductListResponseSchema,
  StoreProductListSchema,
  StoreProductSchema,
  ProductSchema,
  UpdateProductSchema,
} from "@stockflow/core";
import type { AuthContext } from "../plugins/auth.js";
import type { StockServices } from "../services/index.js";
import { handleDomainRouteError, sendApiError } from "./helpers.js";

const PathSkuSchema = z.object({
  sku: z.string().min(1),
});

export function registerCatalogRoutes(
  app: FastifyInstance,
  services: StockServices,
  authGuards: AuthContext,
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

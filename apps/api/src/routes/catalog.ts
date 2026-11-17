import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  CreateProductSchema,
  ErrorBodySchema,
  ProductDetailWithHistorySchema,
  ProductListQuerySchema,
  ProductListResponseSchema,
  ProductSchema,
  UpdateProductSchema,
} from "@stockflow/core";
import type { AuthContext } from "../plugins/auth.js";
import {
  DecisionForbiddenError,
  ProductConflictError,
  ProductNotFoundError,
  ProductValidationError,
  type StockServices,
} from "../services/index.js";

const PathSkuSchema = z.object({
  sku: z.string().min(1),
});

export function registerCatalogRoutes(
  app: FastifyInstance,
  services: StockServices,
  authGuards: AuthContext,
): void {
  // Publicly readable for authenticated users (admin, manager, staff) with catalog:view
  app.get(
    "/catalog/products",
    { preHandler: [authGuards.requirePermission("catalog:view")] },
    async (request, reply) => {
      const parsed = ProductListQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send(
          ErrorBodySchema.parse({ error: parsed.error.issues[0]?.message || "Invalid query parameters" }),
        );
      }
      try {
        const result = await services.catalog.listCatalogProducts(parsed.data, request.currentUser);
        return ProductListResponseSchema.parse(result);
      } catch (err) {
        if (err instanceof DecisionForbiddenError) {
          return reply.code(403).send(ErrorBodySchema.parse({ error: err.message }));
        }
        throw err;
      }
    },
  );

  app.get(
    "/catalog/products/:sku",
    { preHandler: [authGuards.requirePermission("catalog:view")] },
    async (request, reply) => {
      const pathParsed = PathSkuSchema.safeParse(request.params);
      if (!pathParsed.success) {
        return reply.code(400).send(ErrorBodySchema.parse({ error: "Invalid SKU in path" }));
      }
      const result = await services.catalog.getCatalogProduct(pathParsed.data.sku);
      if (!result) {
        return reply.code(404).send(ErrorBodySchema.parse({ error: "Product not found" }));
      }
      return ProductDetailWithHistorySchema.parse(result);
    },
  );

  // Admin-only mutation routes (products:manage)
  app.register(async (adminScope) => {
    adminScope.addHook("preHandler", authGuards.requirePermission("products:manage"));

    adminScope.post("/catalog/products", async (request, reply) => {
      const parsed = CreateProductSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send(
          ErrorBodySchema.parse({ error: parsed.error.issues[0]?.message || "Invalid product input" }),
        );
      }
      try {
        const created = await services.catalog.createCatalogProduct(parsed.data, request.currentUser);
        return reply.code(201).send(ProductSchema.parse(created));
      } catch (err) {
        if (err instanceof ProductConflictError) {
          return reply.code(409).send(ErrorBodySchema.parse({ error: err.message }));
        }
        if (err instanceof DecisionForbiddenError) {
          return reply.code(403).send(ErrorBodySchema.parse({ error: err.message }));
        }
        throw err;
      }
    });

    adminScope.patch("/catalog/products/:sku", async (request, reply) => {
      const pathParsed = PathSkuSchema.safeParse(request.params);
      if (!pathParsed.success) {
        return reply.code(400).send(ErrorBodySchema.parse({ error: "Invalid SKU in path" }));
      }
      const parsed = UpdateProductSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send(
          ErrorBodySchema.parse({ error: parsed.error.issues[0]?.message || "Invalid update input" }),
        );
      }
      try {
        const updated = await services.catalog.updateCatalogProduct(
          pathParsed.data.sku,
          parsed.data,
          request.currentUser,
        );
        return ProductSchema.parse(updated);
      } catch (err) {
        if (err instanceof ProductValidationError) {
          return reply.code(400).send(ErrorBodySchema.parse({ error: err.message }));
        }
        if (err instanceof ProductNotFoundError) {
          return reply.code(404).send(ErrorBodySchema.parse({ error: err.message }));
        }
        if (err instanceof ProductConflictError) {
          return reply.code(409).send(ErrorBodySchema.parse({ error: err.message }));
        }
        if (err instanceof DecisionForbiddenError) {
          return reply.code(403).send(ErrorBodySchema.parse({ error: err.message }));
        }
        throw err;
      }
    });

    adminScope.patch("/catalog/products/:sku/archive", async (request, reply) => {
      const pathParsed = PathSkuSchema.safeParse(request.params);
      if (!pathParsed.success) {
        return reply.code(400).send(ErrorBodySchema.parse({ error: "Invalid SKU in path" }));
      }
      try {
        const result = await services.catalog.archiveCatalogProduct(pathParsed.data.sku, request.currentUser);
        return {
          product: ProductSchema.parse(result.product),
          removedPendingActionsCount: result.removedPendingActionsCount,
        };
      } catch (err) {
        if (err instanceof ProductValidationError) {
          return reply.code(400).send(ErrorBodySchema.parse({ error: err.message }));
        }
        if (err instanceof ProductNotFoundError) {
          return reply.code(404).send(ErrorBodySchema.parse({ error: err.message }));
        }
        if (err instanceof DecisionForbiddenError) {
          return reply.code(403).send(ErrorBodySchema.parse({ error: err.message }));
        }
        throw err;
      }
    });

    adminScope.patch("/catalog/products/:sku/restore", async (request, reply) => {
      const pathParsed = PathSkuSchema.safeParse(request.params);
      if (!pathParsed.success) {
        return reply.code(400).send(ErrorBodySchema.parse({ error: "Invalid SKU in path" }));
      }
      try {
        const restored = await services.catalog.restoreCatalogProduct(pathParsed.data.sku, request.currentUser);
        return ProductSchema.parse(restored);
      } catch (err) {
        if (err instanceof ProductValidationError) {
          return reply.code(400).send(ErrorBodySchema.parse({ error: err.message }));
        }
        if (err instanceof ProductNotFoundError) {
          return reply.code(404).send(ErrorBodySchema.parse({ error: err.message }));
        }
        if (err instanceof DecisionForbiddenError) {
          return reply.code(403).send(ErrorBodySchema.parse({ error: err.message }));
        }
        throw err;
      }
    });

    adminScope.delete("/catalog/products/:sku", async (request, reply) => {
      const pathParsed = PathSkuSchema.safeParse(request.params);
      if (!pathParsed.success) {
        return reply.code(400).send(ErrorBodySchema.parse({ error: "Invalid SKU in path" }));
      }
      try {
        await services.catalog.deleteCatalogProduct(pathParsed.data.sku, request.currentUser);
        return { ok: true };
      } catch (err) {
        if (err instanceof ProductValidationError) {
          return reply.code(400).send(ErrorBodySchema.parse({ error: err.message }));
        }
        if (err instanceof ProductNotFoundError) {
          return reply.code(404).send(ErrorBodySchema.parse({ error: err.message }));
        }
        if (err instanceof ProductConflictError) {
          return reply.code(409).send(ErrorBodySchema.parse({ error: err.message }));
        }
        if (err instanceof DecisionForbiddenError) {
          return reply.code(403).send(ErrorBodySchema.parse({ error: err.message }));
        }
        throw err;
      }
    });

    adminScope.post("/catalog/products/:sku/sample-history", async (request, reply) => {
      const pathParsed = PathSkuSchema.safeParse(request.params);
      if (!pathParsed.success) {
        return reply.code(400).send(ErrorBodySchema.parse({ error: "Invalid SKU in path" }));
      }
      try {
        const result = await services.catalog.generateSampleHistory(pathParsed.data.sku, request.currentUser);
        return { ok: true, salesEntriesCount: result.salesEntriesCount };
      } catch (err) {
        if (err instanceof ProductValidationError) {
          return reply.code(400).send(ErrorBodySchema.parse({ error: err.message }));
        }
        if (err instanceof ProductNotFoundError) {
          return reply.code(404).send(ErrorBodySchema.parse({ error: err.message }));
        }
        if (err instanceof DecisionForbiddenError) {
          return reply.code(403).send(ErrorBodySchema.parse({ error: err.message }));
        }
        throw err;
      }
    });
  });
}

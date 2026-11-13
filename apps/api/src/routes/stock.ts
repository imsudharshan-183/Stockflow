import {
  BranchDetailSchema,
  ErrorBodySchema,
  HealthSchema,
  ProductDetailSchema,
  RecommendationQuerySchema,
  RecommendationSchema,
  isBranchInScope,
  type User,
} from "@stockflow/core";
import type { FastifyInstance } from "fastify";
import type { AuthContext } from "../plugins/auth.js";
import { DecisionForbiddenError, type StockService } from "../services/stockService.js";

export function registerStockRoutes(
  app: FastifyInstance,
  service: StockService,
  authGuards: AuthContext,
): void {
  app.get("/health", async () => {
    return HealthSchema.parse({ status: "ok", repository: service.repositoryKind() });
  });

  app.get(
    "/kpis",
    { preHandler: [authGuards.authenticate] },
    async (request) => service.kpis(request.currentUser),
  );

  app.get(
    "/audit",
    { preHandler: [authGuards.requirePermission("audit:read")] },
    async (request, reply) => {
      try {
        return service.listAudit(request.currentUser);
      } catch (err) {
        if (err instanceof DecisionForbiddenError) {
          return reply.code(403).send(ErrorBodySchema.parse({ error: err.message }));
        }
        throw err;
      }
    },
  );

  app.get(
    "/recommendations",
    { preHandler: [authGuards.authenticate] },
    async (request) => {
      const query = RecommendationQuerySchema.parse(cleanQuery(request.query));
      return service.list(query, request.currentUser);
    },
  );

  app.get(
    "/branches/:id",
    { preHandler: [authGuards.authenticate] },
    async (request, reply) => {
      const { id } = pathId.parse(request.params);
      if (!isBranchInScope(request.currentUser, id)) {
        return reply.code(403).send(ErrorBodySchema.parse({ error: "Access to branch forbidden" }));
      }
      const detail = service.branch(id, request.currentUser);
      if (!detail) return reply.code(404).send(ErrorBodySchema.parse({ error: "Branch not found" }));
      return BranchDetailSchema.parse(detail);
    },
  );

  app.get(
    "/products/:sku",
    { preHandler: [authGuards.authenticate] },
    async (request, reply) => {
      const { sku } = pathSku.parse(request.params);
      const detail = service.product(sku, request.currentUser);
      if (!detail) return reply.code(404).send(ErrorBodySchema.parse({ error: "Product not found" }));
      return ProductDetailSchema.parse(detail);
    },
  );

  app.post(
    "/recommendations/:id/approve",
    { preHandler: [authGuards.requirePermission("recommendations:decide")] },
    async (request, reply) => {
      return decide(service, request.params, "APPROVED", request.currentUser, reply);
    },
  );

  app.post(
    "/recommendations/:id/reject",
    { preHandler: [authGuards.requirePermission("recommendations:decide")] },
    async (request, reply) => {
      return decide(service, request.params, "REJECTED", request.currentUser, reply);
    },
  );
}

const pathId = RecommendationSchema.pick({ id: true });
const pathSku = RecommendationSchema.pick({ sku: true });

async function decide(
  service: StockService,
  params: unknown,
  status: "APPROVED" | "REJECTED",
  user: User,
  reply: { code: (statusCode: number) => { send: (body: unknown) => unknown } },
): Promise<unknown> {
  const { id } = pathId.parse(params);
  try {
    const updated = await service.decide(id, status, user);
    if (!updated) {
      return reply.code(404).send(ErrorBodySchema.parse({ error: "Recommendation not found" }));
    }
    return RecommendationSchema.parse(updated);
  } catch (err) {
    if (err instanceof DecisionForbiddenError) {
      return reply.code(403).send(ErrorBodySchema.parse({ error: err.message }));
    }
    throw err;
  }
}

function cleanQuery(query: unknown): Record<string, string | undefined> {
  if (typeof query !== "object" || query === null) return {};
  const source = query as Record<string, unknown>;
  return {
    branch: text(source.branch),
    category: text(source.category),
    action: text(source.action),
    status: text(source.status),
  };
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

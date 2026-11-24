import {
  BatchDecideRequestSchema,
  BatchDecideResponseSchema,
  BranchDetailSchema,
  DbHealthSchema,
  ErrorBodySchema,
  HealthSchema,
  ProductDetailSchema,
  RecommendationQuerySchema,
  RecommendationSchema,
  isBranchInScope,
  type DbHealth,
  type User,
} from "@stockflow/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getMissingRequiredEnvVars, type Env } from "../config/env.js";
import { redactSecrets } from "../config/redact.js";
import type { AuthContext } from "../plugins/auth.js";
import {
  BranchNotFoundError,
  DecisionConflictError,
  DecisionForbiddenError,
  type StockServices,
} from "../services/index.js";
import {
  LifecycleRecommendationSchema,
  QueueLifecycleViewSchema,
} from "../services/queueLifecycle.js";

const ExtendedRecommendationQuerySchema = RecommendationQuerySchema.merge(
  z.object({ view: QueueLifecycleViewSchema.optional() }),
);
const RejectBodySchema = z.object({
  reasonCode: z.string().min(1).max(120).optional(),
  comment: z.string().max(500).optional(),
});
const ReopenBodySchema = z.object({
  comment: z.string().max(500).optional(),
});

const HEALTH_DB_CACHE_TTL_MS = 30_000;

export function registerStockRoutes(
  app: FastifyInstance,
  services: StockServices,
  authGuards: AuthContext,
  diagnostics?: { env?: Partial<Env>; startupError?: string | null },
): void {
  let cachedDbHealth: { statusCode: 200 | 503; body: DbHealth; expiresAt: number } | null = null;
  let inflightDbPing: Promise<{ statusCode: 200 | 503; body: DbHealth }> | null = null;

  app.get("/health", async () => {
    return HealthSchema.parse({
      status: "ok",
      repository: services.repositoryKind(),
      startupError: diagnostics?.startupError ? redactSecrets(diagnostics.startupError) : null,
      missingEnv: getMissingRequiredEnvVars(process.env, diagnostics?.env),
    });
  });

  app.get("/health/db", async (_request, reply) => {
    const now = Date.now();
    if (cachedDbHealth && now < cachedDbHealth.expiresAt) {
      return reply.code(cachedDbHealth.statusCode).send(cachedDbHealth.body);
    }

    if (!inflightDbPing) {
      inflightDbPing = (async () => {
        const missingEnv = getMissingRequiredEnvVars(process.env, diagnostics?.env);
        if (services.repositoryKind() === "memory") {
          return {
            statusCode: 503 as const,
            body: DbHealthSchema.parse({
              db: "error",
              name: "ConfigurationError",
              message: "MongoDB is not configured (MONGODB_URI is unset)",
              missingEnv,
            }),
          };
        }
        try {
          await services.pingDb();
          return {
            statusCode: 200 as const,
            body: DbHealthSchema.parse({ db: "ok", missingEnv }),
          };
        } catch (err) {
          const name = err instanceof Error ? err.name || "Error" : "Error";
          const rawMessage = err instanceof Error ? err.message : "Database ping failed";
          return {
            statusCode: 503 as const,
            body: DbHealthSchema.parse({
              db: "error",
              name,
              message: redactSecrets(rawMessage),
              missingEnv,
            }),
          };
        }
      })().then((result) => {
        cachedDbHealth = { ...result, expiresAt: Date.now() + HEALTH_DB_CACHE_TTL_MS };
        inflightDbPing = null;
        return result;
      });
    }

    const result = await inflightDbPing;
    return reply.code(result.statusCode).send(result.body);
  });

  app.get(
    "/kpis",
    { preHandler: [authGuards.requirePermission("dashboard:financial:scoped")] },
    async (request, reply) => {
      const q = cleanQuery(request.query) as { branch?: string; meta?: string };
      await services.ensureFreshPlan({ syncDecisions: q.meta === "1" });
      try {
        if (q.meta === "1") {
          return services.kpi.kpisWithMeta(request.currentUser, q.branch);
        }
        return services.kpi.kpis(request.currentUser, q.branch);
      } catch (err) {
        if (err instanceof DecisionForbiddenError) {
          return reply.code(403).send(ErrorBodySchema.parse({ error: err.message }));
        }
        if (err instanceof BranchNotFoundError) {
          return reply.code(404).send(ErrorBodySchema.parse({ error: err.message }));
        }
        throw err;
      }
    },
  );

  app.get(
    "/kpis/live",
    { preHandler: [authGuards.requirePermission("dashboard:financial:scoped")] },
    async (request, reply) => {
      await services.ensureFreshPlan();
      const q = cleanQuery(request.query) as { branch?: string };
      try {
        return services.kpi.liveOverview(request.currentUser, q.branch);
      } catch (err) {
        if (err instanceof DecisionForbiddenError) {
          return reply.code(403).send(ErrorBodySchema.parse({ error: err.message }));
        }
        if (err instanceof BranchNotFoundError) {
          return reply.code(404).send(ErrorBodySchema.parse({ error: err.message }));
        }
        throw err;
      }
    },
  );

  app.get(
    "/audit",
    { preHandler: [authGuards.requirePermission("audit:read")] },
    async (request, reply) => {
      await services.ensureFreshPlan({ syncDecisions: false, syncAudit: true });
      const q = cleanQuery(request.query) as { branch?: string };
      try {
        return services.decisions.listAudit(request.currentUser, q.branch);
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
    { preHandler: [authGuards.requirePermission("recommendations:read")] },
    async (request) => {
      await services.ensureFreshPlan();
      const query = ExtendedRecommendationQuerySchema.parse(cleanQuery(request.query));
      return services.decisions.list(query, request.currentUser);
    },
  );

  app.get(
    "/branches/:id",
    // DECISION: Branch detail exposes financial BD rollups (deadStockValue, lostSalesAtRisk, netBenefit)
    // so access matches /api/locations/:id/summary and requires dashboard:financial:scoped (403 for staff).
    { preHandler: [authGuards.requirePermission("dashboard:financial:scoped")] },
    async (request, reply) => {
      await services.ensureFreshPlan();
      const { id } = pathId.parse(request.params);
      if (!isBranchInScope(request.currentUser, id)) {
        return reply.code(403).send(ErrorBodySchema.parse({ error: "Access to branch forbidden" }));
      }
      const detail = services.catalog.branch(id, request.currentUser);
      if (!detail) return reply.code(404).send(ErrorBodySchema.parse({ error: "Branch not found" }));
      return BranchDetailSchema.parse(detail);
    },
  );

  app.get(
    "/products/:sku",
    { preHandler: [authGuards.requirePermission("catalog:view")] },
    async (request, reply) => {
      await services.ensureFreshPlan();
      const { sku } = pathSku.parse(request.params);
      const detail = services.catalog.product(sku, request.currentUser);
      if (!detail) return reply.code(404).send(ErrorBodySchema.parse({ error: "Product not found" }));
      return ProductDetailSchema.parse(detail);
    },
  );

  app.post(
    "/recommendations/:id/approve",
    { preHandler: [authGuards.requirePermission("recommendations:decide")] },
    async (request, reply) => {
      return decide(services, request.params, "APPROVED", request.currentUser, reply);
    },
  );

  app.post(
    "/recommendations/:id/reject",
    { preHandler: [authGuards.requirePermission("recommendations:decide")] },
    async (request, reply) => {
      const body = RejectBodySchema.parse(request.body ?? {});
      return decide(services, request.params, "REJECTED", request.currentUser, reply, body);
    },
  );

  app.post(
    "/recommendations/:id/reopen",
    { preHandler: [authGuards.requirePermission("recommendations:decide")] },
    async (request, reply) => {
      await services.ensureFreshPlan({ syncDecisions: false });
      const { id } = pathId.parse(request.params);
      const body = ReopenBodySchema.parse(request.body ?? {});
      try {
        const reopened = await services.decisions.reopen(id, request.currentUser, body.comment);
        if (!reopened) {
          return reply.code(404).send(ErrorBodySchema.parse({ error: "Recommendation not found" }));
        }
        return LifecycleRecommendationSchema.parse(reopened);
      } catch (err) {
        if (err instanceof DecisionForbiddenError) {
          return reply.code(403).send(ErrorBodySchema.parse({ error: err.message }));
        }
        if (err instanceof DecisionConflictError) {
          return reply.code(409).send(ErrorBodySchema.parse({ error: err.message }));
        }
        throw err;
      }
    },
  );

  app.post(
    "/recommendations/batch/decide",
    { preHandler: [authGuards.requirePermission("recommendations:decide")] },
    async (request) => {
      await services.ensureFreshPlan({ syncDecisions: false });
      const body = BatchDecideRequestSchema.parse(request.body);
      const status = body.decision === "approve" ? "APPROVED" : "REJECTED";
      const reasonCode = body.decision === "reject" ? body.reasonCode : undefined;
      const results = await services.decisions.decideBatch(body.ids, status, request.currentUser, reasonCode);
      return BatchDecideResponseSchema.parse({ results });
    },
  );
}

const pathId = RecommendationSchema.pick({ id: true });
const pathSku = RecommendationSchema.pick({ sku: true });

async function decide(
  services: StockServices,
  params: unknown,
  status: "APPROVED" | "REJECTED",
  user: User,
  reply: { code: (statusCode: number) => { send: (body: unknown) => unknown } },
  opts?: { reasonCode?: string; comment?: string },
): Promise<unknown> {
  await services.ensureFreshPlan({ syncDecisions: false });
  const { id } = pathId.parse(params);
  try {
    const updated = await services.decisions.decide(id, status, user, opts);
    if (!updated) {
      return reply.code(404).send(ErrorBodySchema.parse({ error: "Recommendation not found" }));
    }
    return RecommendationSchema.parse(updated);
  } catch (err) {
    if (err instanceof DecisionForbiddenError) {
      return reply.code(403).send(ErrorBodySchema.parse({ error: err.message }));
    }
    if (err instanceof DecisionConflictError) {
      return reply.code(409).send(ErrorBodySchema.parse({ error: err.message }));
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
    view: text(source.view),
    meta: text(source.meta),
  };
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

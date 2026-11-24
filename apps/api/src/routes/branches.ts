import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  BranchListQuerySchema,
  BranchListResponseSchema,
  BranchSchema,
  CreateBranchSchema,
  ErrorBodySchema,
  UpdateBranchSchema,
} from "@stockflow/core";
import type { AuthContext } from "../plugins/auth.js";
import {
  BranchConflictError,
  BranchNotFoundError,
  BranchValidationError,
  DecisionForbiddenError,
  type StockServices,
} from "../services/index.js";
import { validateCoordinates } from "../utils/coordinates.js";

const PathIdSchema = z.object({
  id: z.string().min(1),
});

function normalizeBranchBody(
  raw: unknown,
): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Invalid branch request body" };
  }
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...src };
  if (
    out.coordinates === undefined &&
    (src.latitude !== undefined || src.longitude !== undefined)
  ) {
    if (
      typeof src.latitude !== "number" ||
      typeof src.longitude !== "number" ||
      !Number.isFinite(src.latitude) ||
      !Number.isFinite(src.longitude)
    ) {
      return { ok: false, error: "Latitude and longitude must be finite numbers" };
    }
    out.coordinates = [src.latitude, src.longitude];
    delete out.latitude;
    delete out.longitude;
  }
  return { ok: true, body: out };
}

function cleanQuery(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== "" && value !== undefined && value !== null) cleaned[key] = value;
  }
  return cleaned;
}

export function registerBranchRoutes(
  app: FastifyInstance,
  services: StockServices,
  authGuards: AuthContext,
): void {
  // Admin-only branch lifecycle routes (`branches:manage`).
  // Everyday active-only location views stay on /api/locations; historical drilldowns stay on /api/branches/:id.
  app.register(async (adminScope) => {
    adminScope.addHook("preHandler", authGuards.requirePermission("branches:manage"));

    adminScope.get("/branches", async (request, reply) => {
      const parsed = BranchListQuerySchema.safeParse(cleanQuery(request.query));
      if (!parsed.success) {
        return reply.code(400).send(
          ErrorBodySchema.parse({
            error: parsed.error.issues[0]?.message || "Invalid query parameters",
          }),
        );
      }
      try {
        const result = await services.catalog.listBranches(parsed.data, request.currentUser);
        return BranchListResponseSchema.parse(result);
      } catch (err) {
        if (err instanceof DecisionForbiddenError) {
          return reply.code(403).send(ErrorBodySchema.parse({ error: err.message }));
        }
        throw err;
      }
    });

    adminScope.post("/branches", async (request, reply) => {
      const normalized = normalizeBranchBody(request.body);
      if (!normalized.ok) {
        return reply.code(400).send(ErrorBodySchema.parse({ error: normalized.error }));
      }
      const parsed = CreateBranchSchema.safeParse(normalized.body);
      if (!parsed.success) {
        return reply.code(400).send(
          ErrorBodySchema.parse({
            error: parsed.error.issues[0]?.message || "Invalid branch input",
          }),
        );
      }
      const payload = { ...parsed.data };
      if (payload.coordinates !== undefined) {
        const coordCheck = validateCoordinates(payload.coordinates[0], payload.coordinates[1]);
        if (!coordCheck.ok) {
          return reply.code(400).send(ErrorBodySchema.parse({ error: coordCheck.error }));
        }
        payload.coordinates = [coordCheck.lat, coordCheck.lng];
      }
      try {
        const created = await services.catalog.createBranch(payload, request.currentUser);
        return reply.code(201).send(BranchSchema.parse(created));
      } catch (err) {
        if (err instanceof BranchConflictError) {
          return reply.code(409).send(ErrorBodySchema.parse({ error: err.message }));
        }
        if (err instanceof BranchValidationError) {
          return reply.code(400).send(ErrorBodySchema.parse({ error: err.message }));
        }
        if (err instanceof DecisionForbiddenError) {
          return reply.code(403).send(ErrorBodySchema.parse({ error: err.message }));
        }
        throw err;
      }
    });

    adminScope.patch("/branches/:id", async (request, reply) => {
      const pathParsed = PathIdSchema.safeParse(request.params);
      if (!pathParsed.success) {
        return reply.code(400).send(ErrorBodySchema.parse({ error: "Invalid branch ID in path" }));
      }
      const normalized = normalizeBranchBody(request.body);
      if (!normalized.ok) {
        return reply.code(400).send(ErrorBodySchema.parse({ error: normalized.error }));
      }
      const parsed = UpdateBranchSchema.safeParse(normalized.body);
      if (!parsed.success) {
        return reply.code(400).send(
          ErrorBodySchema.parse({
            error: parsed.error.issues[0]?.message || "Invalid branch update input",
          }),
        );
      }
      const payload = { ...parsed.data };
      if (payload.coordinates !== undefined) {
        const coordCheck = validateCoordinates(payload.coordinates[0], payload.coordinates[1]);
        if (!coordCheck.ok) {
          return reply.code(400).send(ErrorBodySchema.parse({ error: coordCheck.error }));
        }
        payload.coordinates = [coordCheck.lat, coordCheck.lng];
      }
      try {
        const updated = await services.catalog.updateBranch(
          pathParsed.data.id,
          payload,
          request.currentUser,
        );
        return BranchSchema.parse(updated);
      } catch (err) {
        if (err instanceof BranchNotFoundError) {
          return reply.code(404).send(ErrorBodySchema.parse({ error: err.message }));
        }
        if (err instanceof BranchConflictError) {
          return reply.code(409).send(ErrorBodySchema.parse({ error: err.message }));
        }
        if (err instanceof BranchValidationError) {
          return reply.code(400).send(ErrorBodySchema.parse({ error: err.message }));
        }
        if (err instanceof DecisionForbiddenError) {
          return reply.code(403).send(ErrorBodySchema.parse({ error: err.message }));
        }
        throw err;
      }
    });
  });
}

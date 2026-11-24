import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  BranchListQuerySchema,
  BranchListResponseSchema,
  BranchSchema,
  CreateBranchSchema,
  UpdateBranchSchema,
  validateCoordinates,
} from "@stockflow/core";
import type { AuthContext } from "../plugins/auth.js";
import type { StockServices } from "../services/index.js";
import { cleanQuery, handleDomainRouteError, sendApiError } from "./helpers.js";

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

function applyValidatedCoordinates<T extends { coordinates?: [number, number] }>(
  payload: T,
): string | null {
  if (payload.coordinates === undefined) return null;
  const check = validateCoordinates(payload.coordinates[0], payload.coordinates[1]);
  if (!check.ok) return check.error;
  payload.coordinates = [check.lat, check.lng];
  return null;
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

    // RBAC: Admin only (branches:manage via adminScope hook; returns active/archived branches).
    adminScope.get("/branches", async (request, reply) => {
      const parsed = BranchListQuerySchema.safeParse(cleanQuery(request.query));
      if (!parsed.success) {
        return sendApiError(reply, 400, parsed.error.issues[0]?.message || "Invalid query parameters");
      }
      try {
        const result = await services.catalog.listBranches(parsed.data, request.currentUser);
        return BranchListResponseSchema.parse(result);
      } catch (err) {
        return handleDomainRouteError(err, reply);
      }
    });

    // RBAC: Admin only (branches:manage via adminScope hook; creates branch + zero-filled history).
    adminScope.post("/branches", async (request, reply) => {
      const normalized = normalizeBranchBody(request.body);
      if (!normalized.ok) {
        return sendApiError(reply, 400, normalized.error);
      }
      const parsed = CreateBranchSchema.safeParse(normalized.body);
      if (!parsed.success) {
        return sendApiError(reply, 400, parsed.error.issues[0]?.message || "Invalid branch input");
      }
      const payload = { ...parsed.data };
      const coordErr = applyValidatedCoordinates(payload);
      if (coordErr) return sendApiError(reply, 400, coordErr);
      try {
        const created = await services.catalog.createBranch(payload, request.currentUser);
        return reply.code(201).send(BranchSchema.parse(created));
      } catch (err) {
        return handleDomainRouteError(err, reply);
      }
    });

    // RBAC: Admin only (branches:manage via adminScope hook; updates details or archives/unarchives).
    adminScope.patch("/branches/:id", async (request, reply) => {
      const pathParsed = PathIdSchema.safeParse(request.params);
      if (!pathParsed.success) {
        return sendApiError(reply, 400, "Invalid branch ID in path");
      }
      const normalized = normalizeBranchBody(request.body);
      if (!normalized.ok) {
        return sendApiError(reply, 400, normalized.error);
      }
      const parsed = UpdateBranchSchema.safeParse(normalized.body);
      if (!parsed.success) {
        return sendApiError(
          reply,
          400,
          parsed.error.issues[0]?.message || "Invalid branch update input",
        );
      }
      const payload = { ...parsed.data };
      const coordErr = applyValidatedCoordinates(payload);
      if (coordErr) return sendApiError(reply, 400, coordErr);
      try {
        const updated = await services.catalog.updateBranch(
          pathParsed.data.id,
          payload,
          request.currentUser,
        );
        return BranchSchema.parse(updated);
      } catch (err) {
        return handleDomainRouteError(err, reply);
      }
    });
  });
}

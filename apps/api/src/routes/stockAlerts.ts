import {
  CreateStockAlertSchema,
  ResolveStockAlertResponseSchema,
  ResolveStockAlertSchema,
  StockAlertListSchema,
  StockAlertQuerySchema,
  StockAlertSchema,
} from "@stockflow/core";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { AuthContext } from "../plugins/auth.js";
import type { StockServices } from "../services/index.js";
import type { StockAlertService } from "../services/stockAlertService.js";
import { cleanQuery, handleDomainRouteError } from "./helpers.js";

const PathIdSchema = z.object({ id: z.string().min(1) });

export function registerStockAlertsRoutes(
  app: FastifyInstance,
  services: StockServices,
  authGuards: AuthContext,
): void {
  // RBAC: Admin, manager, staff (stock:flag or stock:flag:decide; non-admin sees assigned branches only).
  app.get(
    "/stock-alerts",
    // DECISION: Both staff (read own submitted branch alerts) and manager/admin (review queue)
    // share this endpoint, with non-admin branch scoping and ?branchId= guard enforced below.
    { preHandler: [authGuards.requireAnyPermission(["stock:flag", "stock:flag:decide"])] },
    async (request, reply) => {
      const query = StockAlertQuerySchema.parse(cleanQuery(request.query));
      try {
        const result = await services.stockAlerts.listStockAlerts(request.currentUser, query.branchId);
        return StockAlertListSchema.parse(result);
      } catch (err) {
        return handleDomainRouteError(err, reply);
      }
    },
  );

  // RBAC: Admin, manager, staff (stock:flag; caller must belong to alert branchId).
  app.post(
    "/stock-alerts",
    { preHandler: [authGuards.requirePermission("stock:flag")] },
    async (request, reply) => {
      const body = CreateStockAlertSchema.parse(request.body);
      try {
        const alert = await services.stockAlerts.createStockAlert(body, request.currentUser);
        return reply.code(201).send(StockAlertSchema.parse(alert));
      } catch (err) {
        return handleDomainRouteError(err, reply);
      }
    },
  );

  // RBAC: Admin and manager (stock:flag:decide; 403 for staff; branch scope enforced inside service).
  app.post(
    "/stock-alerts/:id/resolve",
    { preHandler: [authGuards.requirePermission("stock:flag:decide")] },
    async (request, reply) => {
      const { id } = PathIdSchema.parse(request.params);
      const body = ResolveStockAlertSchema.parse(request.body);
      try {
        const result = await services.stockAlerts.resolveStockAlert(id, body, request.currentUser);
        return ResolveStockAlertResponseSchema.parse(result);
      } catch (err) {
        return handleDomainRouteError(err, reply);
      }
    },
  );

  // RBAC: Admin and manager (stock:flag:decide; 403 for staff; legacy approval endpoint).
  app.patch(
    "/stock-alerts/:id/approve",
    { preHandler: [authGuards.requirePermission("stock:flag:decide")] },
    async (request, reply) => {
      return decideAlert(services.stockAlerts, request.params, "APPROVED", request.currentUser, reply);
    },
  );

  // RBAC: Admin and manager (stock:flag:decide; 403 for staff; legacy dismissal endpoint).
  app.patch(
    "/stock-alerts/:id/reject",
    { preHandler: [authGuards.requirePermission("stock:flag:decide")] },
    async (request, reply) => {
      return decideAlert(services.stockAlerts, request.params, "REJECTED", request.currentUser, reply);
    },
  );
}

async function decideAlert(
  stockAlerts: StockAlertService,
  params: unknown,
  decision: "APPROVED" | "REJECTED",
  user: Parameters<StockAlertService["decideStockAlert"]>[2],
  reply: FastifyReply,
): Promise<unknown> {
  const { id } = PathIdSchema.parse(params);
  try {
    const updated = await stockAlerts.decideStockAlert(id, decision, user);
    return StockAlertSchema.parse(updated);
  } catch (err) {
    return handleDomainRouteError(err, reply);
  }
}

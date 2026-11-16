import { CreateStockAlertSchema, ErrorBodySchema, StockAlertListSchema, StockAlertSchema } from "@stockflow/core";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { AuthContext } from "../plugins/auth.js";
import {
  DecisionForbiddenError,
  StockAlertConflictError,
  StockAlertNotFoundError,
  StockAlertValidationError,
  type StockService,
} from "../services/stockService.js";

const PathIdSchema = z.object({ id: z.string().min(1) });

export function registerStockAlertsRoutes(
  app: FastifyInstance,
  service: StockService,
  authGuards: AuthContext,
): void {
  app.get(
    "/stock-alerts",
    { preHandler: [authGuards.authenticate] },
    async (request) => {
      const result = await service.listStockAlerts(request.currentUser);
      return StockAlertListSchema.parse(result);
    },
  );

  app.post(
    "/stock-alerts",
    { preHandler: [authGuards.requirePermission("stock:flag")] },
    async (request, reply) => {
      const body = CreateStockAlertSchema.parse(request.body);
      try {
        const alert = await service.createStockAlert(body, request.currentUser);
        return reply.code(201).send(StockAlertSchema.parse(alert));
      } catch (err) {
        if (err instanceof DecisionForbiddenError) {
          return reply.code(403).send(ErrorBodySchema.parse({ error: err.message }));
        }
        if (err instanceof StockAlertValidationError) {
          return reply.code(400).send(ErrorBodySchema.parse({ error: err.message }));
        }
        throw err;
      }
    },
  );

  app.patch(
    "/stock-alerts/:id/approve",
    { preHandler: [authGuards.requirePermission("stock:flag:decide")] },
    async (request, reply) => {
      return decideAlert(service, request.params, "APPROVED", request.currentUser, reply);
    },
  );

  app.patch(
    "/stock-alerts/:id/reject",
    { preHandler: [authGuards.requirePermission("stock:flag:decide")] },
    async (request, reply) => {
      return decideAlert(service, request.params, "REJECTED", request.currentUser, reply);
    },
  );
}

async function decideAlert(
  service: StockService,
  params: unknown,
  decision: "APPROVED" | "REJECTED",
  user: Parameters<StockService["decideStockAlert"]>[2],
  reply: FastifyReply,
): Promise<unknown> {
  const { id } = PathIdSchema.parse(params);
  try {
    const updated = await service.decideStockAlert(id, decision, user);
    return StockAlertSchema.parse(updated);
  } catch (err) {
    if (err instanceof DecisionForbiddenError) {
      return reply.code(403).send(ErrorBodySchema.parse({ error: err.message }));
    }
    if (err instanceof StockAlertNotFoundError) {
      return reply.code(404).send(ErrorBodySchema.parse({ error: err.message }));
    }
    if (err instanceof StockAlertConflictError) {
      return reply.code(409).send(ErrorBodySchema.parse({ error: err.message }));
    }
    throw err;
  }
}

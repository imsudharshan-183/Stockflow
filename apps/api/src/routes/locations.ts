import {
  ErrorBodySchema,
  LocationInventoryQuerySchema,
  LocationTrendQuerySchema,
  RecommendationSchema,
} from "@stockflow/core";
import type { FastifyInstance } from "fastify";
import type { AuthContext } from "../plugins/auth.js";
import type { StockService } from "../services/stockService.js";

const pathId = RecommendationSchema.pick({ id: true });

export function registerLocationRoutes(
  app: FastifyInstance,
  service: StockService,
  authGuards: AuthContext,
): void {
  app.get(
    "/locations",
    { preHandler: [authGuards.authenticate] },
    async (request) => {
      await service.ensureFreshPlan();
      return service.listLocations(request.currentUser);
    },
  );

  app.get(
    "/locations/:id/summary",
    { preHandler: [authGuards.authenticate] },
    async (request, reply) => {
      await service.ensureFreshPlan();
      const { id } = pathId.parse(request.params);
      const summary = service.locationSummary(id, request.currentUser);
      if (!summary) {
        return reply.code(404).send(ErrorBodySchema.parse({ error: "Location not found" }));
      }
      return summary;
    },
  );

  app.get(
    "/locations/:id/inventory",
    { preHandler: [authGuards.authenticate] },
    async (request, reply) => {
      await service.ensureFreshPlan();
      const { id } = pathId.parse(request.params);
      const query = LocationInventoryQuerySchema.parse(cleanQuery(request.query));
      const inventory = service.locationInventory(id, query, request.currentUser);
      if (!inventory) {
        return reply.code(404).send(ErrorBodySchema.parse({ error: "Location not found" }));
      }
      return inventory;
    },
  );

  app.get(
    "/locations/:id/trend",
    { preHandler: [authGuards.authenticate] },
    async (request, reply) => {
      await service.ensureFreshPlan();
      const { id } = pathId.parse(request.params);
      const query = LocationTrendQuerySchema.parse(cleanQuery(request.query));
      const trend = service.locationTrend(id, query, request.currentUser);
      if (!trend) {
        return reply.code(404).send(ErrorBodySchema.parse({ error: "Location not found" }));
      }
      return trend;
    },
  );
}

function cleanQuery(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== "" && value !== undefined && value !== null) cleaned[key] = value;
  }
  return cleaned;
}

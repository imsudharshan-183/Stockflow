import {
  ErrorBodySchema,
  LocationInventoryQuerySchema,
  LocationTrendQuerySchema,
  RecommendationSchema,
} from "@stockflow/core";
import type { FastifyInstance } from "fastify";
import type { AuthContext } from "../plugins/auth.js";
import type { StockServices } from "../services/index.js";

const pathId = RecommendationSchema.pick({ id: true });

export function registerLocationRoutes(
  app: FastifyInstance,
  services: StockServices,
  authGuards: AuthContext,
): void {
  // DECISION: Location drilldown endpoints expose branch financial BD rollups (lostSalesAtRisk,
  // overstockValue, cashReleasable, netBenefit) and are gated by dashboard:financial:scoped (403 for staff).
  const requireScopedDashboard = authGuards.requirePermission("dashboard:financial:scoped");

  // RBAC: Admin and manager (dashboard:financial:scoped; 403 for staff; non-admin sees assigned branches).
  app.get(
    "/locations",
    { preHandler: [requireScopedDashboard] },
    async (request) => {
      await services.ensureFreshPlan();
      return services.catalog.listLocations(request.currentUser);
    },
  );

  // RBAC: Admin and manager (dashboard:financial:scoped; 403 for staff; 404 out of assigned branch scope).
  app.get(
    "/locations/:id/summary",
    { preHandler: [requireScopedDashboard] },
    async (request, reply) => {
      await services.ensureFreshPlan();
      const { id } = pathId.parse(request.params);
      const summary = services.catalog.locationSummary(id, request.currentUser);
      if (!summary) {
        return reply.code(404).send(ErrorBodySchema.parse({ error: "Location not found" }));
      }
      return summary;
    },
  );

  // RBAC: Admin and manager (dashboard:financial:scoped; 403 for staff; 404 out of assigned branch scope).
  app.get(
    "/locations/:id/inventory",
    { preHandler: [requireScopedDashboard] },
    async (request, reply) => {
      await services.ensureFreshPlan();
      const { id } = pathId.parse(request.params);
      const query = LocationInventoryQuerySchema.parse(cleanQuery(request.query));
      const inventory = services.catalog.locationInventory(id, query, request.currentUser);
      if (!inventory) {
        return reply.code(404).send(ErrorBodySchema.parse({ error: "Location not found" }));
      }
      return inventory;
    },
  );

  // RBAC: Admin and manager (dashboard:financial:scoped; 403 for staff; 404 out of assigned branch scope).
  app.get(
    "/locations/:id/trend",
    { preHandler: [requireScopedDashboard] },
    async (request, reply) => {
      await services.ensureFreshPlan();
      const { id } = pathId.parse(request.params);
      const query = LocationTrendQuerySchema.parse(cleanQuery(request.query));
      const trend = services.catalog.locationTrend(id, query, request.currentUser);
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

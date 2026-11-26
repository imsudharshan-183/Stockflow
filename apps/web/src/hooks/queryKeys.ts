import type { QueryClient } from "@tanstack/react-query";
import type {
  LocationInventoryQuery,
  LocationTrendQuery,
  OrderListQuery,
  RecommendationQuery,
} from "@stockflow/core";

export type LifecycleRecommendationQuery = RecommendationQuery & {
  view?: "pending" | "in_progress" | "decided";
};

export type LifecycleOrderQuery = OrderListQuery & {
  view?: "pending" | "in_progress" | "decided";
};

export const queryKeys = {
  kpis: (branch?: string) => (branch ? (["kpis", branch] as const) : (["kpis"] as const)),
  kpisLive: (branch?: string) => (branch ? (["kpisLive", branch] as const) : (["kpisLive"] as const)),
  audit: (branch?: string) => (branch ? (["audit", branch] as const) : (["audit"] as const)),
  recommendations: (query: LifecycleRecommendationQuery) => ["recommendations", query] as const,
  orders: (query?: LifecycleOrderQuery) => ["orders", query ?? {}] as const,
  order: (id: string) => ["order", id] as const,
  donorCandidates: (params: {
    sku: string;
    target: string;
    qty: number;
    includeIneligible?: boolean;
  }) => ["donorCandidates", params] as const,
  branch: (id: string) => ["branch", id] as const,
  product: (sku: string) => ["product", sku] as const,
  catalogProducts: (query?: Record<string, unknown>) => ["catalogProducts", query] as const,
  catalogProduct: (sku: string) => ["catalogProduct", sku] as const,
  locations: ["locations"] as const,
  locationSummary: (id: string) => ["locationSummary", id] as const,
  locationInventory: (id: string, query?: Partial<LocationInventoryQuery>) =>
    ["locationInventory", id, query ?? {}] as const,
  locationTrend: (id: string, query?: Partial<LocationTrendQuery>) =>
    ["locationTrend", id, query ?? {}] as const,
  salesEntries: (query?: Record<string, unknown>) => ["salesEntries", query ?? {}] as const,
  salesImports: ["salesImports"] as const,
  stockAlerts: (branchId?: string) =>
    branchId ? (["stockAlerts", branchId] as const) : (["stockAlerts"] as const),
  adminBranches: (status?: string) =>
    status ? (["adminBranches", status] as const) : (["adminBranches"] as const),
};

// Invalidate all operational query families together after any mutation so KPIs, drilldowns,
// queue tabs, alerts, and audit views never drift out of sync across physical and overlay layers.
export async function invalidateOperationalQueries(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["kpis"] }),
    queryClient.invalidateQueries({ queryKey: ["kpisLive"] }),
    queryClient.invalidateQueries({ queryKey: ["orders"] }),
    queryClient.invalidateQueries({ queryKey: ["order"] }),
    queryClient.invalidateQueries({ queryKey: ["recommendations"] }),
    queryClient.invalidateQueries({ queryKey: ["locations"] }),
    queryClient.invalidateQueries({ queryKey: ["locationSummary"] }),
    queryClient.invalidateQueries({ queryKey: ["locationInventory"] }),
    queryClient.invalidateQueries({ queryKey: ["locationTrend"] }),
    queryClient.invalidateQueries({ queryKey: ["branch"] }),
    queryClient.invalidateQueries({ queryKey: ["product"] }),
    queryClient.invalidateQueries({ queryKey: ["salesEntries"] }),
    queryClient.invalidateQueries({ queryKey: ["salesImports"] }),
    queryClient.invalidateQueries({ queryKey: ["stockAlerts"] }),
    queryClient.invalidateQueries({ queryKey: ["audit"] }),
    queryClient.invalidateQueries({ queryKey: ["catalogProducts"] }),
    queryClient.invalidateQueries({ queryKey: ["adminBranches"] }),
  ]);
}

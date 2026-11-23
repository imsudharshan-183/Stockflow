import type {
  LocationInventoryQuery,
  LocationTrendQuery,
  RecommendationQuery,
} from "@stockflow/core";

export const queryKeys = {
  kpis: (branch?: string) => (branch ? (["kpis", branch] as const) : (["kpis"] as const)),
  audit: (branch?: string) => (branch ? (["audit", branch] as const) : (["audit"] as const)),
  recommendations: (query: RecommendationQuery) => ["recommendations", query] as const,
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
  stockAlerts: (branchId?: string) =>
    branchId ? (["stockAlerts", branchId] as const) : (["stockAlerts"] as const),
  adminBranches: (status?: string) =>
    status ? (["adminBranches", status] as const) : (["adminBranches"] as const),
};

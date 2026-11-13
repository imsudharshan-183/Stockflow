import type { RecommendationQuery } from "@stockflow/core";

export const queryKeys = {
  kpis: ["kpis"] as const,
  audit: ["audit"] as const,
  recommendations: (query: RecommendationQuery) => ["recommendations", query] as const,
  branch: (id: string) => ["branch", id] as const,
  product: (sku: string) => ["product", sku] as const,
};

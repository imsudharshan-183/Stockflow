import type { KpiSummary } from "@stockflow/core";

export interface RiskChartRow {
  id: string;
  label: string;
  atRiskCount?: number;
  stockoutRate?: number;
  revenueAtRisk: number;
  href: string;
}

export type ResolvedRiskChart =
  | {
      mode: "branches";
      titleKey: "topRiskBranches";
      subtitle: string;
      rows: RiskChartRow[];
    }
  | {
      mode: "categories";
      titleKey: "atRiskByCategory";
      subtitle: string;
      rows: RiskChartRow[];
    };

/**
 * Pure selector deciding whether the Risk chart renders top 8 network/cluster locations
 * or sorted at-risk categories for a single selected store.
 */
export function resolveRiskChart(
  selectedLocation: string | null | undefined,
  report: KpiSummary,
): ResolvedRiskChart {
  if (selectedLocation) {
    const sorted = [...(report.categoryRisk ?? [])].sort(
      (left, right) =>
        right.revenueAtRisk - left.revenueAtRisk || left.category.localeCompare(right.category),
    );
    return {
      mode: "categories",
      titleKey: "atRiskByCategory",
      subtitle: "Sorted by sales at risk · click a bar to filter branch inventory",
      rows: sorted.map((cat) => ({
        id: cat.category,
        label: cat.category,
        atRiskCount: cat.atRiskCount,
        revenueAtRisk: cat.revenueAtRisk,
        href: `/branches/${selectedLocation}?cat=${encodeURIComponent(cat.category)}&status=AT_RISK`,
      })),
    };
  }

  return {
    mode: "branches",
    titleKey: "topRiskBranches",
    subtitle: "Top 8 locations · click a bar for details and branch link",
    rows: report.branchRisk.slice(0, 8).map((b) => ({
      id: b.branchId,
      label: b.branchName,
      stockoutRate: b.stockoutRate,
      revenueAtRisk: b.revenueAtRisk,
      href: `/branches/${b.branchId}`,
    })),
  };
}

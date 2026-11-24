import {
  DEFAULT_POLICY,
  MATERIAL_MIN_NET_BENEFIT,
  analyze,
  isBranchInScope,
  scopeBranches,
  type Analysis,
  type Dataset,
  type OrderOwnership,
  type Product,
  type Recommendation,
  type RecommendationStatus,
  type ReplenishmentOrder,
  type User,
} from "@stockflow/core";

export { isBranchInScope, scopeBranches };

export function isIntraClusterTransfer(
  user: User,
  targetBranchId: string,
  sourceBranchId: string | null | undefined,
): boolean {
  if (!sourceBranchId) return false;
  if (user.role === "admin") return true;
  if (user.role !== "manager") return false;
  return isBranchInScope(user, targetBranchId) && isBranchInScope(user, sourceBranchId);
}

export function isOrderInScope(
  order: Pick<ReplenishmentOrder, "type" | "targetBranchId" | "sourceBranchId">,
  user?: User,
): boolean {
  if (!user || user.role === "admin") return true;
  if (user.role === "staff") {
    return isBranchInScope(user, order.targetBranchId);
  }
  return (
    isBranchInScope(user, order.targetBranchId) ||
    (order.type === "TRANSFER" && order.sourceBranchId
      ? isBranchInScope(user, order.sourceBranchId)
      : false)
  );
}

export function buildOrderOwnership(
  order: Pick<ReplenishmentOrder, "targetBranchId" | "sourceBranchId" | "requestedBy">,
  user: User,
  opts?: {
    hasComment?: boolean;
    force?: boolean;
    targetDonorBranchId?: string | null;
  },
): OrderOwnership {
  const ownsTarget = isBranchInScope(user, order.targetBranchId);
  const ownsSource = order.sourceBranchId ? isBranchInScope(user, order.sourceBranchId) : false;
  const intraCluster = isIntraClusterTransfer(user, order.targetBranchId, order.sourceBranchId);
  const isRequester = order.requestedBy?.userId === user.id;
  return {
    ownsTarget,
    ownsSource,
    intraCluster,
    isRequester,
    hasComment: opts?.hasComment,
    force: opts?.force,
    targetDonorBranchId: opts?.targetDonorBranchId,
  };
}

export function isTransferInScope(
  user: User,
  branchId: string,
  donorBranchId: string | null | undefined,
): boolean {
  if (user.role === "admin") return true;
  return (
    isBranchInScope(user, branchId) ||
    (donorBranchId ? isBranchInScope(user, donorBranchId) : false)
  );
}

export function isRecommendationInScope(existing: Recommendation, user?: User): boolean {
  if (!user || user.role === "admin") return true;
  return isTransferInScope(user, existing.branchId, existing.donorBranchId);
}

export function isMaterialRecommendation(recommendation: Recommendation): boolean {
  return (
    recommendation.netBenefit >= MATERIAL_MIN_NET_BENEFIT &&
    recommendation.quantity >= DEFAULT_POLICY.minTransferQty
  );
}

export function applyDecisionOverlay(
  recommendation: Recommendation,
  decisions: ReadonlyMap<string, Extract<RecommendationStatus, "APPROVED" | "REJECTED">>,
): Recommendation {
  const status = decisions.get(recommendation.id);
  if (!status || status === recommendation.status) return recommendation;
  return { ...recommendation, status };
}

export function resolveScopedBranchIndex(
  data: Dataset,
  branchId: string,
  user?: User,
): number | null {
  if (user && user.role !== "admin" && !isBranchInScope(user, branchId)) {
    return null;
  }
  const idx = data.branches.findIndex((b) => b.id === branchId);
  return idx >= 0 ? idx : null;
}

export function computeActivePlan(data: Dataset): Analysis {
  const numBranches = data.branches.length;
  const numDays = data.dates.length;
  const activeIndices: number[] = [];
  const activeProducts: Product[] = [];

  for (let i = 0; i < data.products.length; i += 1) {
    const p = data.products[i]!;
    if (p.status !== "archived") {
      activeIndices.push(i);
      activeProducts.push(p);
    }
  }

  const productFilteredDataset: Dataset =
    activeProducts.length === data.products.length
      ? data
      : {
          ...data,
          products: activeProducts,
          sales: activeIndices.map(
            (i) => data.sales[i] ?? Array.from({ length: numBranches }, () => new Array(numDays).fill(0)),
          ),
          onHand: activeIndices.map(
            (i) => data.onHand[i] ?? Array.from({ length: numBranches }, () => new Array(numDays).fill(0)),
          ),
          demand: activeIndices.map(
            (i) => data.demand[i] ?? Array.from({ length: numBranches }, () => new Array(numDays).fill(0)),
          ),
        };

  const archivedBranchIndices = new Set<number>();
  const archivedBranchIds = new Set<string>();
  for (let bIdx = 0; bIdx < data.branches.length; bIdx += 1) {
    const b = data.branches[bIdx]!;
    if (b.status === "archived") {
      archivedBranchIndices.add(bIdx);
      archivedBranchIds.add(b.id);
    }
  }

  const baseAnalysis = analyze(productFilteredDataset, DEFAULT_POLICY);
  if (archivedBranchIndices.size === 0) {
    return baseAnalysis;
  }

  // Zero-mask archived branches when building active recommendations and live branch/KPI exposure so
  // archived locations neither source nor receive stock, while preserving historical trend & positions.
  const maskBranchRows = (bySku: readonly (readonly (readonly number[])[])[]): number[][][] =>
    bySku.map((byBranch) =>
      byBranch.map((series, bIdx) =>
        archivedBranchIndices.has(bIdx) ? new Array(numDays).fill(0) : [...series],
      ),
    );

  const planningDataset: Dataset = {
    ...productFilteredDataset,
    sales: maskBranchRows(productFilteredDataset.sales),
    onHand: maskBranchRows(productFilteredDataset.onHand),
    demand: maskBranchRows(productFilteredDataset.demand),
  };
  const planningAnalysis = analyze(planningDataset, DEFAULT_POLICY);

  return {
    recommendations: planningAnalysis.recommendations,
    kpis: {
      ...planningAnalysis.kpis,
      trend: baseAnalysis.kpis.trend,
      backtest: baseAnalysis.kpis.backtest,
      branches: baseAnalysis.kpis.branches.filter((b) => !archivedBranchIds.has(b.id)),
      branchRisk: baseAnalysis.kpis.branchRisk.filter((r) => !archivedBranchIds.has(r.branchId)),
      coverGrid: baseAnalysis.kpis.coverGrid.filter((c) => !archivedBranchIds.has(c.branchId)),
    },
    positions: baseAnalysis.positions,
  };
}

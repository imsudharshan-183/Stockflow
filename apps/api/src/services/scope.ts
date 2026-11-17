import {
  DEFAULT_POLICY,
  MATERIAL_MIN_NET_BENEFIT,
  analyze,
  isBranchInScope,
  scopeBranches,
  type Analysis,
  type Dataset,
  type Product,
  type Recommendation,
  type RecommendationStatus,
  type User,
} from "@stockflow/core";

export { isBranchInScope, scopeBranches };

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

  if (activeProducts.length === data.products.length) {
    return analyze(data, DEFAULT_POLICY);
  }

  const activeDataset: Dataset = {
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
  return analyze(activeDataset, DEFAULT_POLICY);
}

import {
  ZERO_DELTA,
  deltaKey,
  getCommittedDelta,
  projectPosition,
  type Action,
  type Analysis,
  type CommittedDelta,
  type CommittedDeltaStore,
  type Dataset,
  type Position,
  type ProjectedPosition,
} from "@stockflow/core";

export {
  ZERO_DELTA,
  deltaKey,
  getCommittedDelta,
  projectPosition,
  type CommittedDelta,
  type CommittedDeltaStore,
  type ProjectedPosition,
};

export interface CommittedAllocation {
  sku: string;
  branchId: string;
  donorBranchId: string | null;
  action: Action;
  quantity: number;
}

export function adjustCommittedDelta(
  committedDeltas: Map<string, CommittedDelta>,
  sku: string,
  branchId: string,
  dReserved: number,
  dInTransit: number,
  dAdjustment = 0,
): void {
  const key = deltaKey(sku, branchId);
  const current = committedDeltas.get(key) ?? ZERO_DELTA;
  const reserved = Math.max(0, current.reserved + dReserved);
  const inTransit = Math.max(0, current.inTransit + dInTransit);
  const adjustment = (current.adjustment ?? 0) + dAdjustment;
  if (reserved === 0 && inTransit === 0 && adjustment === 0) {
    committedDeltas.delete(key);
  } else if (adjustment === 0) {
    committedDeltas.set(key, { reserved, inTransit });
  } else {
    committedDeltas.set(key, { reserved, inTransit, adjustment });
  }
}

export function clearCommittedForSku(
  committedDeltas: Map<string, CommittedDelta>,
  committedRecommendationIds: Map<string, CommittedAllocation>,
  sku: string,
): void {
  const prefix = `${sku}::`;
  for (const key of committedDeltas.keys()) {
    if (key.startsWith(prefix)) committedDeltas.delete(key);
  }
  for (const [id, entry] of committedRecommendationIds.entries()) {
    if (entry.sku === sku) committedRecommendationIds.delete(id);
  }
}

export function clearAllCommittedDeltas(
  committedDeltas: Map<string, CommittedDelta>,
  committedRecommendationIds: Map<string, CommittedAllocation>,
): void {
  committedDeltas.clear();
  committedRecommendationIds.clear();
}

export function findRawPosition(
  data: Dataset,
  analysis: Analysis,
  sku: string,
  branchId: string,
): Position | undefined {
  const sIdx = data.products.findIndex((p) => p.sku === sku);
  const bIdx = data.branches.findIndex((b) => b.id === branchId);
  if (sIdx < 0 || bIdx < 0) return undefined;
  return analysis.positions[sIdx]?.[bIdx];
}

export function projectPositionFor(
  data: Dataset,
  analysis: Analysis,
  committedDeltas: ReadonlyMap<string, CommittedDelta>,
  skuIndex: number,
  branchIndex: number,
): ProjectedPosition | undefined {
  const raw = analysis.positions[skuIndex]?.[branchIndex];
  const product = data.products[skuIndex];
  const branch = data.branches[branchIndex];
  if (!raw || !product || !branch) return raw ? projectPosition(raw) : undefined;
  return projectPosition(raw, getCommittedDelta(committedDeltas, product.sku, branch.id));
}

export function projectAllPositions(
  data: Dataset,
  analysis: Analysis,
  committedDeltas: ReadonlyMap<string, CommittedDelta>,
  onlySkuIndex?: number,
): ProjectedPosition[][] {
  return analysis.positions.map((row, sIdx) => {
    if (onlySkuIndex !== undefined && sIdx !== onlySkuIndex) {
      return row.map((pos) => projectPosition(pos));
    }
    return row.map(
      (pos, bIdx) =>
        projectPositionFor(data, analysis, committedDeltas, sIdx, bIdx) ?? projectPosition(pos),
    );
  });
}

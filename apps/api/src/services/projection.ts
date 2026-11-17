import {
  DEFAULT_POLICY,
  coverDaysOf,
  type Action,
  type Analysis,
  type Dataset,
  type Position,
  type PositionStatus,
} from "@stockflow/core";

export interface CommittedDelta {
  reserved: number;
  inTransit: number;
}

export interface CommittedAllocation {
  sku: string;
  branchId: string;
  donorBranchId: string | null;
  action: Action;
  quantity: number;
}

export interface ProjectedPosition extends Position {
  reserved: number;
  inTransit: number;
}

export const ZERO_DELTA: CommittedDelta = { reserved: 0, inTransit: 0 };

/**
 * Pure projection applying committed outgoing reservations and inbound stock
 * on top of an immutable engine Position snapshot.
 *
 * DECISION: `StockRuntimeState.analysis` is treated as an immutable baseline per `dataVersion` (`ADR-001`)
 * so golden snapshots, engine math, and cross-instance plan caching stay deterministic; approvals write
 * to `actions`/`audit` and project live `reserved`/`inTransit` adjustments at read time instead.
 */
export function projectPosition(
  rawPosition: Position,
  deltas: CommittedDelta = ZERO_DELTA,
): ProjectedPosition {
  const reserved = Math.max(0, deltas.reserved);
  const inTransit = Math.max(0, deltas.inTransit);
  if (reserved === 0 && inTransit === 0) {
    return { ...rawPosition, reserved: 0, inTransit: 0 };
  }

  const onHand = Math.max(0, rawPosition.onHand - reserved);
  const surplus = Math.max(0, rawPosition.surplus - reserved);
  const effectiveStock = onHand + inTransit;
  const coverDays = coverDaysOf(effectiveStock, rawPosition.velocity);
  const onHandCoverDays = coverDaysOf(onHand, rawPosition.velocity);

  let status: PositionStatus = rawPosition.status;
  if (rawPosition.inStockDays === 0) {
    status = "NEW";
  } else {
    const overstock =
      onHandCoverDays === null ? onHand > 0 : onHandCoverDays > DEFAULT_POLICY.overstockCoverDays;
    if (overstock) {
      status = "OVERSTOCK";
    } else if (effectiveStock < rawPosition.reorderPoint) {
      status = "AT_RISK";
    } else {
      status = "HEALTHY";
    }
  }

  const need = status === "AT_RISK" ? Math.max(0, rawPosition.need - inTransit) : 0;
  const lostUnits = status === "AT_RISK" ? Math.max(0, rawPosition.lostUnits - inTransit) : 0;

  return {
    ...rawPosition,
    onHand,
    coverDays,
    status,
    surplus,
    need,
    lostUnits,
    reserved,
    inTransit,
  };
}

export function deltaKey(sku: string, branchId: string): string {
  return `${sku}::${branchId}`;
}

export function getCommittedDelta(
  committedDeltas: ReadonlyMap<string, CommittedDelta>,
  sku: string,
  branchId: string,
): CommittedDelta {
  return committedDeltas.get(deltaKey(sku, branchId)) ?? ZERO_DELTA;
}

export function adjustCommittedDelta(
  committedDeltas: Map<string, CommittedDelta>,
  sku: string,
  branchId: string,
  dReserved: number,
  dInTransit: number,
): void {
  const key = deltaKey(sku, branchId);
  const current = committedDeltas.get(key) ?? ZERO_DELTA;
  const reserved = Math.max(0, current.reserved + dReserved);
  const inTransit = Math.max(0, current.inTransit + dInTransit);
  if (reserved === 0 && inTransit === 0) {
    committedDeltas.delete(key);
  } else {
    committedDeltas.set(key, { reserved, inTransit });
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

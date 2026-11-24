import {
  BAHRAIN_BRANCHES,
  DEFAULT_POLICY,
  OrderEngineSnapshotSchema,
  haversineDistanceKm,
  rankDonorCandidates,
  round2,
  round3,
  totalTransferCostBreakdown,
  type Branch,
  type OrderEngineSnapshot,
  type OrderType,
  type ReasonCode,
} from "@stockflow/core";
import { projectPositionFor } from "./projection.js";
import type { StockRuntimeState } from "./runtimeState.js";

const BAHRAIN_COORDS_BY_ID = new Map(
  BAHRAIN_BRANCHES.filter((b) => b.coordinates).map((b) => [b.id, b.coordinates!]),
);

export function resolveBranchCoords(branch: Branch | undefined): readonly [number, number] | undefined {
  if (!branch) return undefined;
  return branch.coordinates ?? BAHRAIN_COORDS_BY_ID.get(branch.id);
}

/**
 * Shared read-only helper computing initial engine snapshot metadata for manually
 * created or alert-escalated ReplenishmentOrders. Keeps engine reasonCodes strictly
 * system-computed and identical between OrderService and StockAlertService.
 */
export function computeOrderEngineSnapshot(
  runtime: StockRuntimeState,
  input: {
    sku: string;
    productName: string;
    type: OrderType;
    targetBranch: Branch;
    sourceBranch: Branch | null;
    quantity: number;
    existingRecommendationId?: string | null;
  },
): OrderEngineSnapshot {
  const sIdx = runtime.data.products.findIndex((p) => p.sku === input.sku);
  const product = runtime.data.products[sIdx];
  const tIdx = runtime.data.branches.findIndex((b) => b.id === input.targetBranch.id);

  const targetPos =
    sIdx >= 0 && tIdx >= 0
      ? projectPositionFor(runtime.data, runtime.analysis, runtime.committedDeltas, sIdx, tIdx)
      : undefined;

  const reasonCodes: ReasonCode[] = [];
  let distanceKm: number | null = null;
  let freightCostBhd = 0;
  let netBenefitBhd = 0;
  let reason = `${input.type} of ${input.quantity} units for ${input.productName} at ${input.targetBranch.name}.`;

  if (input.type === "TRANSFER" && input.sourceBranch && product) {
    const candidates = rankDonorCandidates(
      runtime.data,
      runtime.committedDeltas,
      input.sku,
      input.targetBranch.id,
      input.quantity,
      { includeIneligible: true, limit: runtime.data.branches.length },
    );
    const match = candidates.find((c) => c.branchId === input.sourceBranch!.id);
    if (match) {
      distanceKm = match.distanceKm;
      freightCostBhd = match.freightCostBhd;
      netBenefitBhd = match.netBenefitBhd;
    } else {
      const dc = resolveBranchCoords(input.sourceBranch);
      const tc = resolveBranchCoords(input.targetBranch);
      distanceKm = dc && tc ? round2(haversineDistanceKm(dc, tc)) : 0;
      freightCostBhd = totalTransferCostBreakdown(input.quantity, distanceKm, DEFAULT_POLICY).totalCost;
    }
    if ((targetPos?.status ?? "AT_RISK") === "AT_RISK") reasonCodes.push("BELOW_REORDER_POINT");
    reasonCodes.push("RECEIVER_BELOW_TARGET", "DONOR_SURPLUS");
    if (input.quantity >= DEFAULT_POLICY.minTransferQty) reasonCodes.push("MIN_TRANSFER_MET");
    reason = `Transfer ${input.quantity} units of ${input.productName} from ${input.sourceBranch.name} to ${input.targetBranch.name} (${distanceKm.toFixed(1)} km, freight BD ${freightCostBhd.toFixed(3)}).`;
  } else if (input.type === "TRANSFER" && !input.sourceBranch && product) {
    const targetLostUnits = targetPos?.lostUnits ?? 0;
    netBenefitBhd = round3(Math.min(input.quantity, targetLostUnits) * (product.price - product.cost));
    if ((targetPos?.status ?? "AT_RISK") === "AT_RISK") reasonCodes.push("BELOW_REORDER_POINT");
    reasonCodes.push("RECEIVER_BELOW_TARGET");
    reason = `Open transfer request for ${input.quantity} units of ${input.productName} at ${input.targetBranch.name} awaiting donor selection.`;
  } else if (input.type === "REORDER" && product) {
    const targetLostUnits = targetPos?.lostUnits ?? 0;
    netBenefitBhd = round3(Math.min(input.quantity, targetLostUnits) * (product.price - product.cost));
    reasonCodes.push("BELOW_REORDER_POINT", "REORDER_TO_TARGET", "NO_DONOR");
    reason = `Reorder ${input.quantity} units of ${input.productName} for ${input.targetBranch.name}.`;
  } else {
    reasonCodes.push("OVERSTOCK_COVER", "MARKDOWN_CLEARANCE");
    reason = `Markdown ${input.quantity} surplus units of ${input.productName} at ${input.targetBranch.name}.`;
  }

  return OrderEngineSnapshotSchema.parse({
    recommendationId: input.existingRecommendationId ?? null,
    netBenefitBhd,
    reasonCodes,
    reason,
    distanceKm,
    freightCostBhd,
  });
}

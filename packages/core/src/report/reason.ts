import type { Action, ReasonCode } from "../schemas/index.js";
import { round2, round3 } from "../round.js";

export interface ReasonInput {
  action: Action;
  quantity: number;
  productName: string;
  branchName: string;
  donorBranchName: string | null;
  coverDays: number | null;
  reorderPoint: number;
  netBenefit: number;
  lostMarginAvoided: number;
  carryingCostSaved: number;
  transferCost: number;
  distanceKm?: number | null;
  fixedTransferCost?: number;
  distanceTransferCost?: number;
  unitTransferCost?: number;
  markdownCost: number;
  reasonCodes: readonly ReasonCode[];
}

function bhd(value: number): string {
  const rounded = round3(value);
  const sign = rounded < 0 ? "-" : "";
  return `${sign}BD ${Math.abs(rounded).toFixed(3)}`;
}

function coverText(coverDays: number | null): string {
  if (coverDays === null) return "no recorded demand, so cover is treated as unlimited";
  return `${round2(coverDays).toFixed(2)} days of cover`;
}

/** Buyers read this paragraph instead of the formula sheet. */
export function describeRecommendation(input: ReasonInput): string {
  const cover = coverText(input.coverDays);
  const point = round2(input.reorderPoint).toFixed(2);
  const benefit = `Net benefit ${bhd(input.netBenefit)}`;

  if (input.action === "TRANSFER") {
    const donor = input.donorBranchName ?? "the donor branch";
    const hasDist = input.distanceKm !== null && input.distanceKm !== undefined && input.distanceKm > 0;
    const distLabel = hasDist ? ` (${input.distanceKm!.toFixed(1)} km)` : "";
    const hasBreakdown = input.fixedTransferCost !== undefined;
    const freightBreakdown = hasBreakdown
      ? ` (${bhd(input.fixedTransferCost!)} fixed + ${bhd(input.distanceTransferCost ?? 0)} distance + ${bhd(input.unitTransferCost ?? 0)} handling)`
      : "";
    const freight = input.reasonCodes.includes("FREIGHT_LIMITS_QTY")
      ? " The quantity stops where another unit would cost more to move than it saves."
      : "";
    return `Transfer ${input.quantity} units of ${input.productName} from ${donor} to ${input.branchName}${distLabel}. ${input.branchName} has ${cover}, below its reorder point of ${point} units. ${benefit}: lost margin avoided ${bhd(input.lostMarginAvoided)}, carrying cost saved ${bhd(input.carryingCostSaved)}, freight cost ${bhd(input.transferCost)}${freightBreakdown}.${freight}`;
  }

  if (input.action === "REORDER") {
    return `Reorder ${input.quantity} units of ${input.productName} for ${input.branchName}. The branch has ${cover}, below its reorder point of ${point} units, and no surplus transfer covers the gap. ${benefit}, from lost margin avoided ${bhd(input.lostMarginAvoided)}.`;
  }

  return `Mark down ${input.quantity} units of ${input.productName} at ${input.branchName}. The branch has ${cover}, past the overstock line, and no branch is short of this SKU. ${benefit}: carrying cost saved ${bhd(input.carryingCostSaved)}, markdown margin given up ${bhd(input.markdownCost)}.`;
}

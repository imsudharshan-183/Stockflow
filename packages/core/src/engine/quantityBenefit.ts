/**
 * Live action-economics recomputation for manager-edited approval quantities.
 * Inputs: action type (TRANSFER/REORDER/MARKDOWN), quantity, unitPrice/unitCost (BD), distanceKm, lostUnits, cover/velocity stats.
 * Outputs: ActionQuantityBenefitResult { netBenefitBhd, lostMarginAvoided, carryingCostSaved, freightCostBhd, markdownCost } (all BD).
 * Formula: exact same formulas as match.ts (TRANSFER) and recommend.ts (REORDER, MARKDOWN), using TotalTransferCost(Q, D).
 * Units: money in BD (round3), distance in km, velocity in units/day, cover in days, quantity in whole units.
 * Where used: apps/api OrderService (commit), apps/api orderSnapshot, apps/web ApproveQuantityDialog.
 */
import type { Action, Policy } from "../schemas/index.js";
import { round3 } from "../round.js";
import { holdingWindowDays } from "./classify.js";
import { DEFAULT_POLICY, totalTransferCostBreakdown } from "./config.js";

export interface ActionQuantityBenefitInput {
  type: Action;
  quantity: number;
  unitPrice: number;
  unitCost: number;
  distanceKm?: number | null;
  targetLostUnits?: number;
  targetCoverDays?: number | null;
  targetVelocity?: number;
  donorCoverDays?: number | null;
  donorVelocity?: number;
  policy?: Partial<Policy>;
}

export interface ActionQuantityBenefitResult {
  netBenefitBhd: number;
  lostMarginAvoided: number;
  carryingCostSaved: number;
  freightCostBhd: number;
  markdownCost: number;
}

/**
 * Recomputes BD net benefit and cost components for an edited approval quantity without modifying the engine plan.
 * Formula: TRANSFER = lostMargin + carryingSaved - TotalTransferCost(Q, D); REORDER = min(Q, lostUnits) * margin; MARKDOWN = clearance delta + carryingSaved.
 * Example: TRANSFER Q = 12, D = 10 km, price BD 22, cost BD 10 -> freight BD 6.000 + netBenefitBhd recomputed at Q = 12.
 */
export function computeActionBenefitForQuantity(
  input: ActionQuantityBenefitInput,
): ActionQuantityBenefitResult {
  const policy: Policy = input.policy
    ? { ...DEFAULT_POLICY, ...input.policy }
    : DEFAULT_POLICY;
  const quantity = Math.max(0, Math.floor(Number.isFinite(input.quantity) ? input.quantity : 0));
  const unitPrice = Number.isFinite(input.unitPrice) ? Math.max(0, input.unitPrice) : 0;
  const unitCost = Number.isFinite(input.unitCost) ? Math.max(0, input.unitCost) : 0;
  const margin = unitPrice - unitCost;
  const targetLostUnits =
    input.targetLostUnits !== undefined && Number.isFinite(input.targetLostUnits)
      ? Math.max(0, input.targetLostUnits)
      : 0;

  if (quantity <= 0) {
    return {
      netBenefitBhd: 0,
      lostMarginAvoided: 0,
      carryingCostSaved: 0,
      freightCostBhd: 0,
      markdownCost: 0,
    };
  }

  if (input.type === "TRANSFER") {
    const donorVelocity =
      input.donorVelocity !== undefined && Number.isFinite(input.donorVelocity)
        ? Math.max(0, input.donorVelocity)
        : 0;
    const excessDays =
      input.donorCoverDays !== undefined && input.donorCoverDays !== null
        ? holdingWindowDays(input.donorCoverDays, donorVelocity, policy)
        : 0;
    const carryPerUnit =
      unitCost * policy.annualHoldingRate * (excessDays / policy.deadStockHoldDays);
    const distanceKm =
      input.distanceKm !== undefined && input.distanceKm !== null && Number.isFinite(input.distanceKm)
        ? Math.max(0, input.distanceKm)
        : 0;
    const freight = totalTransferCostBreakdown(quantity, distanceKm, policy);
    const lostMarginAvoided = round3(Math.min(quantity, targetLostUnits) * margin);
    const carryingCostSaved = round3(quantity * carryPerUnit);
    const freightCostBhd = freight.totalCost;
    const netBenefitBhd = round3(lostMarginAvoided + carryingCostSaved - freightCostBhd);
    return {
      netBenefitBhd,
      lostMarginAvoided,
      carryingCostSaved,
      freightCostBhd,
      markdownCost: 0,
    };
  }

  if (input.type === "REORDER") {
    const lostMarginAvoided = round3(Math.min(quantity, targetLostUnits) * margin);
    return {
      netBenefitBhd: lostMarginAvoided,
      lostMarginAvoided,
      carryingCostSaved: 0,
      freightCostBhd: 0,
      markdownCost: 0,
    };
  }

  const targetVelocity =
    input.targetVelocity !== undefined && Number.isFinite(input.targetVelocity)
      ? Math.max(0, input.targetVelocity)
      : 0;
  const hold = holdingWindowDays(input.targetCoverDays ?? null, targetVelocity, policy);
  const sellPrice = unitPrice * (1 - policy.markdownDiscount);
  const fullPriceUnits = Math.min(quantity, targetVelocity * hold);
  const versusWaiting =
    quantity * (sellPrice - unitCost) - fullPriceUnits * (unitPrice - unitCost);
  const carryingCostSaved = round3(
    quantity * unitCost * policy.annualHoldingRate * (hold / policy.deadStockHoldDays),
  );
  const lostMarginAvoided = versusWaiting > 0 ? round3(versusWaiting) : 0;
  const markdownCost = versusWaiting < 0 ? round3(-versusWaiting) : 0;
  const netBenefitBhd = round3(lostMarginAvoided + carryingCostSaved - markdownCost);
  return {
    netBenefitBhd,
    lostMarginAvoided,
    carryingCostSaved,
    freightCostBhd: 0,
    markdownCost,
  };
}

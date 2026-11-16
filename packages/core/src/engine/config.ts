/**
 * Tunable defaults. Change these, not the formulas.
 * ASSUMPTION: lead time is per product, transfer cost is TotalTransferCost(Q, D) = C_fixed + (C_km * D) + (C_unit * Q)
 * calibrated in BHD to Bahrain's 2-45 km island network (BD 1.500 fixed + BD 0.150/km + BD 0.250/unit),
 * holding is 20% a year, markdown is 30% off, z = 1.65.
 */
import type { Policy } from "../schemas/index.js";
import { round3 } from "../round.js";

export const EWMA_SPAN_DAYS = 28;
export const SERVICE_Z = 1.65;
export const OVERSTOCK_COVER_DAYS = 60;
export const RECEIVER_COVER_DAYS = 14;
export const DONOR_COVER_DAYS = 30;
export const MIN_TRANSFER_QTY = 5;
export const TRANSFER_FIXED_COST = 1.5;
export const TRANSFER_COST_PER_KM = 0.15;
export const TRANSFER_COST_PER_UNIT = 0.25;
export const ANNUAL_HOLDING_RATE = 0.2;
export const MARKDOWN_DISCOUNT = 0.3;
export const DEAD_STOCK_HOLD_DAYS = 365;
export const BACKTEST_DAYS = 45;
export const EWMA_SMOOTHING_NUMERATOR = 2;
export const SAMPLE_STDEV_MIN_POINTS = 2;
export const DEAD_VELOCITY_PER_DAY = 1 / 7;
export const STOCKOUT_RATE_DAYS = EWMA_SPAN_DAYS;
/** Actions below this net benefit (BD 9.500, scaled from $25 USD ÷ ~2.65) stay in the engine output and are hidden by the service. */
export const MATERIAL_MIN_NET_BENEFIT = 9.5;
export const MIN_ACTION_UNITS = 1;

export const DEFAULT_POLICY: Policy = {
  ewmaSpanDays: EWMA_SPAN_DAYS,
  serviceZ: SERVICE_Z,
  overstockCoverDays: OVERSTOCK_COVER_DAYS,
  receiverCoverDays: RECEIVER_COVER_DAYS,
  donorCoverDays: DONOR_COVER_DAYS,
  minTransferQty: MIN_TRANSFER_QTY,
  transferFixedCost: TRANSFER_FIXED_COST,
  transferCostPerKm: TRANSFER_COST_PER_KM,
  transferCostPerUnit: TRANSFER_COST_PER_UNIT,
  annualHoldingRate: ANNUAL_HOLDING_RATE,
  markdownDiscount: MARKDOWN_DISCOUNT,
  deadStockHoldDays: DEAD_STOCK_HOLD_DAYS,
  backtestDays: BACKTEST_DAYS,
};

export interface TransferCostBreakdown {
  fixedCost: number;
  distanceCost: number;
  unitCost: number;
  totalCost: number;
}

export function totalTransferCostBreakdown(
  quantity: number,
  distanceKm: number,
  policy: Pick<Policy, "transferFixedCost" | "transferCostPerKm" | "transferCostPerUnit">,
): TransferCostBreakdown {
  const fixedCost = round3(Math.max(0, policy.transferFixedCost));
  const distanceCost = round3(Math.max(0, policy.transferCostPerKm) * Math.max(0, distanceKm));
  const unitCost = round3(Math.max(0, policy.transferCostPerUnit) * Math.max(0, quantity));
  const totalCost = round3(fixedCost + distanceCost + unitCost);
  return { fixedCost, distanceCost, unitCost, totalCost };
}

export function totalTransferCost(
  quantity: number,
  distanceKm: number,
  policy: Pick<Policy, "transferFixedCost" | "transferCostPerKm" | "transferCostPerUnit">,
): number {
  return totalTransferCostBreakdown(quantity, distanceKm, policy).totalCost;
}

export function ewmaAlpha(spanDays: number): number {
  if (spanDays <= 0) throw new Error("ewmaSpanDays must be positive");
  return EWMA_SMOOTHING_NUMERATOR / (spanDays + 1);
}

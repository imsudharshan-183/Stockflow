/**
 * Tunable policy defaults and freight cost primitives for the StockFlow engine.
 * Inputs: policy weights (days, z-score, BHD rates) and transfer quantity Q with route distance D (km).
 * Outputs: DEFAULT_POLICY, scalar defaults, ewmaAlpha, and BHD transfer cost totals/breakdowns.
 * Formula: alpha = 2 / (ewmaSpanDays + 1); TotalTransferCost(Q, D) = C_fixed + (C_km * D) + (C_unit * Q).
 * Units: money in BD (BHD, 3 decimals = fils), time in days, distance in km, rates dimensionless/annual.
 * Where used: imported by velocity, classify, match, recommend, projection, donorRanking, quantityBenefit, and apps/api services.
 */
import type { Policy } from "../schemas/index.js";
import { round3 } from "../round.js";

// ASSUMPTION: EWMA span in days (28 days -> alpha = 2/29 ~ 0.069); long enough to smooth weekend noise while reacting within weeks; rejected 7-day SMA (too volatile) and 90-day window (too sluggish).
export const EWMA_SPAN_DAYS = 28;
// ASSUMPTION: Standard-normal quantile z = 1.65 (dimensionless); targets ~95% one-sided cycle service level (~5% stockout probability) without tying up working capital at z >= 2.33 (99%).
export const SERVICE_Z = 1.65;
// ASSUMPTION: Overstock threshold in days of cover (60 days); flags positions holding > 2 months of demand for outbound transfer or markdown; rejected 30 days (triggers false moves on normal lead-time cycles).
export const OVERSTOCK_COVER_DAYS = 60;
// ASSUMPTION: Target cover in days for AT_RISK receiving branches (14 days); balances two-week store shelf replenishment against finite donor pool; rejected 30 days (starves multiple short stores).
export const RECEIVER_COVER_DAYS = 14;
// ASSUMPTION: Minimum post-transfer cover in days retained at a donor branch (30 days plus safety stock); protects donor availability so resolving one stockout never seeds another.
export const DONOR_COVER_DAYS = 30;
// ASSUMPTION: Minimum viable inter-branch transfer lot size in units (5 units); spreads BD 1.500 dispatch + distance overhead over enough items; rejected 1 unit (fixed freight erodes net benefit).
export const MIN_TRANSFER_QTY = 5;
// ASSUMPTION: Fixed dispatch overhead per inter-branch transfer in BD (BD 1.500); covers picking, paperwork, and van dispatch loading across Bahrain routes regardless of distance or qty.
export const TRANSFER_FIXED_COST = 1.5;
// ASSUMPTION: Distance-based transport rate in BD/km (BD 0.150/km); weights short intra-city hops above cross-island trips across Bahrain's 2-45 km network (rejected flat fee which erased proximity).
export const TRANSFER_COST_PER_KM = 0.15;
// ASSUMPTION: Per-unit handling cost in BD/unit (BD 0.250/unit); prices marginal packing/shelving work per piece and determines whether extra over-lead-time units beat 20% annual carrying cost.
export const TRANSFER_COST_PER_UNIT = 0.25;
// ASSUMPTION: Annual capital + storage carrying rate as a fraction of unit cost (0.20 = 20%/year); standard retail cost of tied-up cash, shrinkage, and shelf space.
export const ANNUAL_HOLDING_RATE = 0.2;
// ASSUMPTION: Markdown price discount fraction (0.30 = 30% off shelf price); large enough to clear dead/overstock lots without pricing below typical 55-75% wholesale cost floors.
export const MARKDOWN_DISCOUNT = 0.3;
// ASSUMPTION: Maximum holding-cost horizon in days (365 days = 1 year); caps dead-stock / unlimited-cover holding savings so slow SKUs do not claim infinite multi-year carrying benefit.
export const DEAD_STOCK_HOLD_DAYS = 365;
// ASSUMPTION: Counterfactual replay window in days (45 days); long enough to cross multiple 1-21 day supplier lead times while remaining inside the 120-day synthetic history.
export const BACKTEST_DAYS = 45;
// ASSUMPTION: Standard EWMA smoothing numerator (2, dimensionless) for alpha = 2 / (span + 1); aligns with textbook N-day exponential moving average equivalence.
export const EWMA_SMOOTHING_NUMERATOR = 2;
// ASSUMPTION: Minimum in-stock day count (2 days) required to compute unbiased sample stdev (n - 1 denominator); prevents division by zero on single-day observations.
export const SAMPLE_STDEV_MIN_POINTS = 2;
// ASSUMPTION: Slow-mover velocity cutoff in units/day (1/7 ~ 0.1429 units/day, under 1 unit/week); separates true dead-stock overstock from moderately slow items in KPI reporting.
export const DEAD_VELOCITY_PER_DAY = 1 / 7;
// ASSUMPTION: Rolling KPI stockout-rate window in days (28 days, aliases EWMA_SPAN_DAYS); matches the demand smoothing horizon so overview metrics and velocity react together.
export const STOCKOUT_RATE_DAYS = EWMA_SPAN_DAYS;
// ASSUMPTION: Service-layer materiality threshold in BD (BD 9.500 net benefit, scaled from $25 USD / ~2.65); suppresses sub-BD-9.500 noise in UI queues without shifting frozen core quantities.
export const MATERIAL_MIN_NET_BENEFIT = 9.5;
// ASSUMPTION: Minimum unit floor in units (1 unit) for non-transfer actions (REORDER and MARKDOWN); unlike transfers, store reorders and shelf markdowns do not pay fixed dispatch overhead.
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

/**
 * Splits transfer freight into fixed, distance, and per-unit BD components rounded to fils (3 decimals).
 * Formula: fixedCost = C_fixed, distanceCost = C_km * D_km, unitCost = C_unit * Q, totalCost = fixed + distance + unit (all BD).
 * Example: Q = 20 units, D = 10 km with DEFAULT_POLICY -> fixed BD 1.500 + distance BD 1.500 + unit BD 5.000 = BD 8.000.
 */
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

/**
 * Computes total inter-branch transfer freight cost in BD.
 * Formula: TotalTransferCost(Q, D) = round3(C_fixed + C_km * D_km + C_unit * Q).
 * Example: totalTransferCost(60, 0, DEFAULT_POLICY) = 1.500 + 0 + 15.000 = BD 16.500.
 */
export function totalTransferCost(
  quantity: number,
  distanceKm: number,
  policy: Pick<Policy, "transferFixedCost" | "transferCostPerKm" | "transferCostPerUnit">,
): number {
  return totalTransferCostBreakdown(quantity, distanceKm, policy).totalCost;
}

/**
 * Converts EWMA span in days to the smoothing weight alpha.
 * Formula: alpha = 2 / (spanDays + 1).
 * Example: ewmaAlpha(28) = 2 / 29 ~ 0.068966.
 */
export function ewmaAlpha(spanDays: number): number {
  if (spanDays <= 0) throw new Error("ewmaSpanDays must be positive");
  return EWMA_SMOOTHING_NUMERATOR / (spanDays + 1);
}

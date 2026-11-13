/**
 * Tunable defaults. Change these, not the formulas.
 * ASSUMPTION: lead time is per product, transfer cost is a flat $12, holding is 20% a year, markdown is 30% off, z = 1.65.
 */
import type { Policy } from "../schemas/index.js";

export const EWMA_SPAN_DAYS = 28;
export const SERVICE_Z = 1.65;
export const OVERSTOCK_COVER_DAYS = 60;
export const RECEIVER_COVER_DAYS = 14;
export const DONOR_COVER_DAYS = 30;
export const MIN_TRANSFER_QTY = 5;
export const TRANSFER_COST_PER_UNIT = 12;
export const ANNUAL_HOLDING_RATE = 0.2;
export const MARKDOWN_DISCOUNT = 0.3;
export const DEAD_STOCK_HOLD_DAYS = 365;
export const BACKTEST_DAYS = 45;
export const EWMA_SMOOTHING_NUMERATOR = 2;
export const SAMPLE_STDEV_MIN_POINTS = 2;
export const DEAD_VELOCITY_PER_DAY = 1 / 7;
export const STOCKOUT_RATE_DAYS = EWMA_SPAN_DAYS;
/** Actions below this net benefit stay in the engine output and are hidden by the service. */
export const MATERIAL_MIN_NET_BENEFIT = 25;
export const MIN_ACTION_UNITS = 1;

export const DEFAULT_POLICY: Policy = {
  ewmaSpanDays: EWMA_SPAN_DAYS,
  serviceZ: SERVICE_Z,
  overstockCoverDays: OVERSTOCK_COVER_DAYS,
  receiverCoverDays: RECEIVER_COVER_DAYS,
  donorCoverDays: DONOR_COVER_DAYS,
  minTransferQty: MIN_TRANSFER_QTY,
  transferCostPerUnit: TRANSFER_COST_PER_UNIT,
  annualHoldingRate: ANNUAL_HOLDING_RATE,
  markdownDiscount: MARKDOWN_DISCOUNT,
  deadStockHoldDays: DEAD_STOCK_HOLD_DAYS,
  backtestDays: BACKTEST_DAYS,
};

export function ewmaAlpha(spanDays: number): number {
  if (spanDays <= 0) throw new Error("ewmaSpanDays must be positive");
  return EWMA_SMOOTHING_NUMERATOR / (spanDays + 1);
}

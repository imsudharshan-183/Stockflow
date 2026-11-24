/**
 * Demand rate and dispersion estimator from in-stock sales history.
 * Inputs: daily sales series (units/day) and end-of-day on-hand series (units) plus smoothing alpha, leadTimeDays, and serviceZ.
 * Outputs: velocity (units/day), sigma (units/day), inStockDays (days), safetyStock (units), and reorderPoint (units).
 * Formula: EWMA_t = alpha * s_t + (1 - alpha) * EWMA_(t-1) over in-stock days (endOnHand + sales > 0); sample sigma with (n - 1).
 * Units: units/day for velocity and sigma; days for counts/lead time; units for stock thresholds. No currency (BD) math here.
 * Where used: classify.ts (assessNetwork), report/kpis.ts (isStockoutDay), and backtest.ts.
 */
import { SAMPLE_STDEV_MIN_POINTS } from "./config.js";
import { safetyStockUnits, reorderPointUnits } from "./safetyStock.js";
import type { DemandEstimate, DemandHistory, ForecastContext, Forecaster } from "./strategies.js";

/**
 * Exponentially weighted moving average initialized at values[0].
 * Formula: L_0 = v_0; L_i = alpha * v_i + (1 - alpha) * L_(i-1). Empty array returns 0.
 * Example: ewma([2, 6], 0.5) = 0.5 * 6 + 0.5 * 2 = 4 units/day.
 */
export function ewma(values: readonly number[], alpha: number): number {
  const first = values[0];
  if (first === undefined) return 0;
  let level = first;
  for (let i = 1; i < values.length; i += 1) {
    const point = values[i];
    if (point === undefined) continue;
    level = alpha * point + (1 - alpha) * level;
  }
  return level;
}

/**
 * Unbiased sample standard deviation across observed in-stock daily sales.
 * Formula: sqrt(sum((v - mean)^2) / (n - 1)) when n >= 2; 0 when n < 2.
 * Example: sampleStdev([1, 3]) = sqrt((1 + 1) / 1) = 1.4142 units/day.
 */
export function sampleStdev(values: readonly number[]): number {
  const n = values.length;
  if (n < SAMPLE_STDEV_MIN_POINTS) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  const mean = sum / n;
  let squareSum = 0;
  for (const value of values) {
    const delta = value - mean;
    squareSum += delta * delta;
  }
  return Math.sqrt(squareSum / (n - 1));
}

/**
 * Reports whether stock existed at any point during the business day.
 * Formula: endOnHand + salesUnits > 0.
 * Example: wasInStock(0, 0) = false (zero available all day); wasInStock(0, 4) = true (sold 4 before selling out).
 */
// IMPORTANT: a stockout day (0 end on hand and 0 sold) had nothing available to sell, so excluding it prevents zeros from biasing velocity and sigma downward.
export function wasInStock(endOnHand: number, salesUnits: number): boolean {
  return endOnHand + salesUnits > 0;
}

/**
 * Detects an unfulfilled-demand stockout day for historical KPIs and counterfactual backtest replay.
 * Formula: demand > 0 && available <= 0.
 * Example: isStockoutDay(0, 5) = true; isStockoutDay(3, 5) = false (had stock at open).
 */
export function isStockoutDay(available: number, demand: number): boolean {
  return demand > 0 && available <= 0;
}

// SCALE: each branch-SKU series is independent, so 100x SKUs is 100x of this loop and can be sharded cleanly across workers by SKU.
// DECISION: 28-day EWMA (alpha = 2/29) over ML/SARIMA because 120 days is too short to train reliably and buyers can audit a single recency weight; rejected uniform SMA (over-weights stale 90-day demand).
export const ewmaForecaster: Forecaster = {
  estimateDemand(history: DemandHistory, ctx: ForecastContext): DemandEstimate {
    const observed: number[] = [];
    const days = Math.min(history.sales.length, history.onHand.length);
    for (let day = 0; day < days; day += 1) {
      const endOnHand = history.onHand[day] ?? 0;
      const sold = history.sales[day] ?? 0;
      if (wasInStock(endOnHand, sold)) observed.push(sold);
    }
    const velocity = ewma(observed, ctx.alpha);
    const sigma = sampleStdev(observed);
    const safetyStock = safetyStockUnits(sigma, ctx.leadTimeDays, ctx.serviceZ);
    return {
      velocity,
      sigma,
      inStockDays: observed.length,
      safetyStock,
      reorderPoint: reorderPointUnits(velocity, ctx.leadTimeDays, safetyStock),
    };
  },
};

/**
 * Demand rate from in-stock history.
 * Inputs: daily sales and end-of-day on hand. Output: velocity, sigma, safety stock, reorder point.
 * Formula: EWMA of in-stock sales, sample sigma, safety = z * sigma * sqrt(lead).
 */
import { SAMPLE_STDEV_MIN_POINTS } from "./config.js";
import { safetyStockUnits, reorderPointUnits } from "./safetyStock.js";
import type { DemandEstimate, DemandHistory, ForecastContext, Forecaster } from "./strategies.js";

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

// IMPORTANT: a stockout day has nothing available to sell, so it must not pull velocity or sigma down.
export function wasInStock(endOnHand: number, salesUnits: number): boolean {
  return endOnHand + salesUnits > 0;
}

export function isStockoutDay(available: number, demand: number): boolean {
  return demand > 0 && available <= 0;
}

// SCALE: each series is independent, so 100x SKUs is 100x of this loop and can be sharded per SKU.
// DECISION: EWMA over a learned model because 120 days is too short to train, and the weight is inspectable.
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

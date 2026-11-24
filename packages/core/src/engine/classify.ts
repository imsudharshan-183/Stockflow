/**
 * Converts demand forecasts and stock counts into branch-SKU position classifications, surpluses, and needs.
 * Inputs: Dataset (sales, onHand, products, branches), Policy cover thresholds, Forecaster, dayIndex, optional onHandOverride.
 * Outputs: Position[][] matrix [skuIndex][branchIndex] with status (NEW/OVERSTOCK/AT_RISK/HEALTHY), coverDays, surplus, need, lostUnits.
 * Formula: cover = onHand / velocity (null if v <= 0 & onHand > 0); floor = donorCoverDays * v + safetyStock; target = receiverCoverDays * v.
 * Units: units, days, units/day (no BD conversion at this stage).
 * Where used: recommend.ts, report/kpis.ts, index.ts (assessPositions), donorRanking.ts, projection.ts, quantityBenefit.ts.
 */
import type { Dataset } from "../seed/types.js";
import type { Policy, PositionStatus } from "../schemas/index.js";
import { at } from "../round.js";
import { ewmaAlpha } from "./config.js";
import type { Forecaster } from "./strategies.js";

export interface Position {
  skuIndex: number;
  branchIndex: number;
  onHand: number;
  velocity: number;
  sigma: number;
  inStockDays: number;
  safetyStock: number;
  reorderPoint: number;
  coverDays: number | null;
  status: PositionStatus;
  surplus: number;
  need: number;
  lostUnits: number;
  leadTimeDays: number;
}

/**
 * Capped excess cover duration in days used for holding-cost savings and markdown hold comparison.
 * Formula: min(deadStockHoldDays, max(0, coverDays - donorCoverDays)), defaulting to deadStockHoldDays (365) when velocity <= 0 or coverDays is null.
 * Example: coverDays = 150, velocity = 2, DEFAULT_POLICY -> min(365, 150 - 30) = 120 days; null cover -> 365 days.
 */
// DECISION: cap holding window at deadStockHoldDays (365) so zero-velocity dead stock claims at most 1 year of carrying relief rather than unbounded savings.
export function holdingWindowDays(coverDays: number | null, velocity: number, policy: Policy): number {
  if (coverDays === null || velocity <= 0) return policy.deadStockHoldDays;
  return Math.min(policy.deadStockHoldDays, Math.max(0, coverDays - policy.donorCoverDays));
}

/**
 * Days of demand covered by current on-hand inventory.
 * Formula: onHand / velocity when velocity > 0; null (unlimited cover) when velocity <= 0 and onHand > 0; 0 when both are 0.
 * Example: coverDaysOf(10, 5) = 2 days; coverDaysOf(15, 0) = null (dead stock, not divide-by-zero).
 */
// IMPORTANT: zero velocity with stock on hand is unlimited cover (null), not a divide-by-zero and not a stockout.
export function coverDaysOf(onHand: number, velocity: number): number | null {
  if (velocity <= 0) return onHand > 0 ? null : 0;
  return onHand / velocity;
}

/**
 * Precedence classifier assigning exactly one status to each branch-SKU position.
 * Formula: inStockDays === 0 -> NEW; cover > overstockCoverDays (or unlimited cover with stock > 0) -> OVERSTOCK; onHand < reorderPoint -> AT_RISK; else HEALTHY.
 * Example: onHand = 10, cover = 2, rop = 35, inStockDays = 20 -> AT_RISK; cover = null, onHand = 5, inStockDays = 20 -> OVERSTOCK.
 */
// DECISION: precedence NEW -> OVERSTOCK -> AT_RISK -> HEALTHY ensures zero-velocity high-sigma items never flip into AT_RISK while sitting on dead stock, and prevents shipping into an overstocked pile.
// ASSUMPTION: 60 / 30 / 14 day cover thresholds are buyer policy bounds rather than parameters fitted per category.
export function classifyPosition(
  onHand: number,
  coverDays: number | null,
  reorderPoint: number,
  inStockDays: number,
  policy: Policy,
): PositionStatus {
  if (inStockDays === 0) return "NEW";
  const overstock = coverDays === null ? onHand > 0 : coverDays > policy.overstockCoverDays;
  if (overstock) return "OVERSTOCK";
  if (onHand < reorderPoint) return "AT_RISK";
  return "HEALTHY";
}

/**
 * Assesses all SKU x branch positions up to dayIndex using the pluggable Forecaster strategy.
 * Formula: surplus = floor(max(0, onHand - (donorCoverDays * v + safetyStock))); need = ceil(max(0, receiverCoverDays * v - onHand)); lostUnits = max(0, v * leadTimeDays - onHand).
 * Example: v = 2, onHand = 300, floor = 30 * 2 + 0 = 60 -> surplus = 240; v = 5, onHand = 10, target = 14 * 5 = 70 -> need = 60.
 */
// SCALE: outer SKU loop is independent across products (O(S * B * T)); at 100x SKUs, recompute only the edited SKU shard.
export function assessNetwork(
  data: Dataset,
  policy: Policy,
  forecaster: Forecaster,
  dayIndex: number,
  onHandOverride?: readonly (readonly number[])[],
): Position[][] {
  const alpha = ewmaAlpha(policy.ewmaSpanDays);
  const lastHistory = dayIndex - 1;
  const positions: Position[][] = [];

  for (let skuIndex = 0; skuIndex < data.products.length; skuIndex += 1) {
    const product = at(data.products, skuIndex, "product");
    const salesByBranch = at(data.sales, skuIndex, "sales");
    const stockByBranch = at(data.onHand, skuIndex, "onHand");
    const row: Position[] = [];

    for (let branchIndex = 0; branchIndex < data.branches.length; branchIndex += 1) {
      const sales = at(salesByBranch, branchIndex, "sales branch");
      const stock = at(stockByBranch, branchIndex, "stock branch");
      const historyEnd = Math.min(lastHistory, sales.length - 1);
      const historySales = historyEnd >= 0 ? sales.slice(0, historyEnd + 1) : [];
      const historyStock = historyEnd >= 0 ? stock.slice(0, historyEnd + 1) : [];
      const estimate = forecaster.estimateDemand(
        { sales: historySales, onHand: historyStock },
        { alpha, leadTimeDays: product.leadTimeDays, serviceZ: policy.serviceZ },
      );
      const onHand = onHandOverride
        ? at(at(onHandOverride, skuIndex, "override sku"), branchIndex, "override branch")
        : historyEnd >= 0
          ? at(stock, historyEnd, "current stock")
          : 0;
      const coverDays = coverDaysOf(onHand, estimate.velocity);
      const status = classifyPosition(onHand, coverDays, estimate.reorderPoint, estimate.inStockDays, policy);
      // DECISION: sender floor retains 30 days of cover PLUS full safety stock (rounded down with Math.floor) while receiver transfer target aims for 14 days (Math.ceil), rejecting symmetric 14d/14d which risks whipsawing donors into stockouts.
      const floor = policy.donorCoverDays * estimate.velocity + estimate.safetyStock;
      const surplus = status === "OVERSTOCK" ? Math.max(0, Math.floor(onHand - floor)) : 0;
      const target = policy.receiverCoverDays * estimate.velocity;
      const need = status === "AT_RISK" ? Math.max(0, Math.ceil(target - onHand)) : 0;
      const lostUnits = status === "AT_RISK" ? Math.max(0, estimate.velocity * product.leadTimeDays - onHand) : 0;

      row.push({
        skuIndex,
        branchIndex,
        onHand,
        velocity: estimate.velocity,
        sigma: estimate.sigma,
        inStockDays: estimate.inStockDays,
        safetyStock: estimate.safetyStock,
        reorderPoint: estimate.reorderPoint,
        coverDays,
        status,
        surplus,
        need,
        lostUnits,
        leadTimeDays: product.leadTimeDays,
      });
    }
    positions.push(row);
  }

  return positions;
}

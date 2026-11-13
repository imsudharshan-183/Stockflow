/**
 * Turns a forecast into a position status and a transfer quantity.
 * Inputs: on hand, velocity, reorder point, policy cover targets. Output: NEW, OVERSTOCK, AT_RISK, or HEALTHY, plus surplus and need.
 * Formula: cover = on hand / velocity; overstock above 60 days; at risk below the reorder point; donor floor is 30 days plus safety; receiver target is 14 days.
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

export function holdingWindowDays(coverDays: number | null, velocity: number, policy: Policy): number {
  if (coverDays === null || velocity <= 0) return policy.deadStockHoldDays;
  return Math.min(policy.deadStockHoldDays, Math.max(0, coverDays - policy.donorCoverDays));
}

// IMPORTANT: zero velocity with stock on hand is unlimited cover, not a divide-by-zero and not a stockout.
export function coverDaysOf(onHand: number, velocity: number): number | null {
  if (velocity <= 0) return onHand > 0 ? null : 0;
  return onHand / velocity;
}

// DECISION: overstock wins when a position is both above 60 days and below the reorder point, so we do not ship into a pile.
// ASSUMPTION: 60 / 30 / 14 day lines are policy, not a fit to this catalog.
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

/**
 * Counterfactual morning-action replay across the trailing policy.backtestDays history window.
 * Inputs: Dataset (recorded sales, end-of-day onHand, uncensored demand) and Policy.
 * Outputs: BacktestResult with windowDays, baselineStockoutDays, engineStockoutDays, stockoutDaysAvoided, and cashReleased (BD).
 * Formula: baseline counts (available <= 0 && demand > 0); simulation starts at day (start - 1) onHand, credits recorded receipts + morning engine moves, then deducts daily demand.
 * Units: days for stockout counts; units for inventory moves; BD (round3) for cashReleased (sum of moved/cleared units * product.cost, excluding reorders).
 * Where used: report/kpis.ts, engine/index.ts, and apps/api KpiService.
 */
import type { Dataset } from "../seed/types.js";
import type { BacktestResult, Policy } from "../schemas/index.js";
import { at, round3 } from "../round.js";
import { greedyMatcher } from "./match.js";
import { recommend } from "./recommend.js";
import { ewmaForecaster, isStockoutDay } from "./velocity.js";

/**
 * Replays the trailing `policy.backtestDays` mornings to compare baseline stockout days against StockFlow's plan.
 * Formula: stockoutDaysAvoided = baselineStockoutDays - engineStockoutDays; cashReleased = sum((transferredUnits + clearedUnits) * unitCost) in BD.
 * Example: 120-day Bahrain dataset (windowDays = 45) -> compares baseline stockouts across 7,500 store-SKU slots against engine transfers/reorders/markdowns.
 */
// ASSUMPTION: historical receipts implied by day-to-day stock deltas still arrive on schedule, and transfers release/cash counts exclude REORDER arrivals (new spend, not freed shelf capital); cancelling legacy POs would require order-book data.
// IMPORTANT: purely deterministic over dataset arrays with no wall-clock or RNG calls, ensuring golden kpis.backtest stability.
export function backtest(data: Dataset, policy: Policy): BacktestResult {
  const end = data.dates.length;
  const windowDays = Math.min(policy.backtestDays, end);
  const start = end - windowDays;
  const baselineStockoutDays = countBaselineStockouts(data, start, end);
  const simulated = simulate(data, policy, start, end);

  return {
    windowDays,
    baselineStockoutDays,
    engineStockoutDays: simulated.stockoutDays,
    stockoutDaysAvoided: baselineStockoutDays - simulated.stockoutDays,
    cashReleased: round3(simulated.cashReleased),
  };
}

function countBaselineStockouts(data: Dataset, start: number, end: number): number {
  let stockouts = 0;
  for (let sku = 0; sku < data.products.length; sku++) {
    const salesByBranch = at(data.sales, sku, "sales");
    const stockByBranch = at(data.onHand, sku, "onHand");
    const demandByBranch = at(data.demand, sku, "demand");
    for (let branch = 0; branch < data.branches.length; branch++) {
      const sales = at(salesByBranch, branch, "sales branch");
      const stock = at(stockByBranch, branch, "stock branch");
      const demand = at(demandByBranch, branch, "demand branch");
      for (let day = start; day < end; day++) {
        const available = at(stock, day, "stock day") + at(sales, day, "sales day");
        if (isStockoutDay(available, at(demand, day, "demand day"))) stockouts += 1;
      }
    }
  }
  return stockouts;
}

function simulate(
  data: Dataset,
  policy: Policy,
  start: number,
  end: number,
): { stockoutDays: number; cashReleased: number } {
  const sim = data.onHand.map((byBranch) =>
    byBranch.map((series) => (start > 0 ? at(series, start - 1, "opening") : 0)),
  );
  const inbound = new Map<string, number>();
  const openOrder = new Set<string>();
  let stockoutDays = 0;
  let cashReleased = 0;

  for (let day = start; day < end; day++) {
    receiveInbound(sim, inbound, openOrder, day);
    addRecordedReceipts(data, sim, day);
    const drafts = recommend(data, policy, ewmaForecaster, greedyMatcher, day, sim);
    for (const draft of drafts) {
      const product = at(data.products, draft.skuIndex, "product");
      const onHand = at(sim, draft.skuIndex, "sim sku");
      if (draft.action === "TRANSFER" && draft.donorBranchIndex !== null) {
        const donorOnHand = at(onHand, draft.donorBranchIndex, "donor");
        const receiverOnHand = at(onHand, draft.branchIndex, "receiver");
        const moved = Math.min(Math.round(draft.quantity), Math.max(0, Math.floor(donorOnHand)));
        if (moved < 1) continue;
        onHand[draft.donorBranchIndex] = donorOnHand - moved;
        onHand[draft.branchIndex] = receiverOnHand + moved;
        cashReleased += moved * product.cost;
        continue;
      }
      if (draft.action === "MARKDOWN" && draft.netBenefit > 0) {
        const current = at(onHand, draft.branchIndex, "markdown");
        const cleared = Math.min(Math.round(draft.quantity), Math.max(0, Math.floor(current)));
        if (cleared < 1) continue;
        onHand[draft.branchIndex] = current - cleared;
        cashReleased += cleared * product.cost;
        continue;
      }
      if (draft.action === "REORDER") {
        const key = pairKey(draft.skuIndex, draft.branchIndex);
        if (openOrder.has(key)) continue;
        const arrive = day + product.leadTimeDays;
        if (arrive >= end) continue;
        openOrder.add(key);
        const arrivalKey = `${arrive}:${key}`;
        inbound.set(arrivalKey, (inbound.get(arrivalKey) ?? 0) + Math.round(draft.quantity));
      }
    }

    for (let sku = 0; sku < data.products.length; sku++) {
      const row = at(sim, sku, "sim sku");
      const demandByBranch = at(data.demand, sku, "demand");
      for (let branch = 0; branch < data.branches.length; branch++) {
        const demand = at(at(demandByBranch, branch, "demand branch"), day, "demand day");
        const available = at(row, branch, "available");
        if (isStockoutDay(available, demand)) stockoutDays += 1;
        row[branch] = Math.max(0, available - demand);
      }
    }
  }

  return { stockoutDays, cashReleased };
}

function receiveInbound(
  sim: number[][],
  inbound: Map<string, number>,
  openOrder: Set<string>,
  day: number,
): void {
  const prefix = `${day}:`;
  const due = [...inbound.keys()].filter((key) => key.startsWith(prefix));
  for (const key of due) {
    const quantity = inbound.get(key) ?? 0;
    if (quantity <= 0) continue;
    const rest = key.slice(prefix.length);
    const split = rest.indexOf(":");
    const sku = Number(rest.slice(0, split));
    const branch = Number(rest.slice(split + 1));
    const row = at(sim, sku, "arrival sku");
    row[branch] = at(row, branch, "arrival branch") + quantity;
    openOrder.delete(rest);
    inbound.delete(key);
  }
}

function addRecordedReceipts(data: Dataset, sim: number[][], day: number): void {
  if (day <= 0) return;
  for (let sku = 0; sku < data.products.length; sku++) {
    const stockByBranch = at(data.onHand, sku, "onHand");
    const salesByBranch = at(data.sales, sku, "sales");
    const row = at(sim, sku, "sim sku");
    for (let branch = 0; branch < data.branches.length; branch++) {
      const stock = at(stockByBranch, branch, "stock branch");
      const sales = at(salesByBranch, branch, "sales branch");
      const receipt =
        at(stock, day, "end") - at(stock, day - 1, "prev") + at(sales, day, "sold");
      if (receipt > 0) row[branch] = at(row, branch, "before receipt") + receipt;
    }
  }
}

function pairKey(sku: number, branch: number): string {
  return `${sku}:${branch}`;
}

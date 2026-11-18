import type { Dataset } from "../seed/types.js";
import { KpiSummarySchema, type KpiSummary, type Policy, type Recommendation } from "../schemas/index.js";
import { at, round2, round3 } from "../round.js";
import { DEAD_VELOCITY_PER_DAY, STOCKOUT_RATE_DAYS } from "../engine/config.js";
import { assessPositions, backtest, type Position } from "../engine/index.js";
import { isStockoutDay } from "../engine/velocity.js";
import { buildRecommendations } from "./recommendations.js";
import { roundRate } from "./numbers.js";

export interface Analysis {
  recommendations: Recommendation[];
  kpis: KpiSummary;
  positions: Position[][];
}

export function analyze(data: Dataset, policy: Policy): Analysis {
  const positions = assessPositions(data, policy);
  const recommendations = buildRecommendations(data, policy);
  const kpis = buildKpiSummary(data, policy, positions);
  return { recommendations, kpis, positions };
}

function buildKpiSummary(data: Dataset, policy: Policy, positions: Position[][]): KpiSummary {
  let deadStockValue = 0;
  let lostSalesAtRisk = 0;
  let cashReleasable = 0;
  const categoryRiskMap = new Map<
    string,
    { category: string; atRiskCount: number; revenueAtRisk: number }
  >();
  for (let sku = 0; sku < data.products.length; sku += 1) {
    const product = at(data.products, sku, "product");
    const row = at(positions, sku, "position sku");
    for (const position of row) {
      if (position.status === "AT_RISK") {
        const risk = position.lostUnits * product.price;
        lostSalesAtRisk += risk;
        const catRow = categoryRiskMap.get(product.category) ?? {
          category: product.category,
          atRiskCount: 0,
          revenueAtRisk: 0,
        };
        catRow.atRiskCount += 1;
        catRow.revenueAtRisk = round3(catRow.revenueAtRisk + risk);
        categoryRiskMap.set(product.category, catRow);
      }
      if (position.status === "OVERSTOCK") {
        const excessValue = position.surplus * product.cost;
        cashReleasable += excessValue;
        // DECISION: dead stock is tracked as the near-zero velocity subset of overstock excess
        // so "includes dead stock" on Overstock cards never exceeds total cashReleasable.
        if (position.velocity < DEAD_VELOCITY_PER_DAY && position.surplus > 0) {
          deadStockValue += excessValue;
        }
      }
    }
  }

  const trend = data.dates.map((date, day) => {
    let stockouts = 0;
    let cells = 0;
    let salesValue = 0;
    let inventoryValue = 0;
    for (let sku = 0; sku < data.products.length; sku += 1) {
      const product = at(data.products, sku, "product");
      const salesByBranch = at(data.sales, sku, "sales");
      const stockByBranch = at(data.onHand, sku, "onHand");
      const demandByBranch = at(data.demand, sku, "demand");
      for (let branch = 0; branch < data.branches.length; branch += 1) {
        const sold = at(at(salesByBranch, branch, "sales branch"), day, "sales day");
        const onHand = at(at(stockByBranch, branch, "stock branch"), day, "stock day");
        const demand = at(at(demandByBranch, branch, "demand branch"), day, "demand day");
        cells += 1;
        salesValue += sold * product.price;
        inventoryValue += onHand * product.cost;
        if (isStockoutDay(onHand + sold, demand)) stockouts += 1;
      }
    }
    return {
      date,
      stockoutRate: cells === 0 ? 0 : stockouts / cells,
      salesValue: round3(salesValue),
      inventoryValue: round3(inventoryValue),
    };
  });

  const categories = [...new Set(data.products.map((product) => product.category))].sort((a, b) =>
    a.localeCompare(b),
  );
  const window = trend.map((point) => point.stockoutRate).slice(-STOCKOUT_RATE_DAYS);
  const branchRisk = riskByBranch(data, positions);
  const categoryRisk = [...categoryRiskMap.values()].sort(
    (left, right) =>
      right.revenueAtRisk - left.revenueAtRisk || left.category.localeCompare(right.category),
  );
  const coverGrid = coverByBranchCategory(data, positions, categories);

  return KpiSummarySchema.parse({
    asOf: data.asOf,
    stockoutRate: window.length === 0 ? 0 : roundRate(window),
    deadStockValue: round3(deadStockValue),
    lostSalesAtRisk: round3(lostSalesAtRisk),
    cashReleasable: round3(cashReleasable),
    backtest: backtest(data, policy),
    trend,
    branches: data.branches,
    categories,
    policy,
    branchRisk,
    categoryRisk,
    coverGrid,
  });
}

function riskByBranch(data: Dataset, positions: Position[][]) {
  const start = Math.max(0, data.dates.length - STOCKOUT_RATE_DAYS);
  const rows = data.branches.map((branch, branchIndex) => {
    let stockouts = 0;
    let cells = 0;
    let revenueAtRisk = 0;
    for (let sku = 0; sku < data.products.length; sku += 1) {
      const product = at(data.products, sku, "product");
      const position = at(at(positions, sku, "position sku"), branchIndex, "position branch");
      if (position.status === "AT_RISK") revenueAtRisk += position.lostUnits * product.price;
      const salesByBranch = at(data.sales, sku, "sales");
      const stockByBranch = at(data.onHand, sku, "onHand");
      const demandByBranch = at(data.demand, sku, "demand");
      for (let day = start; day < data.dates.length; day += 1) {
        const sold = at(at(salesByBranch, branchIndex, "sales branch"), day, "sales day");
        const onHand = at(at(stockByBranch, branchIndex, "stock branch"), day, "stock day");
        const demand = at(at(demandByBranch, branchIndex, "demand branch"), day, "demand day");
        cells += 1;
        if (isStockoutDay(onHand + sold, demand)) stockouts += 1;
      }
    }
    return {
      branchId: branch.id,
      branchName: branch.name,
      stockoutRate: cells === 0 ? 0 : stockouts / cells,
      revenueAtRisk: round3(revenueAtRisk),
    };
  });
  rows.sort((left, right) => right.revenueAtRisk - left.revenueAtRisk || left.branchId.localeCompare(right.branchId));
  return rows;
}

function coverByBranchCategory(data: Dataset, positions: Position[][], categories: string[]) {
  const totals = new Map<string, { sum: number; count: number }>();
  for (let sku = 0; sku < data.products.length; sku += 1) {
    const product = at(data.products, sku, "product");
    const row = at(positions, sku, "position sku");
    for (const position of row) {
      if (position.coverDays === null) continue;
      const branch = at(data.branches, position.branchIndex, "branch");
      const key = `${branch.id}|${product.category}`;
      const current = totals.get(key) ?? { sum: 0, count: 0 };
      current.sum += position.coverDays;
      current.count += 1;
      totals.set(key, current);
    }
  }
  return data.branches.flatMap((branch) =>
    categories.map((category) => {
      const bucket = totals.get(`${branch.id}|${category}`);
      return {
        branchId: branch.id,
        branchName: branch.name,
        category,
        coverDays: bucket && bucket.count > 0 ? round2(bucket.sum / bucket.count) : null,
      };
    }),
  );
}

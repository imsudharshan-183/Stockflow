import type { Dataset } from "../seed/types.js";
import { formatProductDisplayName } from "../seed/catalog.js";
import {
  BranchDetailSchema,
  ProductDetailSchema,
  type BranchDetail,
  type Policy,
  type PositionView,
  type ProductDetail,
  type Recommendation,
} from "../schemas/index.js";
import { at, round3 } from "../round.js";
import { DEAD_VELOCITY_PER_DAY, STOCKOUT_RATE_DAYS } from "../engine/config.js";
import type { Position } from "../engine/classify.js";
import { isStockoutDay } from "../engine/velocity.js";
import { coverOf, roundRate, stat } from "./numbers.js";

export function buildBranchDetail(
  data: Dataset,
  positions: Position[][],
  recommendations: readonly Recommendation[],
  branchId: string,
): BranchDetail | null {
  const branchIndex = data.branches.findIndex((branch) => branch.id === branchId);
  if (branchIndex < 0) return null;
  const branch = at(data.branches, branchIndex, "branch");
  let deadStockValue = 0;
  let cashReleasable = 0;
  let lostSalesAtRisk = 0;
  let inventoryValue = 0;

  for (let sku = 0; sku < data.products.length; sku += 1) {
    const product = at(data.products, sku, "product");
    const position = at(at(positions, sku, "position sku"), branchIndex, "position branch");
    inventoryValue += position.onHand * product.cost;
    if (position.status === "OVERSTOCK") {
      const excessValue = position.surplus * product.cost;
      cashReleasable += excessValue;
      if (position.velocity < DEAD_VELOCITY_PER_DAY && position.surplus > 0) {
        deadStockValue += excessValue;
      }
    }
    if (position.status === "AT_RISK") lostSalesAtRisk += position.lostUnits * product.price;
  }

  const trend = data.dates.map((date, day) => {
    let salesUnits = 0;
    let salesValue = 0;
    let onHandUnits = 0;
    let stockouts = 0;
    for (let sku = 0; sku < data.products.length; sku += 1) {
      const product = at(data.products, sku, "product");
      const sold = at(at(at(data.sales, sku, "sales"), branchIndex, "sales branch"), day, "sales day");
      const onHand = at(at(at(data.onHand, sku, "onHand"), branchIndex, "stock branch"), day, "stock day");
      const demand = at(at(at(data.demand, sku, "demand"), branchIndex, "demand branch"), day, "demand day");
      salesUnits += sold;
      salesValue += sold * product.price;
      onHandUnits += onHand;
      if (isStockoutDay(onHand + sold, demand)) stockouts += 1;
    }
    return {
      date,
      salesUnits,
      salesValue: round3(salesValue),
      onHandUnits,
      stockoutRate: data.products.length === 0 ? 0 : stockouts / data.products.length,
    };
  });

  const scoped = recommendations.filter(
    (recommendation) => recommendation.branchId === branchId || recommendation.donorBranchId === branchId,
  );

  return BranchDetailSchema.parse({
    branch,
    stockoutRate: averageRate(trend.map((point) => point.stockoutRate)),
    deadStockValue: round3(deadStockValue),
    cashReleasable: round3(cashReleasable),
    lostSalesAtRisk: round3(lostSalesAtRisk),
    inventoryValue: round3(inventoryValue),
    recommendations: scoped,
    trend,
  });
}

export function buildProductDetail(
  data: Dataset,
  policy: Policy,
  positions: Position[][],
  recommendations: readonly Recommendation[],
  sku: string,
): ProductDetail | null {
  const skuIndex = data.products.findIndex((product) => product.sku === sku);
  if (skuIndex < 0) return null;
  const product = at(data.products, skuIndex, "product");
  const row = at(positions, skuIndex, "position sku");
  const views: PositionView[] = row.map((position) => {
    const branch = at(data.branches, position.branchIndex, "branch");
    return {
      branch: { ...branch, status: branch.status ?? "active" },
      onHand: position.onHand,
      velocity: stat(position.velocity, "velocity"),
      sigmaDemand: stat(position.sigma, "sigma"),
      coverDays: coverOf(position.coverDays),
      safetyStock: stat(position.safetyStock, "safetyStock"),
      reorderPoint: stat(position.reorderPoint, "reorderPoint"),
      leadTimeDays: product.leadTimeDays,
      inStockDays: position.inStockDays,
      status: position.status,
      lostUnits: stat(position.lostUnits, "lostUnits"),
      surplus: position.surplus,
      reserved: "reserved" in position && typeof position.reserved === "number" ? position.reserved : 0,
      inTransit: "inTransit" in position && typeof position.inTransit === "number" ? position.inTransit : 0,
      recommendation: recommendationFor(recommendations, product.sku, branch.id),
    };
  });

  const series = data.branches.map((branch, branchIndex) => ({
    branchId: branch.id,
    points: data.dates.map((date, day) => ({
      date,
      salesUnits: at(at(at(data.sales, skuIndex, "sales"), branchIndex, "sales branch"), day, "day"),
      onHand: at(at(at(data.onHand, skuIndex, "onHand"), branchIndex, "stock branch"), day, "day"),
      demandUnits: at(at(at(data.demand, skuIndex, "demand"), branchIndex, "demand branch"), day, "day"),
    })),
  }));

  const normalizedProduct = {
    ...product,
    name: formatProductDisplayName(product.name, product.sku),
  };

  return ProductDetailSchema.parse({ product: normalizedProduct, policy, positions: views, series });
}

function recommendationFor(
  recommendations: readonly Recommendation[],
  sku: string,
  branchId: string,
): Recommendation | null {
  let best: Recommendation | null = null;
  for (const recommendation of recommendations) {
    if (recommendation.sku !== sku) continue;
    if (recommendation.branchId !== branchId && recommendation.donorBranchId !== branchId) continue;
    if (!best || recommendation.rank < best.rank) best = recommendation;
  }
  return best;
}

function averageRate(rates: readonly number[]): number {
  const window = rates.slice(-STOCKOUT_RATE_DAYS);
  if (window.length === 0) return 0;
  return roundRate(window);
}

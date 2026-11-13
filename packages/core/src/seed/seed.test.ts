import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../engine/config.js";
import { backtest } from "../engine/index.js";
import { buildRecommendations } from "../report/index.js";
import { at, round2 } from "../round.js";
import { InventorySnapshotSchema, SalesDailySchema } from "../schemas/index.js";
import {
  CHRONIC_BRANCH_IDS,
  DAY_COUNT,
  EXCESS_BRANCH_IDS,
  FAILED_SKU_START,
  FAST_SKU_COUNT,
  PRODUCT_COUNT,
  PROMO_DAY_END,
  PROMO_DAY_START,
  PROMO_SKU,
} from "./catalog.js";
import { generateDataset } from "./generate.js";

const data = generateDataset();

describe("seed", () => {
  it("builds the catalog and stays deterministic", () => {
    expect(data.branches).toHaveLength(15);
    expect(data.branches[0]?.id).toBe("BR-001");
    expect(data.branches[0]?.name).toBe("Chicago - Loop");
    expect(data.branches[14]?.id).toBe("BR-015");
    expect(data.products).toHaveLength(PRODUCT_COUNT);
    expect(data.products[0]?.sku).toBe("SKU-00001");
    expect(data.dates).toHaveLength(DAY_COUNT);
    expect(new Set(data.products.map((product) => product.category)).size).toBe(12);
    for (const product of data.products) {
      expect(product.price).toBeGreaterThanOrEqual(2);
      expect(product.price).toBeLessThanOrEqual(150);
      const share = product.cost / product.price;
      expect(share).toBeGreaterThanOrEqual(0.54);
      expect(share).toBeLessThanOrEqual(0.76);
    }
    expect(generateDataset()).toEqual(data);
  });

  it("projects a day onto the sales and stock contracts", () => {
    const branch = at(data.branches, 0, "branch");
    const product = at(data.products, 0, "product");
    const units = at(at(at(data.sales, 0, "sales"), 0, "branch"), 0, "day");
    const onHand = at(at(at(data.onHand, 0, "onHand"), 0, "branch"), 0, "day");
    const date = at(data.dates, 0, "date");
    expect(
      SalesDailySchema.parse({
        branchId: branch.id,
        sku: product.sku,
        date,
        units,
        revenue: round2(units * product.price),
      }).units,
    ).toBe(units);
    expect(
      InventorySnapshotSchema.parse({
        branchId: branch.id,
        sku: product.sku,
        date,
        onHand,
      }).onHand,
    ).toBe(onHand);
  });

  it("never sells more than demand and does plant stockouts, excess, dead stock, and a promo", () => {
    let violations = 0;
    let stockoutDays = 0;
    for (let sku = 0; sku < data.products.length; sku++) {
      for (let branch = 0; branch < data.branches.length; branch++) {
        const sales = at(at(data.sales, sku, "sales"), branch, "branch");
        const onHand = at(at(data.onHand, sku, "onHand"), branch, "branch");
        const demand = at(at(data.demand, sku, "demand"), branch, "branch");
        for (let day = 0; day < data.dates.length; day++) {
          const sold = at(sales, day, "sales");
          const stock = at(onHand, day, "stock");
          const wanted = at(demand, day, "demand");
          if (sold > wanted || stock < 0 || sold < 0) violations += 1;
          if (wanted > 0 && stock + sold === 0) stockoutDays += 1;
        }
      }
    }
    expect(violations).toBe(0);
    expect(stockoutDays).toBeGreaterThan(0);

    const chronic = new Set<string>(CHRONIC_BRANCH_IDS);
    const excess = new Set<string>(EXCESS_BRANCH_IDS);
    let chronicStockouts = 0;
    let healthyStockouts = 0;
    let chronicCells = 0;
    let healthyCells = 0;
    let excessOnHand = 0;
    let chronicOnHand = 0;
    let excessCount = 0;
    let chronicCount = 0;

    for (let sku = 0; sku < FAST_SKU_COUNT; sku++) {
      for (let branchIndex = 0; branchIndex < data.branches.length; branchIndex++) {
        const branch = at(data.branches, branchIndex, "branch");
        const sales = at(at(data.sales, sku, "sales"), branchIndex, "branch");
        const onHand = at(at(data.onHand, sku, "onHand"), branchIndex, "branch");
        const demand = at(at(data.demand, sku, "demand"), branchIndex, "branch");
        const end = at(onHand, onHand.length - 1, "end");
        if (chronic.has(branch.id)) {
          chronicOnHand += end;
          chronicCount += 1;
        }
        if (excess.has(branch.id)) {
          excessOnHand += end;
          excessCount += 1;
        }
        if (!chronic.has(branch.id) && branch.id !== "BR-001") continue;
        for (let day = 0; day < data.dates.length; day++) {
          const stockout =
            at(demand, day, "demand") > 0 &&
            at(onHand, day, "stock") + at(sales, day, "sales") === 0;
          if (branch.id === "BR-001") {
            healthyCells += 1;
            if (stockout) healthyStockouts += 1;
          } else {
            chronicCells += 1;
            if (stockout) chronicStockouts += 1;
          }
        }
      }
    }

    expect(chronicStockouts / chronicCells).toBeGreaterThan(healthyStockouts / healthyCells);
    expect(excessOnHand / excessCount).toBeGreaterThan((chronicOnHand / chronicCount) * 3);

    for (let sku = FAILED_SKU_START; sku < PRODUCT_COUNT; sku++) {
      for (let branch = 0; branch < data.branches.length; branch++) {
        const series = at(at(data.onHand, sku, "onHand"), branch, "branch");
        expect(at(series, series.length - 1, "end")).toBeGreaterThan(100);
      }
    }

    const promoSku = data.products.findIndex((item) => item.sku === PROMO_SKU);
    const excessIndexes = data.branches
      .map((branch, index) => (excess.has(branch.id) ? index : -1))
      .filter((index) => index >= 0);
    const mean = (from: number, to: number) => {
      let total = 0;
      let count = 0;
      for (const branch of excessIndexes) {
        const series = at(at(data.sales, promoSku, "promo"), branch, "branch");
        for (let day = from; day <= to; day++) {
          total += at(series, day, "day");
          count += 1;
        }
      }
      return total / count;
    };
    const prior = mean(PROMO_DAY_START - 7, PROMO_DAY_START - 1);
    const promo = mean(PROMO_DAY_START, PROMO_DAY_END);
    expect(promo).toBeGreaterThan(prior * 2);
  });

  it("replays the network with fewer stockout days and released cash", () => {
    const result = backtest(data, DEFAULT_POLICY);
    expect(result.windowDays).toBe(45);
    expect(result.baselineStockoutDays).toBeGreaterThan(0);
    expect(result.stockoutDaysAvoided).toBeGreaterThan(0);
    expect(result.cashReleased).toBeGreaterThan(0);
    const first = buildRecommendations(data, DEFAULT_POLICY);
    const second = buildRecommendations(data, DEFAULT_POLICY);
    expect(second).toEqual(first);
    expect(first.every((recommendation) => recommendation.reasonCodes.length > 0)).toBe(true);
  });
});

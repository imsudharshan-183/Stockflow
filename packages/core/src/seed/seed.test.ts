import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../engine/config.js";
import { assessPositions, backtest } from "../engine/index.js";
import { buildProductDetail, buildRecommendations } from "../report/index.js";
import { at, round2 } from "../round.js";
import { InventorySnapshotSchema, SalesDailySchema } from "../schemas/index.js";
import {
  BAHRAIN_BRANCHES,
  BHD_PRICE_TIERS,
  CATEGORY_PRICE_TIER,
  CHRONIC_BRANCH_IDS,
  DAY_COUNT,
  EXCESS_BRANCH_IDS,
  FAILED_SKU_START,
  FAST_SKU_COUNT,
  PRODUCT_COUNT,
  PROMO_DAY_END,
  PROMO_DAY_START,
  PROMO_SKU,
  formatProductDisplayName,
  haversineDistanceKm,
  matchesProductQuery,
  type CatalogCategory,
} from "./catalog.js";
import { generateDataset } from "./generate.js";

const data = generateDataset();

describe("seed", () => {
  it("builds the Bahrain catalog with tiered non-round BHD pricing and stays deterministic", () => {
    expect(data.branches).toHaveLength(15);
    expect(data.branches[0]?.id).toBe("BR-001");
    expect(data.branches[0]?.name).toBe("Manama - CBD");
    expect(data.branches[1]?.id).toBe("BR-002");
    expect(data.branches[1]?.name).toBe("Manama - Juffair");
    expect(data.branches[14]?.id).toBe("BR-015");
    expect(data.branches[14]?.name).toBe("Saar");
    expect(data.products).toHaveLength(PRODUCT_COUNT);
    expect(data.products[0]?.sku).toBe("SKU-00001");
    expect(data.dates).toHaveLength(DAY_COUNT);
    expect(new Set(data.products.map((product) => product.category)).size).toBe(12);

    // Verify all 15 branches have Bahrain coordinates and pairwise distances in 2..45 km
    for (let i = 0; i < BAHRAIN_BRANCHES.length; i++) {
      const a = at(BAHRAIN_BRANCHES, i, "branchA");
      expect(a.coordinates).toBeDefined();
      const [latA, lngA] = a.coordinates!;
      expect(latA).toBeGreaterThan(25.9);
      expect(latA).toBeLessThan(26.4);
      expect(lngA).toBeGreaterThan(50.3);
      expect(lngA).toBeLessThan(50.8);
      for (let j = i + 1; j < BAHRAIN_BRANCHES.length; j++) {
        const b = at(BAHRAIN_BRANCHES, j, "branchB");
        const distKm = haversineDistanceKm(a.coordinates!, b.coordinates!);
        expect(distKm).toBeGreaterThanOrEqual(2);
        expect(distKm).toBeLessThanOrEqual(45);
      }
    }

    for (const product of data.products) {
      const tier = CATEGORY_PRICE_TIER[product.category as CatalogCategory];
      const range = BHD_PRICE_TIERS[tier];
      expect(product.price).toBeGreaterThanOrEqual(range.min);
      expect(product.price).toBeLessThanOrEqual(range.max);
      expect(Number.isInteger(product.price)).toBe(false);
      expect(product.price).toBeGreaterThan(product.cost);
      expect(product.cost).toBeGreaterThan(0);
      const share = product.cost / product.price;
      expect(share).toBeGreaterThanOrEqual(0.55 - 1e-9);
      expect(share).toBeLessThanOrEqual(0.75 + 1e-9);
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

  it("generates unique, professional product names per category without SKU codes or mismatched units", () => {
    const allNames = new Set<string>();
    const byCategory = new Map<string, Set<string>>();

    for (const product of data.products) {
      expect(product.name.length).toBeGreaterThanOrEqual(3);
      expect(product.name.length).toBeLessThanOrEqual(60);
      expect(product.name).not.toMatch(/SKU-\d+/i);
      expect(product.name).not.toContain("$");
      expect(product.name).toMatch(/^[^,]+, [^,]+$/);

      expect(allNames.has(product.name.toLowerCase())).toBe(false);
      allNames.add(product.name.toLowerCase());

      const catSet = byCategory.get(product.category) ?? new Set<string>();
      expect(catSet.has(product.name.toLowerCase())).toBe(false);
      catSet.add(product.name.toLowerCase());
      byCategory.set(product.category, catSet);

      if (product.category === "Toys" || product.category === "Stationery" || product.category === "Accessories") {
        expect(product.name).not.toMatch(/\b(\d+\s*(ml|l|g|kg))\b/i);
      }
      if (product.category === "Beverages") {
        expect(product.name).toMatch(/\b(ml|L|Pack of \d+)\b/);
      }
    }
    expect(allNames.size).toBe(PRODUCT_COUNT);
  });

  it("matches search queries by both product name and SKU and falls back to SKU when name is missing", () => {
    const sample = at(data.products, 0, "product");
    expect(matchesProductQuery(sample, sample.sku)).toBe(true);
    expect(matchesProductQuery(sample, sample.sku.toLowerCase())).toBe(true);
    expect(matchesProductQuery(sample, "sparkling")).toBe(true);
    expect(matchesProductQuery(sample, "aurelia")).toBe(true);
    expect(matchesProductQuery(sample, "nonexistent-term-xyz")).toBe(false);

    expect(formatProductDisplayName("Aurelia Sparkling Water, 330 ml", "SKU-00001")).toBe(
      "Aurelia Sparkling Water, 330 ml",
    );
    expect(formatProductDisplayName("", "SKU-00001")).toBe("SKU-00001");
    expect(formatProductDisplayName("   ", "SKU-00001")).toBe("SKU-00001");
    expect(formatProductDisplayName(null, "SKU-00001")).toBe("SKU-00001");

    const blankNameData = {
      ...data,
      products: data.products.map((p, idx) => (idx === 0 ? { ...p, name: "   " } : p)),
    };
    const positions = assessPositions(blankNameData, DEFAULT_POLICY);
    const recs = buildRecommendations(blankNameData, DEFAULT_POLICY);
    const detail = buildProductDetail(blankNameData, DEFAULT_POLICY, positions, recs, "SKU-00001");
    expect(detail?.product.name).toBe("SKU-00001");
    for (const r of recs.filter((x) => x.sku === "SKU-00001")) {
      expect(r.productName).toBe("SKU-00001");
      expect(r.reason).toContain("SKU-00001");
    }
  });
});

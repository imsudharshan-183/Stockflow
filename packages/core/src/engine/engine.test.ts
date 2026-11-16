import { describe, expect, it } from "vitest";
import { at, round3 } from "../round.js";
import { buildRecommendations } from "../report/index.js";
import {
  RecommendationSchema,
  type Branch,
  type Policy,
  type Product,
} from "../schemas/index.js";
import type { Dataset } from "../seed/types.js";
import { BAHRAIN_BRANCHES, haversineDistanceKm } from "../seed/catalog.js";
import { DEFAULT_POLICY, totalTransferCost } from "./config.js";
import { assessPositions, backtest, planActions } from "./index.js";

const branchA: Branch = { id: "A", name: "Branch A", city: "Mumbai", region: "West" };
const branchB: Branch = { id: "B", name: "Branch B", city: "Pune", region: "West" };
const branchC: Branch = { id: "C", name: "Branch C", city: "Delhi", region: "North" };

function product(overrides: Partial<Product> = {}): Product {
  return {
    sku: "SKU-TEST",
    name: "Test Dal 1kg",
    category: "Staples",
    price: 400,
    cost: 200,
    leadTimeDays: 7,
    ...overrides,
  };
}

function buildDataset(input: {
  branches: Branch[];
  product: Product;
  dates: string[];
  sales: number[][];
  onHand: number[][];
  demand?: number[][];
}): Dataset {
  const demand = input.demand ?? input.sales;
  return {
    seed: 1,
    asOf: at(input.dates, input.dates.length - 1, "asOf"),
    dates: input.dates,
    branches: input.branches,
    products: [input.product],
    sales: [input.sales],
    onHand: [input.onHand],
    demand: [demand],
  };
}

describe("engine formulas", () => {
  it("excludes stockout days from velocity and applies safety stock", () => {
    const data = buildDataset({
      branches: [branchA],
      product: product({ leadTimeDays: 4 }),
      dates: ["2026-11-10", "2026-11-11"],
      sales: [[1, 3]],
      onHand: [[2, 2]],
    });
    const position = at(at(assessPositions(data, DEFAULT_POLICY), 0, "sku"), 0, "branch");
    const alpha = 2 / (DEFAULT_POLICY.ewmaSpanDays + 1);
    expect(position.velocity).toBeCloseTo(1 + 2 * alpha, 10);
    expect(position.sigma).toBeCloseTo(Math.sqrt(2), 10);
    expect(position.safetyStock).toBeCloseTo(1.65 * Math.sqrt(2) * Math.sqrt(4), 10);
    expect(position.reorderPoint).toBeCloseTo(position.velocity * 4 + position.safetyStock, 10);
    expect(position.coverDays).toBeCloseTo(2 / position.velocity, 10);
  });

  it("does not let a zero-sales stockout pull velocity down", () => {
    const data = buildDataset({
      branches: [branchA],
      product: product(),
      dates: ["2026-11-10", "2026-11-11"],
      sales: [[5, 0]],
      onHand: [[10, 0]],
      demand: [[5, 5]],
    });
    const position = at(at(assessPositions(data, DEFAULT_POLICY), 0, "sku"), 0, "branch");
    expect(position.velocity).toBe(5);
    expect(position.inStockDays).toBe(1);
  });
});

describe("planActions", () => {
  it("moves 60 units from Branch B to Branch A", () => {
    const data = buildDataset({
      branches: [branchA, branchB],
      product: product(),
      dates: ["2026-11-11"],
      sales: [[5], [2]],
      onHand: [[10], [300]],
    });

    const drafts = planActions(data, DEFAULT_POLICY);
    expect(drafts).toHaveLength(1);
    const draft = at(drafts, 0, "draft");
    expect(draft.action).toBe("TRANSFER");
    expect(draft.quantity).toBe(60);
    expect(draft.branchIndex).toBe(0);
    expect(draft.donorBranchIndex).toBe(1);
    expect(draft.onHand).toBe(10);
    expect(draft.velocity).toBe(5);
    expect(draft.coverDays).toBe(2);
    expect(draft.donorCoverDays).toBe(150);
    expect(draft.safetyStock).toBe(0);
    expect(draft.reorderPoint).toBe(35);
    expect(draft.lostUnits).toBe(25);

    const excessDays = Math.min(DEFAULT_POLICY.deadStockHoldDays, 150 - DEFAULT_POLICY.donorCoverDays);
    const carryPerUnit =
      200 * DEFAULT_POLICY.annualHoldingRate * (excessDays / DEFAULT_POLICY.deadStockHoldDays);
    const carryingCostSaved = round3(60 * carryPerUnit);
    const expectedTransferCost = totalTransferCost(60, 0, DEFAULT_POLICY);
    expect(draft.lostMarginAvoided).toBe(25 * (400 - 200));
    expect(draft.transferCost).toBe(expectedTransferCost);
    expect(draft.carryingCostSaved).toBe(carryingCostSaved);
    expect(draft.netBenefit).toBe(round3(5000 + carryingCostSaved - expectedTransferCost));
    expect(draft.reasonCodes).toEqual(
      expect.arrayContaining([
        "BELOW_REORDER_POINT",
        "DONOR_SURPLUS",
        "RECEIVER_BELOW_TARGET",
        "MIN_TRANSFER_MET",
      ]),
    );

    const recommendations = buildRecommendations(data, DEFAULT_POLICY);
    expect(RecommendationSchema.array().parse(recommendations)).toHaveLength(1);
    const recommendation = at(recommendations, 0, "recommendation");
    expect(recommendation.branchName).toBe("Branch A");
    expect(recommendation.donorBranchName).toBe("Branch B");
    expect(recommendation.quantity).toBe(60);
    expect(recommendation.rank).toBe(1);
    expect(recommendation.status).toBe("PENDING");
    expect(recommendation.reason).toContain("Transfer 60 units");
    expect(recommendation.reason).toContain("freight cost BD");
    expect(recommendation.reasonCodes.length).toBeGreaterThan(0);
  });

  it("prices Bahrain transfer freight by Haversine distance and prefers the nearer donor", () => {
    const manamaCbd = at(BAHRAIN_BRANCHES, 0, "BR-001");
    const juffair = at(BAHRAIN_BRANCHES, 1, "BR-002");
    const zallaq = at(BAHRAIN_BRANCHES, 11, "BR-012");
    const data = buildDataset({
      branches: [manamaCbd, juffair, zallaq],
      product: product({ price: 30, cost: 18 }),
      dates: ["2026-11-11"],
      sales: [[5], [2], [2]],
      onHand: [[10], [300], [300]],
    });
    const recs = buildRecommendations(data, DEFAULT_POLICY);
    expect(recs).toHaveLength(1);
    const rec = at(recs, 0, "recommendation");
    expect(rec.action).toBe("TRANSFER");
    expect(rec.donorBranchId).toBe(juffair.id);
    const expectedKm = Math.round(haversineDistanceKm(juffair.coordinates!, manamaCbd.coordinates!) * 100) / 100;
    expect(rec.metrics.transferCost).toBe(totalTransferCost(rec.quantity, expectedKm, DEFAULT_POLICY));
    expect(rec.reason).toContain(`${expectedKm.toFixed(1)} km`);
    expect(rec.reason).toContain("fixed +");
    expect(rec.reason).toContain("distance +");
    expect(rec.reason).toContain("handling");
  });

  it("marks down a branch with stock and zero velocity", () => {
    const data = buildDataset({
      branches: [branchA],
      product: product(),
      dates: ["2026-11-09", "2026-11-10", "2026-11-11"],
      sales: [[0, 0, 0]],
      onHand: [[40, 40, 40]],
    });
    const drafts = planActions(data, DEFAULT_POLICY);
    expect(drafts).toHaveLength(1);
    const draft = at(drafts, 0, "draft");
    expect(draft.action).toBe("MARKDOWN");
    expect(draft.quantity).toBe(40);
    expect(draft.velocity).toBe(0);
    expect(draft.coverDays).toBeNull();
    expect(draft.reasonCodes).toContain("ZERO_VELOCITY");
    expect(Number.isFinite(draft.netBenefit)).toBe(true);
  });

  it("leaves a new SKU with no in-stock history alone", () => {
    const data = buildDataset({
      branches: [branchA],
      product: product(),
      dates: ["2026-11-10", "2026-11-11"],
      sales: [[0, 0]],
      onHand: [[0, 0]],
      demand: [[1, 1]],
    });
    const position = at(at(assessPositions(data, DEFAULT_POLICY), 0, "sku"), 0, "branch");
    expect(position.status).toBe("NEW");
    expect(position.velocity).toBe(0);
    expect(planActions(data, DEFAULT_POLICY)).toEqual([]);
  });

  it("stops when the donor surplus is used up", () => {
    const policy: Policy = { ...DEFAULT_POLICY, transferCostPerUnit: 0 };
    const data = buildDataset({
      branches: [branchA, branchB, branchC],
      product: product(),
      dates: ["2026-11-11"],
      sales: [[5], [2], [5]],
      onHand: [[10], [121], [10]],
    });
    const drafts = planActions(data, policy);
    const transfers = drafts.filter((draft) => draft.action === "TRANSFER");
    const reorders = drafts.filter((draft) => draft.action === "REORDER");
    expect(transfers).toHaveLength(1);
    expect(at(transfers, 0, "transfer")).toMatchObject({
      quantity: 60,
      branchIndex: 0,
      donorBranchIndex: 1,
    });
    expect(reorders).toHaveLength(1);
    expect(at(reorders, 0, "reorder").branchIndex).toBe(2);
    expect(reorders.every((draft) => draft.quantity > 0)).toBe(true);
  });

  it("is deterministic for the same inputs", () => {
    const data = buildDataset({
      branches: [branchA, branchB],
      product: product(),
      dates: ["2026-11-11"],
      sales: [[5], [2]],
      onHand: [[10], [300]],
    });
    expect(planActions(data, DEFAULT_POLICY)).toEqual(planActions(data, DEFAULT_POLICY));
    expect(buildRecommendations(data, DEFAULT_POLICY)).toEqual(
      buildRecommendations(data, DEFAULT_POLICY),
    );
  });
});

describe("backtest", () => {
  it("counts stockout days a same-day transfer removes", () => {
    const dates = ["2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11"];
    const data = buildDataset({
      branches: [branchA, branchB],
      product: product(),
      dates,
      sales: [
        [5, 5, 5, 0, 0, 0],
        [2, 2, 2, 2, 2, 2],
      ],
      onHand: [
        [10, 5, 0, 0, 0, 0],
        [400, 400, 400, 400, 400, 400],
      ],
      demand: [
        [5, 5, 5, 5, 5, 5],
        [2, 2, 2, 2, 2, 2],
      ],
    });
    const result = backtest(data, { ...DEFAULT_POLICY, backtestDays: 2 });
    expect(result.windowDays).toBe(2);
    expect(result.baselineStockoutDays).toBe(2);
    expect(result.engineStockoutDays).toBe(0);
    expect(result.stockoutDaysAvoided).toBe(2);
    expect(result.cashReleased).toBeGreaterThan(0);
  });
});

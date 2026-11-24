import { describe, expect, it } from "vitest";
import { at, round3 } from "../round.js";
import { BAHRAIN_BRANCHES, haversineDistanceKm } from "../seed/catalog.js";
import type { Dataset } from "../seed/types.js";
import {
  DonorCandidateSchema,
  type Branch,
  type Product,
} from "../schemas/index.js";
import { assessPositions, DEFAULT_POLICY, totalTransferCost } from "./index.js";
import { deltaKey, project, type CommittedDelta } from "./projection.js";
import { rankDonorCandidates } from "./donorRanking.js";

const branchA: Branch = { id: "A", name: "Branch A", city: "Manama", region: "Capital" };
const branchB: Branch = { id: "B", name: "Branch B", city: "Muharraq", region: "Muharraq" };
const branchC: Branch = { id: "C", name: "Branch C", city: "Riffa", region: "Southern" };

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    sku: "SKU-TEST",
    name: "Test Product",
    category: "Staples",
    price: 400,
    cost: 200,
    leadTimeDays: 7,
    ...overrides,
  };
}

function buildDataset(input: {
  branches: Branch[];
  product?: Product;
  dates?: string[];
  sales: number[][];
  onHand: number[][];
  demand?: number[][];
}): Dataset {
  const dates = input.dates ?? ["2026-11-11"];
  const product = input.product ?? makeProduct();
  const demand = input.demand ?? input.sales;
  return {
    seed: 1,
    asOf: at(dates, dates.length - 1, "asOf"),
    dates,
    branches: input.branches,
    products: [product],
    sales: [input.sales],
    onHand: [input.onHand],
    demand: [demand],
  };
}

describe("project & rankDonorCandidates", () => {
  it("matches the worked 60-unit B->A example", () => {
    const data = buildDataset({
      branches: [branchA, branchB],
      sales: [[5], [2]],
      onHand: [[10], [300]],
    });

    const candidates = rankDonorCandidates(data, new Map(), "SKU-TEST", "A", 60);
    expect(candidates).toHaveLength(1);
    const cand = DonorCandidateSchema.parse(candidates[0]);

    const excessDays = Math.min(DEFAULT_POLICY.deadStockHoldDays, 150 - DEFAULT_POLICY.donorCoverDays);
    const carryPerUnit =
      200 * DEFAULT_POLICY.annualHoldingRate * (excessDays / DEFAULT_POLICY.deadStockHoldDays);
    const expectedCarryingSaved = round3(60 * carryPerUnit);
    const expectedFreight = totalTransferCost(60, 0, DEFAULT_POLICY);
    const expectedNetBenefit = round3(25 * (400 - 200) + expectedCarryingSaved - expectedFreight);

    expect(cand).toMatchObject({
      branchId: "B",
      branchName: "Branch B",
      distanceKm: 0,
      freightCostBhd: expectedFreight,
      availableSurplusUnits: 240,
      requestedQty: 60,
      offeredQty: 60,
      isPartial: false,
      donorCoverDaysAfter: 120,
      targetCoverDaysBefore: 2,
      targetCoverDaysAfter: 14,
      netBenefitBhd: expectedNetBenefit,
      eligible: true,
    });
    expect(cand.ineligibleReason).toBeUndefined();
  });

  it("prefers nearer Bahrain donors using Haversine distance and TotalTransferCost(Q, D)", () => {
    const manamaCbd = at(BAHRAIN_BRANCHES, 0, "BR-001");
    const juffair = at(BAHRAIN_BRANCHES, 1, "BR-002");
    const zallaq = at(BAHRAIN_BRANCHES, 11, "BR-012");

    const data = buildDataset({
      branches: [manamaCbd, zallaq, juffair],
      product: makeProduct({ price: 30, cost: 18 }),
      sales: [[5], [2], [2]],
      onHand: [[10], [300], [300]],
    });

    const candidates = rankDonorCandidates(data, new Map(), "SKU-TEST", manamaCbd.id, 60);
    expect(candidates.map((c) => c.branchId)).toEqual([juffair.id, zallaq.id]);

    const expectedJuffairKm =
      Math.round(haversineDistanceKm(juffair.coordinates!, manamaCbd.coordinates!) * 100) / 100;
    expect(candidates[0]?.distanceKm).toBe(expectedJuffairKm);
    expect(candidates[0]?.freightCostBhd).toBe(
      totalTransferCost(60, expectedJuffairKm, DEFAULT_POLICY),
    );
  });

  it("excludes reserved units from committedDeltas, offers partial caps, and flags depleted donors", () => {
    const data = buildDataset({
      branches: [branchA, branchB, branchC],
      sales: [[5], [2], [2]],
      onHand: [[10], [140], [300]], // B floor = 60 (raw surplus 80), C floor = 60 (raw surplus 240)
    });

    // Reserve 60 units at B (leaving 20 surplus -> partial for qty 60) and all 240 surplus at C (0 left -> ineligible)
    const deltas = new Map<string, CommittedDelta>([
      [deltaKey("SKU-TEST", "B"), { reserved: 60, inTransit: 0 }],
      [deltaKey("SKU-TEST", "C"), { reserved: 240, inTransit: 0 }],
    ]);

    const eligibleOnly = rankDonorCandidates(data, deltas, "SKU-TEST", "A", 60);
    expect(eligibleOnly).toHaveLength(1);
    expect(eligibleOnly[0]).toMatchObject({
      branchId: "B",
      availableSurplusUnits: 20,
      requestedQty: 60,
      offeredQty: 20,
      isPartial: true,
      donorCoverDaysAfter: 30,
      eligible: true,
    });

    // Plain object record store works identically to Map and includeIneligible surfaces C
    const recordDeltas: Record<string, CommittedDelta> = {
      [deltaKey("SKU-TEST", "B")]: { reserved: 60, inTransit: 0 },
      [deltaKey("SKU-TEST", "C")]: { reserved: 240, inTransit: 0 },
    };
    const withIneligible = rankDonorCandidates(data, recordDeltas, "SKU-TEST", "A", 60, {
      includeIneligible: true,
    });
    expect(withIneligible).toHaveLength(2);
    expect(withIneligible[1]).toMatchObject({
      branchId: "C",
      availableSurplusUnits: 0,
      offeredQty: 0,
      eligible: false,
      ineligibleReason: "INSUFFICIENT_SURPLUS",
    });

    // Pure project() adjusts target inTransit and donor onHand/surplus coherently
    const positions = assessPositions(data, DEFAULT_POLICY);
    const projectedB = project(at(at(positions, 0, "sku"), 1, "B"), deltas.get(deltaKey("SKU-TEST", "B")));
    expect(projectedB.onHand).toBe(80);
    expect(projectedB.surplus).toBe(20);
    expect(projectedB.reserved).toBe(60);
  });

  it("tie-breaks by donorCoverDaysAfter desc then branchIndex asc, and caps at top 3 by default", () => {
    const d1: Branch = { id: "D1", name: "Donor 1", city: "Manama", region: "Capital" };
    const d2: Branch = { id: "D2", name: "Donor 2", city: "Manama", region: "Capital" };
    const d3: Branch = { id: "D3", name: "Donor 3", city: "Manama", region: "Capital" };
    const d4: Branch = { id: "D4", name: "Donor 4", city: "Manama", region: "Capital" };
    const d5: Branch = { id: "D5", name: "Donor 5", city: "Manama", region: "Capital" };

    // Target sells 5/day (stock 10); all donors sell 1/day (30d floor = 30), stock >= 400 so holdingWindow caps at 365 days
    // meaning equal carryingCostSaved & equal freight (no coords => distance 0) => identical netBenefitBhd!
    const data = buildDataset({
      branches: [branchA, d1, d2, d3, d4, d5],
      product: makeProduct({ price: 50, cost: 20 }),
      sales: [[5], [1], [1], [1], [1], [1]],
      onHand: [[10], [450], [600], [500], [600], [420]],
    });

    const top3 = rankDonorCandidates(data, new Map(), "SKU-TEST", "A", 40);
    expect(top3).toHaveLength(3);
    // d2 (600, index 2) and d4 (600, index 4) tie on coverAfter (560) -> d2 beats d4 by lower branchIndex, then d3 (460)
    expect(top3.map((c) => c.branchId)).toEqual(["D2", "D4", "D3"]);

    const all5 = rankDonorCandidates(data, new Map(), "SKU-TEST", "A", 40, { limit: 5 });
    expect(all5.map((c) => c.branchId)).toEqual(["D2", "D4", "D3", "D1", "D5"]);
  });

  it("returns empty array when no donors exist and surfaces specific ineligible reasons on opt-in", () => {
    const archivedDonor: Branch = {
      id: "ARC",
      name: "Archived Branch",
      city: "Sitra",
      region: "Capital",
      status: "archived",
    };
    const newBranch: Branch = { id: "NEWB", name: "New Branch", city: "Saar", region: "Northern" };

    const data = buildDataset({
      branches: [branchA, branchB, archivedDonor, newBranch],
      sales: [[5], [2], [2], [0]],
      onHand: [[10], [50], [300], [0]], // branchB floor=60 => INSUFFICIENT_SURPLUS; ARC => ARCHIVED_BRANCH; NEWB => NO_HISTORY
    });

    expect(rankDonorCandidates(data, new Map(), "SKU-TEST", "A", 20)).toEqual([]);

    const all = rankDonorCandidates(data, new Map(), "SKU-TEST", "A", 20, {
      includeIneligible: true,
    });
    expect(all).toHaveLength(3);
    expect(all.every((c) => !c.eligible)).toBe(true);
    const byId = Object.fromEntries(all.map((c) => [c.branchId, c.ineligibleReason]));
    expect(byId).toEqual({
      B: "INSUFFICIENT_SURPLUS",
      ARC: "ARCHIVED_BRANCH",
      NEWB: "NO_HISTORY",
    });
  });
});

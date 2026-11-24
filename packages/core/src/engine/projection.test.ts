import { describe, expect, it } from "vitest";
import type { Branch, Product } from "../schemas/index.js";
import type { Dataset } from "../seed/types.js";
import { assessPositions, DEFAULT_POLICY } from "./index.js";
import { rankDonorCandidates } from "./donorRanking.js";
import {
  deltaKey,
  projectPosition,
  ZERO_DELTA,
  type CommittedDelta,
} from "./projection.js";

const branchA: Branch = { id: "A", name: "Branch A", city: "Manama", region: "Capital" };
const branchB: Branch = { id: "B", name: "Branch B", city: "Muharraq", region: "Muharraq" };

const product: Product = {
  sku: "SKU-ADJ-1",
  name: "Adjustment Test Product",
  category: "Staples",
  price: 20,
  cost: 10,
  leadTimeDays: 7,
};

function makeDataset(sales: number[][], onHand: number[][]): Dataset {
  return {
    seed: 1,
    asOf: "2026-11-11",
    dates: ["2026-11-11"],
    branches: [branchA, branchB],
    products: [product],
    sales: [sales],
    onHand: [onHand],
    demand: [sales],
  };
}

describe("projectPosition adjustment overlays", () => {
  it("applies negative shrinkage adjustments and recomputes status, need, and lostUnits", () => {
    // 5 units/day, reorderPoint = 5 * 7 = 35, receiverTarget = 5 * 14 = 70
    // Start at onHand = 40 (HEALTHY). Shrinkage of -15 brings onHand to 25 (AT_RISK).
    const data = makeDataset([[5], [2]], [[40], [100]]);
    const positions = assessPositions(data, DEFAULT_POLICY);
    const rawHealthy = positions[0]![0]!;
    expect(rawHealthy.status).toBe("HEALTHY");
    expect(rawHealthy.need).toBe(0);

    const projected = projectPosition(rawHealthy, { reserved: 0, inTransit: 0, adjustment: -15 });
    expect(projected.onHand).toBe(25);
    expect(projected.coverDays).toBe(5);
    expect(projected.status).toBe("AT_RISK");
    expect(projected.need).toBe(45);
    expect(projected.lostUnits).toBe(10);
    expect(projected.adjustment).toBe(-15);
  });

  it("applies positive physical count adjustments and promotes AT_RISK to HEALTHY or OVERSTOCK", () => {
    // 5 units/day, reorderPoint = 35 -> onHand = 20 (AT_RISK)
    // Count correction +300 -> onHand = 320 (64d cover > 60 -> OVERSTOCK, floor = 150 -> surplus = 170)
    const data = makeDataset([[5], [2]], [[20], [100]]);
    const positions = assessPositions(data, DEFAULT_POLICY);
    const rawAtRisk = positions[0]![0]!;
    expect(rawAtRisk.status).toBe("AT_RISK");

    const healthy = projectPosition(rawAtRisk, { reserved: 0, inTransit: 0, adjustment: 30 });
    expect(healthy.onHand).toBe(50);
    expect(healthy.status).toBe("HEALTHY");
    expect(healthy.need).toBe(0);
    expect(healthy.lostUnits).toBe(0);

    const overstock = projectPosition(rawAtRisk, { reserved: 0, inTransit: 0, adjustment: 300 });
    expect(overstock.onHand).toBe(320);
    expect(overstock.status).toBe("OVERSTOCK");
    expect(overstock.surplus).toBe(170);
  });

  it("combines reserved, inTransit, and adjustment overlays and feeds rankDonorCandidates", () => {
    // Branch B: 2 units/day, onHand = 200 (100d OVERSTOCK) -> floor = 60 -> raw surplus = 140
    // With reserved = 20 and shrinkage adjustment = -30 -> effective onHand = 150 (75d OVERSTOCK) -> surplus = 90
    const data = makeDataset([[5], [2]], [[10], [200]]);
    const positions = assessPositions(data, DEFAULT_POLICY);
    const rawDonor = positions[0]![1]!;

    const zeroProj = projectPosition(rawDonor, ZERO_DELTA);
    expect(zeroProj.adjustment).toBeUndefined();

    const deltas = new Map<string, CommittedDelta>([
      [deltaKey(product.sku, branchB.id), { reserved: 20, inTransit: 0, adjustment: -30 }],
    ]);
    const donorProj = projectPosition(rawDonor, deltas.get(deltaKey(product.sku, branchB.id)));
    expect(donorProj.onHand).toBe(150);
    expect(donorProj.status).toBe("OVERSTOCK");
    expect(donorProj.surplus).toBe(90);

    const candidates = rankDonorCandidates(data, deltas, product.sku, branchA.id, 120);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.branchId).toBe("B");
    expect(candidates[0]!.availableSurplusUnits).toBe(90);
    expect(candidates[0]!.offeredQty).toBe(90);
    expect(candidates[0]!.isPartial).toBe(true);
  });
});

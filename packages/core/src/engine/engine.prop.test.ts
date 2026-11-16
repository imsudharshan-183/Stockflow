import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, analyze, type Branch, type Dataset, type Product } from "../index.js";

const DAYS = 30;
const DATES = Array.from({ length: DAYS }, (_, i) =>
  new Date(Date.UTC(2026, 9, 1) + i * 86_400_000).toISOString().slice(0, 10),
);

const BRANCHES: Branch[] = [
  { id: "BR-001", name: "Manama - CBD", city: "Manama", region: "Capital", coordinates: [26.2285, 50.586] },
  { id: "BR-002", name: "Riffa", city: "Riffa", region: "Southern", coordinates: [26.1226, 50.555] },
  { id: "BR-003", name: "Budaiya", city: "Budaiya", region: "Northern", coordinates: [26.2128, 50.4472] },
];

describe("Engine invariants (fast-check property tests)", () => {
  it("preserves mathematical and structural invariants for arbitrary valid datasets", () => {
    const skuArb = fc.record({
      price: fc.integer({ min: 20, max: 500 }),
      costRatio: fc.double({ min: 0.2, max: 0.7, noNaN: true }),
      leadTimeDays: fc.integer({ min: 2, max: 14 }),
      branches: fc.tuple(
        fc.record({ dailySales: fc.integer({ min: 0, max: 20 }), onHand: fc.integer({ min: 0, max: 800 }) }),
        fc.record({ dailySales: fc.integer({ min: 0, max: 20 }), onHand: fc.integer({ min: 0, max: 800 }) }),
        fc.record({ dailySales: fc.integer({ min: 0, max: 20 }), onHand: fc.integer({ min: 0, max: 800 }) }),
      ),
    });

    fc.assert(
      fc.property(fc.array(skuArb, { minLength: 1, maxLength: 4 }), (skuSpecs) => {
        const products: Product[] = skuSpecs.map((spec, idx) => ({
          sku: `SKU-P${idx + 1}`,
          name: `Prop Product ${idx + 1}`,
          category: "Apparel",
          price: spec.price,
          cost: Math.max(1, Math.round(spec.price * spec.costRatio)),
          leadTimeDays: spec.leadTimeDays,
          status: "active",
        }));

        const sales = skuSpecs.map((spec) =>
          spec.branches.map((b) => Array.from({ length: DAYS }, () => b.dailySales)),
        );
        const onHand = skuSpecs.map((spec) =>
          spec.branches.map((b) => Array.from({ length: DAYS }, () => b.onHand)),
        );

        const dataset: Dataset = {
          seed: 42,
          asOf: DATES[DAYS - 1] ?? "2026-10-30",
          dates: DATES,
          branches: BRANCHES,
          products,
          sales,
          onHand,
          demand: sales,
        };

        const analysis = analyze(dataset, DEFAULT_POLICY);

        // Position invariants
        for (const skuRow of analysis.positions) {
          for (const pos of skuRow) {
            expect(pos.onHand).toBeGreaterThanOrEqual(0);
            expect(pos.velocity).toBeGreaterThanOrEqual(0);
            expect(pos.safetyStock).toBeGreaterThanOrEqual(0);
            expect(pos.reorderPoint).toBeGreaterThanOrEqual(pos.safetyStock);
            if (pos.velocity <= 0) {
              if (pos.onHand <= 0) {
                expect(pos.coverDays).toBe(0);
              } else {
                expect(pos.coverDays).toBeNull();
              }
            } else {
              expect(pos.coverDays).not.toBeNull();
              expect(pos.coverDays ?? 0).toBeGreaterThanOrEqual(0);
            }
          }
        }

        // Recommendation invariants
        for (const rec of analysis.recommendations) {
          expect(Number.isFinite(rec.quantity)).toBe(true);
          expect(rec.quantity).toBeGreaterThan(0);
          expect(Number.isFinite(rec.netBenefit)).toBe(true);
          if (rec.action === "TRANSFER") {
            expect(rec.donorBranchId).toBeTruthy();
            expect(rec.donorBranchId).not.toBe(rec.branchId);
          }
        }

        // KPI invariants
        expect(analysis.kpis.deadStockValue).toBeGreaterThanOrEqual(0);
        expect(analysis.kpis.lostSalesAtRisk).toBeGreaterThanOrEqual(0);
        expect(analysis.kpis.cashReleasable).toBeGreaterThanOrEqual(0);
        expect(analysis.kpis.stockoutRate).toBeGreaterThanOrEqual(0);
        expect(analysis.kpis.stockoutRate).toBeLessThanOrEqual(1);
      }),
      { numRuns: 50 },
    );
  });
});

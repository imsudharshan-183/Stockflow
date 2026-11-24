import { describe, expect, it } from "vitest";
import { analyze, DEFAULT_POLICY, generateDataset, planActions } from "../index.js";
import { computeActionBenefitForQuantity } from "./quantityBenefit.js";

describe("computeActionBenefitForQuantity", () => {
  it("matches engine TRANSFER, REORDER, and MARKDOWN netBenefit at engine quantity and scales on edits", () => {
    const dataset = generateDataset();
    const analysis = analyze(dataset, DEFAULT_POLICY);
    const drafts = planActions(dataset, DEFAULT_POLICY);

    const transfer = drafts.find((r) => r.action === "TRANSFER");
    expect(transfer).toBeDefined();
    if (transfer) {
      const product = dataset.products[transfer.skuIndex]!;
      const donorPos =
        transfer.donorBranchIndex !== null
          ? analysis.positions[transfer.skuIndex]?.[transfer.donorBranchIndex]
          : undefined;

      const exact = computeActionBenefitForQuantity({
        type: "TRANSFER",
        quantity: transfer.quantity,
        unitPrice: product.price,
        unitCost: product.cost,
        distanceKm: transfer.distanceKm,
        targetLostUnits: transfer.lostUnits,
        donorCoverDays: transfer.donorCoverDays,
        donorVelocity: donorPos?.velocity ?? 0,
      });
      expect(exact.netBenefitBhd).toBeCloseTo(transfer.netBenefit, 3);
      expect(exact.freightCostBhd).toBeCloseTo(transfer.transferCost, 3);

      const reducedQty = Math.max(5, Math.floor(transfer.quantity / 2));
      const reduced = computeActionBenefitForQuantity({
        type: "TRANSFER",
        quantity: reducedQty,
        unitPrice: product.price,
        unitCost: product.cost,
        distanceKm: transfer.distanceKm,
        targetLostUnits: transfer.lostUnits,
        donorCoverDays: transfer.donorCoverDays,
        donorVelocity: donorPos?.velocity ?? 0,
      });
      const dist = transfer.distanceKm ?? 0;
      expect(reduced.freightCostBhd).toBeCloseTo(1.5 + 0.15 * dist + 0.25 * reducedQty, 3);
      if (reducedQty < transfer.quantity) {
        expect(reduced.freightCostBhd).toBeLessThan(exact.freightCostBhd);
      }
    }

    const reorder = drafts.find((r) => r.action === "REORDER");
    expect(reorder).toBeDefined();
    if (reorder) {
      const product = dataset.products[reorder.skuIndex]!;
      const exact = computeActionBenefitForQuantity({
        type: "REORDER",
        quantity: reorder.quantity,
        unitPrice: product.price,
        unitCost: product.cost,
        targetLostUnits: reorder.lostUnits,
      });
      expect(exact.netBenefitBhd).toBeCloseTo(reorder.netBenefit, 3);
      expect(exact.freightCostBhd).toBe(0);
    }

    const markdown = drafts.find((r) => r.action === "MARKDOWN");
    expect(markdown).toBeDefined();
    if (markdown) {
      const product = dataset.products[markdown.skuIndex]!;
      const exact = computeActionBenefitForQuantity({
        type: "MARKDOWN",
        quantity: markdown.quantity,
        unitPrice: product.price,
        unitCost: product.cost,
        targetCoverDays: markdown.coverDays,
        targetVelocity: markdown.velocity,
      });
      expect(exact.netBenefitBhd).toBeCloseTo(markdown.netBenefit, 3);
      expect(exact.carryingCostSaved).toBeCloseTo(markdown.carryingCostSaved, 3);
    }
  });

  it("returns zero economics when quantity is zero or negative", () => {
    expect(
      computeActionBenefitForQuantity({
        type: "TRANSFER",
        quantity: 0,
        unitPrice: 20,
        unitCost: 12,
        distanceKm: 10,
      }),
    ).toEqual({
      netBenefitBhd: 0,
      lostMarginAvoided: 0,
      carryingCostSaved: 0,
      freightCostBhd: 0,
      markdownCost: 0,
    });
  });
});

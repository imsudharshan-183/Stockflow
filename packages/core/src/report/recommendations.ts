import type { Dataset } from "../seed/types.js";
import { formatProductDisplayName } from "../seed/catalog.js";
import { RecommendationSchema, type Policy, type Recommendation } from "../schemas/index.js";
import { at } from "../round.js";
import { planActions, type ActionDraft } from "../engine/index.js";
import { coverOf, money, stat } from "./numbers.js";
import { describeRecommendation } from "./reason.js";

export function buildRecommendations(data: Dataset, policy: Policy): Recommendation[] {
  const drafts = planActions(data, policy);
  const recommendations: Recommendation[] = [];
  const seen = new Set<string>();

  for (const draft of drafts) {
    const quantity = Math.round(draft.quantity);
    if (quantity < 1) continue;
    const product = at(data.products, draft.skuIndex, "product");
    const branch = at(data.branches, draft.branchIndex, "branch");
    if (draft.action === "TRANSFER" && draft.donorBranchIndex === null) {
      throw new Error(`transfer of ${product.sku} is missing a donor`);
    }
    const donor = draft.donorBranchIndex === null ? null : at(data.branches, draft.donorBranchIndex, "donor");
    const id = [data.asOf, draft.action, product.sku, branch.id, donor?.id ?? "none"].join("_");
    if (seen.has(id)) throw new Error(`duplicate recommendation ${id}`);
    seen.add(id);

    const displayName = formatProductDisplayName(product.name, product.sku);

    recommendations.push(
      RecommendationSchema.parse({
        id,
        rank: recommendations.length + 1,
        sku: product.sku,
        productName: displayName,
        category: product.category,
        branchId: branch.id,
        branchName: branch.name,
        donorBranchId: donor?.id ?? null,
        donorBranchName: donor?.name ?? null,
        action: draft.action,
        quantity,
        netBenefit: money(draft.netBenefit, "netBenefit"),
        reasonCodes: draft.reasonCodes,
        reason: describeRecommendation({
          action: draft.action,
          quantity,
          productName: displayName,
          branchName: branch.name,
          donorBranchName: donor?.name ?? null,
          coverDays: draft.coverDays,
          reorderPoint: draft.reorderPoint,
          netBenefit: draft.netBenefit,
          lostMarginAvoided: draft.lostMarginAvoided,
          carryingCostSaved: draft.carryingCostSaved,
          transferCost: draft.transferCost,
          markdownCost: draft.markdownCost,
          reasonCodes: draft.reasonCodes,
        }),
        status: "PENDING",
        metrics: metricsOf(draft),
      }),
    );
  }

  return recommendations;
}

function metricsOf(draft: ActionDraft): Recommendation["metrics"] {
  return {
    onHand: money(draft.onHand, "onHand"),
    velocity: stat(draft.velocity, "velocity"),
    sigmaDemand: stat(draft.sigmaDemand, "sigmaDemand"),
    coverDays: coverOf(draft.coverDays),
    safetyStock: stat(draft.safetyStock, "safetyStock"),
    reorderPoint: stat(draft.reorderPoint, "reorderPoint"),
    lostMarginAvoided: money(draft.lostMarginAvoided, "lostMarginAvoided"),
    carryingCostSaved: money(draft.carryingCostSaved, "carryingCostSaved"),
    transferCost: money(draft.transferCost, "transferCost"),
    markdownCost: money(draft.markdownCost, "markdownCost"),
    donorOnHand: draft.donorOnHand === null ? null : money(draft.donorOnHand, "donorOnHand"),
    donorCoverDays: coverOf(draft.donorCoverDays),
    lostUnits: stat(draft.lostUnits, "lostUnits"),
  };
}

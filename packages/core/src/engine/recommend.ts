/**
 * One morning's actions for the whole network.
 * Inputs: dataset, policy, a Forecaster, and a Matcher. Output: transfer, reorder, and markdown drafts sorted by net benefit.
 * Formula: transfers come only from Matcher; leftover shortage is a reorder; overstock with no receiver is a markdown.
 */
import type { Dataset } from "../seed/types.js";
import type { Policy, ReasonCode } from "../schemas/index.js";
import { round2 } from "../round.js";
import { MIN_ACTION_UNITS } from "./config.js";
import { assessNetwork, coverDaysOf, holdingWindowDays, type Position } from "./classify.js";
import type { Forecaster, Matcher, PartyState, TransferQuote } from "./strategies.js";

export interface ActionDraft {
  action: "TRANSFER" | "REORDER" | "MARKDOWN";
  skuIndex: number;
  branchIndex: number;
  donorBranchIndex: number | null;
  quantity: number;
  netBenefit: number;
  reasonCodes: ReasonCode[];
  lostMarginAvoided: number;
  carryingCostSaved: number;
  transferCost: number;
  markdownCost: number;
  onHand: number;
  velocity: number;
  sigmaDemand: number;
  coverDays: number | null;
  safetyStock: number;
  reorderPoint: number;
  donorOnHand: number | null;
  donorCoverDays: number | null;
  lostUnits: number;
}

// DECISION: reorder and markdown stay here, not inside Matcher, so a new matcher cannot change the fallback rules.
// The $25 materiality cutoff stays out of this function so the golden quantities do not move.
export function recommend(
  data: Dataset,
  policy: Policy,
  forecaster: Forecaster,
  matcher: Matcher,
  dayIndex: number,
  onHandOverride?: readonly (readonly number[])[],
): ActionDraft[] {
  const assessed = assessNetwork(data, policy, forecaster, dayIndex, onHandOverride);
  const drafts: ActionDraft[] = [];

  for (let skuIndex = 0; skuIndex < data.products.length; skuIndex += 1) {
    const product = data.products[skuIndex];
    const row = assessed[skuIndex];
    if (!product || !row) continue;
    drafts.push(...planSku(row, product.price, product.cost, product.leadTimeDays, policy, matcher));
  }

  drafts.sort(compareDrafts);
  return drafts;
}

function planSku(
  row: readonly Position[],
  price: number,
  cost: number,
  leadTimeDays: number,
  policy: Policy,
  matcher: Matcher,
): ActionDraft[] {
  const receivers = row.filter((position) => position.status === "AT_RISK").map((position) => toParty(position, "receiver"));
  const donors = row
    .filter((position) => position.status === "OVERSTOCK" && position.surplus > 0)
    .map((position) => toParty(position, "donor"));
  const matched = matcher.match(receivers, donors, { price, unitCost: cost, policy });
  const drafts: ActionDraft[] = [];
  const received = new Set<number>();

  for (const transfer of matched.transfers) {
    const receiver = row[transfer.receiverBranchIndex];
    const donor = row[transfer.donorBranchIndex];
    if (!receiver || !donor) continue;
    received.add(transfer.receiverBranchIndex);
    drafts.push(transferDraft(receiver, transfer));
  }

  for (const receiver of matched.receivers) {
    const position = row[receiver.branchIndex];
    if (!position) continue;
    const target = Math.max(policy.receiverCoverDays * position.velocity, position.reorderPoint);
    const quantity = Math.ceil(target - receiver.onHand);
    if (quantity <= 0) continue;
    const lostUnitsNow = Math.max(0, position.velocity * leadTimeDays - receiver.onHand);
    const lostMarginAvoided = round2(Math.min(quantity, lostUnitsNow) * (price - cost));
    const reasonCodes: ReasonCode[] = ["BELOW_REORDER_POINT", "REORDER_TO_TARGET"];
    if (donors.length === 0 || !received.has(receiver.branchIndex)) reasonCodes.push("NO_DONOR");
    if (lostMarginAvoided > 0) reasonCodes.push("LOST_SALES_AT_RISK");
    drafts.push(
      draftFrom(position, "REORDER", position.branchIndex, null, quantity, {
        netBenefit: lostMarginAvoided,
        lostMarginAvoided,
        carryingCostSaved: 0,
        transferCost: 0,
        markdownCost: 0,
        reasonCodes,
        onHand: receiver.onHand,
        coverDays: coverDaysOf(receiver.onHand, position.velocity),
        lostUnits: lostUnitsNow,
        donorOnHand: null,
        donorCoverDays: null,
      }),
    );
  }

  if (receivers.length === 0) {
    for (const donor of donors) {
      if (donor.surplus < MIN_ACTION_UNITS) continue;
      const position = row[donor.branchIndex];
      if (!position) continue;
      const economics = markdownEconomics(donor, price, cost, policy);
      const reasonCodes: ReasonCode[] = ["OVERSTOCK_COVER", "NO_RECEIVER", "MARKDOWN_CLEARANCE"];
      if (position.velocity === 0) reasonCodes.push("ZERO_VELOCITY");
      if (economics.carryingCostSaved > 0) reasonCodes.push("CARRYING_COST");
      drafts.push(
        draftFrom(position, "MARKDOWN", position.branchIndex, null, donor.surplus, {
          ...economics,
          transferCost: 0,
          reasonCodes,
          onHand: donor.onHand,
          coverDays: donor.coverDays,
          lostUnits: 0,
          donorOnHand: null,
          donorCoverDays: null,
        }),
      );
    }
  }

  return drafts;
}

function transferDraft(position: Position, transfer: TransferQuote): ActionDraft {
  const reasonCodes: ReasonCode[] = [
    "BELOW_REORDER_POINT",
    "RECEIVER_BELOW_TARGET",
    "DONOR_SURPLUS",
    "OVERSTOCK_COVER",
    "MIN_TRANSFER_MET",
  ];
  if (transfer.lostMarginAvoided > 0) reasonCodes.push("LOST_SALES_AT_RISK");
  if (transfer.carryingCostSaved > 0) reasonCodes.push("CARRYING_COST");
  if (transfer.freightLimited && transfer.quantity < transfer.needBefore) reasonCodes.push("FREIGHT_LIMITS_QTY");
  return draftFrom(position, "TRANSFER", transfer.receiverBranchIndex, transfer.donorBranchIndex, transfer.quantity, {
    netBenefit: transfer.netBenefit,
    lostMarginAvoided: transfer.lostMarginAvoided,
    carryingCostSaved: transfer.carryingCostSaved,
    transferCost: transfer.transferCost,
    markdownCost: 0,
    reasonCodes,
    onHand: transfer.receiverOnHandBefore,
    coverDays: coverDaysOf(transfer.receiverOnHandBefore, position.velocity),
    lostUnits: transfer.lostUnitsBefore,
    donorOnHand: transfer.donorOnHandBefore,
    donorCoverDays: transfer.donorCoverDaysBefore,
  });
}

function markdownEconomics(
  donor: PartyState,
  price: number,
  cost: number,
  policy: Policy,
): { netBenefit: number; lostMarginAvoided: number; carryingCostSaved: number; markdownCost: number } {
  const quantity = donor.surplus;
  const hold = holdingWindowDays(donor.coverDays, donor.velocity, policy);
  const sellPrice = price * (1 - policy.markdownDiscount);
  const fullPriceUnits = Math.min(quantity, donor.velocity * hold);
  const versusWaiting = quantity * (sellPrice - cost) - fullPriceUnits * (price - cost);
  const carryingCostSaved = round2(quantity * cost * policy.annualHoldingRate * (hold / policy.deadStockHoldDays));
  const lostMarginAvoided = versusWaiting > 0 ? round2(versusWaiting) : 0;
  const markdownCost = versusWaiting < 0 ? round2(-versusWaiting) : 0;
  const netBenefit = round2(lostMarginAvoided + carryingCostSaved - markdownCost);
  return { netBenefit, lostMarginAvoided, carryingCostSaved, markdownCost };
}

function toParty(position: Position, role: PartyState["role"]): PartyState {
  return {
    branchIndex: position.branchIndex,
    onHand: position.onHand,
    surplus: position.surplus,
    need: position.need,
    lostUnits: position.lostUnits,
    velocity: position.velocity,
    leadTimeDays: position.leadTimeDays,
    coverDays: position.coverDays,
    role,
  };
}

function draftFrom(
  position: Position,
  action: ActionDraft["action"],
  branchIndex: number,
  donorBranchIndex: number | null,
  quantity: number,
  money: {
    netBenefit: number;
    lostMarginAvoided: number;
    carryingCostSaved: number;
    transferCost: number;
    markdownCost: number;
    reasonCodes: ReasonCode[];
    onHand: number;
    coverDays: number | null;
    lostUnits: number;
    donorOnHand: number | null;
    donorCoverDays: number | null;
  },
): ActionDraft {
  return {
    action,
    skuIndex: position.skuIndex,
    branchIndex,
    donorBranchIndex,
    quantity,
    netBenefit: money.netBenefit,
    reasonCodes: money.reasonCodes,
    lostMarginAvoided: money.lostMarginAvoided,
    carryingCostSaved: money.carryingCostSaved,
    transferCost: money.transferCost,
    markdownCost: money.markdownCost,
    onHand: money.onHand,
    velocity: position.velocity,
    sigmaDemand: position.sigma,
    coverDays: money.coverDays,
    safetyStock: position.safetyStock,
    reorderPoint: position.reorderPoint,
    donorOnHand: money.donorOnHand,
    donorCoverDays: money.donorCoverDays,
    lostUnits: money.lostUnits,
  };
}

function compareDrafts(a: ActionDraft, b: ActionDraft): number {
  if (a.netBenefit !== b.netBenefit) return b.netBenefit - a.netBenefit;
  if (a.skuIndex !== b.skuIndex) return a.skuIndex - b.skuIndex;
  if (a.branchIndex !== b.branchIndex) return a.branchIndex - b.branchIndex;
  return a.action.localeCompare(b.action);
}

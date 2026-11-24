/**
 * Generates and ranks one morning's replenishment and clearance drafts across the whole network.
 * Inputs: Dataset, Policy, Forecaster strategy, Matcher strategy, dayIndex, optional onHandOverride.
 * Outputs: ActionDraft[] (TRANSFER, REORDER, MARKDOWN) sorted descending by netBenefit (BD).
 * Formula: TRANSFER via Matcher; residual AT_RISK -> REORDER up to max(14d*v, rop); OVERSTOCK with no receivers -> 30% MARKDOWN.
 * Units: BD (netBenefit, margin, carrying, transferCost, markdownCost), units, days, km, units/day.
 * Where used: engine/index.ts (planActions), report/recommendations.ts, backtest.ts.
 */
import type { Dataset } from "../seed/types.js";
import type { Branch, Policy, ReasonCode } from "../schemas/index.js";
import { BAHRAIN_BRANCHES } from "../seed/catalog.js";
import { round3 } from "../round.js";
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
  distanceKm: number | null;
  fixedTransferCost: number;
  distanceTransferCost: number;
  unitTransferCost: number;
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

const BAHRAIN_COORDS_BY_ID = new Map(
  BAHRAIN_BRANCHES.filter((b) => b.coordinates).map((b) => [b.id, b.coordinates!]),
);

// DECISION: fall back to static BAHRAIN_BRANCHES coordinates if a MongoDB branch document omits coordinates, preserving deterministic freight math on pre-coordinate fixtures.
function resolveCoordinates(branch: Branch | undefined): readonly [number, number] | undefined {
  if (!branch) return undefined;
  return branch.coordinates ?? BAHRAIN_COORDS_BY_ID.get(branch.id);
}

/**
 * Computes ranked TRANSFER, REORDER, and MARKDOWN drafts for all SKUs up to dayIndex.
 * Formula: assesses network positions -> matches donors/receivers per SKU -> emits fallback reorders/markdowns -> sorts by (netBenefit desc, skuIndex asc, branchIndex asc, action asc).
 * Example: 1 overstocked donor and 1 at-risk receiver -> 1 TRANSFER draft; 0 donors with 1 short receiver -> 1 REORDER draft.
 */
// DECISION: reorder and markdown fallback rules stay here, not inside Matcher, so swapping Matcher implementations cannot alter fallback inventory policy.
// IMPORTANT: the BD 9.500 service materiality cutoff stays outside this function so golden quantities and backtest moves stay invariant.
export function recommend(
  data: Dataset,
  policy: Policy,
  forecaster: Forecaster,
  matcher: Matcher,
  dayIndex: number,
  onHandOverride?: readonly (readonly number[])[],
): ActionDraft[] {
  const assessed = assessNetwork(data, policy, forecaster, dayIndex, onHandOverride);
  const branchCoords = data.branches.map((branch) => resolveCoordinates(branch));
  const drafts: ActionDraft[] = [];

  for (let skuIndex = 0; skuIndex < data.products.length; skuIndex += 1) {
    const product = data.products[skuIndex];
    const row = assessed[skuIndex];
    if (!product || !row) continue;
    drafts.push(...planSku(row, branchCoords, product.price, product.cost, product.leadTimeDays, policy, matcher));
  }

  drafts.sort(compareDrafts);
  return drafts;
}

function planSku(
  row: readonly Position[],
  branchCoords: readonly (readonly [number, number] | undefined)[],
  price: number,
  cost: number,
  leadTimeDays: number,
  policy: Policy,
  matcher: Matcher,
): ActionDraft[] {
  const receivers = row
    .filter((position) => position.status === "AT_RISK")
    .map((position) => toParty(position, "receiver", branchCoords[position.branchIndex]));
  const donors = row
    .filter((position) => position.status === "OVERSTOCK" && position.surplus > 0)
    .map((position) => toParty(position, "donor", branchCoords[position.branchIndex]));
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
    // DECISION: reorder fallback targets max(14d cover, reorderPoint) rather than 14d alone so volatile high-safety-stock SKUs replenish past their reorder trigger on supplier delivery.
    const target = Math.max(policy.receiverCoverDays * position.velocity, position.reorderPoint);
    const quantity = Math.ceil(target - receiver.onHand);
    if (quantity <= 0) continue;
    const lostUnitsNow = Math.max(0, position.velocity * leadTimeDays - receiver.onHand);
    // DECISION: supplier reorders credit only lead-time lostMarginAvoided (0 carrying savings, 0 freight) because incoming purchase orders add fresh inventory rather than liquidating existing excess.
    const lostMarginAvoided = round3(Math.min(quantity, lostUnitsNow) * (price - cost));
    const reasonCodes: ReasonCode[] = ["BELOW_REORDER_POINT", "REORDER_TO_TARGET"];
    if (donors.length === 0 || !received.has(receiver.branchIndex)) reasonCodes.push("NO_DONOR");
    if (lostMarginAvoided > 0) reasonCodes.push("LOST_SALES_AT_RISK");
    drafts.push(
      draftFrom(position, "REORDER", position.branchIndex, null, quantity, {
        netBenefit: lostMarginAvoided,
        lostMarginAvoided,
        carryingCostSaved: 0,
        transferCost: 0,
        distanceKm: null,
        fixedTransferCost: 0,
        distanceTransferCost: 0,
        unitTransferCost: 0,
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

  // DECISION: emit MARKDOWN only when zero network receivers exist for the SKU; otherwise prioritize transfers over discounting stock another branch still needs.
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
          distanceKm: null,
          fixedTransferCost: 0,
          distanceTransferCost: 0,
          unitTransferCost: 0,
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
    distanceKm: transfer.distanceKm,
    fixedTransferCost: transfer.fixedTransferCost,
    distanceTransferCost: transfer.distanceTransferCost,
    unitTransferCost: transfer.unitTransferCost,
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
  const carryingCostSaved = round3(quantity * cost * policy.annualHoldingRate * (hold / policy.deadStockHoldDays));
  const lostMarginAvoided = versusWaiting > 0 ? round3(versusWaiting) : 0;
  const markdownCost = versusWaiting < 0 ? round3(-versusWaiting) : 0;
  const netBenefit = round3(lostMarginAvoided + carryingCostSaved - markdownCost);
  return { netBenefit, lostMarginAvoided, carryingCostSaved, markdownCost };
}

function toParty(
  position: Position,
  role: PartyState["role"],
  coordinates?: readonly [number, number],
): PartyState {
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
    ...(coordinates ? { coordinates } : {}),
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
    distanceKm: number | null;
    fixedTransferCost: number;
    distanceTransferCost: number;
    unitTransferCost: number;
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
    distanceKm: money.distanceKm,
    fixedTransferCost: money.fixedTransferCost,
    distanceTransferCost: money.distanceTransferCost,
    unitTransferCost: money.unitTransferCost,
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

// DECISION: canonical sort order (netBenefit desc -> skuIndex asc -> branchIndex asc -> action asc) keeps golden snapshots and UI ranks total-ordered even on exact BD ties.
function compareDrafts(a: ActionDraft, b: ActionDraft): number {
  if (a.netBenefit !== b.netBenefit) return b.netBenefit - a.netBenefit;
  if (a.skuIndex !== b.skuIndex) return a.skuIndex - b.skuIndex;
  if (a.branchIndex !== b.branchIndex) return a.branchIndex - b.branchIndex;
  return a.action.localeCompare(b.action);
}

/**
 * Pairs surplus sending branches with AT_RISK receiving branches for a single SKU.
 * Inputs: receiver PartyState[], donor PartyState[], and MatchCosts (unitPrice, unitCost, policy).
 * Outputs: MatchResult with greedy transfer quotes (BD + units + km) and residual unmet receivers.
 * Formula: netBenefit = round3(lostMarginAvoided + carryingCostSaved - TotalTransferCost(Q, D)),
 *   where TotalTransferCost(Q, D) = C_fixed + (C_km * D_km) + (C_unit * Q).
 * Units: money in BD (round3), distance in km (round2), quantities in whole units, time in days.
 * Where used: recommend.ts (planSku), engine/index.ts.
 */
import type { Policy } from "../schemas/index.js";
import { round2, round3 } from "../round.js";
import { haversineDistanceKm } from "../seed/catalog.js";
import { totalTransferCostBreakdown } from "./config.js";
import { holdingWindowDays } from "./classify.js";
import type { MatchCosts, MatchResult, Matcher, PartyState, TransferQuote } from "./strategies.js";

interface Quote {
  quantity: number;
  netBenefit: number;
  lostMarginAvoided: number;
  carryingCostSaved: number;
  transferCost: number;
  distanceKm: number;
  fixedTransferCost: number;
  distanceTransferCost: number;
  unitTransferCost: number;
  freightLimited: boolean;
}

/**
 * Default greedy inter-branch transfer matcher iterating highest positive net benefit pairs per SKU.
 * Formula: picks pair with max netBenefit (> 0) and Q >= minTransferQty, deducts moved stock, and repeats.
 * Example: donor surplus 240, receiver need 60 (lostUnits 25), price BD 400, cost BD 200 -> transfers 60 units for BD 6,315 + carrying - freight.
 */
// DECISION: greedy highest net benefit, tie-broken by lower branch index, over a min-cost-flow LP solver so every quote explains its exact pair math; rejected global solver because optimal matching shifts on every partial fulfillment.
// SCALE: O(B^2 * K) quadratic in branch count per SKU; at 100x branches (~1,500 stores), swap greedyMatcher for min-cost flow via the Matcher interface.
export const greedyMatcher: Matcher = {
  match(receivers, donors, costs): MatchResult {
    const receiverCopies = receivers.map(cloneParty);
    if (receivers.length === 0 || donors.length === 0) {
      return { transfers: [], receivers: receiverCopies };
    }

    const width = Math.max(widthOf(receivers), widthOf(donors));
    const slots: Array<PartyState | undefined> = Array.from({ length: width }, () => undefined);
    for (const receiver of receiverCopies) slots[receiver.branchIndex] = receiver;
    for (const donor of donors) slots[donor.branchIndex] = cloneParty(donor);

    const transfers: TransferQuote[] = [];
    for (;;) {
      const best = bestTransfer(slots, costs);
      if (!best || best.quote.netBenefit <= 0) break;
      const donor = slots[best.donorIndex];
      const receiver = slots[best.receiverIndex];
      if (!donor || !receiver) break;
      transfers.push({
        donorBranchIndex: best.donorIndex,
        receiverBranchIndex: best.receiverIndex,
        quantity: best.quote.quantity,
        netBenefit: best.quote.netBenefit,
        lostMarginAvoided: best.quote.lostMarginAvoided,
        carryingCostSaved: best.quote.carryingCostSaved,
        transferCost: best.quote.transferCost,
        distanceKm: best.quote.distanceKm,
        fixedTransferCost: best.quote.fixedTransferCost,
        distanceTransferCost: best.quote.distanceTransferCost,
        unitTransferCost: best.quote.unitTransferCost,
        freightLimited: best.quote.freightLimited,
        receiverOnHandBefore: receiver.onHand,
        donorOnHandBefore: donor.onHand,
        donorCoverDaysBefore: donor.coverDays,
        lostUnitsBefore: receiver.lostUnits,
        needBefore: receiver.need,
      });
      applyTransfer(donor, receiver, best.quote.quantity, costs.policy);
    }

    return { transfers, receivers: receiverCopies };
  },
};

function bestTransfer(
  slots: readonly (PartyState | undefined)[],
  costs: MatchCosts,
): { donorIndex: number; receiverIndex: number; quote: Quote } | null {
  let best: { donorIndex: number; receiverIndex: number; quote: Quote } | null = null;
  for (let donorIndex = 0; donorIndex < slots.length; donorIndex += 1) {
    const donor = slots[donorIndex];
    if (!donor || donor.role !== "donor" || donor.surplus < costs.policy.minTransferQty) continue;
    for (let receiverIndex = 0; receiverIndex < slots.length; receiverIndex += 1) {
      const receiver = slots[receiverIndex];
      if (!receiver || receiver.role !== "receiver" || receiver.need < 1) continue;
      const quote = quoteTransfer(donor, receiver, costs);
      if (!quote) continue;
      // DECISION: break equal-net-benefit ties deterministically (netBenefit desc -> receiverIndex asc -> donorIndex asc) instead of insertion/hash order so queue rankings never flicker across runs.
      if (
        !best ||
        quote.netBenefit > best.quote.netBenefit ||
        (quote.netBenefit === best.quote.netBenefit && receiverIndex < best.receiverIndex) ||
        (quote.netBenefit === best.quote.netBenefit &&
          receiverIndex === best.receiverIndex &&
          donorIndex < best.donorIndex)
      ) {
        best = { donorIndex, receiverIndex, quote };
      }
    }
  }
  return best;
}

function quoteTransfer(donor: PartyState, receiver: PartyState, costs: MatchCosts): Quote | null {
  const qMax = Math.min(donor.surplus, receiver.need);
  const excessDays = holdingWindowDays(donor.coverDays, donor.velocity, costs.policy);
  const carryPerUnit =
    costs.unitCost * costs.policy.annualHoldingRate * (excessDays / costs.policy.deadStockHoldDays);
  // DECISION: when marginal holding cost saved per unit <= BD 0.250 handling fee, cap transfer qty at floor(lostUnits) instead of qMax so buffer units beyond immediate stockout risk do not lose money on handling.
  const freightLimited = carryPerUnit - costs.policy.transferCostPerUnit <= 0;
  const quantity = freightLimited ? Math.min(qMax, Math.floor(receiver.lostUnits)) : qMax;
  // IMPORTANT: enforce minimum transfer lot (5 units) and positive net benefit before emitting a quote; moving 1-4 units wastes fixed BD 1.500 dispatch cost.
  if (quantity < costs.policy.minTransferQty) return null;

  // IMPORTANT: fall back to 0 km (fixed + per-unit freight only) if a branch lacks coordinates rather than rejecting valid stock moves.
  const distanceKm =
    donor.coordinates && receiver.coordinates
      ? round2(haversineDistanceKm(donor.coordinates, receiver.coordinates))
      : 0;
  const freight = totalTransferCostBreakdown(quantity, distanceKm, costs.policy);
  const margin = costs.price - costs.unitCost;
  // DECISION: cap avoided lost margin at min(Q, lostUnits) * margin because units shipped above lead-time shortage build buffer stock rather than saving immediate sales.
  const lostMarginAvoided = round3(Math.min(quantity, receiver.lostUnits) * margin);
  // DECISION: carryPerUnit uses excessDays capped at 365 days in holdingWindowDays() so holding savings stay bounded to one accounting year.
  const carryingCostSaved = round3(quantity * carryPerUnit);
  const transferCost = freight.totalCost;
  const netBenefit = round3(lostMarginAvoided + carryingCostSaved - transferCost);
  if (netBenefit <= 0) return null;
  return {
    quantity,
    netBenefit,
    lostMarginAvoided,
    carryingCostSaved,
    transferCost,
    distanceKm,
    fixedTransferCost: freight.fixedCost,
    distanceTransferCost: freight.distanceCost,
    unitTransferCost: freight.unitCost,
    freightLimited,
  };
}

function applyTransfer(donor: PartyState, receiver: PartyState, quantity: number, policy: Policy): void {
  donor.onHand -= quantity;
  donor.surplus -= quantity;
  donor.coverDays = coverAfter(donor.onHand, donor.velocity);
  receiver.onHand += quantity;
  const target = policy.receiverCoverDays * receiver.velocity;
  receiver.need = Math.max(0, Math.ceil(target - receiver.onHand));
  receiver.lostUnits = Math.max(0, receiver.velocity * receiver.leadTimeDays - receiver.onHand);
}

function coverAfter(onHand: number, velocity: number): number | null {
  if (velocity <= 0) return onHand > 0 ? null : 0;
  return onHand / velocity;
}

function cloneParty(party: PartyState): PartyState {
  return { ...party };
}

function widthOf(parties: readonly PartyState[]): number {
  return parties.reduce((max, party) => Math.max(max, party.branchIndex + 1), 0);
}

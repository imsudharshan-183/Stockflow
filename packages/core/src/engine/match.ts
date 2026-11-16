/**
 * Pairs surplus with shortage.
 * Inputs: receiver need, donor surplus, price, cost, and branch coordinates.
 * Output: ordered transfers and the receivers' stock after them.
 * Formula: net benefit = lost margin avoided + carrying cost saved - TotalTransferCost(Q, D),
 * where TotalTransferCost(Q, D) = C_fixed + (C_km * D) + (C_unit * Q).
 * Marginal quantity stops where another unit saves less holding cost than C_unit.
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

// DECISION: greedy highest net benefit, tie-broken by lower branch index, instead of a solver. Optimal matching needs a new matrix each time stock moves.
// SCALE: pairs are per SKU. 100x branches makes this loop quadratic, which is the point to switch to min-cost flow.
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
  const freightLimited = carryPerUnit - costs.policy.transferCostPerUnit <= 0;
  const quantity = freightLimited ? Math.min(qMax, Math.floor(receiver.lostUnits)) : qMax;
  if (quantity < costs.policy.minTransferQty) return null;

  const distanceKm =
    donor.coordinates && receiver.coordinates
      ? round2(haversineDistanceKm(donor.coordinates, receiver.coordinates))
      : 0;
  const freight = totalTransferCostBreakdown(quantity, distanceKm, costs.policy);
  const margin = costs.price - costs.unitCost;
  const lostMarginAvoided = round3(Math.min(quantity, receiver.lostUnits) * margin);
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

/**
 * Strategy interfaces (seams) decoupling forecasting and matching from the planning pipeline.
 * Inputs: DemandHistory/ForecastContext for Forecaster; PartyState[] and MatchCosts for Matcher.
 * Outputs: DemandEstimate and MatchResult (transfers + leftover receivers).
 * Formula: none directly (contract only; implementations supply EWMA/safety stock and BD net-benefit transfer math).
 * Units: units, days, units/day, BD (in MatchCosts price/unitCost and TransferQuote money fields), km.
 * Where used: velocity.ts, match.ts, classify.ts, recommend.ts, index.ts.
 */
// DECISION: Forecaster and Matcher live in a separate interface module so swapping in Croston/Holt-Winters or min-cost flow never changes recommend() or report DTOs.
import type { Policy } from "../schemas/index.js";

export interface DemandHistory {
  readonly sales: readonly number[];
  readonly onHand: readonly number[];
}

export interface ForecastContext {
  readonly alpha: number;
  readonly leadTimeDays: number;
  readonly serviceZ: number;
}

export interface DemandEstimate {
  readonly velocity: number;
  readonly sigma: number;
  readonly inStockDays: number;
  readonly safetyStock: number;
  readonly reorderPoint: number;
}

export interface Forecaster {
  estimateDemand(history: DemandHistory, ctx: ForecastContext): DemandEstimate;
}

export interface PartyState {
  branchIndex: number;
  onHand: number;
  surplus: number;
  need: number;
  lostUnits: number;
  velocity: number;
  leadTimeDays: number;
  coverDays: number | null;
  role: "receiver" | "donor";
  coordinates?: readonly [number, number];
}

export interface MatchCosts {
  price: number;
  unitCost: number;
  policy: Policy;
}

export interface TransferQuote {
  donorBranchIndex: number;
  receiverBranchIndex: number;
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
  receiverOnHandBefore: number;
  donorOnHandBefore: number;
  donorCoverDaysBefore: number | null;
  lostUnitsBefore: number;
  needBefore: number;
}

export interface MatchResult {
  transfers: TransferQuote[];
  receivers: PartyState[];
}

export interface Matcher {
  match(receivers: readonly PartyState[], donors: readonly PartyState[], costs: MatchCosts): MatchResult;
}

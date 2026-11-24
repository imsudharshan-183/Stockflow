/**
 * Default-strategy entry points and public barrel exports for the pure planning engine.
 * Inputs: Dataset, Policy, optional dayIndex and onHandOverride.
 * Outputs: Position[][] (assessPositions), ActionDraft[] (planActions), BacktestResult (backtest), plus strategy/projection helpers.
 * Formula: binds ewmaForecaster + greedyMatcher onto assessNetwork and recommend.
 * Units: BD for monetary outputs, units, days, km, units/day.
 * Where used: packages/core/src/report/*, packages/core/src/index.ts, apps/api, apps/web.
 */
import type { Dataset } from "../seed/types.js";
import type { Policy } from "../schemas/index.js";
import { assessNetwork, type Position } from "./classify.js";
import { greedyMatcher } from "./match.js";
import { recommend, type ActionDraft } from "./recommend.js";
import { ewmaForecaster } from "./velocity.js";

/**
 * Evaluates branch-SKU inventory positions using the default 28-day EWMA forecaster.
 * Formula: assessNetwork(data, policy, ewmaForecaster, dayIndex, onHandOverride).
 * Example: assessPositions(dataset, DEFAULT_POLICY) -> Position[500][15] for 500 SKUs x 15 Bahrain branches.
 */
export function assessPositions(
  data: Dataset,
  policy: Policy,
  dayIndex = data.dates.length,
  onHandOverride?: readonly (readonly number[])[],
): Position[][] {
  return assessNetwork(data, policy, ewmaForecaster, dayIndex, onHandOverride);
}

/**
 * Computes ranked morning action drafts using the default EWMA forecaster and greedy matcher.
 * Formula: recommend(data, policy, ewmaForecaster, greedyMatcher, dayIndex, onHandOverride).
 * Example: planActions(dataset, DEFAULT_POLICY) -> sorted TRANSFER / REORDER / MARKDOWN drafts.
 */
export function planActions(
  data: Dataset,
  policy: Policy,
  dayIndex = data.dates.length,
  onHandOverride?: readonly (readonly number[])[],
): ActionDraft[] {
  return recommend(data, policy, ewmaForecaster, greedyMatcher, dayIndex, onHandOverride);
}

export { backtest } from "./backtest.js";
export {
  DEAD_VELOCITY_PER_DAY,
  DEFAULT_POLICY,
  MATERIAL_MIN_NET_BENEFIT,
  STOCKOUT_RATE_DAYS,
  TRANSFER_COST_PER_KM,
  TRANSFER_COST_PER_UNIT,
  TRANSFER_FIXED_COST,
  ewmaAlpha,
  totalTransferCost,
  totalTransferCostBreakdown,
} from "./config.js";
export type { TransferCostBreakdown } from "./config.js";
export { coverDaysOf } from "./classify.js";
export type { Position } from "./classify.js";
export type { ActionDraft } from "./recommend.js";
export type { Forecaster, Matcher } from "./strategies.js";
export { ewma, isStockoutDay, sampleStdev, wasInStock } from "./velocity.js";
export { recommend } from "./recommend.js";
export { ewmaForecaster } from "./velocity.js";
export { greedyMatcher } from "./match.js";
export {
  ZERO_DELTA,
  deltaKey,
  getCommittedDelta,
  project,
  projectPosition,
} from "./projection.js";
export type { CommittedDelta, CommittedDeltaStore, ProjectedPosition } from "./projection.js";
export { rankDonorCandidates } from "./donorRanking.js";
export type { RankDonorCandidatesOptions } from "./donorRanking.js";
export { computeActionBenefitForQuantity } from "./quantityBenefit.js";
export type {
  ActionQuantityBenefitInput,
  ActionQuantityBenefitResult,
} from "./quantityBenefit.js";

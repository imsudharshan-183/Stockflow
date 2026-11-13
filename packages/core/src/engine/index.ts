/**
 * Binds the default forecaster and matcher so callers keep the original function signatures.
 * Inputs: dataset and policy. Output: positions or action drafts.
 * Formula: EWMA forecast, then greedy match, then reorder and markdown fallbacks.
 */
import type { Dataset } from "../seed/types.js";
import type { Policy } from "../schemas/index.js";
import { assessNetwork, type Position } from "./classify.js";
import { greedyMatcher } from "./match.js";
import { recommend, type ActionDraft } from "./recommend.js";
import { ewmaForecaster } from "./velocity.js";

export function assessPositions(
  data: Dataset,
  policy: Policy,
  dayIndex = data.dates.length,
  onHandOverride?: readonly (readonly number[])[],
): Position[][] {
  return assessNetwork(data, policy, ewmaForecaster, dayIndex, onHandOverride);
}

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
  ewmaAlpha,
} from "./config.js";
export { coverDaysOf } from "./classify.js";
export type { Position } from "./classify.js";
export type { ActionDraft } from "./recommend.js";
export type { Forecaster, Matcher } from "./strategies.js";
export { ewma, isStockoutDay, sampleStdev, wasInStock } from "./velocity.js";
export { recommend } from "./recommend.js";
export { ewmaForecaster } from "./velocity.js";
export { greedyMatcher } from "./match.js";

/**
 * Pure post-plan stock overlay projecting human commitments and floor adjustments onto immutable engine positions.
 * Inputs: raw Position, CommittedDelta { reserved, inTransit, adjustment }, Policy.
 * Outputs: ProjectedPosition with updated onHand, coverDays, status, surplus, need, lostUnits, reserved, inTransit.
 * Formula: onHand = max(0, raw.onHand - reserved + adjustment); effectiveStock = onHand + inTransit; cover = effectiveStock / v.
 * Units: units, days, units/day (no BD currency computation).
 * Where used: apps/api projection/KPI/order services, engine/donorRanking.ts, engine/index.ts.
 */
import type { Policy, PositionStatus } from "../schemas/index.js";
import { coverDaysOf, type Position } from "./classify.js";
import { DEFAULT_POLICY } from "./config.js";

export interface CommittedDelta {
  reserved: number;
  inTransit: number;
  adjustment?: number;
}

export interface ProjectedPosition extends Position {
  reserved: number;
  inTransit: number;
  adjustment?: number;
}

export type CommittedDeltaStore =
  | ReadonlyMap<string, CommittedDelta>
  | Readonly<Record<string, CommittedDelta>>;

export const ZERO_DELTA: CommittedDelta = { reserved: 0, inTransit: 0 };

/**
 * Builds the canonical composite lookup key for a SKU at a branch.
 * Formula: `${sku}::${branchId}`.
 * Example: deltaKey("SKU-00012", "BR-001") === "SKU-00012::BR-001".
 */
export function deltaKey(sku: string, branchId: string): string {
  return `${sku}::${branchId}`;
}

/**
 * Reads committed reservation/in-transit/adjustment deltas for a branch-SKU pair from either a Map or plain record.
 * Formula: lookup(deltas, `${sku}::${branchId}`) ?? { reserved: 0, inTransit: 0 }.
 * Example: getCommittedDelta(new Map(), "SKU-00012", "BR-001") -> ZERO_DELTA.
 */
export function getCommittedDelta(
  deltas: CommittedDeltaStore,
  sku: string,
  branchId: string,
): CommittedDelta {
  const key = deltaKey(sku, branchId);
  if (deltas instanceof Map || typeof (deltas as { get?: unknown }).get === "function") {
    return (deltas as ReadonlyMap<string, CommittedDelta>).get(key) ?? ZERO_DELTA;
  }
  return (deltas as Readonly<Record<string, CommittedDelta>>)[key] ?? ZERO_DELTA;
}

/**
 * Applies committed outbound reservations, inbound in-transit stock, and stock adjustments without mutating raw engine positions.
 * Formula: onHand = max(0, raw.onHand - reserved + adjustment); effectiveStock = onHand + inTransit; surplus = floor(max(0, onHand - floor)).
 * Example: raw.onHand = 300 (surplus 240), reserved = 40 -> onHand = 260, surplus = 200; receiver onHand = 10, inTransit = 40 -> effective = 50.
 */
// IMPORTANT: only committed/adjusted states appear here; SUGGESTED/AWAITING_DONOR never alter committedDeltas, and overstock check intentionally excludes inTransit.
export function projectPosition(
  rawPosition: Position,
  deltas: CommittedDelta = ZERO_DELTA,
  policy: Policy = DEFAULT_POLICY,
): ProjectedPosition {
  const reserved = Math.max(0, deltas.reserved);
  const inTransit = Math.max(0, deltas.inTransit);
  const adjustment = deltas.adjustment ?? 0;
  if (reserved === 0 && inTransit === 0 && adjustment === 0) {
    return { ...rawPosition, reserved: 0, inTransit: 0 };
  }

  const onHand = Math.max(0, rawPosition.onHand - reserved + adjustment);
  const effectiveStock = onHand + inTransit;
  const coverDays = coverDaysOf(effectiveStock, rawPosition.velocity);
  const onHandCoverDays = coverDaysOf(onHand, rawPosition.velocity);

  let status: PositionStatus = rawPosition.status;
  if (rawPosition.inStockDays === 0) {
    status = "NEW";
  } else {
    const overstock =
      onHandCoverDays === null ? onHand > 0 : onHandCoverDays > policy.overstockCoverDays;
    if (overstock) {
      status = "OVERSTOCK";
    } else if (effectiveStock < rawPosition.reorderPoint) {
      status = "AT_RISK";
    } else {
      status = "HEALTHY";
    }
  }

  let surplus: number;
  let need: number;
  let lostUnits: number;
  if (adjustment === 0) {
    surplus = Math.max(0, rawPosition.surplus - reserved);
    need = status === "AT_RISK" ? Math.max(0, rawPosition.need - inTransit) : 0;
    lostUnits = status === "AT_RISK" ? Math.max(0, rawPosition.lostUnits - inTransit) : 0;
  } else {
    const floor = policy.donorCoverDays * rawPosition.velocity + rawPosition.safetyStock;
    surplus = status === "OVERSTOCK" ? Math.max(0, Math.floor(onHand - floor)) : 0;
    need =
      status === "AT_RISK"
        ? Math.max(0, Math.ceil(policy.receiverCoverDays * rawPosition.velocity - effectiveStock))
        : 0;
    lostUnits =
      status === "AT_RISK"
        ? Math.max(0, rawPosition.velocity * rawPosition.leadTimeDays - effectiveStock)
        : 0;
  }

  return {
    ...rawPosition,
    onHand,
    coverDays,
    status,
    surplus,
    need,
    lostUnits,
    reserved,
    inTransit,
    ...(adjustment !== 0 ? { adjustment } : {}),
  };
}

export const project = projectPosition;

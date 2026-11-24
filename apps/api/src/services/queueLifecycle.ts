import type {
  ActionMetaRecord,
  DecisionSnapshot,
  QueueLifecycleView,
  ReopenBadge,
  ReplenishmentOrder,
} from "@stockflow/core";
import type { QueueLifecycleConfig } from "../config/queueLifecycle.js";
import type { OrderLifecycleMeta } from "../repositories/types.js";

const DAY_MS = 86_400_000;

export interface LifecycleEvaluation {
  bucket: QueueLifecycleView;
  reopenBadge: ReopenBadge | null;
  canReopen: boolean;
  decidedAt: string | null;
  rejectedUntil: string | null;
  effectiveStatus: "PENDING" | "APPROVED" | "REJECTED";
}

// DECISION: Break the 3-day decline snooze early only on a +/-50% deterioration so transient daily noise
// does not re-nag buyers, while genuine stockout spikes surface for immediate re-evaluation.
function isWorsened(
  currentNetBenefit: number,
  currentCoverDays: number | null,
  snapshot?: DecisionSnapshot | null,
): boolean {
  if (!snapshot) return false;
  if (snapshot.netBenefit > 0 && currentNetBenefit >= snapshot.netBenefit * 1.5) {
    return true;
  }
  if (
    snapshot.targetCoverDays !== null &&
    snapshot.targetCoverDays > 0 &&
    currentCoverDays !== null &&
    currentCoverDays <= snapshot.targetCoverDays * 0.5
  ) {
    return true;
  }
  return false;
}

// DECISION: Lifecycle buckets (pending / in_progress / decided) and 24h reopen eligibility are computed
// on read using the injectable `nowMs` clock rather than cron mutations—avoiding DB write races and dataVersion bumps.
export function evaluateDecisionLifecycle(params: {
  recExists: boolean;
  currentNetBenefit: number;
  currentCoverDays: number | null;
  actionMeta?: ActionMetaRecord;
  order?: ReplenishmentOrder;
  orderMeta?: OrderLifecycleMeta;
  latestReasonText?: string;
  nowMs: number;
  config: QueueLifecycleConfig;
}): LifecycleEvaluation {
  const {
    recExists,
    currentNetBenefit,
    currentCoverDays,
    actionMeta,
    order,
    orderMeta,
    latestReasonText,
    nowMs,
    config,
  } = params;

  const reopenWindowMs = config.reopenWindowHours * 3_600_000;

  // 1. Persisted ReplenishmentOrder takes precedence when not reopened.
  if (order && !order.isVirtual) {
    const orderReopenedAt = orderMeta?.reopenedAt ?? actionMeta?.reopenedAt ?? null;
    if (orderReopenedAt && orderReopenedAt >= order.updatedAt) {
      return {
        bucket: "pending",
        reopenBadge: null,
        canReopen: false,
        decidedAt: null,
        rejectedUntil: null,
        effectiveStatus: "PENDING",
      };
    }

    if (order.status === "OPEN_REQUEST" || order.status === "SUGGESTED") {
      return {
        bucket: "pending",
        reopenBadge: null,
        canReopen: false,
        decidedAt: null,
        rejectedUntil: null,
        effectiveStatus: "PENDING",
      };
    }

    // Active workflow orders remain In Progress until RECEIVED.
    // Migrated legacy approvals (single MIGRATED event) still follow APPROVED_ACTIVE_DAYS.
    if (order.status === "AWAITING_DONOR" || order.status === "COMMITTED") {
      const refIso = order.committedAt ?? order.awaitingDonorSince ?? order.updatedAt;
      const refMs = Date.parse(refIso);
      const isMigratedLegacyOnly =
        order.origin === "ENGINE" &&
        order.events.length === 1 &&
        order.events[0]?.action === "MIGRATED";
      // Un-reopened workflow orders stay In Progress until RECEIVED so cross-branch dispatch never
      // silently drops off the active queue; migrated legacy approvals still age out at APPROVED_ACTIVE_DAYS.
      const bucket: QueueLifecycleView =
        isMigratedLegacyOnly &&
        Number.isFinite(refMs) &&
        nowMs - refMs >= config.approvedActiveDays * DAY_MS
          ? "decided"
          : "in_progress";
      // Enforce 24h reopen cutoff from commit/request timestamp so settled fulfillment cannot be undone later.
      const canReopen = Number.isFinite(refMs) ? nowMs - refMs <= reopenWindowMs : false;
      return {
        bucket,
        reopenBadge: null,
        canReopen,
        decidedAt: refIso,
        rejectedUntil: null,
        effectiveStatus: "APPROVED",
      };
    }

    if (order.status === "RECEIVED" || order.status === "CANCELLED") {
      const refIso = order.receivedAt ?? order.updatedAt;
      const refMs = Date.parse(refIso);
      const canReopen =
        order.status === "CANCELLED" && Number.isFinite(refMs)
          ? nowMs - refMs <= reopenWindowMs
          : false;
      return {
        bucket: "decided",
        reopenBadge: null,
        canReopen,
        decidedAt: refIso,
        rejectedUntil: null,
        effectiveStatus: order.status === "RECEIVED" ? "APPROVED" : "REJECTED",
      };
    }

    if (order.status === "REJECTED") {
      const decidedIso = order.updatedAt;
      const decidedMs = Date.parse(decidedIso);
      const snapshot = orderMeta?.rejectionSnapshot ?? actionMeta?.snapshot ?? null;
      const rejectedUntilIso =
        orderMeta?.rejectedUntil ??
        actionMeta?.rejectedUntil ??
        (Number.isFinite(decidedMs)
          ? new Date(decidedMs + config.rejectSnoozeDays * DAY_MS).toISOString()
          : null);
      const rejectedUntilMs = rejectedUntilIso ? Date.parse(rejectedUntilIso) : NaN;
      const lastComment = [...order.events].reverse().find((e) => e.comment?.trim())?.comment;
      const reason =
        lastComment ??
        latestReasonText ??
        actionMeta?.comment ??
        actionMeta?.reasonCode ??
        "Declined";

      if (recExists && isWorsened(currentNetBenefit, currentCoverDays, snapshot)) {
        return {
          bucket: "pending",
          reopenBadge: { kind: "worsened", label: "Situation worsened" },
          canReopen: false,
          decidedAt: decidedIso,
          rejectedUntil: rejectedUntilIso,
          effectiveStatus: "PENDING",
        };
      }

      if (recExists && Number.isFinite(rejectedUntilMs) && nowMs >= rejectedUntilMs) {
        const daysAgo = Number.isFinite(decidedMs)
          ? Math.max(1, Math.floor((nowMs - decidedMs) / DAY_MS))
          : Math.round(config.rejectSnoozeDays);
        return {
          bucket: "pending",
          reopenBadge: {
            kind: "snooze_expired",
            daysAgo,
            reason,
            label: `Rejected ${daysAgo} ${daysAgo === 1 ? "day" : "days"} ago: ${reason}`,
          },
          canReopen: false,
          decidedAt: decidedIso,
          rejectedUntil: rejectedUntilIso,
          effectiveStatus: "PENDING",
        };
      }

      const canReopen = Number.isFinite(decidedMs) ? nowMs - decidedMs <= reopenWindowMs : false;
      return {
        bucket: "decided",
        reopenBadge: null,
        canReopen,
        decidedAt: decidedIso,
        rejectedUntil: rejectedUntilIso,
        effectiveStatus: "REJECTED",
      };
    }
  }

  // 2. Legacy ActionRecord lifecycle (when not reopened or no active persisted order).
  if (actionMeta && (!actionMeta.reopenedAt || actionMeta.reopenedAt < actionMeta.decidedAt)) {
    const decidedMs = Date.parse(actionMeta.decidedAt);
    const canReopen = Number.isFinite(decidedMs) ? nowMs - decidedMs <= reopenWindowMs : false;

    if (actionMeta.status === "APPROVED") {
      const activeMs = config.approvedActiveDays * DAY_MS;
      const isActive = Number.isFinite(decidedMs) && nowMs - decidedMs < activeMs;
      return {
        bucket: isActive ? "in_progress" : "decided",
        reopenBadge: null,
        canReopen,
        decidedAt: actionMeta.decidedAt,
        rejectedUntil: null,
        effectiveStatus: "APPROVED",
      };
    }

    if (actionMeta.status === "REJECTED") {
      const rejectedUntilIso =
        actionMeta.rejectedUntil ??
        (Number.isFinite(decidedMs)
          ? new Date(decidedMs + config.rejectSnoozeDays * DAY_MS).toISOString()
          : null);
      const rejectedUntilMs = rejectedUntilIso ? Date.parse(rejectedUntilIso) : NaN;
      const reason =
        actionMeta.comment?.trim() ||
        actionMeta.reasonCode?.trim() ||
        latestReasonText ||
        "Rejected";

      if (recExists && isWorsened(currentNetBenefit, currentCoverDays, actionMeta.snapshot)) {
        return {
          bucket: "pending",
          reopenBadge: { kind: "worsened", label: "Situation worsened" },
          canReopen: false,
          decidedAt: actionMeta.decidedAt,
          rejectedUntil: rejectedUntilIso,
          effectiveStatus: "PENDING",
        };
      }

      if (recExists && Number.isFinite(rejectedUntilMs) && nowMs >= rejectedUntilMs) {
        const daysAgo = Number.isFinite(decidedMs)
          ? Math.max(1, Math.floor((nowMs - decidedMs) / DAY_MS))
          : Math.round(config.rejectSnoozeDays);
        return {
          bucket: "pending",
          reopenBadge: {
            kind: "snooze_expired",
            daysAgo,
            reason,
            label: `Rejected ${daysAgo} ${daysAgo === 1 ? "day" : "days"} ago: ${reason}`,
          },
          canReopen: false,
          decidedAt: actionMeta.decidedAt,
          rejectedUntil: rejectedUntilIso,
          effectiveStatus: "PENDING",
        };
      }

      return {
        bucket: "decided",
        reopenBadge: null,
        canReopen,
        decidedAt: actionMeta.decidedAt,
        rejectedUntil: rejectedUntilIso,
        effectiveStatus: "REJECTED",
      };
    }
  }

  // 3. Undecided or reopened -> Pending
  return {
    bucket: "pending",
    reopenBadge: null,
    canReopen: false,
    decidedAt: null,
    rejectedUntil: null,
    effectiveStatus: "PENDING",
  };
}

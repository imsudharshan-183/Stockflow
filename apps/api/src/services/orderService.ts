import { randomUUID } from "node:crypto";
import {
  DEFAULT_DONOR_ESCALATION_HOURS,
  DEFAULT_POLICY,
  OrderEventSchema,
  OrderListResponseSchema,
  ReplenishmentOrderSchema,
  can,
  canTransition,
  coverDaysOf,
  haversineDistanceKm,
  rankDonorCandidates,
  round2,
  round4,
  type ActorRef,
  type Branch,
  type CreateOrderRequest,
  type DonorCandidate,
  type OrderCancelBody,
  type OrderCommitBody,
  type OrderDeclineBody,
  type OrderListQuery,
  type OrderListResponse,
  type OrderOrigin,
  type OrderReceiveBody,
  type OrderRequestTransferBody,
  type OrderRerouteBody,
  type OrderStatus,
  type OrderTransitionAction,
  type OrderType,
  type Recommendation,
  type ReplenishmentOrder,
  type User,
} from "@stockflow/core";
import type { z } from "zod";
import type {
  ApiAuditEntry,
  OrderLifecycleMeta,
  QueueLifecycleView,
} from "../repositories/types.js";
import {
  DecisionForbiddenError,
  OrderConflictError,
  OrderNotFoundError,
  OrderValidationError,
} from "./errors.js";
import { computeOrderEngineSnapshot, resolveBranchCoords } from "./orderSnapshot.js";
import {
  adjustCommittedDelta,
  clearAllCommittedDeltas,
  findRawPosition,
  getCommittedDelta,
  projectPosition,
} from "./projection.js";
import {
  LifecycleOrderListResponseSchema,
  LifecycleOrderSchema,
  evaluateDecisionLifecycle,
  type LifecycleOrder,
} from "./queueLifecycle.js";
import {
  bumpDecisionVersion,
  ensureFreshPlan,
  ensureInitialized,
  type StockRuntimeState,
} from "./runtimeState.js";
import {
  buildOrderOwnership,
  isBranchInScope,
  isMaterialRecommendation,
  isOrderInScope,
} from "./scope.js";

const DAY_MS = 86_400_000;
type LifecycleOrderListResponse = z.infer<typeof LifecycleOrderListResponseSchema>;

const SYSTEM_ACTOR: ActorRef = {
  userId: "usr_system",
  name: "System",
  role: "admin",
};

function actorRefOf(user?: User): ActorRef {
  if (!user) return SYSTEM_ACTOR;
  return { userId: user.id, name: user.name, role: user.role };
}

export class OrderService {
  private readonly escalationMs: number;
  private readonly inflightStagedByOrderId = new Map<
    string,
    Array<{ sku: string; branchId: string; reserved: number; inTransit: number }>
  >();

  constructor(
    private readonly runtime: StockRuntimeState,
    options?: { escalationHours?: number },
  ) {
    const hours = options?.escalationHours ?? DEFAULT_DONOR_ESCALATION_HOURS;
    this.escalationMs = Math.max(1, hours * 3_600_000);
  }

  private replayCutoff(): string | undefined {
    return this.runtime.planVersion > 1 ? this.runtime.planComputedAt : undefined;
  }

  async initializeAndMigrate(replayCutoffAt?: string): Promise<void> {
    const persisted = await this.runtime.repo.listOrders();
    this.runtime.orders.clear();
    for (const order of persisted) {
      this.runtime.orders.set(order.id, order);
    }

    const loadedMeta = (await this.runtime.repo.listOrderLifecycleMeta?.()) ?? new Map<string, OrderLifecycleMeta>();
    this.runtime.orderLifecycleMeta.clear();
    for (const [id, meta] of loadedMeta.entries()) {
      this.runtime.orderLifecycleMeta.set(id, meta);
    }

    await this.migrateLegacyDecisionsToOrders();
    this.syncDecisionsOverlayFromOrders();
    this.replayOrdersIntoCommittedDeltas(replayCutoffAt);
  }

  private syncDecisionsOverlayFromOrders(): void {
    for (const order of this.runtime.orders.values()) {
      if (order.origin !== "ENGINE") continue;
      const meta = this.runtime.orderLifecycleMeta.get(order.id);
      if (meta?.reopenedAt && meta.reopenedAt >= order.updatedAt) {
        this.runtime.decisions.delete(order.id);
        continue;
      }
      if (order.status === "COMMITTED" || order.status === "RECEIVED") {
        this.runtime.decisions.set(order.id, "APPROVED");
      } else if (order.status === "REJECTED") {
        this.runtime.decisions.set(order.id, "REJECTED");
      } else {
        this.runtime.decisions.delete(order.id);
      }
    }
  }

  private async migrateLegacyDecisionsToOrders(): Promise<void> {
    if (this.runtime.decisions.size === 0) return;

    const recById = new Map(this.runtime.analysis.recommendations.map((r) => [r.id, r]));
    const auditByRecId = new Map(this.runtime.audit.map((a) => [a.recommendationId, a]));

    for (const [recId, decisionStatus] of this.runtime.decisions.entries()) {
      if (this.runtime.orders.has(recId)) continue;
      const rec = recById.get(recId);
      if (!rec) continue;
      const audit = auditByRecId.get(recId);
      const actionMeta = this.runtime.actionMeta.get(recId);
      const migratedAt = audit?.at ?? actionMeta?.decidedAt ?? new Date(this.runtime.now()).toISOString();
      const targetStatus: OrderStatus = decisionStatus === "APPROVED" ? "COMMITTED" : "REJECTED";
      const base = this.buildVirtualOrderFromRec(rec);
      const actor = audit?.actedBy ?? SYSTEM_ACTOR;

      const migratedOrder = ReplenishmentOrderSchema.parse({
        ...base,
        status: targetStatus,
        createdAt: migratedAt,
        updatedAt: migratedAt,
        committedAt: decisionStatus === "APPROVED" ? migratedAt : null,
        isVirtual: false,
      });

      const migratedEvent = OrderEventSchema.parse({
        id: `evt_mig_${recId}_${decisionStatus}`,
        orderId: recId,
        at: migratedAt,
        actor,
        action: "MIGRATED",
        fromStatus: "SUGGESTED",
        toStatus: targetStatus,
        dispositionCode: audit?.reasonCode ?? actionMeta?.reasonCode,
        comment: audit?.comment ?? actionMeta?.comment,
        sourceBranchId: rec.donorBranchId,
        quantity: rec.quantity,
      });

      const decidedMs = Date.parse(migratedAt);
      const snoozeMs = this.runtime.lifecycleConfig.rejectSnoozeDays * DAY_MS;
      const lifecycleMeta: OrderLifecycleMeta | undefined =
        decisionStatus === "REJECTED"
          ? {
              rejectionSnapshot: actionMeta?.snapshot ?? {
                netBenefit: rec.netBenefit,
                targetCoverDays: rec.metrics.coverDays ?? null,
              },
              rejectedUntil:
                actionMeta?.rejectedUntil ??
                (Number.isFinite(decidedMs)
                  ? new Date(decidedMs + snoozeMs).toISOString()
                  : new Date(this.runtime.now() + snoozeMs).toISOString()),
              reopenedAt: actionMeta?.reopenedAt ?? null,
            }
          : actionMeta?.reopenedAt
            ? { reopenedAt: actionMeta.reopenedAt }
            : undefined;

      const saved = await this.runtime.repo.saveOrderWithEvent(
        migratedOrder,
        migratedEvent,
        null,
        lifecycleMeta,
      );
      if (saved.status === "saved") {
        this.runtime.orders.set(recId, saved.order);
        if (lifecycleMeta) {
          this.runtime.orderLifecycleMeta.set(recId, lifecycleMeta);
        }
      } else {
        const existing = await this.runtime.repo.getOrder(recId);
        if (existing) {
          this.runtime.orders.set(recId, existing);
        }
      }
    }
  }

  replayOrdersIntoCommittedDeltas(replayCutoffAt?: string): void {
    clearAllCommittedDeltas(this.runtime.committedDeltas, this.runtime.committedRecommendationIds);

    const applyOrderDelta = (
      id: string,
      sku: string,
      type: OrderType,
      targetBranchId: string,
      sourceBranchId: string | null,
      quantity: number,
      clearInTransitOnReceipt: boolean,
    ) => {
      if (type === "TRANSFER") {
        if (!sourceBranchId) return;
        adjustCommittedDelta(this.runtime.committedDeltas, sku, sourceBranchId, quantity, 0);
        if (!clearInTransitOnReceipt) {
          adjustCommittedDelta(this.runtime.committedDeltas, sku, targetBranchId, 0, quantity);
        }
      } else if (type === "REORDER") {
        if (!clearInTransitOnReceipt) {
          adjustCommittedDelta(this.runtime.committedDeltas, sku, targetBranchId, 0, quantity);
        }
      } else if (type === "MARKDOWN") {
        adjustCommittedDelta(this.runtime.committedDeltas, sku, targetBranchId, quantity, 0);
      }
      this.runtime.committedRecommendationIds.set(id, {
        sku,
        branchId: targetBranchId,
        donorBranchId: sourceBranchId,
        action: type,
        quantity,
      });
    };

    for (const order of this.runtime.orders.values()) {
      if (order.status !== "COMMITTED" && order.status !== "RECEIVED") continue;
      const effectiveAt = order.committedAt ?? order.updatedAt;
      if (replayCutoffAt && effectiveAt < replayCutoffAt) continue;

      applyOrderDelta(
        order.id,
        order.sku,
        order.type,
        order.targetBranchId,
        order.sourceBranchId,
        order.quantity,
        order.status === "RECEIVED",
      );
    }

    // Also preserve any legacy APPROVED transfer audits not yet migrated into orders (e.g. sync init).
    const recById = new Map(this.runtime.analysis.recommendations.map((r) => [r.id, r]));
    const seen = new Set<string>();
    const sortedAudits = [...this.runtime.audit].sort((a, b) => a.at.localeCompare(b.at));
    for (const entry of sortedAudits) {
      if (entry.decision !== "APPROVED" || entry.action !== "TRANSFER") continue;
      if (this.runtime.orders.has(entry.recommendationId)) continue;
      if (replayCutoffAt && entry.at < replayCutoffAt) continue;
      if (seen.has(entry.recommendationId)) continue;
      seen.add(entry.recommendationId);
      if (
        (this.runtime.decisions.size > 0 || this.runtime.actionMeta.size > 0) &&
        this.runtime.decisions.get(entry.recommendationId) !== "APPROVED"
      ) {
        continue;
      }
      const rec = recById.get(entry.recommendationId);
      if (!rec || rec.action !== "TRANSFER" || !rec.donorBranchId) continue;
      applyOrderDelta(rec.id, rec.sku, rec.action, rec.branchId, rec.donorBranchId, rec.quantity, false);
    }

    for (const [inflightOrderId, staged] of this.inflightStagedByOrderId.entries()) {
      const persisted = this.runtime.orders.get(inflightOrderId);
      if (persisted && (persisted.status === "COMMITTED" || persisted.status === "RECEIVED")) {
        continue;
      }
      for (const e of staged) {
        adjustCommittedDelta(
          this.runtime.committedDeltas,
          e.sku,
          e.branchId,
          e.reserved,
          e.inTransit,
        );
      }
    }

    for (const adj of this.runtime.alertAdjustments.values()) {
      if (replayCutoffAt && adj.decidedAt < replayCutoffAt) continue;
      adjustCommittedDelta(this.runtime.committedDeltas, adj.sku, adj.branchId, 0, 0, adj.delta);
    }
  }

  private async ensureOrdersSynced(): Promise<void> {
    await ensureFreshPlan(this.runtime);
    await this.initializeAndMigrate(this.replayCutoff());
    await this.checkEscalations();
  }

  async checkEscalations(nowMs: number = this.runtime.now()): Promise<ReplenishmentOrder[]> {
    await ensureInitialized(this.runtime);
    const escalated: ReplenishmentOrder[] = [];

    for (const order of Array.from(this.runtime.orders.values())) {
      if (order.status !== "AWAITING_DONOR" || !order.awaitingDonorSince || order.escalatedAt) {
        continue;
      }
      const awaitingMs = Date.parse(order.awaitingDonorSince);
      if (!Number.isFinite(awaitingMs) || nowMs - awaitingMs < this.escalationMs) {
        continue;
      }

      const fresh = await this.runtime.repo.getOrder(order.id);
      if (!fresh || fresh.status !== "AWAITING_DONOR" || fresh.escalatedAt) {
        if (fresh) this.runtime.orders.set(fresh.id, fresh);
        continue;
      }

      const escalatedAt = new Date(nowMs).toISOString();
      const updated = ReplenishmentOrderSchema.parse({
        ...fresh,
        escalatedAt,
        updatedAt: escalatedAt,
      });
      const event = OrderEventSchema.parse({
        id: `evt_esc_${fresh.id}`,
        orderId: fresh.id,
        at: escalatedAt,
        actor: SYSTEM_ACTOR,
        action: "ESCALATE",
        fromStatus: "AWAITING_DONOR",
        toStatus: "AWAITING_DONOR",
        dispositionCode: "DONOR_TIMEOUT_24H",
        comment: `No donor response within ${Math.round(this.escalationMs / 3_600_000)}h; escalated to Admin`,
      });

      const res = await this.runtime.repo.saveOrderWithEvent(updated, event, "AWAITING_DONOR");
      if (res.status === "saved") {
        this.runtime.orders.set(res.order.id, res.order);
        escalated.push(this.enrichOrder(res.order));
      }
    }

    if (escalated.length > 0) {
      bumpDecisionVersion(this.runtime);
    }

    return escalated;
  }

  private availableDonorSurplus(sku: string, sourceBranchId: string): number {
    const donorRaw = findRawPosition(this.runtime.data, this.runtime.analysis, sku, sourceBranchId);
    if (!donorRaw) return 0;
    const donorProj = projectPosition(
      donorRaw,
      getCommittedDelta(this.runtime.committedDeltas, sku, sourceBranchId),
    );
    const floor = DEFAULT_POLICY.donorCoverDays * donorRaw.velocity + donorRaw.safetyStock;
    return Math.max(0, Math.floor(donorProj.onHand - floor));
  }

  private buildVirtualOrderFromRec(rec: Recommendation): ReplenishmentOrder {
    const decisionStatus = this.runtime.decisions.get(rec.id);
    const status: OrderStatus =
      decisionStatus === "APPROVED"
        ? "COMMITTED"
        : decisionStatus === "REJECTED"
          ? "REJECTED"
          : "SUGGESTED";

    const targetBranch = this.runtime.data.branches.find((b) => b.id === rec.branchId);
    const donorBranch = rec.donorBranchId
      ? this.runtime.data.branches.find((b) => b.id === rec.donorBranchId)
      : undefined;
    const tc = resolveBranchCoords(targetBranch);
    const dc = resolveBranchCoords(donorBranch);
    const distanceKm = tc && dc ? round2(haversineDistanceKm(dc, tc)) : null;
    const baseTs = `${this.runtime.data.asOf}T00:00:00.000Z`;

    return ReplenishmentOrderSchema.parse({
      id: rec.id,
      origin: "ENGINE",
      type: rec.action,
      status,
      sku: rec.sku,
      productName: rec.productName,
      category: rec.category,
      targetBranchId: rec.branchId,
      targetBranchName: rec.branchName,
      sourceBranchId: rec.donorBranchId,
      sourceBranchName: rec.donorBranchName,
      quantity: rec.quantity,
      requestedBy: null,
      linkedAlertId: null,
      engineSnapshot: {
        recommendationId: rec.id,
        netBenefitBhd: rec.netBenefit,
        reasonCodes: [...rec.reasonCodes],
        reason: rec.reason,
        distanceKm,
        freightCostBhd: rec.metrics.transferCost,
        metrics: rec.metrics,
      },
      createdAt: baseTs,
      updatedAt: baseTs,
      awaitingDonorSince: null,
      escalatedAt: null,
      committedAt: null,
      receivedAt: null,
      events: [],
      isVirtual: true,
    });
  }

  private enrichOrder(order: ReplenishmentOrder): ReplenishmentOrder {
    const isEscalated = Boolean(order.escalatedAt);
    if (order.type !== "TRANSFER" || !order.sourceBranchId) {
      return { ...order, isEscalated };
    }

    const donorRaw = findRawPosition(
      this.runtime.data,
      this.runtime.analysis,
      order.sku,
      order.sourceBranchId,
    );
    if (!donorRaw) {
      return { ...order, isEscalated };
    }

    const donorProj = projectPosition(
      donorRaw,
      getCommittedDelta(this.runtime.committedDeltas, order.sku, order.sourceBranchId),
    );
    const effectiveDonorOnHand = donorProj.onHand;
    const floor = DEFAULT_POLICY.donorCoverDays * donorRaw.velocity + donorRaw.safetyStock;
    const donorAvailableSurplus = Math.max(0, Math.floor(effectiveDonorOnHand - floor));
    const afterReleaseOnHand =
      order.status === "COMMITTED" || order.status === "RECEIVED"
        ? effectiveDonorOnHand
        : Math.max(0, effectiveDonorOnHand - order.quantity);
    const coverAfterRaw = coverDaysOf(afterReleaseOnHand, donorRaw.velocity);
    const donorCoverDaysAfter = coverAfterRaw === null ? null : round4(coverAfterRaw);

    return {
      ...order,
      isEscalated,
      donorAvailableSurplus,
      donorCoverDaysAfter,
    };
  }

  private resolveOrderRecord(id: string): { order: ReplenishmentOrder; expectedStatus: OrderStatus | null } {
    const persisted = this.runtime.orders.get(id);
    if (persisted) {
      return { order: persisted, expectedStatus: persisted.status };
    }
    const rec = this.runtime.analysis.recommendations.find((r) => r.id === id);
    if (!rec) {
      throw new OrderNotFoundError("Order not found");
    }
    return { order: this.buildVirtualOrderFromRec(rec), expectedStatus: null };
  }

  private evaluateOrderLifecycle(
    order: ReplenishmentOrder,
    recById?: Map<string, Recommendation>,
  ) {
    const rec = recById
      ? recById.get(order.id)
      : this.runtime.analysis.recommendations.find((r) => isMaterialRecommendation(r) && r.id === order.id);
    const currentNetBenefit = rec ? rec.netBenefit : order.engineSnapshot.netBenefitBhd;
    const currentCoverDays = rec
      ? (rec.metrics.coverDays ?? null)
      : (order.engineSnapshot.metrics?.coverDays ?? null);
    return evaluateDecisionLifecycle({
      recExists: Boolean(rec),
      currentNetBenefit,
      currentCoverDays,
      actionMeta: this.runtime.actionMeta.get(order.id),
      order,
      orderMeta: this.runtime.orderLifecycleMeta.get(order.id),
      nowMs: this.runtime.now(),
      config: this.runtime.lifecycleConfig,
    });
  }

  private enforceTransition(
    order: ReplenishmentOrder,
    user: User,
    action: OrderTransitionAction,
    opts?: { hasComment?: boolean; force?: boolean; targetDonorBranchId?: string | null },
  ): { nextStatus: OrderStatus; isAdminOverride: boolean } {
    if (!isOrderInScope(order, user)) {
      throw new OrderNotFoundError("Order not found");
    }
    let effectiveOrder = order;
    if (order.status === "REJECTED" && this.evaluateOrderLifecycle(order).bucket === "pending") {
      effectiveOrder = {
        ...order,
        status: order.origin === "ENGINE" ? "SUGGESTED" : "OPEN_REQUEST",
      };
    }
    const ownership = buildOrderOwnership(effectiveOrder, user, opts);
    const decision = canTransition(effectiveOrder, user, action, ownership);
    if (!decision.allowed) {
      if (decision.code === "FORBIDDEN") {
        throw new DecisionForbiddenError(decision.reason);
      }
      if (decision.code === "INVALID_STATE") {
        throw new OrderConflictError(decision.reason);
      }
      throw new OrderValidationError(decision.reason);
    }
    return { nextStatus: decision.nextStatus, isAdminOverride: decision.isAdminOverride };
  }

  private stageOrderCommitDelta(
    order: ReplenishmentOrder,
  ): Array<{ sku: string; branchId: string; reserved: number; inTransit: number }> {
    const staged: Array<{ sku: string; branchId: string; reserved: number; inTransit: number }> = [];
    if (order.type === "TRANSFER") {
      if (!order.sourceBranchId) {
        throw new OrderValidationError("Cannot commit a TRANSFER order without a source donor branch");
      }
      const avail = this.availableDonorSurplus(order.sku, order.sourceBranchId);
      if (order.quantity > avail) {
        throw new OrderConflictError("Insufficient donor surplus available for commit");
      }
      adjustCommittedDelta(this.runtime.committedDeltas, order.sku, order.sourceBranchId, order.quantity, 0);
      staged.push({
        sku: order.sku,
        branchId: order.sourceBranchId,
        reserved: order.quantity,
        inTransit: 0,
      });
      adjustCommittedDelta(this.runtime.committedDeltas, order.sku, order.targetBranchId, 0, order.quantity);
      staged.push({
        sku: order.sku,
        branchId: order.targetBranchId,
        reserved: 0,
        inTransit: order.quantity,
      });
    } else if (order.type === "REORDER") {
      adjustCommittedDelta(this.runtime.committedDeltas, order.sku, order.targetBranchId, 0, order.quantity);
      staged.push({
        sku: order.sku,
        branchId: order.targetBranchId,
        reserved: 0,
        inTransit: order.quantity,
      });
    } else if (order.type === "MARKDOWN") {
      adjustCommittedDelta(this.runtime.committedDeltas, order.sku, order.targetBranchId, order.quantity, 0);
      staged.push({
        sku: order.sku,
        branchId: order.targetBranchId,
        reserved: order.quantity,
        inTransit: 0,
      });
    }
    this.runtime.committedRecommendationIds.set(order.id, {
      sku: order.sku,
      branchId: order.targetBranchId,
      donorBranchId: order.sourceBranchId,
      action: order.type,
      quantity: order.quantity,
    });
    return staged;
  }

  private rollbackStagedDeltas(
    orderId: string,
    entries: readonly { sku: string; branchId: string; reserved: number; inTransit: number }[],
  ): void {
    for (const e of entries) {
      adjustCommittedDelta(
        this.runtime.committedDeltas,
        e.sku,
        e.branchId,
        -e.reserved,
        -e.inTransit,
      );
    }
    this.runtime.committedRecommendationIds.delete(orderId);
  }

  async list(
    query: OrderListQuery & { view?: QueueLifecycleView },
    user: User,
  ): Promise<OrderListResponse | LifecycleOrderListResponse> {
    await this.ensureOrdersSynced();
    const combined = new Map<string, ReplenishmentOrder>();
    const recById = new Map<string, Recommendation>();

    for (const order of this.runtime.orders.values()) {
      combined.set(order.id, order);
    }

    for (const rec of this.runtime.analysis.recommendations) {
      if (!isMaterialRecommendation(rec)) continue;
      recById.set(rec.id, rec);
      if (combined.has(rec.id)) continue;
      combined.set(rec.id, this.buildVirtualOrderFromRec(rec));
    }

    if (query.view === "decided" || query.view === "in_progress") {
      for (const actionMeta of this.runtime.actionMeta.values()) {
        if (combined.has(actionMeta.recommendationId)) continue;
        const latestAudit = [...this.runtime.audit]
          .reverse()
          .find((a) => a.recommendationId === actionMeta.recommendationId);
        if (!latestAudit) continue;
        const targetBranch = this.runtime.data.branches.find((b) => b.id === latestAudit.branchId);
        const donorBranch = latestAudit.donorBranchId
          ? this.runtime.data.branches.find((b) => b.id === latestAudit.donorBranchId)
          : undefined;
        const productObj = this.runtime.data.products.find((p) => p.sku === latestAudit.sku);
        combined.set(
          actionMeta.recommendationId,
          ReplenishmentOrderSchema.parse({
            id: actionMeta.recommendationId,
            origin: "ENGINE",
            type: latestAudit.action,
            status: actionMeta.status === "APPROVED" ? "COMMITTED" : "REJECTED",
            sku: latestAudit.sku,
            productName: latestAudit.productName,
            category: productObj?.category ?? "General",
            targetBranchId: latestAudit.branchId,
            targetBranchName: targetBranch?.name ?? latestAudit.branchName,
            sourceBranchId: latestAudit.donorBranchId ?? null,
            sourceBranchName: donorBranch?.name ?? null,
            quantity: 1,
            requestedBy: latestAudit.actedBy ?? null,
            linkedAlertId: null,
            engineSnapshot: {
              recommendationId: actionMeta.recommendationId,
              netBenefitBhd: latestAudit.netBenefit,
              reasonCodes: latestAudit.reasonCodes,
              reason: actionMeta.comment ?? actionMeta.reasonCode ?? "Historical decision",
            },
            createdAt: actionMeta.decidedAt,
            updatedAt: actionMeta.decidedAt,
            committedAt: actionMeta.status === "APPROVED" ? actionMeta.decidedAt : null,
            receivedAt: null,
            awaitingDonorSince: null,
            escalatedAt: null,
            events: [],
            isVirtual: true,
          }),
        );
      }
    }

    const baseFiltered = Array.from(combined.values())
      .filter((order) => isOrderInScope(order, user))
      .filter((order) => {
        if (query.queue === "suggested") {
          return query.view
            ? true
            : order.status === "SUGGESTED" || order.status === "OPEN_REQUEST";
        }
        if (query.queue === "incoming") {
          if (order.type !== "TRANSFER" || order.status !== "AWAITING_DONOR" || !order.sourceBranchId) {
            return false;
          }
          return user.role === "admin" || isBranchInScope(user, order.sourceBranchId);
        }
        if (query.queue === "outgoing") {
          if (order.origin === "ENGINE" && order.status === "SUGGESTED") return false;
          return user.role === "admin" || isBranchInScope(user, order.targetBranchId);
        }
        return true;
      })
      .filter((order) => {
        if (query.status && order.status !== query.status) return false;
        if (query.type && order.type !== query.type) return false;
        if (query.sku && order.sku !== query.sku) return false;
        if (query.category && order.category !== query.category) return false;
        if (
          query.branch &&
          order.targetBranchId !== query.branch &&
          !(order.type === "TRANSFER" && order.sourceBranchId === query.branch)
        ) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        const benDiff = b.engineSnapshot.netBenefitBhd - a.engineSnapshot.netBenefitBhd;
        if (benDiff !== 0) return benDiff;
        return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
      });

    if (!query.view) {
      const orders = baseFiltered.map((order) => this.enrichOrder(order));
      return OrderListResponseSchema.parse({ orders, total: orders.length });
    }

    const lifecycleOrders: LifecycleOrder[] = [];
    for (const order of baseFiltered) {
      const evalResult = this.evaluateOrderLifecycle(order, recById);
      if (evalResult.bucket !== query.view) continue;
      const enriched = this.enrichOrder(order);
      lifecycleOrders.push(
        LifecycleOrderSchema.parse({
          ...enriched,
          lifecycleState: evalResult.bucket,
          reopenBadge: evalResult.reopenBadge,
          canReopen: evalResult.canReopen,
          decidedAt: evalResult.decidedAt,
          rejectedUntil: evalResult.rejectedUntil,
        }),
      );
    }

    const totalNetBenefit = round2(
      lifecycleOrders.reduce((sum, item) => sum + item.engineSnapshot.netBenefitBhd, 0),
    );

    return LifecycleOrderListResponseSchema.parse({
      orders: lifecycleOrders,
      total: lifecycleOrders.length,
      totalNetBenefit,
      view: query.view,
    });
  }

  async get(id: string, user: User): Promise<ReplenishmentOrder> {
    await this.ensureOrdersSynced();
    const { order } = this.resolveOrderRecord(id);
    if (!isOrderInScope(order, user)) {
      throw new OrderNotFoundError("Order not found");
    }
    return ReplenishmentOrderSchema.parse(this.enrichOrder(order));
  }

  async donorCandidates(
    sku: string,
    targetBranchId: string,
    qty: number,
    user: User,
    opts?: { includeIneligible?: boolean; limit?: number },
  ): Promise<DonorCandidate[]> {
    await this.ensureOrdersSynced();
    if (!can(user.role, "recommendations:decide")) {
      throw new DecisionForbiddenError("Staff cannot query transfer donor candidates");
    }
    if (user.role !== "admin" && !isBranchInScope(user, targetBranchId)) {
      throw new DecisionForbiddenError("Cannot view donor candidates for a branch outside your scope");
    }
    const product = this.runtime.data.products.find((p) => p.sku === sku);
    if (!product || product.status === "archived") {
      throw new OrderValidationError(`Unknown or archived SKU: ${sku}`);
    }
    const target = this.runtime.data.branches.find((b) => b.id === targetBranchId);
    if (!target || target.status === "archived") {
      throw new OrderValidationError(`Unknown or archived target branch: ${targetBranchId}`);
    }
    return rankDonorCandidates(
      this.runtime.data,
      this.runtime.committedDeltas,
      sku,
      targetBranchId,
      qty,
      opts,
    );
  }

  async create(
    input: CreateOrderRequest,
    user: User,
    opts?: { origin?: OrderOrigin },
  ): Promise<ReplenishmentOrder> {
    await this.ensureOrdersSynced();
    if (!can(user.role, "recommendations:decide")) {
      throw new DecisionForbiddenError("Staff cannot create replenishment orders");
    }
    if (user.role !== "admin" && !isBranchInScope(user, input.targetBranchId)) {
      throw new DecisionForbiddenError("Cannot request replenishment for a branch outside your scope");
    }

    const product = this.runtime.data.products.find((p) => p.sku === input.sku);
    if (!product || product.status === "archived") {
      throw new OrderValidationError(`Unknown or archived SKU: ${input.sku}`);
    }
    const targetBranch = this.runtime.data.branches.find((b) => b.id === input.targetBranchId);
    if (!targetBranch || targetBranch.status === "archived") {
      throw new OrderValidationError(`Unknown or archived target branch: ${input.targetBranchId}`);
    }

    const orderType: OrderType = input.type ?? "TRANSFER";
    let sourceBranch: Branch | null = null;
    if (input.sourceBranchId) {
      if (orderType !== "TRANSFER") {
        throw new OrderValidationError("sourceBranchId is only allowed on TRANSFER orders");
      }
      if (input.sourceBranchId === targetBranch.id) {
        throw new OrderValidationError("Donor branch must differ from target branch");
      }
      const foundDonor = this.runtime.data.branches.find((b) => b.id === input.sourceBranchId);
      if (!foundDonor || foundDonor.status === "archived") {
        throw new OrderValidationError(`Unknown or archived donor branch: ${input.sourceBranchId}`);
      }
      sourceBranch = foundDonor;
    }

    const nowIso = new Date(this.runtime.now()).toISOString();
    const initialStatus: OrderStatus =
      orderType === "TRANSFER" && sourceBranch ? "AWAITING_DONOR" : "OPEN_REQUEST";
    const orderId = `ord_${randomUUID()}`;
    const actor = actorRefOf(user);
    const engineSnapshot = computeOrderEngineSnapshot(this.runtime, {
      sku: product.sku,
      productName: product.name,
      type: orderType,
      targetBranch,
      sourceBranch,
      quantity: input.quantity,
    });

    const newOrder = ReplenishmentOrderSchema.parse({
      id: orderId,
      origin: opts?.origin ?? "MANAGER_REQUEST",
      type: orderType,
      status: initialStatus,
      sku: product.sku,
      productName: product.name,
      category: product.category,
      targetBranchId: targetBranch.id,
      targetBranchName: targetBranch.name,
      sourceBranchId: sourceBranch?.id ?? null,
      sourceBranchName: sourceBranch?.name ?? null,
      quantity: input.quantity,
      requestedBy: actor,
      linkedAlertId: input.linkedAlertId ?? null,
      engineSnapshot,
      createdAt: nowIso,
      updatedAt: nowIso,
      awaitingDonorSince: initialStatus === "AWAITING_DONOR" ? nowIso : null,
      escalatedAt: null,
      committedAt: null,
      receivedAt: null,
      isVirtual: false,
    });

    const createdEvent = OrderEventSchema.parse({
      id: `evt_${randomUUID()}`,
      orderId,
      at: nowIso,
      actor,
      action: "CREATED",
      fromStatus: null,
      toStatus: initialStatus,
      dispositionCode: input.dispositionCode,
      comment: input.comment?.trim() ? input.comment.trim() : undefined,
      sourceBranchId: sourceBranch?.id ?? null,
      quantity: input.quantity,
    });

    const saved = await this.runtime.repo.saveOrderWithEvent(newOrder, createdEvent, null);
    if (saved.status !== "saved") {
      throw new OrderConflictError("Order creation conflicted with existing ID");
    }
    this.runtime.orders.set(saved.order.id, saved.order);
    bumpDecisionVersion(this.runtime);
    return ReplenishmentOrderSchema.parse(this.enrichOrder(saved.order));
  }

  async requestTransfer(
    id: string,
    body: OrderRequestTransferBody,
    user: User,
  ): Promise<ReplenishmentOrder> {
    await this.ensureOrdersSynced();
    const { order, expectedStatus } = this.resolveOrderRecord(id);
    const desiredDonorId = body.sourceBranchId ?? order.sourceBranchId;
    const { nextStatus } = this.enforceTransition(order, user, "REQUEST_TRANSFER", {
      targetDonorBranchId: desiredDonorId,
      hasComment: Boolean(body.comment?.trim()),
    });

    const sourceBranch = this.runtime.data.branches.find((b) => b.id === desiredDonorId);
    if (!sourceBranch || sourceBranch.status === "archived") {
      throw new OrderValidationError(`Unknown or archived donor branch: ${desiredDonorId}`);
    }
    const targetBranch = this.runtime.data.branches.find((b) => b.id === order.targetBranchId);
    if (!targetBranch) {
      throw new OrderValidationError(`Unknown target branch: ${order.targetBranchId}`);
    }

    const quantity = body.quantity ?? order.quantity;
    const engineSnapshot =
      sourceBranch.id === order.sourceBranchId && quantity === order.quantity
        ? order.engineSnapshot
        : computeOrderEngineSnapshot(this.runtime, {
            sku: order.sku,
            productName: order.productName,
            type: order.type,
            targetBranch,
            sourceBranch,
            quantity,
            existingRecommendationId: order.engineSnapshot.recommendationId,
          });

    const nowIso = new Date(this.runtime.now()).toISOString();
    const actor = actorRefOf(user);
    const updatedOrder = ReplenishmentOrderSchema.parse({
      ...order,
      status: nextStatus,
      sourceBranchId: sourceBranch.id,
      sourceBranchName: sourceBranch.name,
      quantity,
      requestedBy: actor,
      engineSnapshot,
      createdAt: expectedStatus === null ? nowIso : order.createdAt,
      updatedAt: nowIso,
      awaitingDonorSince: nowIso,
      escalatedAt: null,
      isVirtual: false,
    });

    const event = OrderEventSchema.parse({
      id: `evt_${randomUUID()}`,
      orderId: order.id,
      at: nowIso,
      actor,
      action: "REQUEST_TRANSFER",
      fromStatus: order.status,
      toStatus: nextStatus,
      dispositionCode: body.dispositionCode,
      comment: body.comment?.trim() ? body.comment.trim() : undefined,
      sourceBranchId: sourceBranch.id,
      quantity,
    });

    const prevMeta = this.runtime.orderLifecycleMeta.get(order.id) ?? {};
    const nextMeta: OrderLifecycleMeta = { ...prevMeta, reopenedAt: null };
    const saved = await this.runtime.repo.saveOrderWithEvent(
      updatedOrder,
      event,
      expectedStatus,
      nextMeta,
    );
    if (saved.status !== "saved") {
      await this.initializeAndMigrate(this.replayCutoff());
      throw new OrderConflictError("Order was modified concurrently");
    }
    this.runtime.orders.set(saved.order.id, saved.order);
    this.runtime.orderLifecycleMeta.set(saved.order.id, nextMeta);
    bumpDecisionVersion(this.runtime);
    return ReplenishmentOrderSchema.parse(this.enrichOrder(saved.order));
  }

  async commit(id: string, body: OrderCommitBody, user: User): Promise<ReplenishmentOrder> {
    await this.ensureOrdersSynced();
    const { order, expectedStatus } = this.resolveOrderRecord(id);
    const comment = body.comment?.trim() ? body.comment.trim() : undefined;
    const { nextStatus, isAdminOverride } = this.enforceTransition(order, user, "COMMIT", {
      hasComment: Boolean(comment),
      force: body.force,
    });

    if (this.runtime.inflightOrderIds.has(order.id)) {
      throw new OrderConflictError("Order transition already in progress");
    }

    this.runtime.inflightOrderIds.add(order.id);
    let staged: Array<{ sku: string; branchId: string; reserved: number; inTransit: number }> = [];
    try {
      staged = this.stageOrderCommitDelta(order);
      this.inflightStagedByOrderId.set(order.id, staged);
      const nowIso = new Date(this.runtime.now()).toISOString();
      const actor = actorRefOf(user);
      const updatedOrder = ReplenishmentOrderSchema.parse({
        ...order,
        status: nextStatus,
        requestedBy: order.requestedBy ?? actor,
        createdAt: expectedStatus === null ? nowIso : order.createdAt,
        updatedAt: nowIso,
        committedAt: nowIso,
        isVirtual: false,
      });
      const event = OrderEventSchema.parse({
        id: `evt_${randomUUID()}`,
        orderId: order.id,
        at: nowIso,
        actor,
        action: "COMMIT",
        fromStatus: order.status,
        toStatus: nextStatus,
        dispositionCode: body.dispositionCode,
        comment,
        sourceBranchId: order.sourceBranchId,
        quantity: order.quantity,
        isAdminOverride: isAdminOverride || undefined,
      });

      const prevMeta = this.runtime.orderLifecycleMeta.get(order.id) ?? {};
      const nextMeta: OrderLifecycleMeta = {
        ...prevMeta,
        rejectedUntil: null,
        reopenedAt: null,
      };
      const saved = await this.runtime.repo.saveOrderWithEvent(
        updatedOrder,
        event,
        expectedStatus,
        nextMeta,
      );
      if (saved.status !== "saved") {
        this.inflightStagedByOrderId.delete(order.id);
        this.rollbackStagedDeltas(order.id, staged);
        staged = [];
        await this.initializeAndMigrate(this.replayCutoff());
        throw new OrderConflictError("Order was modified concurrently");
      }

      this.inflightStagedByOrderId.delete(order.id);
      staged = [];
      this.runtime.orders.set(saved.order.id, saved.order);
      this.runtime.orderLifecycleMeta.set(saved.order.id, nextMeta);
      if (saved.order.origin === "ENGINE") {
        this.runtime.decisions.set(saved.order.id, "APPROVED");
      }
      bumpDecisionVersion(this.runtime);
      return ReplenishmentOrderSchema.parse(this.enrichOrder(saved.order));
    } catch (err) {
      this.inflightStagedByOrderId.delete(order.id);
      if (staged.length > 0) {
        this.rollbackStagedDeltas(order.id, staged);
        staged = [];
      }
      throw err;
    } finally {
      this.inflightStagedByOrderId.delete(order.id);
      this.runtime.inflightOrderIds.delete(order.id);
    }
  }

  async decline(id: string, body: OrderDeclineBody, user: User): Promise<ReplenishmentOrder> {
    await this.ensureOrdersSynced();
    const { order, expectedStatus } = this.resolveOrderRecord(id);
    const comment = body.comment.trim();
    const { nextStatus } = this.enforceTransition(order, user, "DECLINE", {
      hasComment: comment.length > 0,
    });

    const nowMs = this.runtime.now();
    const nowIso = new Date(nowMs).toISOString();
    const snoozeMs = this.runtime.lifecycleConfig.rejectSnoozeDays * DAY_MS;
    const rejectedUntil = new Date(nowMs + snoozeMs).toISOString();
    const rec = this.runtime.analysis.recommendations.find((r) => r.id === order.id);
    const lifecycleMeta: OrderLifecycleMeta = {
      rejectionSnapshot: {
        netBenefit: rec ? rec.netBenefit : order.engineSnapshot.netBenefitBhd,
        targetCoverDays: rec ? (rec.metrics.coverDays ?? null) : (order.engineSnapshot.metrics?.coverDays ?? null),
      },
      rejectedUntil,
      reopenedAt: null,
    };

    const actor = actorRefOf(user);
    const updatedOrder = ReplenishmentOrderSchema.parse({
      ...order,
      status: nextStatus,
      createdAt: expectedStatus === null ? nowIso : order.createdAt,
      updatedAt: nowIso,
      isVirtual: false,
    });
    const event = OrderEventSchema.parse({
      id: `evt_${randomUUID()}`,
      orderId: order.id,
      at: nowIso,
      actor,
      action: "DECLINE",
      fromStatus: order.status,
      toStatus: nextStatus,
      dispositionCode: body.dispositionCode,
      comment,
      sourceBranchId: order.sourceBranchId,
      quantity: order.quantity,
    });

    const saved = await this.runtime.repo.saveOrderWithEvent(
      updatedOrder,
      event,
      expectedStatus,
      lifecycleMeta,
    );
    if (saved.status !== "saved") {
      await this.initializeAndMigrate(this.replayCutoff());
      throw new OrderConflictError("Order was modified concurrently");
    }

    this.runtime.orders.set(saved.order.id, saved.order);
    this.runtime.orderLifecycleMeta.set(saved.order.id, lifecycleMeta);
    if (saved.order.origin === "ENGINE") {
      this.runtime.decisions.set(saved.order.id, "REJECTED");
    }
    bumpDecisionVersion(this.runtime);
    return ReplenishmentOrderSchema.parse(this.enrichOrder(saved.order));
  }

  async reroute(id: string, body: OrderRerouteBody, user: User): Promise<ReplenishmentOrder> {
    await this.ensureOrdersSynced();
    const { order, expectedStatus } = this.resolveOrderRecord(id);
    const { nextStatus } = this.enforceTransition(order, user, "REROUTE", {
      targetDonorBranchId: body.sourceBranchId,
      hasComment: Boolean(body.comment?.trim()),
    });

    const nextDonor = this.runtime.data.branches.find((b) => b.id === body.sourceBranchId);
    if (!nextDonor || nextDonor.status === "archived") {
      throw new OrderValidationError(`Unknown or archived donor branch: ${body.sourceBranchId}`);
    }
    const targetBranch = this.runtime.data.branches.find((b) => b.id === order.targetBranchId);
    if (!targetBranch) {
      throw new OrderValidationError(`Unknown target branch: ${order.targetBranchId}`);
    }

    const quantity = body.quantity ?? order.quantity;
    const engineSnapshot = computeOrderEngineSnapshot(this.runtime, {
      sku: order.sku,
      productName: order.productName,
      type: order.type,
      targetBranch,
      sourceBranch: nextDonor,
      quantity,
      existingRecommendationId: order.engineSnapshot.recommendationId,
    });

    const nowIso = new Date(this.runtime.now()).toISOString();
    const actor = actorRefOf(user);
    const updatedOrder = ReplenishmentOrderSchema.parse({
      ...order,
      status: nextStatus,
      sourceBranchId: nextDonor.id,
      sourceBranchName: nextDonor.name,
      quantity,
      requestedBy: order.requestedBy ?? actor,
      engineSnapshot,
      createdAt: expectedStatus === null ? nowIso : order.createdAt,
      updatedAt: nowIso,
      awaitingDonorSince: nowIso,
      escalatedAt: null,
      isVirtual: false,
    });
    const event = OrderEventSchema.parse({
      id: `evt_${randomUUID()}`,
      orderId: order.id,
      at: nowIso,
      actor,
      action: "REROUTE",
      fromStatus: order.status,
      toStatus: nextStatus,
      dispositionCode: body.dispositionCode,
      comment: body.comment?.trim() ? body.comment.trim() : undefined,
      sourceBranchId: nextDonor.id,
      quantity,
    });

    const prevMeta = this.runtime.orderLifecycleMeta.get(order.id) ?? {};
    const nextMeta: OrderLifecycleMeta = { ...prevMeta, reopenedAt: null };
    const saved = await this.runtime.repo.saveOrderWithEvent(
      updatedOrder,
      event,
      expectedStatus,
      nextMeta,
    );
    if (saved.status !== "saved") {
      await this.initializeAndMigrate(this.replayCutoff());
      throw new OrderConflictError("Order was modified concurrently");
    }

    this.runtime.orders.set(saved.order.id, saved.order);
    this.runtime.orderLifecycleMeta.set(saved.order.id, nextMeta);
    bumpDecisionVersion(this.runtime);
    return ReplenishmentOrderSchema.parse(this.enrichOrder(saved.order));
  }

  async cancel(id: string, body: OrderCancelBody, user: User): Promise<ReplenishmentOrder> {
    await this.ensureOrdersSynced();
    const { order, expectedStatus } = this.resolveOrderRecord(id);
    const { nextStatus } = this.enforceTransition(order, user, "CANCEL", {
      hasComment: Boolean(body.comment?.trim()),
    });

    const nowIso = new Date(this.runtime.now()).toISOString();
    const actor = actorRefOf(user);
    const updatedOrder = ReplenishmentOrderSchema.parse({
      ...order,
      status: nextStatus,
      createdAt: expectedStatus === null ? nowIso : order.createdAt,
      updatedAt: nowIso,
      isVirtual: false,
    });
    const event = OrderEventSchema.parse({
      id: `evt_${randomUUID()}`,
      orderId: order.id,
      at: nowIso,
      actor,
      action: "CANCEL",
      fromStatus: order.status,
      toStatus: nextStatus,
      dispositionCode: body.dispositionCode,
      comment: body.comment?.trim() ? body.comment.trim() : undefined,
      sourceBranchId: order.sourceBranchId,
      quantity: order.quantity,
    });

    const prevMeta = this.runtime.orderLifecycleMeta.get(order.id) ?? {};
    const nextMeta: OrderLifecycleMeta = { ...prevMeta, reopenedAt: null };
    const saved = await this.runtime.repo.saveOrderWithEvent(
      updatedOrder,
      event,
      expectedStatus,
      nextMeta,
    );
    if (saved.status !== "saved") {
      await this.initializeAndMigrate(this.replayCutoff());
      throw new OrderConflictError("Order was modified concurrently");
    }

    this.runtime.orders.set(saved.order.id, saved.order);
    this.runtime.orderLifecycleMeta.set(saved.order.id, nextMeta);
    bumpDecisionVersion(this.runtime);
    return ReplenishmentOrderSchema.parse(this.enrichOrder(saved.order));
  }

  async receive(id: string, body: OrderReceiveBody, user: User): Promise<ReplenishmentOrder> {
    await this.ensureOrdersSynced();
    const { order, expectedStatus } = this.resolveOrderRecord(id);
    if (expectedStatus === null) {
      throw new OrderConflictError("Cannot RECEIVE an order in SUGGESTED status");
    }
    const { nextStatus } = this.enforceTransition(order, user, "RECEIVE", {
      hasComment: Boolean(body.comment?.trim()),
    });

    const nowIso = new Date(this.runtime.now()).toISOString();
    const actor = actorRefOf(user);
    const updatedOrder = ReplenishmentOrderSchema.parse({
      ...order,
      status: nextStatus,
      updatedAt: nowIso,
      receivedAt: nowIso,
      isVirtual: false,
    });
    const event = OrderEventSchema.parse({
      id: `evt_${randomUUID()}`,
      orderId: order.id,
      at: nowIso,
      actor,
      action: "RECEIVE",
      fromStatus: order.status,
      toStatus: nextStatus,
      dispositionCode: body.dispositionCode,
      comment: body.comment?.trim() ? body.comment.trim() : undefined,
      sourceBranchId: order.sourceBranchId,
      quantity: order.quantity,
    });

    const prevMeta = this.runtime.orderLifecycleMeta.get(order.id) ?? {};
    const nextMeta: OrderLifecycleMeta = { ...prevMeta, reopenedAt: null };
    const saved = await this.runtime.repo.saveOrderWithEvent(
      updatedOrder,
      event,
      "COMMITTED",
      nextMeta,
    );
    if (saved.status !== "saved") {
      await this.initializeAndMigrate(this.replayCutoff());
      throw new OrderConflictError("Order was modified concurrently");
    }

    this.runtime.orders.set(saved.order.id, saved.order);
    this.runtime.orderLifecycleMeta.set(saved.order.id, nextMeta);
    if (saved.order.type === "TRANSFER" || saved.order.type === "REORDER") {
      adjustCommittedDelta(
        this.runtime.committedDeltas,
        saved.order.sku,
        saved.order.targetBranchId,
        0,
        -saved.order.quantity,
      );
    }
    bumpDecisionVersion(this.runtime);
    return ReplenishmentOrderSchema.parse(this.enrichOrder(saved.order));
  }

  async reopen(id: string, user: User, comment?: string): Promise<LifecycleOrder> {
    await this.ensureOrdersSynced();
    if (!can(user.role, "recommendations:decide")) {
      throw new DecisionForbiddenError("Staff cannot reopen replenishment orders");
    }

    const { order, expectedStatus } = this.resolveOrderRecord(id);
    if (!isOrderInScope(order, user)) {
      throw new OrderNotFoundError("Order not found");
    }
    if (expectedStatus === null || order.isVirtual) {
      throw new OrderConflictError("Order is already pending");
    }

    const evalResult = this.evaluateOrderLifecycle(order);
    if (evalResult.bucket === "pending") {
      throw new OrderConflictError("Order is already pending");
    }
    if (!evalResult.canReopen) {
      throw new OrderConflictError("Reopen window (24 hours) has expired for this order");
    }

    const committed = this.runtime.committedRecommendationIds.get(order.id);
    if (committed) {
      if (committed.action === "TRANSFER") {
        if (committed.donorBranchId) {
          adjustCommittedDelta(
            this.runtime.committedDeltas,
            committed.sku,
            committed.donorBranchId,
            -committed.quantity,
            0,
          );
        }
        adjustCommittedDelta(
          this.runtime.committedDeltas,
          committed.sku,
          committed.branchId,
          0,
          -committed.quantity,
        );
      } else if (committed.action === "REORDER") {
        adjustCommittedDelta(
          this.runtime.committedDeltas,
          committed.sku,
          committed.branchId,
          0,
          -committed.quantity,
        );
      } else if (committed.action === "MARKDOWN") {
        adjustCommittedDelta(
          this.runtime.committedDeltas,
          committed.sku,
          committed.branchId,
          -committed.quantity,
          0,
        );
      }
      this.runtime.committedRecommendationIds.delete(order.id);
    }

    const nowMs = this.runtime.now();
    const reopenedAt = new Date(nowMs).toISOString();
    const resetStatus: OrderStatus = order.origin === "ENGINE" ? "SUGGESTED" : "OPEN_REQUEST";
    const trimmedComment = comment?.trim() ? comment.trim() : undefined;
    const actor = actorRefOf(user);

    const updatedOrder = ReplenishmentOrderSchema.parse({
      ...order,
      status: resetStatus,
      updatedAt: reopenedAt,
      committedAt: null,
      awaitingDonorSince: null,
      escalatedAt: null,
      isVirtual: false,
    });
    const event = OrderEventSchema.parse({
      id: `evt_reopen_${order.id}_${nowMs}`,
      orderId: order.id,
      at: reopenedAt,
      actor,
      action: "MIGRATED",
      fromStatus: order.status,
      toStatus: resetStatus,
      dispositionCode: "REOPENED",
      comment: trimmedComment ?? "Reopened within 24h window",
      sourceBranchId: order.sourceBranchId,
      quantity: order.quantity,
    });

    const prevMeta = this.runtime.orderLifecycleMeta.get(order.id) ?? {};
    const nextMeta: OrderLifecycleMeta = { ...prevMeta, reopenedAt };
    const saved = await this.runtime.repo.saveOrderWithEvent(
      updatedOrder,
      event,
      expectedStatus,
      nextMeta,
    );
    if (saved.status !== "saved") {
      await this.initializeAndMigrate(this.replayCutoff());
      throw new OrderConflictError("Order was modified concurrently");
    }

    const auditEntry: ApiAuditEntry = {
      id: `${order.id}:REOPENED:${reopenedAt}`,
      at: reopenedAt,
      user: user.name,
      recommendationId: order.id,
      decision: "REOPENED",
      action: order.type,
      sku: order.sku,
      productName: order.productName,
      branchId: order.targetBranchId,
      branchName: order.targetBranchName,
      donorBranchId: order.sourceBranchId,
      netBenefit: order.engineSnapshot.netBenefitBhd,
      reasonCodes: order.engineSnapshot.reasonCodes,
      ...(trimmedComment ? { comment: trimmedComment } : {}),
      actedBy: actor,
    };

    const existingActionMeta = this.runtime.actionMeta.get(order.id);
    if (existingActionMeta) {
      await this.runtime.repo.reopenAction(order.id, reopenedAt, auditEntry);
      this.runtime.actionMeta.set(order.id, { ...existingActionMeta, reopenedAt });
    } else {
      await this.runtime.repo.saveAudit(auditEntry);
    }

    this.runtime.orders.set(saved.order.id, saved.order);
    this.runtime.orderLifecycleMeta.set(saved.order.id, nextMeta);
    this.runtime.decisions.delete(order.id);
    this.runtime.audit.push(auditEntry);
    bumpDecisionVersion(this.runtime);

    return LifecycleOrderSchema.parse({
      ...this.enrichOrder(saved.order),
      lifecycleState: "pending",
      reopenBadge: null,
      canReopen: false,
      decidedAt: null,
      rejectedUntil: nextMeta.rejectedUntil ?? null,
    });
  }
}

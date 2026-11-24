import { randomUUID } from "node:crypto";
import {
  OrderEventSchema,
  ReplenishmentOrderSchema,
  ResolveStockAlertResponseSchema,
  StockAlertListSchema,
  StockAlertResolutionSchema,
  StockAlertSchema,
  can,
  type Branch,
  type CreateStockAlert,
  type OrderStatus,
  type OrderType,
  type ResolveStockAlert,
  type ResolveStockAlertResponse,
  type StockAlert,
  type StockAlertList,
  type User,
} from "@stockflow/core";
import {
  DecisionForbiddenError,
  StockAlertConflictError,
  StockAlertNotFoundError,
  StockAlertValidationError,
} from "./errors.js";
import { computeOrderEngineSnapshot } from "./orderSnapshot.js";
import { adjustCommittedDelta, projectPositionFor } from "./projection.js";
import { bumpDecisionVersion, ensureInitialized, type StockRuntimeState } from "./runtimeState.js";
import { isBranchInScope } from "./scope.js";

export class StockAlertService {
  constructor(private readonly runtime: StockRuntimeState) {}

  async syncLoggedAdjustments(replayCutoffAt?: string): Promise<void> {
    const all = await this.runtime.repo.listStockAlerts();
    this.runtime.alertAdjustments.clear();
    for (const alert of all) {
      if (alert.status !== "RESOLVED" || alert.resolution?.action !== "LOGGED_ADJUSTMENT") {
        continue;
      }
      const delta = alert.resolution.adjustmentDelta;
      if (typeof delta !== "number" || delta === 0) continue;
      if (replayCutoffAt && alert.resolution.decidedAt < replayCutoffAt) continue;

      this.runtime.alertAdjustments.set(alert.id, {
        sku: alert.sku,
        branchId: alert.branchId,
        delta,
        decidedAt: alert.resolution.decidedAt,
      });
      adjustCommittedDelta(this.runtime.committedDeltas, alert.sku, alert.branchId, 0, 0, delta);
    }
  }

  async listStockAlerts(user?: User, branchId?: string): Promise<StockAlertList> {
    await ensureInitialized(this.runtime);
    if (branchId && user && !isBranchInScope(user, branchId)) {
      throw new DecisionForbiddenError("Cannot view stock alerts outside your assigned branches");
    }
    const all = await this.runtime.repo.listStockAlerts();
    const scoped = branchId
      ? all.filter((alert) => alert.branchId === branchId)
      : !user || user.role === "admin"
        ? all
        : all.filter((alert) => isBranchInScope(user, alert.branchId));

    const linkedOrderIds = Array.from(
      new Set(
        scoped
          .map((alert) => alert.resolution?.linkedOrderId)
          .filter((orderId): orderId is string => typeof orderId === "string" && orderId.length > 0),
      ),
    );

    const statusByOrderId = new Map<string, OrderStatus>();
    if (linkedOrderIds.length > 0) {
      const orders = await Promise.all(
        linkedOrderIds.map(async (orderId) => {
          const order =
            (await this.runtime.repo.getOrder(orderId)) ?? this.runtime.orders.get(orderId);
          return [orderId, order?.status ?? null] as const;
        }),
      );
      for (const [orderId, status] of orders) {
        if (status) statusByOrderId.set(orderId, status);
      }
    }

    const alerts = scoped.map((alert) => {
      const linkedOrderId = alert.resolution?.linkedOrderId;
      if (!linkedOrderId) return alert;
      return {
        ...alert,
        linkedOrderStatus: statusByOrderId.get(linkedOrderId) ?? null,
      };
    });

    return StockAlertListSchema.parse({ alerts });
  }

  async createStockAlert(input: CreateStockAlert, user: User): Promise<StockAlert> {
    await ensureInitialized(this.runtime);
    if (!can(user.role, "stock:flag")) {
      throw new DecisionForbiddenError("Only branch staff can flag stock alerts");
    }
    if (!isBranchInScope(user, input.branchId)) {
      throw new DecisionForbiddenError("Cannot flag stock outside your assigned branch");
    }

    const branch = this.runtime.data.branches.find((b) => b.id === input.branchId);
    if (!branch) {
      throw new StockAlertValidationError(`Unknown branch: ${input.branchId}`);
    }
    const product = this.runtime.data.products.find((p) => p.sku === input.sku);
    if (!product || product.status === "archived") {
      throw new StockAlertValidationError(`Unknown or archived SKU: ${input.sku}`);
    }

    const alert = StockAlertSchema.parse({
      id: `alt_${randomUUID().slice(0, 8)}`,
      branchId: branch.id,
      branchName: branch.name,
      sku: product.sku,
      productName: product.name,
      category: input.category ?? "CRITICAL_LOW",
      ...(input.reportedQty !== undefined ? { reportedQty: input.reportedQty } : {}),
      flaggedBy: { userId: user.id, name: user.name, role: user.role },
      flaggedAt: new Date().toISOString(),
      note: input.note.trim(),
      status: "PENDING",
      decidedBy: null,
      decidedAt: null,
      resolution: null,
    });
    return this.runtime.repo.createStockAlert(alert);
  }

  async resolveStockAlert(
    id: string,
    input: ResolveStockAlert,
    user: User,
  ): Promise<ResolveStockAlertResponse> {
    await ensureInitialized(this.runtime);
    if (!can(user.role, "stock:flag:decide")) {
      throw new DecisionForbiddenError("Staff cannot resolve stock alerts");
    }

    const existing = await this.runtime.repo.getStockAlert(id);
    if (!existing) {
      throw new StockAlertNotFoundError("Stock alert not found");
    }
    if (!isBranchInScope(user, existing.branchId)) {
      throw new DecisionForbiddenError("Cannot resolve stock alert outside your assigned branches");
    }
    if (existing.status !== "PENDING") {
      throw new StockAlertConflictError("Stock alert has already been decided and is immutable");
    }

    const comment = input.comment?.trim() ? input.comment.trim() : undefined;
    const nowIso = new Date().toISOString();
    const actor = { userId: user.id, name: user.name, role: user.role };

    let adjustmentDelta: number | undefined;
    let adjustedOnHand: number | undefined;
    let linkedOrderId: string | null = null;
    let linkedOrderPayload:
      | {
          order: ReturnType<typeof ReplenishmentOrderSchema.parse>;
          event: ReturnType<typeof OrderEventSchema.parse>;
        }
      | undefined;

    if (input.action === "DISMISSED") {
      if (!comment) {
        throw new StockAlertValidationError("Comment is required when dismissing a stock alert");
      }
    } else if (input.action === "LOGGED_ADJUSTMENT") {
      const sIdx = this.runtime.data.products.findIndex((p) => p.sku === existing.sku);
      const bIdx = this.runtime.data.branches.findIndex((b) => b.id === existing.branchId);
      if (sIdx < 0 || bIdx < 0) {
        throw new StockAlertValidationError(
          `Cannot apply stock adjustment for unknown SKU ${existing.sku} or branch ${existing.branchId}`,
        );
      }
      const currentPos = projectPositionFor(
        this.runtime.data,
        this.runtime.analysis,
        this.runtime.committedDeltas,
        sIdx,
        bIdx,
      );
      const currentOnHand = currentPos?.onHand ?? 0;

      if (input.adjustmentDelta !== undefined) {
        if (input.adjustmentDelta === 0) {
          throw new StockAlertValidationError("adjustmentDelta must be non-zero");
        }
        const nextOnHand = currentOnHand + input.adjustmentDelta;
        if (nextOnHand < 0) {
          throw new StockAlertValidationError("Adjustment would result in negative on-hand stock");
        }
        if (input.adjustedOnHand !== undefined && input.adjustedOnHand !== nextOnHand) {
          throw new StockAlertValidationError("adjustedOnHand conflicts with adjustmentDelta");
        }
        adjustmentDelta = input.adjustmentDelta;
        adjustedOnHand = nextOnHand;
      } else {
        const targetOnHand = input.adjustedOnHand ?? existing.reportedQty;
        if (targetOnHand === undefined) {
          throw new StockAlertValidationError(
            "LOGGED_ADJUSTMENT requires adjustedOnHand, adjustmentDelta, or alert reportedQty",
          );
        }
        adjustedOnHand = targetOnHand;
        adjustmentDelta = targetOnHand - currentOnHand;
      }
    } else if (input.action === "CONVERTED_TO_REQUEST") {
      const sIdx = this.runtime.data.products.findIndex((p) => p.sku === existing.sku);
      const bIdx = this.runtime.data.branches.findIndex((b) => b.id === existing.branchId);
      const product = sIdx >= 0 ? this.runtime.data.products[sIdx] : undefined;
      const targetBranch = bIdx >= 0 ? this.runtime.data.branches[bIdx] : undefined;
      if (!product || product.status === "archived") {
        throw new StockAlertValidationError(`Unknown or archived SKU: ${existing.sku}`);
      }
      if (!targetBranch || targetBranch.status === "archived") {
        throw new StockAlertValidationError(`Unknown or archived target branch: ${existing.branchId}`);
      }

      const orderType: OrderType = input.orderType ?? "TRANSFER";
      const donorId = input.sourceBranchId?.trim() ? input.sourceBranchId.trim() : null;
      let sourceBranch: Branch | null = null;
      if (donorId) {
        if (orderType !== "TRANSFER") {
          throw new StockAlertValidationError("sourceBranchId is only valid for TRANSFER orders");
        }
        if (donorId === targetBranch.id) {
          throw new StockAlertValidationError("Donor branch must differ from target branch");
        }
        const foundDonor = this.runtime.data.branches.find((b) => b.id === donorId);
        if (!foundDonor || foundDonor.status === "archived") {
          throw new StockAlertValidationError(`Unknown or archived donor branch: ${donorId}`);
        }
        sourceBranch = foundDonor;
      }

      const targetProj = projectPositionFor(
        this.runtime.data,
        this.runtime.analysis,
        this.runtime.committedDeltas,
        sIdx,
        bIdx,
      );
      const fallbackQty = targetProj && targetProj.need > 0 ? Math.ceil(targetProj.need) : undefined;
      const quantity = input.quantity ?? fallbackQty;
      if (!quantity || quantity <= 0) {
        throw new StockAlertValidationError(
          "A positive quantity is required when converting a stock alert to a replenishment request",
        );
      }

      const orderId = `ord_${randomUUID()}`;
      linkedOrderId = orderId;
      const initialStatus: OrderStatus =
        orderType === "TRANSFER" && sourceBranch ? "AWAITING_DONOR" : "OPEN_REQUEST";
      const engineSnapshot = computeOrderEngineSnapshot(this.runtime, {
        sku: product.sku,
        productName: product.name,
        type: orderType,
        targetBranch,
        sourceBranch,
        quantity,
      });

      const order = ReplenishmentOrderSchema.parse({
        id: orderId,
        origin: "ALERT_ESCALATION",
        type: orderType,
        status: initialStatus,
        sku: product.sku,
        productName: product.name,
        category: product.category,
        targetBranchId: targetBranch.id,
        targetBranchName: targetBranch.name,
        sourceBranchId: sourceBranch?.id ?? null,
        sourceBranchName: sourceBranch?.name ?? null,
        quantity,
        requestedBy: actor,
        linkedAlertId: existing.id,
        engineSnapshot,
        createdAt: nowIso,
        updatedAt: nowIso,
        awaitingDonorSince: initialStatus === "AWAITING_DONOR" ? nowIso : null,
        escalatedAt: null,
        committedAt: null,
        receivedAt: null,
        isVirtual: false,
      });

      const event = OrderEventSchema.parse({
        id: `evt_${randomUUID()}`,
        orderId,
        at: nowIso,
        actor,
        action: "CREATED",
        fromStatus: null,
        toStatus: initialStatus,
        dispositionCode: existing.category,
        comment,
        sourceBranchId: sourceBranch?.id ?? null,
        quantity,
      });

      linkedOrderPayload = { order, event };
    }

    const resolution = StockAlertResolutionSchema.parse({
      action: input.action,
      linkedOrderId,
      ...(adjustedOnHand !== undefined ? { adjustedOnHand } : {}),
      ...(adjustmentDelta !== undefined ? { adjustmentDelta } : {}),
      ...(comment !== undefined ? { comment } : {}),
      decidedBy: actor,
      decidedAt: nowIso,
    });

    const result = await this.runtime.repo.resolveStockAlert(id, resolution, linkedOrderPayload);
    if (result.status === "not_found") {
      throw new StockAlertNotFoundError("Stock alert not found");
    }
    if (result.status === "already_decided") {
      throw new StockAlertConflictError("Stock alert has already been decided and is immutable");
    }

    if (result.order) {
      this.runtime.orders.set(result.order.id, result.order);
    }

    if (input.action === "LOGGED_ADJUSTMENT" && adjustmentDelta !== undefined && adjustmentDelta !== 0) {
      this.runtime.alertAdjustments.set(result.alert.id, {
        sku: result.alert.sku,
        branchId: result.alert.branchId,
        delta: adjustmentDelta,
        decidedAt: resolution.decidedAt,
      });
      adjustCommittedDelta(
        this.runtime.committedDeltas,
        result.alert.sku,
        result.alert.branchId,
        0,
        0,
        adjustmentDelta,
      );
    }

    bumpDecisionVersion(this.runtime);

    return ResolveStockAlertResponseSchema.parse({
      alert: {
        ...result.alert,
        linkedOrderStatus: result.order?.status ?? null,
      },
      order: result.order,
    });
  }

  async decideStockAlert(
    id: string,
    decision: "APPROVED" | "REJECTED",
    user: User,
  ): Promise<StockAlert> {
    await ensureInitialized(this.runtime);
    if (!can(user.role, "stock:flag:decide")) {
      throw new DecisionForbiddenError("Staff cannot approve or reject stock alerts");
    }
    const existing = await this.runtime.repo.getStockAlert(id);
    if (!existing) {
      throw new StockAlertNotFoundError("Stock alert not found");
    }
    if (!isBranchInScope(user, existing.branchId)) {
      throw new DecisionForbiddenError("Cannot decide stock alert outside your assigned branches");
    }
    if (existing.status !== "PENDING") {
      throw new StockAlertConflictError("Stock alert has already been decided and is immutable");
    }

    const result = await this.runtime.repo.decideStockAlert(
      id,
      decision,
      { userId: user.id, name: user.name, role: user.role },
      new Date().toISOString(),
    );
    if (result.status === "not_found") {
      throw new StockAlertNotFoundError("Stock alert not found");
    }
    if (result.status === "already_decided") {
      throw new StockAlertConflictError("Stock alert has already been decided and is immutable");
    }
    bumpDecisionVersion(this.runtime);
    return StockAlertSchema.parse(result.alert);
  }
}

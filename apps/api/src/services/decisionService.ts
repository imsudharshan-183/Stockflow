import {
  ApiAuditListSchema,
  LifecycleRecommendationListSchema,
  LifecycleRecommendationSchema,
  OrderEventSchema,
  RecommendationListSchema,
  RecommendationSchema,
  ReplenishmentOrderSchema,
  can,
  type ActionMetaRecord,
  type ApiAuditEntry,
  type ApiAuditList,
  type BatchDecideItemResult,
  type LifecycleRecommendation,
  type LifecycleRecommendationList,
  type QueueLifecycleView,
  type Recommendation,
  type RecommendationList,
  type RecommendationQuery,
  type User,
} from "@stockflow/core";
import { DecisionConflictError, DecisionForbiddenError } from "./errors.js";
import {
  adjustCommittedDelta,
  clearAllCommittedDeltas,
  findRawPosition,
  getCommittedDelta,
  projectPositionFor,
  rollbackDeltaEntries,
  unwindCommittedAllocation,
  type ProjectedPosition,
  type StagedDeltaEntry,
} from "./projection.js";
import { evaluateDecisionLifecycle } from "./queueLifecycle.js";
import {
  applyDecisionHistoryToState,
  bumpDecisionVersion,
  ensureInitialized,
  ensureFreshPlan,
  ensureInitializedSyncIfPossible,
  type StockRuntimeState,
} from "./runtimeState.js";
import {
  applyDecisionOverlay,
  isBranchInScope,
  isMaterialRecommendation,
  isRecommendationInScope,
  scopeBranches,
} from "./scope.js";

const DAY_MS = 86_400_000;

const DEMO_USER = "Demo Buyer";

export class DecisionService {
  constructor(private readonly runtime: StockRuntimeState) {}

  /**
   * Reconstructs `committedDeltas` at startup from persisted APPROVED transfer
   * records in the `audits` collection so restarts never lose live reservations.
   *
   * IMPORTANT: `replayCutoffAt` (`plan_cache.computedAt` when `dataVersion > 1`) skips audit entries
   * recorded before the current plan was built—after a sales or catalog write bumps `dataVersion`,
   * recomputation already incorporates physical stock changes into base `onHand`, so replaying older
   * approvals would double-deduct donor surplus.
   */
  replayApprovedTransfersFromAudit(replayCutoffAt?: string): void {
    clearAllCommittedDeltas(this.runtime.committedDeltas, this.runtime.committedRecommendationIds);
    const recById = new Map(this.runtime.analysis.recommendations.map((r) => [r.id, r]));
    const sorted = [...this.runtime.audit].sort((a, b) => a.at.localeCompare(b.at));
    const seenRecIds = new Set<string>();

    for (const entry of sorted) {
      if (entry.decision !== "APPROVED" || entry.action !== "TRANSFER") continue;
      if (replayCutoffAt && entry.at < replayCutoffAt) continue;
      if (seenRecIds.has(entry.recommendationId)) continue;
      seenRecIds.add(entry.recommendationId);

      // Respect actions collection if present (e.g. if an external script cleared decisions or an action was reopened).
      if (
        (this.runtime.decisions.size > 0 || this.runtime.actionMeta.size > 0) &&
        this.runtime.decisions.get(entry.recommendationId) !== "APPROVED"
      ) {
        continue;
      }

      const rec = recById.get(entry.recommendationId);
      if (!rec || rec.action !== "TRANSFER" || !rec.donorBranchId) continue;

      adjustCommittedDelta(
        this.runtime.committedDeltas,
        rec.sku,
        rec.donorBranchId,
        rec.quantity,
        0,
      );
      adjustCommittedDelta(this.runtime.committedDeltas, rec.sku, rec.branchId, 0, rec.quantity);
      this.runtime.committedRecommendationIds.set(rec.id, {
        sku: rec.sku,
        branchId: rec.branchId,
        donorBranchId: rec.donorBranchId,
        action: rec.action,
        quantity: rec.quantity,
      });
    }

    for (const adj of this.runtime.alertAdjustments.values()) {
      if (replayCutoffAt && adj.decidedAt < replayCutoffAt) continue;
      adjustCommittedDelta(this.runtime.committedDeltas, adj.sku, adj.branchId, 0, 0, adj.delta);
    }
  }

  projectPosition(sku: string, branchId: string): ProjectedPosition | null {
    ensureInitializedSyncIfPossible(this.runtime);
    const sIdx = this.runtime.data.products.findIndex((p) => p.sku === sku);
    const bIdx = this.runtime.data.branches.findIndex((b) => b.id === branchId);
    if (sIdx < 0 || bIdx < 0) return null;
    return (
      projectPositionFor(
        this.runtime.data,
        this.runtime.analysis,
        this.runtime.committedDeltas,
        sIdx,
        bIdx,
      ) ?? null
    );
  }

  private stageApprovedDelta(
    rec: Recommendation,
  ): Array<{ sku: string; branchId: string; reserved: number; inTransit: number }> {
    const applied: Array<{ sku: string; branchId: string; reserved: number; inTransit: number }> =
      [];
    if (rec.action === "TRANSFER") {
      if (!rec.donorBranchId) return applied;
      const donorPos = findRawPosition(
        this.runtime.data,
        this.runtime.analysis,
        rec.sku,
        rec.donorBranchId,
      );
      const rawSurplus = donorPos?.surplus ?? 0;
      const alreadyReserved = getCommittedDelta(
        this.runtime.committedDeltas,
        rec.sku,
        rec.donorBranchId,
      ).reserved;
      const effectiveAvailable = rawSurplus - alreadyReserved;
      if (rec.quantity > effectiveAvailable) {
        throw new DecisionConflictError("Donor stock already committed to another approved transfer");
      }
      adjustCommittedDelta(
        this.runtime.committedDeltas,
        rec.sku,
        rec.donorBranchId,
        rec.quantity,
        0,
      );
      applied.push({
        sku: rec.sku,
        branchId: rec.donorBranchId,
        reserved: rec.quantity,
        inTransit: 0,
      });
      adjustCommittedDelta(this.runtime.committedDeltas, rec.sku, rec.branchId, 0, rec.quantity);
      applied.push({ sku: rec.sku, branchId: rec.branchId, reserved: 0, inTransit: rec.quantity });
    } else if (rec.action === "REORDER") {
      adjustCommittedDelta(this.runtime.committedDeltas, rec.sku, rec.branchId, 0, rec.quantity);
      applied.push({ sku: rec.sku, branchId: rec.branchId, reserved: 0, inTransit: rec.quantity });
    } else if (rec.action === "MARKDOWN") {
      adjustCommittedDelta(this.runtime.committedDeltas, rec.sku, rec.branchId, rec.quantity, 0);
      applied.push({ sku: rec.sku, branchId: rec.branchId, reserved: rec.quantity, inTransit: 0 });
    }
    if (applied.length > 0) {
      this.runtime.committedRecommendationIds.set(rec.id, {
        sku: rec.sku,
        branchId: rec.branchId,
        donorBranchId: rec.donorBranchId,
        action: rec.action,
        quantity: rec.quantity,
      });
    }
    return applied;
  }

  // Reverts optimistic committedDeltas staging when DB persistence fails or loses an optimistic-lock race.
  private rollbackStagedDeltas(recId: string, entries: readonly StagedDeltaEntry[]): void {
    rollbackDeltaEntries(
      this.runtime.committedDeltas,
      this.runtime.committedRecommendationIds,
      recId,
      entries,
    );
  }

  private matches(recommendation: Recommendation, query: RecommendationQuery): boolean {
    if (
      query.branch &&
      recommendation.branchId !== query.branch &&
      !(recommendation.action === "TRANSFER" && recommendation.donorBranchId === query.branch)
    ) {
      return false;
    }
    if (query.category && recommendation.category !== query.category) return false;
    if (query.action && recommendation.action !== query.action) return false;
    if (
      query.status &&
      applyDecisionOverlay(recommendation, this.runtime.decisions).status !== query.status
    ) {
      return false;
    }
    return true;
  }

  list(
    query: RecommendationQuery & { view?: QueueLifecycleView },
    user?: User,
  ): RecommendationList | LifecycleRecommendationList {
    ensureInitializedSyncIfPossible(this.runtime);
    const allBranchIds = this.runtime.data.branches.map((b) => b.id);
    const userBranches =
      user && user.role !== "admin" ? new Set(scopeBranches(user, allBranchIds)) : null;

    if (query.branch && userBranches && !userBranches.has(query.branch)) {
      if (query.view) {
        return LifecycleRecommendationListSchema.parse({
          recommendations: [],
          total: 0,
          totalNetBenefit: 0,
          view: query.view,
        });
      }
      return RecommendationListSchema.parse({ recommendations: [], total: 0 });
    }

    if (!query.view) {
      // IMPORTANT: Filter materiality and assigned branches post-plan rather than pre-plan so
      // network donor rankings match the un-scoped optimization while buyers act only on in-scope moves.
      const recommendations = this.runtime.analysis.recommendations
        .filter(isMaterialRecommendation)
        .filter((recommendation) => {
          if (!userBranches) return true;
          if (recommendation.action === "TRANSFER") {
            return (
              userBranches.has(recommendation.branchId) ||
              (recommendation.donorBranchId ? userBranches.has(recommendation.donorBranchId) : false)
            );
          }
          return userBranches.has(recommendation.branchId);
        })
        .filter((recommendation) => this.matches(recommendation, query))
        .map((recommendation) => applyDecisionOverlay(recommendation, this.runtime.decisions));

      return RecommendationListSchema.parse({ recommendations, total: recommendations.length });
    }

    const nowMs = this.runtime.now();
    const config = this.runtime.lifecycleConfig;
    const seenRecIds = new Set<string>();
    const results: LifecycleRecommendation[] = [];

    const passesQueryNonStatus = (rec: Recommendation): boolean => {
      if (query.branch) {
        const matchesBranch =
          rec.branchId === query.branch ||
          (rec.action === "TRANSFER" && rec.donorBranchId === query.branch);
        if (!matchesBranch) return false;
      }
      if (query.category && rec.category !== query.category) return false;
      if (query.action && rec.action !== query.action) return false;
      return true;
    };

    const passesUserBranches = (rec: Recommendation): boolean => {
      if (!userBranches) return true;
      if (rec.action === "TRANSFER") {
        return (
          userBranches.has(rec.branchId) ||
          (rec.donorBranchId ? userBranches.has(rec.donorBranchId) : false)
        );
      }
      return userBranches.has(rec.branchId);
    };

    for (const recommendation of this.runtime.analysis.recommendations) {
      if (!isMaterialRecommendation(recommendation)) continue;
      seenRecIds.add(recommendation.id);
      if (!passesUserBranches(recommendation) || !passesQueryNonStatus(recommendation)) continue;

      const evalResult = evaluateDecisionLifecycle({
        recExists: true,
        currentNetBenefit: recommendation.netBenefit,
        currentCoverDays: recommendation.metrics.coverDays ?? null,
        actionMeta: this.runtime.actionMeta.get(recommendation.id),
        order: this.runtime.orders.get(recommendation.id),
        orderMeta: this.runtime.orderLifecycleMeta.get(recommendation.id),
        nowMs,
        config,
      });

      if (evalResult.bucket !== query.view) continue;
      if (query.status && evalResult.effectiveStatus !== query.status) continue;

      results.push(
        LifecycleRecommendationSchema.parse({
          ...recommendation,
          status: evalResult.effectiveStatus,
          lifecycleState: evalResult.bucket,
          reopenBadge: evalResult.reopenBadge,
          canReopen: evalResult.canReopen,
          decidedAt: evalResult.decidedAt,
          rejectedUntil: evalResult.rejectedUntil,
        }),
      );
    }

    // Items whose engine recommendation no longer exists still belong in In progress or Decided if active/historical.
    if (query.view === "decided" || query.view === "in_progress") {
      for (const actionMeta of this.runtime.actionMeta.values()) {
        if (seenRecIds.has(actionMeta.recommendationId)) continue;
        const latestAudit = [...this.runtime.audit]
          .reverse()
          .find((a) => a.recommendationId === actionMeta.recommendationId);
        if (!latestAudit) continue;

        const branchObj = this.runtime.data.branches.find((b) => b.id === latestAudit.branchId);
        const donorObj = latestAudit.donorBranchId
          ? this.runtime.data.branches.find((b) => b.id === latestAudit.donorBranchId)
          : undefined;
        const productObj = this.runtime.data.products.find((p) => p.sku === latestAudit.sku);

        const syntheticRec: Recommendation = {
          id: actionMeta.recommendationId,
          rank: 9999,
          sku: latestAudit.sku,
          productName: latestAudit.productName,
          category: productObj?.category ?? "General",
          branchId: latestAudit.branchId,
          branchName: branchObj?.name ?? latestAudit.branchName,
          donorBranchId: latestAudit.donorBranchId ?? null,
          donorBranchName: donorObj?.name ?? null,
          action: latestAudit.action,
          quantity: 1,
          netBenefit: latestAudit.netBenefit,
          reasonCodes: latestAudit.reasonCodes,
          reason: actionMeta.comment ?? actionMeta.reasonCode ?? "Historical decision",
          status: actionMeta.status,
          metrics: {
            onHand: 0,
            velocity: 0,
            sigmaDemand: 0,
            coverDays: null,
            safetyStock: 0,
            reorderPoint: 0,
            lostMarginAvoided: 0,
            carryingCostSaved: 0,
            transferCost: 0,
            markdownCost: 0,
            donorOnHand: null,
            donorCoverDays: null,
            lostUnits: 0,
          },
        };

        if (!passesUserBranches(syntheticRec) || !passesQueryNonStatus(syntheticRec)) continue;

        const evalResult = evaluateDecisionLifecycle({
          recExists: false,
          currentNetBenefit: latestAudit.netBenefit,
          currentCoverDays: actionMeta.snapshot?.targetCoverDays ?? null,
          actionMeta,
          order: this.runtime.orders.get(actionMeta.recommendationId),
          orderMeta: this.runtime.orderLifecycleMeta.get(actionMeta.recommendationId),
          nowMs,
          config,
        });

        if (evalResult.bucket !== query.view) continue;
        if (query.status && evalResult.effectiveStatus !== query.status) continue;

        results.push(
          LifecycleRecommendationSchema.parse({
            ...syntheticRec,
            status: evalResult.effectiveStatus,
            lifecycleState: evalResult.bucket,
            reopenBadge: evalResult.reopenBadge,
            canReopen: evalResult.canReopen,
            decidedAt: evalResult.decidedAt,
            rejectedUntil: evalResult.rejectedUntil,
          }),
        );
      }
    }

    const totalNetBenefit =
      Math.round(results.reduce((acc, item) => acc + item.netBenefit, 0) * 100) / 100;

    return LifecycleRecommendationListSchema.parse({
      recommendations: results,
      total: results.length,
      totalNetBenefit,
      view: query.view,
    });
  }

  listAudit(user?: User, branchId?: string): ApiAuditList {
    ensureInitializedSyncIfPossible(this.runtime);
    if (user && !can(user.role, "audit:read")) {
      throw new DecisionForbiddenError("Staff cannot view audit log");
    }

    if (branchId && user && user.role !== "admin" && !isBranchInScope(user, branchId)) {
      throw new DecisionForbiddenError("Access to branch forbidden");
    }

    let entries = [...this.runtime.audit].sort((a, b) => b.at.localeCompare(a.at));
    if (user && user.role !== "admin") {
      entries = entries.filter(
        (e) =>
          isBranchInScope(user, e.branchId) ||
          (e.donorBranchId ? isBranchInScope(user, e.donorBranchId) : false),
      );
    }
    if (branchId) {
      entries = entries.filter((e) => e.branchId === branchId || e.donorBranchId === branchId);
    }
    return ApiAuditListSchema.parse({ entries });
  }

  private buildDecisionRecords(
    existing: Recommendation,
    status: "APPROVED" | "REJECTED",
    decidedAt: string,
    user?: User,
    reasonCode?: string,
    comment?: string,
  ): { record: ActionMetaRecord; entry: ApiAuditEntry } {
    const decidedMs = Date.parse(decidedAt);
    const snoozeMs = this.runtime.lifecycleConfig.rejectSnoozeDays * DAY_MS;
    const record: ActionMetaRecord = {
      id: `${existing.id}:${status}:${decidedAt}`,
      recommendationId: existing.id,
      status,
      decidedAt,
      ...(reasonCode ? { reasonCode } : {}),
      ...(comment ? { comment } : {}),
      ...(status === "REJECTED"
        ? {
            snapshot: {
              netBenefit: existing.netBenefit,
              targetCoverDays: existing.metrics.coverDays ?? null,
            },
            rejectedUntil: Number.isFinite(decidedMs)
              ? new Date(decidedMs + snoozeMs).toISOString()
              : new Date(this.runtime.now() + snoozeMs).toISOString(),
          }
        : {}),
      reopenedAt: null,
    };
    const entry: ApiAuditEntry = {
      id: record.id,
      at: decidedAt,
      user: user ? user.name : DEMO_USER,
      recommendationId: existing.id,
      decision: status,
      action: existing.action,
      sku: existing.sku,
      productName: existing.productName,
      branchId: existing.branchId,
      branchName: existing.branchName,
      donorBranchId: existing.donorBranchId,
      netBenefit: existing.netBenefit,
      reasonCodes: existing.reasonCodes,
      ...(reasonCode ? { reasonCode } : {}),
      ...(comment ? { comment } : {}),
      ...(user
        ? {
            actedBy: {
              userId: user.id,
              name: user.name,
              role: user.role,
            },
          }
        : {}),
    };
    return { record, entry };
  }

  private canDecideRecommendation(rec: Recommendation, nowMs: number): boolean {
    const meta = this.runtime.actionMeta.get(rec.id);
    const order = this.runtime.orders.get(rec.id);
    if (!meta && !order && !this.runtime.decisions.has(rec.id) && rec.status === "PENDING") {
      return true;
    }
    const evalResult = evaluateDecisionLifecycle({
      recExists: true,
      currentNetBenefit: rec.netBenefit,
      currentCoverDays: rec.metrics.coverDays ?? null,
      actionMeta: meta,
      order,
      orderMeta: this.runtime.orderLifecycleMeta.get(rec.id),
      nowMs,
      config: this.runtime.lifecycleConfig,
    });
    return evalResult.bucket === "pending";
  }

  private async prepareApproval(status: "APPROVED" | "REJECTED") {
    if (status !== "APPROVED" || !this.runtime.repo.getAllocationRevision) return undefined;
    const revision = await this.runtime.repo.getAllocationRevision();
    if (revision !== this.runtime.allocationRevision) {
      await ensureFreshPlan(this.runtime, { syncDecisions: true, syncAudit: true });
      await this.runtime.onAfterInit?.(this.runtime.planVersion > 1 ? this.runtime.planComputedAt : undefined);
      this.runtime.allocationRevision = revision;
    }
    return { revision, dataVersion: this.runtime.planVersion };
  }

  async decide(
    id: string,
    status: "APPROVED" | "REJECTED",
    user?: User,
    opts?: { reasonCode?: string; comment?: string },
  ): Promise<Recommendation | null> {
    await ensureInitialized(this.runtime);
    if (user && !can(user.role, "recommendations:decide")) {
      throw new DecisionForbiddenError("Staff cannot approve or reject actions");
    }
    const allocationGuard = await this.prepareApproval(status);

    const existing = this.runtime.analysis.recommendations.find(
      (recommendation) => recommendation.id === id,
    );
    if (!existing) return null;

    if (!isRecommendationInScope(existing, user)) {
      throw new DecisionForbiddenError("Cannot decide action outside your assigned branches");
    }

    if (this.runtime.inflightDecisionIds.has(id)) {
      throw new DecisionConflictError("Decision already in progress for this recommendation");
    }

    const nowMs = this.runtime.now();
    const hadPriorAction = this.runtime.actionMeta.has(id) || this.runtime.decisions.has(id);
    const canDecide = this.canDecideRecommendation(existing, nowMs);
    const alreadyDecided = !canDecide;
    this.runtime.inflightDecisionIds.add(id);
    let staged: Array<{ sku: string; branchId: string; reserved: number; inTransit: number }> = [];
    try {
      // DECISION: Stage donor reservation and receiver in-transit synchronously *before* awaiting persistence.
      // Because Node runs synchronously between awaits, checking donor surplus and mutating `committedDeltas`
      // before `saveDecisionBatch` prevents same-process concurrent approvals from double-allocating without
      // an async mutex (`409 Conflict`), while `rollbackStagedDeltas` reverts on DB failure or an E11000 race.
      if (!alreadyDecided && status === "APPROVED") {
        staged = this.stageApprovedDelta(existing);
      }

      const decidedAt = new Date(nowMs).toISOString();
      const { record, entry } = this.buildDecisionRecords(
        existing,
        status,
        decidedAt,
        user,
        opts?.reasonCode,
        opts?.comment,
      );
      const saveOptions = !alreadyDecided && hadPriorAction
        ? { allowOverwriteIds: new Set([id]) }
        : undefined;
      const { persistedIds } = await this.runtime.repo.saveDecisionBatch(
        [record],
        [entry],
        { ...saveOptions, allocationGuard },
      );
      if (persistedIds.has(id)) {
        if (allocationGuard) this.runtime.allocationRevision = allocationGuard.revision + 1;
        this.runtime.decisions.set(id, status);
        this.runtime.actionMeta.set(id, record);
        this.runtime.audit.push(entry);
        bumpDecisionVersion(this.runtime);
      } else {
        this.rollbackStagedDeltas(id, staged);
        // Another instance decided this recommendation first; refresh local overlay.
        applyDecisionHistoryToState(this.runtime, await this.runtime.repo.listActions());
        bumpDecisionVersion(this.runtime);
      }
      return RecommendationSchema.parse(applyDecisionOverlay(existing, this.runtime.decisions));
    } catch (err) {
      this.rollbackStagedDeltas(id, staged);
      throw err;
    } finally {
      this.runtime.inflightDecisionIds.delete(id);
    }
  }

  async decideBatch(
    ids: readonly string[],
    status: "APPROVED" | "REJECTED",
    user?: User,
    reasonCode?: string,
    comment?: string,
  ): Promise<BatchDecideItemResult[]> {
    await ensureInitialized(this.runtime);
    if (user && !can(user.role, "recommendations:decide")) {
      throw new DecisionForbiddenError("Staff cannot approve or reject actions");
    }
    const allocationGuard = await this.prepareApproval(status);

    const byId = new Map(this.runtime.analysis.recommendations.map((r) => [r.id, r]));
    const nowMs = this.runtime.now();
    const decidedAt = new Date(nowMs).toISOString();
    const seen = new Set<string>();
    const results: BatchDecideItemResult[] = [];
    const actionsToSave: ActionMetaRecord[] = [];
    const auditsToSave: ApiAuditEntry[] = [];
    const allowOverwriteIds = new Set<string>();
    const effectiveReasonCode = status === "REJECTED" ? reasonCode : undefined;
    const effectiveComment = status === "REJECTED" ? comment : undefined;
    const stagedByRecId = new Map<
      string,
      Array<{ sku: string; branchId: string; reserved: number; inTransit: number }>
    >();

    try {
      for (const id of ids) {
        const existing = byId.get(id);
        if (!existing) {
          results.push({ id, status: "not_found" });
          continue;
        }
        if (!isRecommendationInScope(existing, user)) {
          results.push({ id, status: "forbidden" });
          continue;
        }
        if (
          seen.has(id) ||
          this.runtime.inflightDecisionIds.has(id) ||
          !this.canDecideRecommendation(existing, nowMs)
        ) {
          results.push({ id, status: "already_decided" });
          continue;
        }

        if (status === "APPROVED") {
          try {
            stagedByRecId.set(id, this.stageApprovedDelta(existing));
          } catch (err) {
            if (err instanceof DecisionConflictError) {
              results.push({ id, status: "already_decided" });
              continue;
            }
            throw err;
          }
        }

        seen.add(id);
        this.runtime.inflightDecisionIds.add(id);
        if (this.runtime.actionMeta.has(id) || this.runtime.decisions.has(id)) {
          allowOverwriteIds.add(id);
        }
        const { record, entry } = this.buildDecisionRecords(
          existing,
          status,
          decidedAt,
          user,
          effectiveReasonCode,
          effectiveComment,
        );
        actionsToSave.push(record);
        auditsToSave.push(entry);
        results.push({ id, status: "ok" });
      }

      if (actionsToSave.length > 0) {
        // DECISION: Atomic bulk persist (<= 3 DB ops total with getDataVersion) without bumping dataVersion.
        const saveOptions = allowOverwriteIds.size > 0 ? { allowOverwriteIds } : undefined;
        const { persistedIds, duplicateIds } = await this.runtime.repo.saveDecisionBatch(
          actionsToSave,
          auditsToSave,
          { ...saveOptions, allocationGuard },
        );
        for (const item of results) {
          if (item.status === "ok" && duplicateIds.has(item.id)) {
            item.status = "already_decided";
          }
        }
        for (const [recId, staged] of stagedByRecId.entries()) {
          if (!persistedIds.has(recId)) {
            this.rollbackStagedDeltas(recId, staged);
          }
        }
        for (const record of actionsToSave) {
          if (persistedIds.has(record.recommendationId)) {
            this.runtime.decisions.set(record.recommendationId, record.status);
            this.runtime.actionMeta.set(record.recommendationId, record);
          }
        }
        for (const entry of auditsToSave) {
          if (persistedIds.has(entry.recommendationId)) {
            this.runtime.audit.push(entry);
          }
        }
        if (persistedIds.size > 0) {
          if (allocationGuard) this.runtime.allocationRevision = allocationGuard.revision + 1;
          bumpDecisionVersion(this.runtime);
        }
        if (duplicateIds.size > 0) {
          applyDecisionHistoryToState(this.runtime, await this.runtime.repo.listActions());
        }
      }

      return results;
    } catch (err) {
      for (const [recId, staged] of stagedByRecId.entries()) {
        this.rollbackStagedDeltas(recId, staged);
      }
      throw err;
    } finally {
      for (const id of seen) {
        this.runtime.inflightDecisionIds.delete(id);
      }
    }
  }

  async reopen(id: string, user?: User, comment?: string): Promise<LifecycleRecommendation | null> {
    await ensureInitialized(this.runtime);
    if (user && !can(user.role, "recommendations:decide")) {
      throw new DecisionForbiddenError("Staff cannot reopen decisions");
    }

    const existing = this.runtime.analysis.recommendations.find((r) => r.id === id);
    const actionMeta = this.runtime.actionMeta.get(id);
    const existingOrder = this.runtime.orders.get(id);
    if (!existing && !actionMeta && (!existingOrder || existingOrder.isVirtual)) {
      return null;
    }

    const latestAudit = [...this.runtime.audit].reverse().find((a) => a.recommendationId === id);
    if (existing) {
      if (!isRecommendationInScope(existing, user)) {
        throw new DecisionForbiddenError("Cannot reopen decision outside your assigned branches");
      }
    } else if (existingOrder) {
      const inScope =
        !user ||
        user.role === "admin" ||
        isBranchInScope(user, existingOrder.targetBranchId) ||
        (existingOrder.sourceBranchId ? isBranchInScope(user, existingOrder.sourceBranchId) : false);
      if (!inScope) {
        throw new DecisionForbiddenError("Cannot reopen decision outside your assigned branches");
      }
    } else if (latestAudit && user && user.role !== "admin") {
      const inScope =
        isBranchInScope(user, latestAudit.branchId) ||
        (latestAudit.donorBranchId ? isBranchInScope(user, latestAudit.donorBranchId) : false);
      if (!inScope) {
        throw new DecisionForbiddenError("Cannot reopen decision outside your assigned branches");
      }
    }

    if (this.runtime.inflightDecisionIds.has(id)) {
      throw new DecisionConflictError("Decision operation already in progress");
    }

    const nowMs = this.runtime.now();
    const reopenedAt = new Date(nowMs).toISOString();
    const evalResult = evaluateDecisionLifecycle({
      recExists: Boolean(existing),
      currentNetBenefit: existing?.netBenefit ?? existingOrder?.engineSnapshot.netBenefitBhd ?? 0,
      currentCoverDays:
        existing?.metrics.coverDays ?? existingOrder?.engineSnapshot.metrics?.coverDays ?? null,
      actionMeta,
      order: existingOrder,
      orderMeta: this.runtime.orderLifecycleMeta.get(id),
      nowMs,
      config: this.runtime.lifecycleConfig,
    });

    if (evalResult.bucket === "pending") {
      throw new DecisionConflictError("Recommendation is already pending");
    }
    if (!evalResult.canReopen) {
      throw new DecisionConflictError("Reopen window (24 hours) has expired for this decision");
    }

    this.runtime.inflightDecisionIds.add(id);
    try {
      unwindCommittedAllocation(
        this.runtime.committedDeltas,
        this.runtime.committedRecommendationIds,
        id,
      );

      const branchId = existing?.branchId ?? existingOrder?.targetBranchId ?? latestAudit?.branchId ?? "";
      const branchName = existing?.branchName ?? existingOrder?.targetBranchName ?? latestAudit?.branchName ?? "";
      const sku = existing?.sku ?? existingOrder?.sku ?? latestAudit?.sku ?? "";
      const productName =
        existing?.productName ?? existingOrder?.productName ?? latestAudit?.productName ?? "";
      const donorBranchId =
        existing?.donorBranchId ?? existingOrder?.sourceBranchId ?? latestAudit?.donorBranchId ?? null;
      const action = existing?.action ?? (existingOrder?.type ?? latestAudit?.action ?? "REORDER");
      const netBenefit =
        existing?.netBenefit ?? existingOrder?.engineSnapshot.netBenefitBhd ?? latestAudit?.netBenefit ?? 0;
      const reasonCodes: Recommendation["reasonCodes"] =
        existing?.reasonCodes ?? latestAudit?.reasonCodes ?? ["BELOW_REORDER_POINT"];

      const auditEntry: ApiAuditEntry = {
        id: `${id}:REOPENED:${reopenedAt}`,
        at: reopenedAt,
        user: user ? user.name : DEMO_USER,
        recommendationId: id,
        decision: "REOPENED",
        action,
        sku,
        productName,
        branchId,
        branchName,
        donorBranchId,
        netBenefit,
        reasonCodes,
        ...(comment?.trim() ? { comment: comment.trim() } : {}),
        ...(user
          ? {
              actedBy: {
                userId: user.id,
                name: user.name,
                role: user.role,
              },
            }
          : {}),
      };

      if (actionMeta) {
        const updatedAction = await this.runtime.repo.reopenAction(id, reopenedAt, auditEntry);
        if (!updatedAction) {
          await this.runtime.repo.saveAudit(auditEntry);
        }
        this.runtime.actionMeta.set(id, { ...actionMeta, reopenedAt });
      } else {
        await this.runtime.repo.saveAudit(auditEntry);
      }

      if (existingOrder && !existingOrder.isVirtual) {
        const resetStatus = existingOrder.origin === "ENGINE" ? "SUGGESTED" : "OPEN_REQUEST";
        const updatedOrder = ReplenishmentOrderSchema.parse({
          ...existingOrder,
          status: resetStatus,
          updatedAt: reopenedAt,
          committedAt: null,
          awaitingDonorSince: null,
          escalatedAt: null,
          isVirtual: false,
        });
        const orderEvent = OrderEventSchema.parse({
          id: `evt_reopen_${id}_${nowMs}`,
          orderId: id,
          at: reopenedAt,
          actor: user
            ? { userId: user.id, name: user.name, role: user.role }
            : { userId: "usr_system", name: DEMO_USER, role: "admin" },
          action: "MIGRATED",
          fromStatus: existingOrder.status,
          toStatus: resetStatus,
          dispositionCode: "REOPENED",
          comment: comment?.trim() || "Reopened within 24h window",
          sourceBranchId: existingOrder.sourceBranchId,
          quantity: existingOrder.quantity,
        });
        const prevMeta = this.runtime.orderLifecycleMeta.get(id) ?? {};
        const nextMeta = { ...prevMeta, reopenedAt };
        const savedOrder = await this.runtime.repo.saveOrderWithEvent(
          updatedOrder,
          orderEvent,
          existingOrder.status,
          nextMeta,
        );
        if (savedOrder.status === "saved") {
          this.runtime.orders.set(id, savedOrder.order);
        }
        this.runtime.orderLifecycleMeta.set(id, nextMeta);
      }

      this.runtime.decisions.delete(id);
      this.runtime.audit.push(auditEntry);
      bumpDecisionVersion(this.runtime);

      const fallbackRec: Recommendation = existing ?? {
        id,
        rank: 9999,
        sku,
        productName,
        category: "General",
        branchId,
        branchName,
        donorBranchId,
        donorBranchName: existingOrder?.sourceBranchName ?? null,
        action,
        quantity: existingOrder?.quantity ?? 1,
        netBenefit,
        reasonCodes,
        reason: comment?.trim() || "Reopened decision",
        status: "PENDING",
        metrics: {
          onHand: 0,
          velocity: 0,
          sigmaDemand: 0,
          coverDays: null,
          safetyStock: 0,
          reorderPoint: 0,
          lostMarginAvoided: 0,
          carryingCostSaved: 0,
          transferCost: 0,
          markdownCost: 0,
          donorOnHand: null,
          donorCoverDays: null,
          lostUnits: 0,
        },
      };

      return LifecycleRecommendationSchema.parse({
        ...fallbackRec,
        status: "PENDING",
        lifecycleState: "pending",
        reopenBadge: null,
        canReopen: false,
        decidedAt: null,
        rejectedUntil: null,
      });
    } finally {
      this.runtime.inflightDecisionIds.delete(id);
    }
  }
}

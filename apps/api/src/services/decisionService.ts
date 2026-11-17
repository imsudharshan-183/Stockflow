import {
  ActionRecordSchema,
  AuditEntrySchema,
  AuditListSchema,
  RecommendationListSchema,
  RecommendationSchema,
  can,
  type ActionRecord,
  type AuditEntry,
  type AuditList,
  type BatchDecideItemResult,
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
  type ProjectedPosition,
} from "./projection.js";
import {
  applyDecisionHistoryToState,
  ensureInitialized,
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

      // Respect actions collection if present (e.g. if an external script cleared decisions).
      if (
        this.runtime.decisions.size > 0 &&
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

  private rollbackStagedDeltas(
    recId: string,
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
    this.runtime.committedRecommendationIds.delete(recId);
  }

  private matches(recommendation: Recommendation, query: RecommendationQuery): boolean {
    if (query.branch && recommendation.branchId !== query.branch) return false;
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

  list(query: RecommendationQuery, user?: User): RecommendationList {
    ensureInitializedSyncIfPossible(this.runtime);
    const allBranchIds = this.runtime.data.branches.map((b) => b.id);
    const userBranches =
      user && user.role !== "admin" ? new Set(scopeBranches(user, allBranchIds)) : null;

    // The engine keeps every positive-benefit draft. The queue only shows moves a buyer would act on.
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

  listAudit(user?: User, branchId?: string): AuditList {
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
    return AuditListSchema.parse({ entries });
  }

  private buildDecisionRecords(
    existing: Recommendation,
    status: "APPROVED" | "REJECTED",
    decidedAt: string,
    user?: User,
    reasonCode?: string,
  ): { record: ActionRecord; entry: AuditEntry } {
    const record: ActionRecord = ActionRecordSchema.parse({
      id: `${existing.id}:${status}:${decidedAt}`,
      recommendationId: existing.id,
      status,
      decidedAt,
    });
    const entry = AuditEntrySchema.parse({
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
      reasonCode,
      actedBy: user
        ? {
            userId: user.id,
            name: user.name,
            role: user.role,
          }
        : undefined,
    });
    return { record, entry };
  }

  async decide(
    id: string,
    status: "APPROVED" | "REJECTED",
    user?: User,
  ): Promise<Recommendation | null> {
    await ensureInitialized(this.runtime);
    if (user && !can(user.role, "recommendations:decide")) {
      throw new DecisionForbiddenError("Staff cannot approve or reject actions");
    }

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

    const alreadyDecided = this.runtime.decisions.has(id) || existing.status !== "PENDING";
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

      const decidedAt = new Date().toISOString();
      const { record, entry } = this.buildDecisionRecords(existing, status, decidedAt, user);
      const { persistedIds } = await this.runtime.repo.saveDecisionBatch([record], [entry]);
      if (persistedIds.has(id)) {
        this.runtime.decisions.set(id, status);
        this.runtime.audit.push(entry);
        this.runtime.scopedKpiCache.clear();
      } else {
        this.rollbackStagedDeltas(id, staged);
        // Another instance decided this recommendation first; refresh local overlay.
        applyDecisionHistoryToState(this.runtime, await this.runtime.repo.listActions());
        this.runtime.scopedKpiCache.clear();
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
  ): Promise<BatchDecideItemResult[]> {
    await ensureInitialized(this.runtime);
    if (user && !can(user.role, "recommendations:decide")) {
      throw new DecisionForbiddenError("Staff cannot approve or reject actions");
    }

    const byId = new Map(this.runtime.analysis.recommendations.map((r) => [r.id, r]));
    const decidedAt = new Date().toISOString();
    const seen = new Set<string>();
    const results: BatchDecideItemResult[] = [];
    const actionsToSave: ActionRecord[] = [];
    const auditsToSave: AuditEntry[] = [];
    const effectiveReasonCode = status === "REJECTED" ? reasonCode : undefined;
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
          this.runtime.decisions.has(id) ||
          this.runtime.inflightDecisionIds.has(id) ||
          existing.status !== "PENDING"
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
        const { record, entry } = this.buildDecisionRecords(
          existing,
          status,
          decidedAt,
          user,
          effectiveReasonCode,
        );
        actionsToSave.push(record);
        auditsToSave.push(entry);
        results.push({ id, status: "ok" });
      }

      if (actionsToSave.length > 0) {
        // DECISION: Atomic bulk persist (<= 3 DB ops total with getDataVersion) without bumping dataVersion.
        const { persistedIds, duplicateIds } = await this.runtime.repo.saveDecisionBatch(
          actionsToSave,
          auditsToSave,
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
          }
        }
        for (const entry of auditsToSave) {
          if (persistedIds.has(entry.recommendationId)) {
            this.runtime.audit.push(entry);
          }
        }
        if (persistedIds.size > 0) {
          this.runtime.scopedKpiCache.clear();
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
}

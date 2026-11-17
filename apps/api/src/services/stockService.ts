import { randomUUID } from "node:crypto";
import {
  ActionRecordSchema,
  AuditEntrySchema,
  AuditListSchema,
  DEFAULT_POLICY,
  MATERIAL_MIN_NET_BENEFIT,
  RecommendationListSchema,
  RecommendationSchema,
  StockAlertListSchema,
  StockAlertSchema,
  can,
  type ActionRecord,
  type Analysis,
  type AuditEntry,
  type AuditList,
  type BatchDecideItemResult,
  type BranchDetail,
  type CreateProduct,
  type CreateStockAlert,
  type Dataset,
  type KpiSummary,
  type LocationInventoryQuery,
  type LocationInventoryResponse,
  type LocationListResponse,
  type LocationSummaryResponse,
  type LocationTrendQuery,
  type LocationTrendResponse,
  type Position,
  type Product,
  type ProductDetail,
  type ProductDetailWithHistory,
  type ProductListQuery,
  type ProductListResponse,
  type ProductStatus,
  type Recommendation,
  type RecommendationList,
  type RecommendationQuery,
  type StockAlert,
  type StockAlertList,
  type UpdateProduct,
  type User,
} from "@stockflow/core";
import type { StockRepository } from "../repositories/types.js";
import type { UserRepository } from "../repositories/userTypes.js";
import { CatalogService } from "./catalogService.js";
import {
  DecisionConflictError,
  DecisionForbiddenError,
  ProductConflictError,
  ProductNotFoundError,
  ProductValidationError,
  StockAlertConflictError,
  StockAlertNotFoundError,
  StockAlertValidationError,
} from "./errors.js";
import { KpiService } from "./kpiService.js";
import {
  adjustCommittedDelta,
  findRawPosition,
  getCommittedDelta,
  projectPosition as project,
  projectPositionFor,
  type CommittedDelta,
  type ProjectedPosition,
} from "./projection.js";
import {
  applyDecisionHistoryToState,
  commitPlanVersion,
  createStockRuntimeState,
  ensureFreshPlan,
  ensureInitialized,
  ensureInitializedSyncIfPossible,
  type StockRuntimeState,
} from "./runtimeState.js";
import { applyDecisionOverlay, isBranchInScope, scopeBranches } from "./scope.js";

export {
  DecisionConflictError,
  DecisionForbiddenError,
  ProductConflictError,
  ProductNotFoundError,
  ProductValidationError,
  StockAlertConflictError,
  StockAlertNotFoundError,
  StockAlertValidationError,
  project,
  type CommittedDelta,
  type ProjectedPosition,
};

const DEMO_USER = "Demo Buyer";

// The morning plan is computed once per process. Approve and reject overlay status; they do not recompute velocity.
// SCALE: a new day or a policy edit is the point to recompute, per SKU, instead of rebuilding 500 x 15 series on every request.

export class StockService {
  private readonly runtime: StockRuntimeState;
  private readonly kpiService: KpiService;
  private readonly catalogService: CatalogService;

  private constructor(
    private readonly repo: StockRepository,
    data?: Dataset,
    analysis?: Analysis,
    planVersion = 0,
  ) {
    this.runtime = createStockRuntimeState(repo);
    this.kpiService = new KpiService(this.runtime);
    this.catalogService = new CatalogService(this.runtime);
    if (data && analysis) {
      this.runtime.data = data;
      this.runtime.analysis = analysis;
      this.runtime.planVersion = planVersion;
      this.runtime.initialized = true;
    }
  }

  private get decisions() {
    return this.runtime.decisions;
  }

  private get committedDeltas() {
    return this.runtime.committedDeltas;
  }

  private get inflightDecisionIds() {
    return this.runtime.inflightDecisionIds;
  }

  private get scopedKpiCache() {
    return this.runtime.scopedKpiCache;
  }

  private get audit(): AuditEntry[] {
    return this.runtime.audit;
  }

  private get data(): Dataset {
    return this.runtime.data;
  }

  private get analysis(): Analysis {
    return this.runtime.analysis;
  }

  static async create(repo: StockRepository): Promise<StockService> {
    // DECISION: Defer dataset loading and morning plan computation until first use so
    // HTTP server startup and /api/health are never blocked by slow dataset or DB loads.
    return new StockService(repo);
  }

  async ensureInitialized(): Promise<void> {
    await ensureInitialized(this.runtime);
  }

  private ensureInitializedSyncIfPossible(): void {
    ensureInitializedSyncIfPossible(this.runtime);
  }

  async ensureFreshPlan(options?: { syncDecisions?: boolean; syncAudit?: boolean }): Promise<void> {
    await ensureFreshPlan(this.runtime, options);
  }

  async commitPlanVersion(): Promise<number> {
    return commitPlanVersion(this.runtime);
  }

  get userRepo(): UserRepository {
    return this.repo.users;
  }

  repositoryKind(): "memory" | "mongo" {
    return this.repo.kind;
  }

  hasBranch(branchId: string): boolean {
    return this.catalogService.hasBranch(branchId);
  }

  allBranchIds(): string[] {
    return this.catalogService.allBranchIds();
  }

  getProductStatus(sku: string): ProductStatus | "unknown" {
    return this.catalogService.getProductStatus(sku);
  }

  applySalesEntryToDataset(
    branchId: string,
    sku: string,
    date: string,
    unitsSold: number,
    onHand: number,
  ): void {
    this.catalogService.applySalesEntryToDataset(branchId, sku, date, unitsSold, onHand);
  }

  async recomputeSingleSku(sku: string, options: { bumpVersion?: boolean } = {}): Promise<void> {
    await this.catalogService.recomputeSingleSku(sku, options);
  }

  private getDelta(sku: string, branchId: string): CommittedDelta {
    return getCommittedDelta(this.runtime.committedDeltas, sku, branchId);
  }

  private adjustDelta(sku: string, branchId: string, dReserved: number, dInTransit: number): void {
    adjustCommittedDelta(this.runtime.committedDeltas, sku, branchId, dReserved, dInTransit);
  }

  private findRawPosition(sku: string, branchId: string): Position | undefined {
    return findRawPosition(this.data, this.analysis, sku, branchId);
  }

  private projectPositionFor(skuIndex: number, branchIndex: number): ProjectedPosition | undefined {
    return projectPositionFor(
      this.data,
      this.analysis,
      this.runtime.committedDeltas,
      skuIndex,
      branchIndex,
    );
  }

  projectPosition(sku: string, branchId: string): ProjectedPosition | null {
    this.ensureInitializedSyncIfPossible();
    const sIdx = this.data.products.findIndex((p) => p.sku === sku);
    const bIdx = this.data.branches.findIndex((b) => b.id === branchId);
    if (sIdx < 0 || bIdx < 0) return null;
    return this.projectPositionFor(sIdx, bIdx) ?? null;
  }

  private stageApprovedDelta(
    rec: Recommendation,
  ): Array<{ sku: string; branchId: string; reserved: number; inTransit: number }> {
    const applied: Array<{ sku: string; branchId: string; reserved: number; inTransit: number }> = [];
    if (rec.action === "TRANSFER") {
      if (!rec.donorBranchId) return applied;
      const donorPos = this.findRawPosition(rec.sku, rec.donorBranchId);
      const rawSurplus = donorPos?.surplus ?? 0;
      const alreadyReserved = this.getDelta(rec.sku, rec.donorBranchId).reserved;
      const effectiveAvailable = rawSurplus - alreadyReserved;
      if (rec.quantity > effectiveAvailable) {
        throw new DecisionConflictError("Donor stock already committed to another approved transfer");
      }
      this.adjustDelta(rec.sku, rec.donorBranchId, rec.quantity, 0);
      applied.push({ sku: rec.sku, branchId: rec.donorBranchId, reserved: rec.quantity, inTransit: 0 });
      this.adjustDelta(rec.sku, rec.branchId, 0, rec.quantity);
      applied.push({ sku: rec.sku, branchId: rec.branchId, reserved: 0, inTransit: rec.quantity });
    } else if (rec.action === "REORDER") {
      this.adjustDelta(rec.sku, rec.branchId, 0, rec.quantity);
      applied.push({ sku: rec.sku, branchId: rec.branchId, reserved: 0, inTransit: rec.quantity });
    } else if (rec.action === "MARKDOWN") {
      this.adjustDelta(rec.sku, rec.branchId, rec.quantity, 0);
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
      this.adjustDelta(e.sku, e.branchId, -e.reserved, -e.inTransit);
    }
    this.runtime.committedRecommendationIds.delete(recId);
  }

  kpis(user?: User, branchId?: string): KpiSummary {
    return this.kpiService.kpis(user, branchId);
  }

  list(query: RecommendationQuery, user?: User): RecommendationList {
    this.ensureInitializedSyncIfPossible();
    const allBranchIds = this.data.branches.map((b) => b.id);
    const userBranches = user && user.role !== "admin" ? new Set(scopeBranches(user, allBranchIds)) : null;

    // The engine keeps every positive-benefit draft. The queue only shows moves a buyer would act on.
    const recommendations = this.analysis.recommendations
      .filter(
        (recommendation) =>
          recommendation.netBenefit >= MATERIAL_MIN_NET_BENEFIT &&
          recommendation.quantity >= DEFAULT_POLICY.minTransferQty,
      )
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
      .map((recommendation) => this.overlay(recommendation));

    return RecommendationListSchema.parse({ recommendations, total: recommendations.length });
  }

  branch(id: string, user?: User): BranchDetail | null {
    return this.catalogService.branch(id, user);
  }

  listLocations(user?: User): LocationListResponse {
    return this.catalogService.listLocations(user);
  }

  locationSummary(branchId: string, user?: User): LocationSummaryResponse | null {
    return this.catalogService.locationSummary(branchId, user);
  }

  locationInventory(
    branchId: string,
    query: LocationInventoryQuery,
    user?: User,
  ): LocationInventoryResponse | null {
    return this.catalogService.locationInventory(branchId, query, user);
  }

  locationTrend(
    branchId: string,
    query: LocationTrendQuery,
    user?: User,
  ): LocationTrendResponse | null {
    return this.catalogService.locationTrend(branchId, query, user);
  }

  product(sku: string, user?: User): ProductDetail | null {
    return this.catalogService.product(sku, user);
  }

  listAudit(user?: User, branchId?: string): AuditList {
    this.ensureInitializedSyncIfPossible();
    if (user && !can(user.role, "audit:read")) {
      throw new DecisionForbiddenError("Staff cannot view audit log");
    }

    if (branchId && user && user.role !== "admin" && !isBranchInScope(user, branchId)) {
      throw new DecisionForbiddenError("Access to branch forbidden");
    }

    let entries = [...this.audit].sort((a, b) => b.at.localeCompare(a.at));
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

  private isRecommendationInScope(existing: Recommendation, user?: User): boolean {
    if (!user || user.role === "admin") return true;
    return (
      isBranchInScope(user, existing.branchId) ||
      (existing.donorBranchId ? isBranchInScope(user, existing.donorBranchId) : false)
    );
  }

  async decide(id: string, status: "APPROVED" | "REJECTED", user?: User): Promise<Recommendation | null> {
    await this.ensureInitialized();
    if (user && !can(user.role, "recommendations:decide")) {
      throw new DecisionForbiddenError("Staff cannot approve or reject actions");
    }

    const existing = this.analysis.recommendations.find((recommendation) => recommendation.id === id);
    if (!existing) return null;

    if (!this.isRecommendationInScope(existing, user)) {
      throw new DecisionForbiddenError("Cannot decide action outside your assigned branches");
    }

    if (this.inflightDecisionIds.has(id)) {
      throw new DecisionConflictError("Decision already in progress for this recommendation");
    }

    const alreadyDecided = this.decisions.has(id) || existing.status !== "PENDING";
    this.inflightDecisionIds.add(id);
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
      const { persistedIds } = await this.repo.saveDecisionBatch([record], [entry]);
      if (persistedIds.has(id)) {
        this.decisions.set(id, status);
        this.audit.push(entry);
        this.scopedKpiCache.clear();
      } else {
        this.rollbackStagedDeltas(id, staged);
        // Another instance decided this recommendation first; refresh local overlay.
        applyDecisionHistoryToState(this.runtime, await this.repo.listActions());
        this.scopedKpiCache.clear();
      }
      return RecommendationSchema.parse(this.overlay(existing));
    } catch (err) {
      this.rollbackStagedDeltas(id, staged);
      throw err;
    } finally {
      this.inflightDecisionIds.delete(id);
    }
  }

  async decideBatch(
    ids: readonly string[],
    status: "APPROVED" | "REJECTED",
    user?: User,
    reasonCode?: string,
  ): Promise<BatchDecideItemResult[]> {
    await this.ensureInitialized();
    if (user && !can(user.role, "recommendations:decide")) {
      throw new DecisionForbiddenError("Staff cannot approve or reject actions");
    }

    const byId = new Map(this.analysis.recommendations.map((r) => [r.id, r]));
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
        if (!this.isRecommendationInScope(existing, user)) {
          results.push({ id, status: "forbidden" });
          continue;
        }
        if (
          seen.has(id) ||
          this.decisions.has(id) ||
          this.inflightDecisionIds.has(id) ||
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
        this.inflightDecisionIds.add(id);
        const { record, entry } = this.buildDecisionRecords(existing, status, decidedAt, user, effectiveReasonCode);
        actionsToSave.push(record);
        auditsToSave.push(entry);
        results.push({ id, status: "ok" });
      }

      if (actionsToSave.length > 0) {
        // DECISION: Atomic bulk persist (<= 3 DB ops total with getDataVersion) without bumping dataVersion.
        const { persistedIds, duplicateIds } = await this.repo.saveDecisionBatch(actionsToSave, auditsToSave);
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
            this.decisions.set(record.recommendationId, record.status);
          }
        }
        for (const entry of auditsToSave) {
          if (persistedIds.has(entry.recommendationId)) {
            this.audit.push(entry);
          }
        }
        if (persistedIds.size > 0) {
          this.scopedKpiCache.clear();
        }
        if (duplicateIds.size > 0) {
          applyDecisionHistoryToState(this.runtime, await this.repo.listActions());
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
        this.inflightDecisionIds.delete(id);
      }
    }
  }

  private matches(recommendation: Recommendation, query: RecommendationQuery): boolean {
    if (query.branch && recommendation.branchId !== query.branch) return false;
    if (query.category && recommendation.category !== query.category) return false;
    if (query.action && recommendation.action !== query.action) return false;
    if (query.status && this.overlay(recommendation).status !== query.status) return false;
    return true;
  }

  private overlay(recommendation: Recommendation): Recommendation {
    return applyDecisionOverlay(recommendation, this.decisions);
  }

  // --- Catalog Product Management ---

  async listCatalogProducts(
    query: ProductListQuery,
    user?: User,
  ): Promise<ProductListResponse> {
    return this.catalogService.listCatalogProducts(query, user);
  }

  async getCatalogProduct(sku: string): Promise<ProductDetailWithHistory | null> {
    return this.catalogService.getCatalogProduct(sku);
  }

  async createCatalogProduct(input: CreateProduct, user: User): Promise<Product> {
    return this.catalogService.createCatalogProduct(input, user);
  }

  async updateCatalogProduct(sku: string, input: UpdateProduct, user: User): Promise<Product> {
    return this.catalogService.updateCatalogProduct(sku, input, user);
  }

  async archiveCatalogProduct(
    sku: string,
    user: User,
  ): Promise<{ product: Product; removedPendingActionsCount: number }> {
    return this.catalogService.archiveCatalogProduct(sku, user);
  }

  async restoreCatalogProduct(sku: string, user: User): Promise<Product> {
    return this.catalogService.restoreCatalogProduct(sku, user);
  }

  async deleteCatalogProduct(sku: string, user: User): Promise<void> {
    await this.catalogService.deleteCatalogProduct(sku, user);
  }

  async generateSampleHistory(
    sku: string,
    user: User,
  ): Promise<{ salesEntriesCount: number }> {
    return this.catalogService.generateSampleHistory(sku, user);
  }

  async listStockAlerts(user?: User, branchId?: string): Promise<StockAlertList> {
    await this.ensureInitialized();
    if (branchId && user && !isBranchInScope(user, branchId)) {
      throw new DecisionForbiddenError("Cannot view stock alerts outside your assigned branches");
    }
    const all = await this.repo.listStockAlerts();
    const alerts = branchId
      ? all.filter((alert) => alert.branchId === branchId)
      : !user || user.role === "admin"
        ? all
        : all.filter((alert) => isBranchInScope(user, alert.branchId));
    return StockAlertListSchema.parse({ alerts });
  }

  async createStockAlert(input: CreateStockAlert, user: User): Promise<StockAlert> {
    await this.ensureInitialized();
    if (!can(user.role, "stock:flag")) {
      throw new DecisionForbiddenError("Only branch staff can flag stock alerts");
    }
    if (!isBranchInScope(user, input.branchId)) {
      throw new DecisionForbiddenError("Cannot flag stock outside your assigned branch");
    }

    const branch = this.data.branches.find((b) => b.id === input.branchId);
    if (!branch) {
      throw new StockAlertValidationError(`Unknown branch: ${input.branchId}`);
    }
    const product = this.data.products.find((p) => p.sku === input.sku);
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
      flaggedBy: { userId: user.id, name: user.name, role: user.role },
      flaggedAt: new Date().toISOString(),
      note: input.note.trim(),
      status: "PENDING",
      decidedBy: null,
      decidedAt: null,
    });
    return this.repo.createStockAlert(alert);
  }

  async decideStockAlert(
    id: string,
    decision: "APPROVED" | "REJECTED",
    user: User,
  ): Promise<StockAlert> {
    await this.ensureInitialized();
    if (!can(user.role, "stock:flag:decide")) {
      throw new DecisionForbiddenError("Staff cannot approve or reject stock alerts");
    }
    const existing = await this.repo.getStockAlert(id);
    if (!existing) {
      throw new StockAlertNotFoundError("Stock alert not found");
    }
    if (!isBranchInScope(user, existing.branchId)) {
      throw new DecisionForbiddenError("Cannot decide stock alert outside your assigned branches");
    }
    if (existing.status !== "PENDING") {
      throw new StockAlertConflictError("Stock alert has already been decided and is immutable");
    }

    const result = await this.repo.decideStockAlert(
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
    return StockAlertSchema.parse(result.alert);
  }
}

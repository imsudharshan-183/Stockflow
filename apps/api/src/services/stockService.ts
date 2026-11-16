import { randomUUID } from "node:crypto";
import {
  ActionRecordSchema,
  AuditEntrySchema,
  AuditListSchema,
  BranchDetailSchema,
  DEAD_VELOCITY_PER_DAY,
  DEFAULT_POLICY,
  LocationInventoryResponseSchema,
  LocationListResponseSchema,
  LocationSummaryResponseSchema,
  LocationTrendResponseSchema,
  MATERIAL_MIN_NET_BENEFIT,
  ProductDetailSchema,
  ProductDetailWithHistorySchema,
  ProductListResponseSchema,
  ProductSchema,
  RecommendationListSchema,
  RecommendationSchema,
  StockAlertListSchema,
  StockAlertSchema,
  analyze,
  backtest,
  buildBranchDetail,
  buildProductDetail,
  can,
  coverDaysOf,
  isBranchInScope,
  matchesProductQuery,
  round3,
  scopeBranches,
  type Action,
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
  type LocationCategoryHeatmapCell,
  type LocationInventoryItem,
  type LocationInventoryQuery,
  type LocationInventoryResponse,
  type LocationListResponse,
  type LocationSummaryItem,
  type LocationSummaryResponse,
  type LocationTopRiskSku,
  type LocationTrendQuery,
  type LocationTrendResponse,
  type Position,
  type PositionStatus,
  type Product,
  type ProductChangeRecord,
  type ProductDetail,
  type ProductDetailWithHistory,
  type ProductListQuery,
  type ProductListResponse,
  type ProductStats,
  type ProductStatus,
  type Recommendation,
  type RecommendationList,
  type RecommendationQuery,
  type RecommendationStatus,
  type StockAlert,
  type StockAlertList,
  type UpdateProduct,
  type User,
} from "@stockflow/core";
import { recomputeForSku, upsertSalesEntry } from "../db.js";
import type { StockRepository } from "../repositories/types.js";
import type { UserRepository } from "../repositories/userTypes.js";

const DEMO_USER = "Demo Buyer";

export class DecisionForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionForbiddenError";
  }
}

export class DecisionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionConflictError";
  }
}

export interface CommittedDelta {
  reserved: number;
  inTransit: number;
}

export interface ProjectedPosition extends Position {
  reserved: number;
  inTransit: number;
}

const ZERO_DELTA: CommittedDelta = { reserved: 0, inTransit: 0 };

/**
 * Pure projection applying committed outgoing reservations and inbound stock
 * on top of an immutable engine Position snapshot.
 */
export function project(
  rawPosition: Position,
  deltas: CommittedDelta = ZERO_DELTA,
): ProjectedPosition {
  const reserved = Math.max(0, deltas.reserved);
  const inTransit = Math.max(0, deltas.inTransit);
  if (reserved === 0 && inTransit === 0) {
    return { ...rawPosition, reserved: 0, inTransit: 0 };
  }

  const onHand = Math.max(0, rawPosition.onHand - reserved);
  const surplus = Math.max(0, rawPosition.surplus - reserved);
  const effectiveStock = onHand + inTransit;
  const coverDays = coverDaysOf(effectiveStock, rawPosition.velocity);
  const onHandCoverDays = coverDaysOf(onHand, rawPosition.velocity);

  let status: PositionStatus = rawPosition.status;
  if (rawPosition.inStockDays === 0) {
    status = "NEW";
  } else {
    const overstock =
      onHandCoverDays === null ? onHand > 0 : onHandCoverDays > DEFAULT_POLICY.overstockCoverDays;
    if (overstock) {
      status = "OVERSTOCK";
    } else if (effectiveStock < rawPosition.reorderPoint) {
      status = "AT_RISK";
    } else {
      status = "HEALTHY";
    }
  }

  const need = status === "AT_RISK" ? Math.max(0, rawPosition.need - inTransit) : 0;
  const lostUnits = status === "AT_RISK" ? Math.max(0, rawPosition.lostUnits - inTransit) : 0;

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
  };
}

export class ProductConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductConflictError";
  }
}

export class ProductNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductNotFoundError";
  }
}

export class ProductValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductValidationError";
  }
}

export class StockAlertNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StockAlertNotFoundError";
  }
}

export class StockAlertConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StockAlertConflictError";
  }
}

export class StockAlertValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StockAlertValidationError";
  }
}

// The morning plan is computed once per process. Approve and reject overlay status; they do not recompute velocity.
// SCALE: a new day or a policy edit is the point to recompute, per SKU, instead of rebuilding 500 x 15 series on every request.

export class StockService {
  private readonly decisions = new Map<string, Extract<RecommendationStatus, "APPROVED" | "REJECTED">>();
  private readonly committedDeltas = new Map<string, CommittedDelta>();
  private readonly committedAllocations = new Map<
    string,
    { sku: string; branchId: string; donorBranchId: string | null; action: Action; quantity: number }
  >();
  private readonly inflightDecisionIds = new Set<string>();
  private readonly scopedKpiCache = new Map<string, KpiSummary>();
  private audit: AuditEntry[] = [];
  private planVersion = 0;
  private initialized = false;
  private inflightRefresh: Promise<void> | null = null;
  private data!: Dataset;
  private analysis!: Analysis;

  private constructor(
    private readonly repo: StockRepository,
    data?: Dataset,
    analysis?: Analysis,
    planVersion = 0,
  ) {
    if (data && analysis) {
      this.data = data;
      this.analysis = analysis;
      this.planVersion = planVersion;
      this.initialized = true;
    }
  }

  static async create(repo: StockRepository): Promise<StockService> {
    // DECISION: Defer dataset loading and morning plan computation until first use so
    // HTTP server startup and /api/health are never blocked by slow dataset or DB loads.
    return new StockService(repo);
  }

  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    if (!this.inflightRefresh) {
      this.inflightRefresh = (async () => {
        if (this.initialized) return;

        const tDataset = performance.now();
        const data = await this.repo.loadDataset();
        const datasetMs = Math.round(performance.now() - tDataset);
        console.log(`loading dataset (${datasetMs}ms)`);

        const tPlan = performance.now();
        const currentVersion = await this.repo.getDataVersion();
        const cached = await this.repo.loadCachedPlan(currentVersion);

        let analysis: Analysis;
        if (cached) {
          analysis = cached.plan;
        } else {
          analysis = (await this.repo.loadAnalysis()) ?? computeActivePlan(data);
          try {
            await this.repo.saveCachedPlan(currentVersion, analysis);
          } catch {
            // Fallback to compute-and-serve if plan persistence fails.
          }
        }
        const planMs = Math.round(performance.now() - tPlan);
        console.log(`computing plan (${planMs}ms)`);

        this.data = data;
        this.analysis = analysis;
        this.planVersion = currentVersion;
        this.scopedKpiCache.clear();
        const replayCutoff = currentVersion > 1 ? cached?.computedAt : undefined;
        await this.syncDecisionsAndAudit(replayCutoff);
        this.initialized = true;
      })().finally(() => {
        this.inflightRefresh = null;
      });
    }

    await this.inflightRefresh;
  }

  private ensureInitializedSyncIfPossible(): void {
    if (this.initialized) return;
    const syncRepo = this.repo as StockRepository & {
      peekDatasetSync?: () => Dataset;
      peekDataVersionSync?: () => number;
      peekCachedPlanSync?: (v: number) => { plan: Analysis } | null;
      saveCachedPlanSync?: (v: number, plan: Analysis) => void;
      peekActionsSync?: () => ActionRecord[];
      peekAuditSync?: () => AuditEntry[];
    };
    if (typeof syncRepo.peekDatasetSync === "function") {
      const tDataset = performance.now();
      const data = syncRepo.peekDatasetSync();
      const datasetMs = Math.round(performance.now() - tDataset);
      console.log(`loading dataset (${datasetMs}ms)`);

      const tPlan = performance.now();
      const currentVersion = syncRepo.peekDataVersionSync?.() ?? 1;
      const cached = syncRepo.peekCachedPlanSync?.(currentVersion) as
        | { plan: Analysis; computedAt?: string }
        | null
        | undefined;
      const analysis = cached ? cached.plan : computeActivePlan(data);
      if (!cached) {
        syncRepo.saveCachedPlanSync?.(currentVersion, analysis);
      }
      const planMs = Math.round(performance.now() - tPlan);
      console.log(`computing plan (${planMs}ms)`);

      this.data = data;
      this.analysis = analysis;
      this.planVersion = currentVersion;
      this.scopedKpiCache.clear();
      if (typeof syncRepo.peekActionsSync === "function") {
        this.applyDecisionHistory(syncRepo.peekActionsSync());
      }
      if (typeof syncRepo.peekAuditSync === "function") {
        this.audit = syncRepo.peekAuditSync();
      }
      this.replayApprovedTransfersFromAudit(currentVersion > 1 ? cached?.computedAt : undefined);
      this.initialized = true;
    }
  }

  private applyDecisionHistory(history: ActionRecord[]): void {
    this.decisions.clear();
    const sorted = [...history].sort((a, b) => a.decidedAt.localeCompare(b.decidedAt));
    for (const action of sorted) this.decisions.set(action.recommendationId, action.status);
  }

  /**
   * Reconstructs committedDeltas at startup from persisted APPROVED transfer
   * records in the audits collection so restarts never lose live reservations.
   */
  private replayApprovedTransfersFromAudit(replayCutoffAt?: string): void {
    this.clearAllCommittedDeltas();
    const recById = new Map(this.analysis.recommendations.map((r) => [r.id, r]));
    const sorted = [...this.audit].sort((a, b) => a.at.localeCompare(b.at));
    const seenRecIds = new Set<string>();

    for (const entry of sorted) {
      if (entry.decision !== "APPROVED" || entry.action !== "TRANSFER") continue;
      if (replayCutoffAt && entry.at < replayCutoffAt) continue;
      if (seenRecIds.has(entry.recommendationId)) continue;
      seenRecIds.add(entry.recommendationId);

      // Respect actions collection if present (e.g. if an external script cleared decisions).
      if (this.decisions.size > 0 && this.decisions.get(entry.recommendationId) !== "APPROVED") {
        continue;
      }

      const rec = recById.get(entry.recommendationId);
      if (!rec || rec.action !== "TRANSFER" || !rec.donorBranchId) continue;

      this.adjustDelta(rec.sku, rec.donorBranchId, rec.quantity, 0);
      this.adjustDelta(rec.sku, rec.branchId, 0, rec.quantity);
      this.committedAllocations.set(rec.id, {
        sku: rec.sku,
        branchId: rec.branchId,
        donorBranchId: rec.donorBranchId,
        action: rec.action,
        quantity: rec.quantity,
      });
    }
  }

  private async syncDecisionsAndAudit(replayCutoffAt?: string): Promise<void> {
    const [history, audit] = await Promise.all([this.repo.listActions(), this.repo.listAudit()]);
    this.applyDecisionHistory(history);
    this.audit = audit;
    this.replayApprovedTransfersFromAudit(replayCutoffAt);
  }

  async ensureFreshPlan(options?: { syncDecisions?: boolean; syncAudit?: boolean }): Promise<void> {
    if (!this.initialized) {
      await this.ensureInitialized();
      return;
    }

    const syncDecisions = options?.syncDecisions ?? true;
    const syncAudit = options?.syncAudit ?? false;

    const [currentVersion, actions, audit] = await Promise.all([
      this.repo.getDataVersion(),
      syncDecisions ? this.repo.listActions() : Promise.resolve(null),
      syncAudit ? this.repo.listAudit() : Promise.resolve(null),
    ]);

    if (actions) this.applyDecisionHistory(actions);
    if (audit) this.audit = audit;
    if (currentVersion === this.planVersion) return;

    if (!this.inflightRefresh) {
      this.inflightRefresh = (async () => {
        if (currentVersion === this.planVersion) return;

        const tDataset = performance.now();
        const [freshData, cached] = await Promise.all([
          this.repo.loadDataset(),
          this.repo.loadCachedPlan(currentVersion),
        ]);
        const datasetMs = Math.round(performance.now() - tDataset);
        console.log(`loading dataset (${datasetMs}ms)`);

        const tPlan = performance.now();
        let nextPlan: Analysis;
        if (cached) {
          nextPlan = cached.plan;
        } else {
          nextPlan = computeActivePlan(freshData);
          try {
            await this.repo.saveCachedPlan(currentVersion, nextPlan);
          } catch {
            // Fallback to compute-and-serve if plan persistence fails.
          }
        }
        const planMs = Math.round(performance.now() - tPlan);
        console.log(`computing plan (${planMs}ms)`);

        this.data = freshData;
        this.analysis = nextPlan;
        this.planVersion = currentVersion;
        this.clearAllCommittedDeltas();
        this.scopedKpiCache.clear();
        if (!actions) this.applyDecisionHistory(await this.repo.listActions());
        if (!audit) this.audit = await this.repo.listAudit();
      })().finally(() => {
        this.inflightRefresh = null;
      });
    }

    await this.inflightRefresh;
  }

  async commitPlanVersion(): Promise<number> {
    const nextVersion = await this.repo.bumpDataVersion();
    this.planVersion = nextVersion;
    try {
      await this.repo.saveCachedPlan(nextVersion, this.analysis);
    } catch {
      // Fallback to compute-and-serve if plan persistence fails.
    }
    return nextVersion;
  }

  get userRepo(): UserRepository {
    return this.repo.users;
  }

  repositoryKind(): "memory" | "mongo" {
    return this.repo.kind;
  }

  hasBranch(branchId: string): boolean {
    this.ensureInitializedSyncIfPossible();
    return this.data.branches.some((b) => b.id === branchId);
  }

  allBranchIds(): string[] {
    this.ensureInitializedSyncIfPossible();
    return this.data.branches.map((b) => b.id);
  }

  getProductStatus(sku: string): ProductStatus | "unknown" {
    this.ensureInitializedSyncIfPossible();
    const p = this.data.products.find((prod) => prod.sku === sku);
    if (!p) return "unknown";
    return p.status ?? "active";
  }

  applySalesEntryToDataset(
    branchId: string,
    sku: string,
    date: string,
    unitsSold: number,
    onHand: number,
  ): void {
    this.ensureInitializedSyncIfPossible();
    const sIdx = this.data.products.findIndex((p) => p.sku === sku);
    const bIdx = this.data.branches.findIndex((b) => b.id === branchId);
    if (sIdx < 0 || bIdx < 0) return;

    const product = this.data.products[sIdx]!;
    if (product.status === "archived") return;

    let dIdx = this.data.dates.indexOf(date);
    if (dIdx < 0) {
      dIdx = this.data.dates.length - 1;
    }
    if (dIdx < 0) return;

    const salesRow = this.data.sales[sIdx]?.[bIdx];
    const onHandRow = this.data.onHand[sIdx]?.[bIdx];
    const demandRow = this.data.demand[sIdx]?.[bIdx];
    if (salesRow && onHandRow && demandRow) {
      salesRow[dIdx] = unitsSold;
      onHandRow[dIdx] = onHand;
      demandRow[dIdx] = unitsSold;
    }
  }

  async recomputeSingleSku(sku: string, options: { bumpVersion?: boolean } = {}): Promise<void> {
    await this.ensureInitialized();
    const sIdx = this.data.products.findIndex((p) => p.sku === sku);
    if (sIdx < 0) return;
    const product = this.data.products[sIdx]!;
    if (product.status === "archived") return;

    this.clearCommittedForSku(sku);
    const singleDataset: Dataset = {
      ...this.data,
      products: [product],
      sales: [this.data.sales[sIdx] ?? []],
      onHand: [this.data.onHand[sIdx] ?? []],
      demand: [this.data.demand[sIdx] ?? []],
    };
    const singleAnalysis = analyze(singleDataset, DEFAULT_POLICY);
    if (singleAnalysis.positions[0]) {
      this.analysis.positions[sIdx] = singleAnalysis.positions[0];
    }
    const otherRecs = this.analysis.recommendations.filter((r) => r.sku !== sku);
    const merged = [...otherRecs, ...singleAnalysis.recommendations].sort(
      (a, b) =>
        b.netBenefit - a.netBenefit ||
        a.sku.localeCompare(b.sku) ||
        a.branchId.localeCompare(b.branchId) ||
        a.action.localeCompare(b.action),
    );
    this.analysis.recommendations = merged.map((r, idx) => ({ ...r, rank: idx + 1 }));
    this.scopedKpiCache.clear();
    if (options.bumpVersion !== false) {
      await this.commitPlanVersion();
    }
  }

  private deltaKey(sku: string, branchId: string): string {
    return `${sku}::${branchId}`;
  }

  private getDelta(sku: string, branchId: string): CommittedDelta {
    return this.committedDeltas.get(this.deltaKey(sku, branchId)) ?? ZERO_DELTA;
  }

  private adjustDelta(sku: string, branchId: string, dReserved: number, dInTransit: number): void {
    const key = this.deltaKey(sku, branchId);
    const current = this.committedDeltas.get(key) ?? ZERO_DELTA;
    const reserved = Math.max(0, current.reserved + dReserved);
    const inTransit = Math.max(0, current.inTransit + dInTransit);
    if (reserved === 0 && inTransit === 0) {
      this.committedDeltas.delete(key);
    } else {
      this.committedDeltas.set(key, { reserved, inTransit });
    }
  }

  private clearCommittedForSku(sku: string): void {
    const prefix = `${sku}::`;
    for (const key of this.committedDeltas.keys()) {
      if (key.startsWith(prefix)) this.committedDeltas.delete(key);
    }
    for (const [id, entry] of this.committedAllocations.entries()) {
      if (entry.sku === sku) this.committedAllocations.delete(id);
    }
  }

  private clearAllCommittedDeltas(): void {
    this.committedDeltas.clear();
    this.committedAllocations.clear();
  }

  private findRawPosition(sku: string, branchId: string): Position | undefined {
    const sIdx = this.data.products.findIndex((p) => p.sku === sku);
    const bIdx = this.data.branches.findIndex((b) => b.id === branchId);
    if (sIdx < 0 || bIdx < 0) return undefined;
    return this.analysis.positions[sIdx]?.[bIdx];
  }

  private projectPositionFor(skuIndex: number, branchIndex: number): ProjectedPosition | undefined {
    const raw = this.analysis.positions[skuIndex]?.[branchIndex];
    const product = this.data.products[skuIndex];
    const branch = this.data.branches[branchIndex];
    if (!raw || !product || !branch) return raw ? project(raw) : undefined;
    return project(raw, this.getDelta(product.sku, branch.id));
  }

  private projectedPositions(onlySkuIndex?: number): ProjectedPosition[][] {
    return this.analysis.positions.map((row, sIdx) => {
      if (onlySkuIndex !== undefined && sIdx !== onlySkuIndex) {
        return row.map((pos) => project(pos));
      }
      return row.map((pos, bIdx) => this.projectPositionFor(sIdx, bIdx) ?? project(pos));
    });
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
      this.committedAllocations.set(rec.id, {
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
    this.committedAllocations.delete(recId);
  }

  private accumulateProjectedKpis(branchIndices: readonly number[]): {
    deadStockValue: number;
    lostSalesAtRisk: number;
    cashReleasable: number;
    revenueAtRiskByBranch: Map<string, number>;
  } {
    let deadStockValue = 0;
    let lostSalesAtRisk = 0;
    let cashReleasable = 0;
    const revenueAtRiskByBranch = new Map<string, number>();

    for (let sku = 0; sku < this.data.products.length; sku += 1) {
      const product = this.data.products[sku];
      if (!product) continue;
      for (const bIdx of branchIndices) {
        const branch = this.data.branches[bIdx];
        const position = this.projectPositionFor(sku, bIdx);
        if (!branch || !position) continue;
        if (position.status === "OVERSTOCK" && position.velocity < DEAD_VELOCITY_PER_DAY) {
          deadStockValue += position.onHand * product.cost;
        }
        if (position.status === "AT_RISK") {
          const risk = position.lostUnits * product.price;
          lostSalesAtRisk += risk;
          revenueAtRiskByBranch.set(branch.id, (revenueAtRiskByBranch.get(branch.id) ?? 0) + risk);
        }
        if (position.status === "OVERSTOCK") {
          cashReleasable += position.surplus * product.cost;
        }
      }
    }

    return { deadStockValue, lostSalesAtRisk, cashReleasable, revenueAtRiskByBranch };
  }

  kpis(user?: User, branchId?: string): KpiSummary {
    this.ensureInitializedSyncIfPossible();
    if (!branchId && (!user || can(user.role, "dashboard:financial:network"))) {
      if (this.committedDeltas.size === 0) {
        return this.analysis.kpis;
      }
      const allBranchIndices = this.data.branches.map((_, idx) => idx);
      const { deadStockValue, lostSalesAtRisk, cashReleasable, revenueAtRiskByBranch } =
        this.accumulateProjectedKpis(allBranchIndices);

      return {
        ...this.analysis.kpis,
        deadStockValue: round3(deadStockValue),
        lostSalesAtRisk: round3(lostSalesAtRisk),
        cashReleasable: round3(cashReleasable),
        branchRisk: this.analysis.kpis.branchRisk.map((row) => ({
          ...row,
          revenueAtRisk: round3(revenueAtRiskByBranch.get(row.branchId) ?? 0),
        })),
      };
    }

    if (user && !can(user.role, "dashboard:financial:scoped")) {
      throw new DecisionForbiddenError("Insufficient permission to view KPIs");
    }

    const allBranchIds = this.data.branches.map((b) => b.id);
    const allowedList = user ? scopeBranches(user, allBranchIds) : allBranchIds;
    if (branchId) {
      if (user && user.role !== "admin" && !isBranchInScope(user, branchId)) {
        throw new DecisionForbiddenError("Access to branch forbidden");
      }
      if (!allBranchIds.includes(branchId)) {
        throw new DecisionForbiddenError("Branch not found in scope");
      }
    }
    const scopedList = branchId ? [branchId] : allowedList;
    const cacheKey = [...scopedList].sort().join("|");
    const cached = this.scopedKpiCache.get(cacheKey);
    if (cached) return cached;

    const userBranches = new Set(scopedList);
    const branches = this.analysis.kpis.branches.filter((b) => userBranches.has(b.id));
    const coverGrid = this.analysis.kpis.coverGrid.filter((b) => userBranches.has(b.branchId));
    const branchIndices: number[] = [];
    for (let bIdx = 0; bIdx < this.data.branches.length; bIdx += 1) {
      const branch = this.data.branches[bIdx];
      if (branch && userBranches.has(branch.id)) branchIndices.push(bIdx);
    }

    const { deadStockValue, lostSalesAtRisk, cashReleasable, revenueAtRiskByBranch } =
      this.accumulateProjectedKpis(branchIndices);

    const branchRisk = this.analysis.kpis.branchRisk
      .filter((b) => userBranches.has(b.branchId))
      .map((row) =>
        this.committedDeltas.size === 0
          ? row
          : { ...row, revenueAtRisk: round3(revenueAtRiskByBranch.get(row.branchId) ?? 0) },
      );

    const trend = this.data.dates.map((date, day) => {
      let stockouts = 0;
      let cells = 0;
      let salesValue = 0;
      let inventoryValue = 0;
      for (let sku = 0; sku < this.data.products.length; sku += 1) {
        const product = this.data.products[sku];
        const salesByBranch = this.data.sales[sku];
        const stockByBranch = this.data.onHand[sku];
        const demandByBranch = this.data.demand[sku];
        if (!product || !salesByBranch || !stockByBranch || !demandByBranch) continue;
        for (const bIdx of branchIndices) {
          const sold = salesByBranch[bIdx]?.[day] ?? 0;
          const onHand = stockByBranch[bIdx]?.[day] ?? 0;
          const demand = demandByBranch[bIdx]?.[day] ?? 0;
          cells += 1;
          salesValue += sold * product.price;
          inventoryValue += onHand * product.cost;
          if (demand > 0 && onHand + sold <= 0) stockouts += 1;
        }
      }
      return {
        date,
        stockoutRate: cells === 0 ? 0 : stockouts / cells,
        salesValue: Math.round((salesValue + Number.EPSILON) * 100) / 100,
        inventoryValue: Math.round((inventoryValue + Number.EPSILON) * 100) / 100,
      };
    });

    const scopedDataset: Dataset = {
      ...this.data,
      branches,
      sales: this.data.sales.map((byBranch) => branchIndices.map((bIdx) => byBranch[bIdx] ?? [])),
      onHand: this.data.onHand.map((byBranch) => branchIndices.map((bIdx) => byBranch[bIdx] ?? [])),
      demand: this.data.demand.map((byBranch) => branchIndices.map((bIdx) => byBranch[bIdx] ?? [])),
    };
    const scopedBacktest =
      branches.length > 0
        ? backtest(scopedDataset, DEFAULT_POLICY)
        : {
            windowDays: Math.min(DEFAULT_POLICY.backtestDays, this.data.dates.length),
            baselineStockoutDays: 0,
            engineStockoutDays: 0,
            stockoutDaysAvoided: 0,
            cashReleased: 0,
          };

    const stockoutRates = branchRisk.map((r) => r.stockoutRate);
    const avgStockoutRate =
      stockoutRates.length > 0 ? stockoutRates.reduce((sum, r) => sum + r, 0) / stockoutRates.length : 0;

    const scopedPendingRecs = this.analysis.recommendations.filter((rec) => {
      const status = this.decisions.get(rec.id) ?? rec.status;
      if (status !== "PENDING") return false;
      return userBranches.has(rec.branchId) || (rec.donorBranchId ? userBranches.has(rec.donorBranchId) : false);
    });
    const pendingApprovalsCount = scopedPendingRecs.length;
    const backlogValue = Math.round((scopedPendingRecs.reduce((acc, r) => acc + r.netBenefit, 0) + Number.EPSILON) * 100) / 100;
    const atRiskBranchCount = branchRisk.filter((r) => r.stockoutRate > 0.05 || r.revenueAtRisk > 0).length;

    const result: KpiSummary = {
      ...this.analysis.kpis,
      branches,
      branchRisk,
      coverGrid,
      trend,
      backtest: scopedBacktest,
      deadStockValue: round3(deadStockValue),
      lostSalesAtRisk: round3(lostSalesAtRisk),
      cashReleasable: round3(cashReleasable),
      stockoutRate: Math.round(avgStockoutRate * 1000) / 1000,
      operational: {
        pendingApprovalsCount,
        backlogValue,
        atRiskBranchCount,
      },
      scope: scopedList,
    };
    this.scopedKpiCache.set(cacheKey, result);
    return result;
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
    this.ensureInitializedSyncIfPossible();
    if (user && !isBranchInScope(user, id)) {
      return null;
    }

    const detail = buildBranchDetail(
      this.data,
      this.projectedPositions(),
      this.analysis.recommendations,
      id,
    );
    if (!detail) return null;
    return BranchDetailSchema.parse({
      ...detail,
      recommendations: detail.recommendations.map((recommendation) => this.overlay(recommendation)),
    });
  }

  private resolveScopedBranchIndex(branchId: string, user?: User): number | null {
    this.ensureInitializedSyncIfPossible();
    if (user && user.role !== "admin" && !isBranchInScope(user, branchId)) {
      return null;
    }
    const idx = this.data.branches.findIndex((b) => b.id === branchId);
    return idx >= 0 ? idx : null;
  }

  private materialRecommendations() {
    this.ensureInitializedSyncIfPossible();
    return this.analysis.recommendations.filter(
      (rec) =>
        rec.netBenefit >= MATERIAL_MIN_NET_BENEFIT &&
        rec.quantity >= DEFAULT_POLICY.minTransferQty,
    );
  }

  listLocations(user?: User): LocationListResponse {
    this.ensureInitializedSyncIfPossible();
    const allBranchIds = this.data.branches.map((b) => b.id);
    const allowedSet = new Set(user ? scopeBranches(user, allBranchIds) : allBranchIds);
    const materialRecs = this.materialRecommendations();
    const riskByBranch = new Map(this.analysis.kpis.branchRisk.map((r) => [r.branchId, r]));

    const locations: LocationSummaryItem[] = [];
    for (let bIdx = 0; bIdx < this.data.branches.length; bIdx += 1) {
      const branch = this.data.branches[bIdx]!;
      if (!allowedSet.has(branch.id)) continue;

      let atRiskCount = 0;
      let overstockCount = 0;
      let totalSkus = 0;
      let lostSalesAtRisk = 0;
      let cashReleasable = 0;

      for (let sIdx = 0; sIdx < this.data.products.length; sIdx += 1) {
        const product = this.data.products[sIdx];
        if (!product || product.status === "archived") continue;
        const pos = this.projectPositionFor(sIdx, bIdx);
        if (!pos) continue;
        totalSkus += 1;
        if (pos.status === "AT_RISK") {
          atRiskCount += 1;
          lostSalesAtRisk += pos.lostUnits * product.price;
        } else if (pos.status === "OVERSTOCK") {
          overstockCount += 1;
          cashReleasable += pos.surplus * product.cost;
        }
      }

      const pendingCount = materialRecs.filter((rec) => {
        const status = this.decisions.get(rec.id) ?? rec.status;
        if (status !== "PENDING") return false;
        return rec.branchId === branch.id || rec.donorBranchId === branch.id;
      }).length;

      const share = totalSkus > 0 ? atRiskCount / totalSkus : 0;
      const health: LocationSummaryItem["health"] =
        share >= 0.25 ? "red" : share >= 0.1 || atRiskCount > 0 ? "amber" : "green";

      locations.push({
        branch,
        health,
        atRiskCount,
        overstockCount,
        totalSkus,
        pendingCount,
        stockoutRate: riskByBranch.get(branch.id)?.stockoutRate ?? 0,
        lostSalesAtRisk: Math.round(lostSalesAtRisk * 100) / 100,
        cashReleasable: Math.round(cashReleasable * 100) / 100,
      });
    }

    return LocationListResponseSchema.parse({ locations });
  }

  locationSummary(branchId: string, user?: User): LocationSummaryResponse | null {
    const bIdx = this.resolveScopedBranchIndex(branchId, user);
    if (bIdx === null) return null;
    const branch = this.data.branches[bIdx]!;

    const detail = buildBranchDetail(
      this.data,
      this.projectedPositions(),
      this.analysis.recommendations,
      branchId,
    );
    if (!detail) return null;

    let skusAtRisk = 0;
    let overstockValue = 0;
    let totalActiveSkus = 0;
    const bandCounts: Record<PositionStatus, number> = {
      AT_RISK: 0,
      HEALTHY: 0,
      OVERSTOCK: 0,
      NEW: 0,
    };
    const heatmapMap = new Map<string, LocationCategoryHeatmapCell>();
    const atRiskSkus: LocationTopRiskSku[] = [];

    for (let sIdx = 0; sIdx < this.data.products.length; sIdx += 1) {
      const product = this.data.products[sIdx];
      if (!product || product.status === "archived") continue;
      const pos = this.projectPositionFor(sIdx, bIdx);
      if (!pos) continue;

      totalActiveSkus += 1;
      bandCounts[pos.status] += 1;

      if (pos.status === "AT_RISK") {
        skusAtRisk += 1;
        atRiskSkus.push({
          sku: product.sku,
          name: product.name,
          category: product.category,
          onHand: pos.onHand,
          coverDays: pos.coverDays !== null && pos.coverDays >= 9999 ? null : pos.coverDays,
          reorderPoint: Math.round(pos.reorderPoint * 10) / 10,
          lostSalesAtRisk: Math.round(pos.lostUnits * product.price * 100) / 100,
          status: pos.status,
        });
      }
      if (pos.status === "OVERSTOCK") {
        overstockValue += pos.onHand * product.cost;
      }

      const cellKey = `${product.category}::${pos.status}`;
      const existingCell = heatmapMap.get(cellKey);
      const cellValue = pos.onHand * product.cost;
      if (existingCell) {
        existingCell.count += 1;
        existingCell.value = Math.round((existingCell.value + cellValue) * 100) / 100;
      } else {
        heatmapMap.set(cellKey, {
          category: product.category,
          status: pos.status,
          count: 1,
          value: Math.round(cellValue * 100) / 100,
        });
      }
    }

    const materialRecs = this.materialRecommendations().map((rec) => this.overlay(rec));
    const needsStock = materialRecs.filter(
      (rec) =>
        (rec.action === "REORDER" && rec.branchId === branchId) ||
        (rec.action === "TRANSFER" && rec.branchId === branchId),
    );
    const canGive = materialRecs.filter(
      (rec) => rec.action === "TRANSFER" && rec.donorBranchId === branchId,
    );
    const shouldMarkdown = materialRecs.filter(
      (rec) => rec.action === "MARKDOWN" && rec.branchId === branchId,
    );

    const pendingDecisions = [...needsStock, ...canGive, ...shouldMarkdown].filter(
      (rec) => rec.status === "PENDING",
    ).length;

    const sumBenefit = (list: typeof materialRecs) =>
      Math.round((list.reduce((acc, r) => acc + r.netBenefit, 0) + Number.EPSILON) * 100) / 100;

    const coverBands = (["AT_RISK", "HEALTHY", "OVERSTOCK", "NEW"] as const).map((band) => ({
      band,
      count: bandCounts[band],
      share: totalActiveSkus > 0 ? Math.round((bandCounts[band] / totalActiveSkus) * 1000) / 1000 : 0,
    }));

    atRiskSkus.sort((a, b) => b.lostSalesAtRisk - a.lostSalesAtRisk);

    return LocationSummaryResponseSchema.parse({
      branch,
      asOf: this.analysis.kpis.asOf,
      kpis: {
        stockoutRate: detail.stockoutRate,
        skusAtRisk,
        overstockValue: Math.round(overstockValue * 100) / 100,
        lostSalesAtRisk: detail.lostSalesAtRisk,
        cashReleasable: detail.cashReleasable,
        pendingDecisions,
      },
      needsStock,
      canGive,
      shouldMarkdown,
      totals: {
        needsStockCount: needsStock.length,
        needsStockValue: sumBenefit(needsStock),
        canGiveCount: canGive.length,
        canGiveValue: sumBenefit(canGive),
        shouldMarkdownCount: shouldMarkdown.length,
        shouldMarkdownValue: sumBenefit(shouldMarkdown),
      },
      coverBands,
      categoryHeatmap: Array.from(heatmapMap.values()),
      topAtRiskSkus: atRiskSkus.slice(0, 10),
    });
  }

  locationInventory(
    branchId: string,
    query: LocationInventoryQuery,
    user?: User,
  ): LocationInventoryResponse | null {
    const bIdx = this.resolveScopedBranchIndex(branchId, user);
    if (bIdx === null) return null;
    const branch = this.data.branches[bIdx]!;

    const recBySku = new Map<string, Recommendation>();
    for (const rec of this.materialRecommendations()) {
      if (rec.branchId === branchId || rec.donorBranchId === branchId) {
        const overlaid = this.overlay(rec);
        if (!recBySku.has(rec.sku) || overlaid.status === "PENDING") {
          recBySku.set(rec.sku, overlaid);
        }
      }
    }

    const categoriesSet = new Set<string>();
    const allItems: LocationInventoryItem[] = [];
    const searchLower = query.search?.trim().toLowerCase() ?? "";

    for (let sIdx = 0; sIdx < this.data.products.length; sIdx += 1) {
      const product = this.data.products[sIdx];
      if (!product || product.status === "archived") continue;
      const pos = this.projectPositionFor(sIdx, bIdx);
      if (!pos) continue;

      categoriesSet.add(product.category);

      if (query.category && product.category !== query.category) continue;
      if (query.status && pos.status !== query.status) continue;
      if (
        searchLower &&
        !product.sku.toLowerCase().includes(searchLower) &&
        !product.name.toLowerCase().includes(searchLower)
      ) {
        continue;
      }

      const rec = recBySku.get(product.sku) ?? null;
      allItems.push({
        sku: product.sku,
        name: product.name,
        category: product.category,
        onHand: pos.onHand,
        velocity: Math.round(pos.velocity * 100) / 100,
        coverDays: pos.coverDays !== null && pos.coverDays >= 9999 ? null : pos.coverDays,
        reorderPoint: Math.round(pos.reorderPoint * 10) / 10,
        status: pos.status,
        surplus: pos.surplus,
        reserved: pos.reserved,
        inTransit: pos.inTransit,
        recommendedAction: rec?.action ?? null,
        recommendationId: rec?.id ?? null,
        netBenefit: rec?.netBenefit ?? null,
      });
    }

    const dir = query.sortDir === "desc" ? -1 : 1;
    allItems.sort((a, b) => {
      switch (query.sortBy) {
        case "sku":
          return a.sku.localeCompare(b.sku) * dir;
        case "name":
          return a.name.localeCompare(b.name) * dir;
        case "category":
          return a.category.localeCompare(b.category) * dir;
        case "onHand":
          return (a.onHand - b.onHand) * dir;
        case "reorderPoint":
          return (a.reorderPoint - b.reorderPoint) * dir;
        case "status":
          return a.status.localeCompare(b.status) * dir;
        case "coverDays":
        default: {
          const av = a.coverDays ?? Number.MAX_SAFE_INTEGER;
          const bv = b.coverDays ?? Number.MAX_SAFE_INTEGER;
          return (av - bv) * dir;
        }
      }
    });

    const total = allItems.length;
    const totalPages = Math.max(1, Math.ceil(total / query.limit));
    const page = Math.min(query.page, totalPages);
    const start = (page - 1) * query.limit;
    const items = allItems.slice(start, start + query.limit);

    return LocationInventoryResponseSchema.parse({
      branch,
      items,
      categories: Array.from(categoriesSet).sort(),
      total,
      page,
      limit: query.limit,
      totalPages,
    });
  }

  locationTrend(
    branchId: string,
    query: LocationTrendQuery,
    user?: User,
  ): LocationTrendResponse | null {
    const bIdx = this.resolveScopedBranchIndex(branchId, user);
    if (bIdx === null) return null;
    const branch = this.data.branches[bIdx]!;

    const daysCount = Number(query.range);
    const totalDays = this.data.dates.length;
    const startIdx = Math.max(0, totalDays - daysCount);

    const matchingSkuIndices: number[] = [];
    for (let sIdx = 0; sIdx < this.data.products.length; sIdx += 1) {
      const product = this.data.products[sIdx];
      if (!product || product.status === "archived") continue;
      if (query.sku && product.sku !== query.sku) continue;
      if (query.category && product.category !== query.category) continue;
      matchingSkuIndices.push(sIdx);
    }

    const points = [];
    for (let d = startIdx; d < totalDays; d += 1) {
      let salesUnits = 0;
      let onHandUnits = 0;
      for (const sIdx of matchingSkuIndices) {
        salesUnits += this.data.sales[sIdx]?.[bIdx]?.[d] ?? 0;
        onHandUnits += this.data.onHand[sIdx]?.[bIdx]?.[d] ?? 0;
      }
      points.push({
        date: this.data.dates[d]!,
        salesUnits,
        onHandUnits,
      });
    }

    return LocationTrendResponseSchema.parse({
      branch,
      sku: query.sku ?? null,
      category: query.category ?? null,
      range: query.range,
      points,
    });
  }

  product(sku: string, user?: User): ProductDetail | null {
    this.ensureInitializedSyncIfPossible();
    const sIdx = this.data.products.findIndex((p) => p.sku === sku);
    const detail = buildProductDetail(
      this.data,
      DEFAULT_POLICY,
      this.projectedPositions(sIdx >= 0 ? sIdx : undefined),
      this.analysis.recommendations,
      sku,
    );
    if (!detail) return null;

    let positions = detail.positions;
    let series = detail.series;
    if (user && user.role !== "admin") {
      positions = positions.filter((p) => isBranchInScope(user, p.branch.id));
      series = series.filter((s) => isBranchInScope(user, s.branchId));
    }

    return ProductDetailSchema.parse({
      ...detail,
      positions: positions.map((position) => ({
        ...position,
        recommendation: position.recommendation ? this.overlay(position.recommendation) : null,
      })),
      series,
    });
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
      // DECISION: Stage donor reservation & receiver in-transit synchronously before awaiting persistence
      // so concurrent approvals against the same depleted donor fail immediately with 409 Conflict.
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
        this.applyDecisionHistory(await this.repo.listActions());
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
          this.applyDecisionHistory(await this.repo.listActions());
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
    const status = this.decisions.get(recommendation.id);
    if (!status || status === recommendation.status) return recommendation;
    return { ...recommendation, status };
  }

  // --- Catalog Product Management ---

  async listCatalogProducts(
    query: ProductListQuery,
    user?: User,
  ): Promise<ProductListResponse> {
    await this.ensureInitialized();
    let targetBranchId = query.branch;
    if (user && user.role === "staff") {
      targetBranchId = query.branch ?? user.branchIds[0];
    }

    if (targetBranchId && user) {
      if (!isBranchInScope(user, targetBranchId)) {
        throw new DecisionForbiddenError(`Branch ${targetBranchId} is not in your assigned scope`);
      }
    }

    let branchIdx = -1;
    if (targetBranchId) {
      branchIdx = this.data.branches.findIndex((b) => b.id === targetBranchId);
    }

    let list = [...this.data.products];
    if (query.status) {
      list = list.filter((p) => (p.status ?? "active") === query.status);
    }
    if (query.category) {
      list = list.filter((p) => p.category.toLowerCase() === query.category!.toLowerCase());
    }
    if (query.search && query.search.trim().length > 0) {
      const q = query.search.trim();
      list = list.filter((p) => matchesProductQuery(p, q));
    }

    const total = list.length;
    const page = Math.max(1, query.page);
    const limit = Math.max(1, query.limit);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const start = (page - 1) * limit;
    const products = list
      .slice(start, start + limit)
      .map((p) => {
        let stats: ProductStats | undefined = undefined;
        if (branchIdx >= 0) {
          const prodIdx = this.data.products.findIndex((dp) => dp.sku === p.sku);
          const pos = prodIdx >= 0 ? this.projectPositionFor(prodIdx, branchIdx) : undefined;
          if (pos) {
            stats = {
              onHand: pos.onHand,
              velocity: Math.round((pos.velocity + Number.EPSILON) * 100) / 100,
              coverDays: pos.coverDays !== null ? Math.round((pos.coverDays + Number.EPSILON) * 10) / 10 : null,
              status: pos.status,
              surplus: pos.surplus,
              reserved: pos.reserved,
              inTransit: pos.inTransit,
            };
          } else {
            stats = {
              onHand: 0,
              velocity: 0,
              coverDays: null,
              status: "NEW",
              surplus: 0,
              reserved: 0,
              inTransit: 0,
            };
          }
        }
        return {
          ...p,
          status: p.status ?? "active",
          ...(stats ? { stats } : {}),
        };
      });

    return ProductListResponseSchema.parse({
      products,
      total,
      page,
      limit,
      totalPages,
    });
  }

  async getCatalogProduct(sku: string): Promise<ProductDetailWithHistory | null> {
    await this.ensureInitialized();
    const product = this.data.products.find((p) => p.sku === sku);
    if (!product) return null;

    const history = await this.repo.listProductChanges(sku);
    const { hasSales, hasAudits } = await this.repo.hasHistoryOrAudits(sku);
    const canDeletePermanently = !hasSales && !hasAudits;
    let cannotDeleteReason: string | null = null;
    if (hasAudits) {
      cannotDeleteReason = "Product has past decision audit entries. Archiving is required to preserve audit history.";
    } else if (hasSales) {
      cannotDeleteReason = "Product has recorded sales history. Archiving is required to preserve history.";
    }

    return ProductDetailWithHistorySchema.parse({
      product: { ...product, status: product.status ?? "active" },
      history,
      canDeletePermanently,
      cannotDeleteReason,
    });
  }

  async createCatalogProduct(input: CreateProduct, user: User): Promise<Product> {
    await this.ensureInitialized();
    if (!can(user.role, "products:manage")) {
      throw new DecisionForbiddenError("Only administrators can manage products");
    }

    const conflict = this.data.products.find(
      (p) =>
        p.category.toLowerCase() === input.category.toLowerCase() &&
        p.name.trim().toLowerCase() === input.name.trim().toLowerCase(),
    );
    if (conflict) {
      throw new ProductConflictError(
        `Product name "${input.name}" already exists in category "${input.category}"`,
      );
    }

    const numericSkus = this.data.products.map((p) => {
      const match = p.sku.match(/^SKU-(\d+)$/);
      return match ? parseInt(match[1]!, 10) : 0;
    });
    const nextNum = Math.max(0, ...numericSkus) + 1;
    const sku = `SKU-${String(nextNum).padStart(5, "0")}`;

    const newProduct: Product = ProductSchema.parse({
      sku,
      name: input.name.trim(),
      category: input.category.trim(),
      price: input.price,
      cost: input.cost,
      leadTimeDays: input.leadTimeDays,
      status: "awaiting_history",
    });

    const changeRecord: ProductChangeRecord = {
      id: `pch_${sku}_${Date.now()}`,
      sku,
      at: new Date().toISOString(),
      actedBy: { userId: user.id, name: user.name, role: user.role },
      action: "CREATE",
      changes: {
        name: { before: null, after: newProduct.name },
        category: { before: null, after: newProduct.category },
        price: { before: null, after: newProduct.price },
        cost: { before: null, after: newProduct.cost },
        leadTimeDays: { before: null, after: newProduct.leadTimeDays },
        status: { before: null, after: newProduct.status },
      },
    };

    this.data.products.push(newProduct);
    const numBranches = this.data.branches.length;
    const numDays = this.data.dates.length;
    this.data.sales.push(Array.from({ length: numBranches }, () => new Array(numDays).fill(0)));
    this.data.onHand.push(Array.from({ length: numBranches }, () => new Array(numDays).fill(0)));
    this.data.demand.push(Array.from({ length: numBranches }, () => new Array(numDays).fill(0)));

    await this.repo.saveProduct(newProduct);
    await this.repo.saveProductChange(changeRecord);

    return newProduct;
  }

  async updateCatalogProduct(sku: string, input: UpdateProduct, user: User): Promise<Product> {
    await this.ensureInitialized();
    if (!can(user.role, "products:manage")) {
      throw new DecisionForbiddenError("Only administrators can manage products");
    }

    const product = this.data.products.find((p) => p.sku === sku);
    if (!product) {
      throw new ProductNotFoundError(`Product ${sku} not found`);
    }

    const effectivePrice = input.price !== undefined ? input.price : product.price;
    const effectiveCost = input.cost !== undefined ? input.cost : product.cost;
    if (effectivePrice <= effectiveCost) {
      throw new ProductValidationError(
        `Selling price (BD ${effectivePrice}) must be greater than unit cost (BD ${effectiveCost})`,
      );
    }

    if (input.name && input.name.trim().toLowerCase() !== product.name.toLowerCase()) {
      const targetCategory = input.category ?? product.category;
      const conflict = this.data.products.find(
        (p) =>
          p.sku !== sku &&
          p.category.toLowerCase() === targetCategory.toLowerCase() &&
          p.name.trim().toLowerCase() === input.name!.trim().toLowerCase(),
      );
      if (conflict) {
        throw new ProductConflictError(
          `Product name "${input.name}" already exists in category "${targetCategory}"`,
        );
      }
    }

    const changes: Record<string, { before: unknown; after: unknown }> = {};
    if (input.name !== undefined && input.name.trim() !== product.name) {
      changes.name = { before: product.name, after: input.name.trim() };
      product.name = input.name.trim();
    }
    if (input.category !== undefined && input.category.trim() !== product.category) {
      changes.category = { before: product.category, after: input.category.trim() };
      product.category = input.category.trim();
    }
    const mathChanged =
      (input.price !== undefined && input.price !== product.price) ||
      (input.cost !== undefined && input.cost !== product.cost) ||
      (input.leadTimeDays !== undefined && input.leadTimeDays !== product.leadTimeDays);

    if (input.price !== undefined && input.price !== product.price) {
      changes.price = { before: product.price, after: input.price };
      product.price = input.price;
    }
    if (input.cost !== undefined && input.cost !== product.cost) {
      changes.cost = { before: product.cost, after: input.cost };
      product.cost = input.cost;
    }
    if (input.leadTimeDays !== undefined && input.leadTimeDays !== product.leadTimeDays) {
      changes.leadTimeDays = { before: product.leadTimeDays, after: input.leadTimeDays };
      product.leadTimeDays = input.leadTimeDays;
    }

    if (Object.keys(changes).length > 0) {
      const changeRecord: ProductChangeRecord = {
        id: `pch_${sku}_${Date.now()}`,
        sku,
        at: new Date().toISOString(),
        actedBy: { userId: user.id, name: user.name, role: user.role },
        action: "UPDATE",
        changes,
      };
      await this.repo.saveProduct(product);
      await this.repo.saveProductChange(changeRecord);
    }

    if (mathChanged && product.status === "active") {
      await this.recomputeAnalysisForProduct(sku);
    }

    return { ...product, status: product.status ?? "active" };
  }

  async archiveCatalogProduct(
    sku: string,
    user: User,
  ): Promise<{ product: Product; removedPendingActionsCount: number }> {
    await this.ensureInitialized();
    if (!can(user.role, "products:manage")) {
      throw new DecisionForbiddenError("Only administrators can manage products");
    }

    const product = this.data.products.find((p) => p.sku === sku);
    if (!product) {
      throw new ProductNotFoundError(`Product ${sku} not found`);
    }

    if (product.status === "archived") {
      return { product: { ...product, status: "archived" }, removedPendingActionsCount: 0 };
    }

    const removedPendingActionsCount = this.analysis.recommendations.filter(
      (r) => r.sku === sku && this.overlay(r).status === "PENDING",
    ).length;

    const beforeStatus = product.status ?? "active";
    product.status = "archived";

    const changeRecord: ProductChangeRecord = {
      id: `pch_${sku}_${Date.now()}`,
      sku,
      at: new Date().toISOString(),
      actedBy: { userId: user.id, name: user.name, role: user.role },
      action: "ARCHIVE",
      changes: {
        status: { before: beforeStatus, after: "archived" },
      },
    };

    await this.repo.saveProduct(product);
    await this.repo.saveProductChange(changeRecord);
    await this.recomputeAnalysisForProduct(sku);

    return { product: { ...product, status: "archived" }, removedPendingActionsCount };
  }

  async restoreCatalogProduct(sku: string, user: User): Promise<Product> {
    await this.ensureInitialized();
    if (!can(user.role, "products:manage")) {
      throw new DecisionForbiddenError("Only administrators can manage products");
    }

    const product = this.data.products.find((p) => p.sku === sku);
    if (!product) {
      throw new ProductNotFoundError(`Product ${sku} not found`);
    }

    if (product.status !== "archived") {
      return { ...product, status: product.status ?? "active" };
    }

    const { hasSales } = await this.repo.hasHistoryOrAudits(sku);
    const nextStatus = hasSales ? "active" : "awaiting_history";
    const beforeStatus = product.status;
    product.status = nextStatus;

    const changeRecord: ProductChangeRecord = {
      id: `pch_${sku}_${Date.now()}`,
      sku,
      at: new Date().toISOString(),
      actedBy: { userId: user.id, name: user.name, role: user.role },
      action: "RESTORE",
      changes: {
        status: { before: beforeStatus, after: nextStatus },
      },
    };

    await this.repo.saveProduct(product);
    await this.repo.saveProductChange(changeRecord);

    if (nextStatus === "active") {
      await this.recomputeAnalysisForProduct(sku);
    }

    return { ...product, status: nextStatus };
  }

  async deleteCatalogProduct(sku: string, user: User): Promise<void> {
    await this.ensureInitialized();
    if (!can(user.role, "products:manage")) {
      throw new DecisionForbiddenError("Only administrators can manage products");
    }

    const product = this.data.products.find((p) => p.sku === sku);
    if (!product) {
      throw new ProductNotFoundError(`Product ${sku} not found`);
    }

    const { hasSales, hasAudits } = await this.repo.hasHistoryOrAudits(sku);
    if (hasAudits || hasSales) {
      const reason = hasAudits
        ? "Cannot permanently delete product with existing audit decisions. Archive the product instead."
        : "Cannot permanently delete product with existing sales history. Archive the product instead.";
      throw new ProductConflictError(reason);
    }

    const idx = this.data.products.findIndex((p) => p.sku === sku);
    if (idx >= 0) {
      this.data.products.splice(idx, 1);
      if (this.data.sales[idx]) this.data.sales.splice(idx, 1);
      if (this.data.onHand[idx]) this.data.onHand.splice(idx, 1);
      if (this.data.demand[idx]) this.data.demand.splice(idx, 1);
    }
    await this.repo.removeProduct(sku);
    this.analysis.recommendations = this.analysis.recommendations.filter((r) => r.sku !== sku);
  }

  async generateSampleHistory(
    sku: string,
    user: User,
  ): Promise<{ salesEntriesCount: number }> {
    await this.ensureInitialized();
    if (!can(user.role, "products:manage")) {
      throw new DecisionForbiddenError("Only administrators can manage products");
    }

    const product = this.data.products.find((p) => p.sku === sku);
    if (!product) {
      throw new ProductNotFoundError(`Product ${sku} not found`);
    }

    const skuIndex = this.data.products.findIndex((p) => p.sku === sku);
    const numBranches = this.data.branches.length;
    const numDays = this.data.dates.length;
    if (!this.data.sales[skuIndex]) {
      this.data.sales[skuIndex] = Array.from({ length: numBranches }, () => new Array(numDays).fill(0));
      this.data.onHand[skuIndex] = Array.from({ length: numBranches }, () => new Array(numDays).fill(0));
      this.data.demand[skuIndex] = Array.from({ length: numBranches }, () => new Array(numDays).fill(0));
    }

    let entriesCount = 0;
    const sampleDayCount = Math.min(30, numDays);
    const startDayIndex = numDays - sampleDayCount;

    for (let b = 0; b < numBranches; b++) {
      const branch = this.data.branches[b]!;
      for (let d = startDayIndex; d < numDays; d++) {
        const date = this.data.dates[d]!;
        const unitsSold = 2 + ((d + branch.id.charCodeAt(3)) % 5);
        const onHand = 15 + ((d + branch.id.charCodeAt(3)) % 25);
        this.data.sales[skuIndex]![b]![d] = unitsSold;
        this.data.onHand[skuIndex]![b]![d] = onHand;
        this.data.demand[skuIndex]![b]![d] = unitsSold;

        await upsertSalesEntry({
          branchId: branch.id,
          sku,
          date,
          unitsSold,
          onHand,
        });
        entriesCount++;
      }
    }

    const beforeStatus = product.status ?? "awaiting_history";
    product.status = "active";

    const changeRecord: ProductChangeRecord = {
      id: `pch_${sku}_${Date.now()}`,
      sku,
      at: new Date().toISOString(),
      actedBy: { userId: user.id, name: user.name, role: user.role },
      action: "UPDATE",
      changes: {
        status: { before: beforeStatus, after: "active" },
        sampleHistory: { before: null, after: `${entriesCount} daily records created` },
      },
    };

    await this.repo.saveProduct(product);
    await this.repo.saveProductChange(changeRecord);
    await this.recomputeAnalysisForProduct(sku);

    return { salesEntriesCount: entriesCount };
  }

  private async recomputeAnalysisForProduct(sku: string): Promise<void> {
    this.clearCommittedForSku(sku);
    this.analysis = computeActivePlan(this.data);
    this.scopedKpiCache.clear();
    await this.repo.saveAnalysis(this.analysis);
    await this.commitPlanVersion();
    for (const b of this.data.branches) {
      await recomputeForSku(b.id, sku);
    }
  }

  async listStockAlerts(user?: User): Promise<StockAlertList> {
    await this.ensureInitialized();
    const all = await this.repo.listStockAlerts();
    const alerts =
      !user || user.role === "admin"
        ? all
        : all.filter((alert) => isBranchInScope(user, alert.branchId));
    return StockAlertListSchema.parse({ alerts });
  }

  async createStockAlert(input: CreateStockAlert, user: User): Promise<StockAlert> {
    await this.ensureInitialized();
    if (!can(user.role, "stock:flag")) {
      throw new DecisionForbiddenError("Only branch staff can flag critical stock");
    }
    if (!isBranchInScope(user, input.branchId)) {
      throw new DecisionForbiddenError("Cannot flag critical stock outside your assigned branch");
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

function computeActivePlan(data: Dataset): Analysis {
  const numBranches = data.branches.length;
  const numDays = data.dates.length;
  const activeIndices: number[] = [];
  const activeProducts: Product[] = [];

  for (let i = 0; i < data.products.length; i++) {
    const p = data.products[i]!;
    if (p.status !== "archived") {
      activeIndices.push(i);
      activeProducts.push(p);
    }
  }

  if (activeProducts.length === data.products.length) {
    return analyze(data, DEFAULT_POLICY);
  }

  const activeDataset: Dataset = {
    ...data,
    products: activeProducts,
    sales: activeIndices.map((i) => data.sales[i] ?? Array.from({ length: numBranches }, () => new Array(numDays).fill(0))),
    onHand: activeIndices.map((i) => data.onHand[i] ?? Array.from({ length: numBranches }, () => new Array(numDays).fill(0))),
    demand: activeIndices.map((i) => data.demand[i] ?? Array.from({ length: numBranches }, () => new Array(numDays).fill(0))),
  };
  return analyze(activeDataset, DEFAULT_POLICY);
}

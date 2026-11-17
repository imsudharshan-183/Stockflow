import { randomUUID } from "node:crypto";
import {
  ActionRecordSchema,
  AuditEntrySchema,
  AuditListSchema,
  BranchDetailSchema,
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
  buildBranchDetail,
  buildProductDetail,
  can,
  matchesProductQuery,
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
  type ProductBranchSummary,
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
  type StockAlert,
  type StockAlertList,
  type UpdateProduct,
  type User,
} from "@stockflow/core";
import { recomputeForSku, upsertSalesEntry } from "../db.js";
import type { StockRepository } from "../repositories/types.js";
import type { UserRepository } from "../repositories/userTypes.js";
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
  clearCommittedForSku,
  findRawPosition,
  getCommittedDelta,
  projectAllPositions,
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
import { applyDecisionOverlay, computeActivePlan, isBranchInScope, scopeBranches } from "./scope.js";

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

  private constructor(
    private readonly repo: StockRepository,
    data?: Dataset,
    analysis?: Analysis,
    planVersion = 0,
  ) {
    this.runtime = createStockRuntimeState(repo);
    this.kpiService = new KpiService(this.runtime);
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

  private set analysis(next: Analysis) {
    this.runtime.analysis = next;
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

  private getDelta(sku: string, branchId: string): CommittedDelta {
    return getCommittedDelta(this.runtime.committedDeltas, sku, branchId);
  }

  private adjustDelta(sku: string, branchId: string, dReserved: number, dInTransit: number): void {
    adjustCommittedDelta(this.runtime.committedDeltas, sku, branchId, dReserved, dInTransit);
  }

  private clearCommittedForSku(sku: string): void {
    clearCommittedForSku(this.runtime.committedDeltas, this.runtime.committedRecommendationIds, sku);
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

  private projectedPositions(onlySkuIndex?: number): ProjectedPosition[][] {
    return projectAllPositions(this.data, this.analysis, this.runtime.committedDeltas, onlySkuIndex);
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

    const leadTimeDaysBySku: Record<string, number> = {};
    if (needsStock.length > 0) {
      const productBySku = new Map(this.data.products.map((p) => [p.sku, p]));
      for (const rec of needsStock) {
        const prod = productBySku.get(rec.sku);
        if (prod) leadTimeDaysBySku[rec.sku] = prod.leadTimeDays;
      }
    }

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
      leadTimeDaysBySku,
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

    let branchSummary: ProductBranchSummary | undefined;
    const skuIndexBySku = new Map<string, number>();
    if (branchIdx >= 0) {
      const statusCounts = { AT_RISK: 0, HEALTHY: 0, OVERSTOCK: 0, NEW: 0 };
      let totalSkus = 0;
      for (let i = 0; i < this.data.products.length; i += 1) {
        const dp = this.data.products[i];
        if (!dp) continue;
        skuIndexBySku.set(dp.sku, i);
        if (dp.status === "archived") continue;
        const pos = this.projectPositionFor(i, branchIdx);
        if (!pos) continue;
        totalSkus += 1;
        statusCounts[pos.status] += 1;
      }
      branchSummary = {
        branch: this.data.branches[branchIdx]!,
        totalSkus,
        statusCounts,
      };
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
          const prodIdx = skuIndexBySku.get(p.sku) ?? -1;
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
      ...(branchSummary ? { branchSummary } : {}),
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

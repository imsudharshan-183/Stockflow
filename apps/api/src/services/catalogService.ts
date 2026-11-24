import {
  BranchDetailSchema,
  BranchListResponseSchema,
  BranchSchema,
  DEFAULT_POLICY,
  LocationInventoryResponseSchema,
  LocationListResponseSchema,
  LocationSummaryResponseSchema,
  LocationTrendResponseSchema,
  ProductDetailSchema,
  ProductDetailWithHistorySchema,
  ProductListResponseSchema,
  ProductSchema,
  analyze,
  buildBranchDetail,
  buildProductDetail,
  can,
  matchesProductQuery,
  type Branch,
  type BranchDetail,
  type BranchListQuery,
  type BranchListResponse,
  type CreateBranch,
  type CreateProduct,
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
  type PositionStatus,
  type Product,
  type ProductBranchSummary,
  type ProductChangeRecord,
  type ProductDetail,
  type ProductListQuery,
  type ProductListResponse,
  type ProductStats,
  type ProductStatus,
  type ProductDetailWithHistory,
  type Recommendation,
  type UpdateBranch,
  type UpdateProduct,
  type User,
} from "@stockflow/core";
import { recomputeForSku, upsertSalesEntry } from "../db.js";
import {
  BranchConflictError,
  BranchNotFoundError,
  DecisionForbiddenError,
  ProductConflictError,
  ProductNotFoundError,
  ProductValidationError,
} from "./errors.js";
import {
  clearAllCommittedDeltas,
  clearCommittedForSku,
  projectAllPositions,
  projectPositionFor,
} from "./projection.js";
import {
  commitPlanVersion,
  ensureInitialized,
  ensureInitializedSyncIfPossible,
  type StockRuntimeState,
} from "./runtimeState.js";
import {
  applyDecisionOverlay,
  computeActivePlan,
  isBranchInScope,
  isMaterialRecommendation,
  resolveScopedBranchIndex,
  scopeBranches,
} from "./scope.js";

export class CatalogService {
  constructor(private readonly runtime: StockRuntimeState) {}

  hasBranch(branchId: string): boolean {
    ensureInitializedSyncIfPossible(this.runtime);
    return this.runtime.data.branches.some((b) => b.id === branchId);
  }

  allBranchIds(): string[] {
    ensureInitializedSyncIfPossible(this.runtime);
    return this.runtime.data.branches.map((b) => b.id);
  }

  getProductStatus(sku: string): ProductStatus | "unknown" {
    ensureInitializedSyncIfPossible(this.runtime);
    const p = this.runtime.data.products.find((prod) => prod.sku === sku);
    if (!p) return "unknown";
    return p.status ?? "active";
  }

  applySalesEntryToDataset(
    branchId: string,
    sku: string,
    date: string,
    unitsSold: number,
    onHand: number,
  ): { dateAdded: boolean } {
    ensureInitializedSyncIfPossible(this.runtime);
    const sIdx = this.runtime.data.products.findIndex((p) => p.sku === sku);
    const bIdx = this.runtime.data.branches.findIndex((b) => b.id === branchId);
    if (sIdx < 0 || bIdx < 0) return { dateAdded: false };

    const product = this.runtime.data.products[sIdx]!;
    if (product.status === "archived") return { dateAdded: false };

    let dateAdded = false;
    let dIdx = this.runtime.data.dates.indexOf(date);
    if (dIdx < 0) {
      let insertAt = this.runtime.data.dates.findIndex((d) => d > date);
      if (insertAt < 0) insertAt = this.runtime.data.dates.length;
      this.runtime.data.dates.splice(insertAt, 0, date);
      for (let p = 0; p < this.runtime.data.products.length; p += 1) {
        const salesByBranch = this.runtime.data.sales[p];
        const stockByBranch = this.runtime.data.onHand[p];
        const demandByBranch = this.runtime.data.demand[p];
        if (!salesByBranch || !stockByBranch || !demandByBranch) continue;
        for (let b = 0; b < this.runtime.data.branches.length; b += 1) {
          const prevStock =
            insertAt > 0
              ? (stockByBranch[b]?.[insertAt - 1] ?? 0)
              : (stockByBranch[b]?.[0] ?? 0);
          salesByBranch[b]?.splice(insertAt, 0, 0);
          stockByBranch[b]?.splice(insertAt, 0, prevStock);
          demandByBranch[b]?.splice(insertAt, 0, 0);
        }
      }
      const latest = this.runtime.data.dates[this.runtime.data.dates.length - 1];
      if (latest) {
        this.runtime.data.asOf = latest;
      }
      dIdx = insertAt;
      dateAdded = true;
    }

    const salesRow = this.runtime.data.sales[sIdx]?.[bIdx];
    const onHandRow = this.runtime.data.onHand[sIdx]?.[bIdx];
    const demandRow = this.runtime.data.demand[sIdx]?.[bIdx];
    if (salesRow && onHandRow && demandRow) {
      salesRow[dIdx] = unitsSold;
      onHandRow[dIdx] = onHand;
      demandRow[dIdx] = unitsSold;
    }
    return { dateAdded };
  }

  async recomputeSingleSku(
    sku: string,
    options: { bumpVersion?: boolean; fullPlanRecompute?: boolean } = {},
  ): Promise<void> {
    await ensureInitialized(this.runtime);
    const sIdx = this.runtime.data.products.findIndex((p) => p.sku === sku);
    if (sIdx < 0) return;
    const product = this.runtime.data.products[sIdx]!;
    if (product.status === "archived") return;

    clearCommittedForSku(
      this.runtime.committedDeltas,
      this.runtime.committedRecommendationIds,
      sku,
    );
    for (const [alertId, adj] of this.runtime.alertAdjustments.entries()) {
      if (adj.sku === sku) this.runtime.alertAdjustments.delete(alertId);
    }
    if (options.fullPlanRecompute) {
      this.runtime.analysis = computeActivePlan(this.runtime.data);
    } else {
      const singleDataset = {
        ...this.runtime.data,
        products: [product],
        sales: [this.runtime.data.sales[sIdx] ?? []],
        onHand: [this.runtime.data.onHand[sIdx] ?? []],
        demand: [this.runtime.data.demand[sIdx] ?? []],
      };
      const singleAnalysis = analyze(singleDataset, DEFAULT_POLICY);
      if (singleAnalysis.positions[0]) {
        this.runtime.analysis.positions[sIdx] = singleAnalysis.positions[0];
      }
      const otherRecs = this.runtime.analysis.recommendations.filter((r) => r.sku !== sku);
      const merged = [...otherRecs, ...singleAnalysis.recommendations].sort(
        (a, b) =>
          b.netBenefit - a.netBenefit ||
          a.sku.localeCompare(b.sku) ||
          a.branchId.localeCompare(b.branchId) ||
          a.action.localeCompare(b.action),
      );
      this.runtime.analysis.recommendations = merged.map((r, idx) => ({ ...r, rank: idx + 1 }));
    }
    this.runtime.scopedKpiCache.clear();
    if (options.bumpVersion !== false) {
      await commitPlanVersion(this.runtime);
    }
  }

  private materialRecommendations(): Recommendation[] {
    ensureInitializedSyncIfPossible(this.runtime);
    return this.runtime.analysis.recommendations.filter(isMaterialRecommendation);
  }

  branch(id: string, user?: User): BranchDetail | null {
    ensureInitializedSyncIfPossible(this.runtime);
    if (user && !isBranchInScope(user, id)) {
      return null;
    }

    const detail = buildBranchDetail(
      this.runtime.data,
      projectAllPositions(this.runtime.data, this.runtime.analysis, this.runtime.committedDeltas),
      this.runtime.analysis.recommendations,
      id,
    );
    if (!detail) return null;
    return BranchDetailSchema.parse({
      ...detail,
      recommendations: detail.recommendations.map((recommendation) =>
        applyDecisionOverlay(recommendation, this.runtime.decisions),
      ),
    });
  }

  listLocations(user?: User): LocationListResponse {
    ensureInitializedSyncIfPossible(this.runtime);
    const allBranchIds = this.runtime.data.branches.map((b) => b.id);
    const allowedSet = new Set(user ? scopeBranches(user, allBranchIds) : allBranchIds);
    const materialRecs = this.materialRecommendations();
    const riskByBranch = new Map(
      this.runtime.analysis.kpis.branchRisk.map((r) => [r.branchId, r]),
    );

    // DECISION: compute network-wide sales at risk first so every branch's sidebar health dot
    // is judged relative to the network median rather than absolute share bands.
    const networkBranchRisk = new Map<string, number>();
    for (const branch of this.runtime.data.branches) {
      if (branch.status === "archived") continue;
      networkBranchRisk.set(branch.id, 0);
    }
    for (let bIdx = 0; bIdx < this.runtime.data.branches.length; bIdx += 1) {
      const branch = this.runtime.data.branches[bIdx]!;
      if (branch.status === "archived") continue;
      let branchLostSales = 0;
      for (let sIdx = 0; sIdx < this.runtime.data.products.length; sIdx += 1) {
        const product = this.runtime.data.products[sIdx];
        if (!product || product.status === "archived") continue;
        const pos = projectPositionFor(
          this.runtime.data,
          this.runtime.analysis,
          this.runtime.committedDeltas,
          sIdx,
          bIdx,
        );
        if (pos?.status === "AT_RISK") {
          branchLostSales += pos.lostUnits * product.price;
        }
      }
      networkBranchRisk.set(branch.id, Math.round(branchLostSales * 100) / 100);
    }
    const sortedRisks = [...networkBranchRisk.values()].sort((a, b) => a - b);
    const mid = Math.floor(sortedRisks.length / 2);
    const medianRisk =
      sortedRisks.length === 0
        ? 0
        : sortedRisks.length % 2 === 1
          ? sortedRisks[mid]!
          : (sortedRisks[mid - 1]! + sortedRisks[mid]!) / 2;

    const locations: LocationSummaryItem[] = [];
    for (let bIdx = 0; bIdx < this.runtime.data.branches.length; bIdx += 1) {
      const branch = this.runtime.data.branches[bIdx]!;
      if (branch.status === "archived") continue;
      if (!allowedSet.has(branch.id)) continue;

      let atRiskCount = 0;
      let overstockCount = 0;
      let totalSkus = 0;
      let lostSalesAtRisk = 0;
      let cashReleasable = 0;

      for (let sIdx = 0; sIdx < this.runtime.data.products.length; sIdx += 1) {
        const product = this.runtime.data.products[sIdx];
        if (!product || product.status === "archived") continue;
        const pos = projectPositionFor(
          this.runtime.data,
          this.runtime.analysis,
          this.runtime.committedDeltas,
          sIdx,
          bIdx,
        );
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
        const status = this.runtime.decisions.get(rec.id) ?? rec.status;
        if (status !== "PENDING") return false;
        return rec.branchId === branch.id || rec.donorBranchId === branch.id;
      }).length;

      const roundedRisk = Math.round(lostSalesAtRisk * 100) / 100;
      const health: LocationSummaryItem["health"] =
        roundedRisk <= medianRisk
          ? "green"
          : roundedRisk <= medianRisk * 1.5
            ? "amber"
            : "red";

      locations.push({
        branch: { ...branch, status: branch.status ?? "active" },
        health,
        atRiskCount,
        overstockCount,
        totalSkus,
        pendingCount,
        stockoutRate: riskByBranch.get(branch.id)?.stockoutRate ?? 0,
        lostSalesAtRisk: roundedRisk,
        cashReleasable: Math.round(cashReleasable * 100) / 100,
      });
    }

    return LocationListResponseSchema.parse({ locations });
  }

  locationSummary(branchId: string, user?: User): LocationSummaryResponse | null {
    ensureInitializedSyncIfPossible(this.runtime);
    const bIdx = resolveScopedBranchIndex(this.runtime.data, branchId, user);
    if (bIdx === null) return null;
    const branch = this.runtime.data.branches[bIdx]!;

    const detail = buildBranchDetail(
      this.runtime.data,
      projectAllPositions(this.runtime.data, this.runtime.analysis, this.runtime.committedDeltas),
      this.runtime.analysis.recommendations,
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

    for (let sIdx = 0; sIdx < this.runtime.data.products.length; sIdx += 1) {
      const product = this.runtime.data.products[sIdx];
      if (!product || product.status === "archived") continue;
      const pos = projectPositionFor(
        this.runtime.data,
        this.runtime.analysis,
        this.runtime.committedDeltas,
        sIdx,
        bIdx,
      );
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

    // Read recommendation-derived fields directly from shared runtime.analysis (no DecisionService import).
    const materialRecs = this.materialRecommendations().map((rec) =>
      applyDecisionOverlay(rec, this.runtime.decisions),
    );
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
      const productBySku = new Map(this.runtime.data.products.map((p) => [p.sku, p]));
      for (const rec of needsStock) {
        const prod = productBySku.get(rec.sku);
        if (prod) leadTimeDaysBySku[rec.sku] = prod.leadTimeDays;
      }
    }

    return LocationSummaryResponseSchema.parse({
      branch,
      asOf: this.runtime.analysis.kpis.asOf,
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
    ensureInitializedSyncIfPossible(this.runtime);
    const bIdx = resolveScopedBranchIndex(this.runtime.data, branchId, user);
    if (bIdx === null) return null;
    const branch = this.runtime.data.branches[bIdx]!;

    const recBySku = new Map<string, Recommendation>();
    for (const rec of this.materialRecommendations()) {
      if (rec.branchId === branchId || rec.donorBranchId === branchId) {
        const overlaid = applyDecisionOverlay(rec, this.runtime.decisions);
        if (!recBySku.has(rec.sku) || overlaid.status === "PENDING") {
          recBySku.set(rec.sku, overlaid);
        }
      }
    }

    const categoriesSet = new Set<string>();
    const allItems: LocationInventoryItem[] = [];
    const searchLower = query.search?.trim().toLowerCase() ?? "";

    for (let sIdx = 0; sIdx < this.runtime.data.products.length; sIdx += 1) {
      const product = this.runtime.data.products[sIdx];
      if (!product || product.status === "archived") continue;
      const pos = projectPositionFor(
        this.runtime.data,
        this.runtime.analysis,
        this.runtime.committedDeltas,
        sIdx,
        bIdx,
      );
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
    ensureInitializedSyncIfPossible(this.runtime);
    const bIdx = resolveScopedBranchIndex(this.runtime.data, branchId, user);
    if (bIdx === null) return null;
    const branch = this.runtime.data.branches[bIdx]!;

    const daysCount = Number(query.range);
    const totalDays = this.runtime.data.dates.length;
    const startIdx = Math.max(0, totalDays - daysCount);

    const matchingSkuIndices: number[] = [];
    for (let sIdx = 0; sIdx < this.runtime.data.products.length; sIdx += 1) {
      const product = this.runtime.data.products[sIdx];
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
        salesUnits += this.runtime.data.sales[sIdx]?.[bIdx]?.[d] ?? 0;
        onHandUnits += this.runtime.data.onHand[sIdx]?.[bIdx]?.[d] ?? 0;
      }
      points.push({
        date: this.runtime.data.dates[d]!,
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
    ensureInitializedSyncIfPossible(this.runtime);
    const sIdx = this.runtime.data.products.findIndex((p) => p.sku === sku);
    const detail = buildProductDetail(
      this.runtime.data,
      DEFAULT_POLICY,
      projectAllPositions(
        this.runtime.data,
        this.runtime.analysis,
        this.runtime.committedDeltas,
        sIdx >= 0 ? sIdx : undefined,
      ),
      this.runtime.analysis.recommendations,
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
        recommendation: position.recommendation
          ? applyDecisionOverlay(position.recommendation, this.runtime.decisions)
          : null,
      })),
      series,
    });
  }

  async listCatalogProducts(
    query: ProductListQuery,
    user?: User,
  ): Promise<ProductListResponse> {
    await ensureInitialized(this.runtime);
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
      branchIdx = this.runtime.data.branches.findIndex((b) => b.id === targetBranchId);
    }

    let branchSummary: ProductBranchSummary | undefined;
    const skuIndexBySku = new Map<string, number>();
    if (branchIdx >= 0) {
      const statusCounts = { AT_RISK: 0, HEALTHY: 0, OVERSTOCK: 0, NEW: 0 };
      let totalSkus = 0;
      for (let i = 0; i < this.runtime.data.products.length; i += 1) {
        const dp = this.runtime.data.products[i];
        if (!dp) continue;
        skuIndexBySku.set(dp.sku, i);
        if (dp.status === "archived") continue;
        const pos = projectPositionFor(
          this.runtime.data,
          this.runtime.analysis,
          this.runtime.committedDeltas,
          i,
          branchIdx,
        );
        if (!pos) continue;
        totalSkus += 1;
        statusCounts[pos.status] += 1;
      }
      const summaryBranch = this.runtime.data.branches[branchIdx]!;
      branchSummary = {
        branch: { ...summaryBranch, status: summaryBranch.status ?? "active" },
        totalSkus,
        statusCounts,
      };
    }

    let list = [...this.runtime.data.products];
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
    const products = list.slice(start, start + limit).map((p) => {
      let stats: ProductStats | undefined = undefined;
      if (branchIdx >= 0) {
        const prodIdx = skuIndexBySku.get(p.sku) ?? -1;
        const pos =
          prodIdx >= 0
            ? projectPositionFor(
                this.runtime.data,
                this.runtime.analysis,
                this.runtime.committedDeltas,
                prodIdx,
                branchIdx,
              )
            : undefined;
        if (pos) {
          stats = {
            onHand: pos.onHand,
            velocity: Math.round((pos.velocity + Number.EPSILON) * 100) / 100,
            coverDays:
              pos.coverDays !== null ? Math.round((pos.coverDays + Number.EPSILON) * 10) / 10 : null,
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
    await ensureInitialized(this.runtime);
    const product = this.runtime.data.products.find((p) => p.sku === sku);
    if (!product) return null;

    const history = await this.runtime.repo.listProductChanges(sku);
    const { hasSales, hasAudits } = await this.runtime.repo.hasHistoryOrAudits(sku);
    const canDeletePermanently = !hasSales && !hasAudits;
    let cannotDeleteReason: string | null = null;
    if (hasAudits) {
      cannotDeleteReason =
        "Product has past decision audit entries. Archiving is required to preserve audit history.";
    } else if (hasSales) {
      cannotDeleteReason =
        "Product has recorded sales history. Archiving is required to preserve history.";
    }

    return ProductDetailWithHistorySchema.parse({
      product: { ...product, status: product.status ?? "active" },
      history,
      canDeletePermanently,
      cannotDeleteReason,
    });
  }

  async createCatalogProduct(input: CreateProduct, user: User): Promise<Product> {
    await ensureInitialized(this.runtime);
    if (!can(user.role, "products:manage")) {
      throw new DecisionForbiddenError("Only administrators can manage products");
    }

    const conflict = this.runtime.data.products.find(
      (p) =>
        p.category.toLowerCase() === input.category.toLowerCase() &&
        p.name.trim().toLowerCase() === input.name.trim().toLowerCase(),
    );
    if (conflict) {
      throw new ProductConflictError(
        `Product name "${input.name}" already exists in category "${input.category}"`,
      );
    }

    const numericSkus = this.runtime.data.products.map((p) => {
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

    this.runtime.data.products.push(newProduct);
    const numBranches = this.runtime.data.branches.length;
    const numDays = this.runtime.data.dates.length;
    this.runtime.data.sales.push(
      Array.from({ length: numBranches }, () => new Array(numDays).fill(0)),
    );
    this.runtime.data.onHand.push(
      Array.from({ length: numBranches }, () => new Array(numDays).fill(0)),
    );
    this.runtime.data.demand.push(
      Array.from({ length: numBranches }, () => new Array(numDays).fill(0)),
    );

    await this.runtime.repo.saveProduct(newProduct);
    await this.runtime.repo.saveProductChange(changeRecord);

    return newProduct;
  }

  async updateCatalogProduct(sku: string, input: UpdateProduct, user: User): Promise<Product> {
    await ensureInitialized(this.runtime);
    if (!can(user.role, "products:manage")) {
      throw new DecisionForbiddenError("Only administrators can manage products");
    }

    const product = this.runtime.data.products.find((p) => p.sku === sku);
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
      const conflict = this.runtime.data.products.find(
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
      await this.runtime.repo.saveProduct(product);
      await this.runtime.repo.saveProductChange(changeRecord);
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
    await ensureInitialized(this.runtime);
    if (!can(user.role, "products:manage")) {
      throw new DecisionForbiddenError("Only administrators can manage products");
    }

    const product = this.runtime.data.products.find((p) => p.sku === sku);
    if (!product) {
      throw new ProductNotFoundError(`Product ${sku} not found`);
    }

    if (product.status === "archived") {
      return { product: { ...product, status: "archived" }, removedPendingActionsCount: 0 };
    }

    const removedPendingActionsCount = this.runtime.analysis.recommendations.filter(
      (r) => r.sku === sku && applyDecisionOverlay(r, this.runtime.decisions).status === "PENDING",
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

    await this.runtime.repo.saveProduct(product);
    await this.runtime.repo.saveProductChange(changeRecord);
    await this.recomputeAnalysisForProduct(sku);

    return { product: { ...product, status: "archived" }, removedPendingActionsCount };
  }

  async restoreCatalogProduct(sku: string, user: User): Promise<Product> {
    await ensureInitialized(this.runtime);
    if (!can(user.role, "products:manage")) {
      throw new DecisionForbiddenError("Only administrators can manage products");
    }

    const product = this.runtime.data.products.find((p) => p.sku === sku);
    if (!product) {
      throw new ProductNotFoundError(`Product ${sku} not found`);
    }

    if (product.status !== "archived") {
      return { ...product, status: product.status ?? "active" };
    }

    const { hasSales } = await this.runtime.repo.hasHistoryOrAudits(sku);
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

    await this.runtime.repo.saveProduct(product);
    await this.runtime.repo.saveProductChange(changeRecord);

    if (nextStatus === "active") {
      await this.recomputeAnalysisForProduct(sku);
    }

    return { ...product, status: nextStatus };
  }

  async deleteCatalogProduct(sku: string, user: User): Promise<void> {
    await ensureInitialized(this.runtime);
    if (!can(user.role, "products:manage")) {
      throw new DecisionForbiddenError("Only administrators can manage products");
    }

    const product = this.runtime.data.products.find((p) => p.sku === sku);
    if (!product) {
      throw new ProductNotFoundError(`Product ${sku} not found`);
    }

    const { hasSales, hasAudits } = await this.runtime.repo.hasHistoryOrAudits(sku);
    if (hasAudits || hasSales) {
      const reason = hasAudits
        ? "Cannot permanently delete product with existing audit decisions. Archive the product instead."
        : "Cannot permanently delete product with existing sales history. Archive the product instead.";
      throw new ProductConflictError(reason);
    }

    const idx = this.runtime.data.products.findIndex((p) => p.sku === sku);
    if (idx >= 0) {
      this.runtime.data.products.splice(idx, 1);
      if (this.runtime.data.sales[idx]) this.runtime.data.sales.splice(idx, 1);
      if (this.runtime.data.onHand[idx]) this.runtime.data.onHand.splice(idx, 1);
      if (this.runtime.data.demand[idx]) this.runtime.data.demand.splice(idx, 1);
    }
    await this.runtime.repo.removeProduct(sku);
    this.runtime.analysis.recommendations = this.runtime.analysis.recommendations.filter(
      (r) => r.sku !== sku,
    );
  }

  async generateSampleHistory(
    sku: string,
    user: User,
  ): Promise<{ salesEntriesCount: number }> {
    await ensureInitialized(this.runtime);
    if (!can(user.role, "products:manage")) {
      throw new DecisionForbiddenError("Only administrators can manage products");
    }

    const product = this.runtime.data.products.find((p) => p.sku === sku);
    if (!product) {
      throw new ProductNotFoundError(`Product ${sku} not found`);
    }

    const skuIndex = this.runtime.data.products.findIndex((p) => p.sku === sku);
    const numBranches = this.runtime.data.branches.length;
    const numDays = this.runtime.data.dates.length;
    if (!this.runtime.data.sales[skuIndex]) {
      this.runtime.data.sales[skuIndex] = Array.from({ length: numBranches }, () =>
        new Array(numDays).fill(0),
      );
      this.runtime.data.onHand[skuIndex] = Array.from({ length: numBranches }, () =>
        new Array(numDays).fill(0),
      );
      this.runtime.data.demand[skuIndex] = Array.from({ length: numBranches }, () =>
        new Array(numDays).fill(0),
      );
    }

    let entriesCount = 0;
    const sampleDayCount = Math.min(30, numDays);
    const startDayIndex = numDays - sampleDayCount;

    for (let b = 0; b < numBranches; b++) {
      const branch = this.runtime.data.branches[b]!;
      for (let d = startDayIndex; d < numDays; d++) {
        const date = this.runtime.data.dates[d]!;
        const unitsSold = 2 + ((d + branch.id.charCodeAt(3)) % 5);
        const onHand = 15 + ((d + branch.id.charCodeAt(3)) % 25);
        this.runtime.data.sales[skuIndex]![b]![d] = unitsSold;
        this.runtime.data.onHand[skuIndex]![b]![d] = onHand;
        this.runtime.data.demand[skuIndex]![b]![d] = unitsSold;

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

    await this.runtime.repo.saveProduct(product);
    await this.runtime.repo.saveProductChange(changeRecord);
    await this.recomputeAnalysisForProduct(sku);

    return { salesEntriesCount: entriesCount };
  }

  async listBranches(query: BranchListQuery, user: User): Promise<BranchListResponse> {
    await ensureInitialized(this.runtime);
    if (!can(user.role, "branches:manage")) {
      throw new DecisionForbiddenError("Only administrators can manage branches");
    }

    let list = [...this.runtime.data.branches];
    if (query.status) {
      list = list.filter((b) => (b.status ?? "active") === query.status);
    }
    if (query.search && query.search.trim().length > 0) {
      const q = query.search.trim().toLowerCase();
      list = list.filter(
        (b) =>
          b.id.toLowerCase().includes(q) ||
          b.name.toLowerCase().includes(q) ||
          b.city.toLowerCase().includes(q) ||
          b.region.toLowerCase().includes(q),
      );
    }

    const branches = list.map((b) =>
      BranchSchema.parse({
        ...b,
        status: b.status ?? "active",
      }),
    );

    return BranchListResponseSchema.parse({
      branches,
      total: branches.length,
    });
  }

  async createBranch(input: CreateBranch, user: User): Promise<Branch> {
    await ensureInitialized(this.runtime);
    if (!can(user.role, "branches:manage")) {
      throw new DecisionForbiddenError("Only administrators can manage branches");
    }

    const normalizedName = input.name.trim();
    const normalizedCity = input.city.trim();
    const conflict = this.runtime.data.branches.find(
      (b) =>
        b.name.trim().toLowerCase() === normalizedName.toLowerCase() &&
        b.city.trim().toLowerCase() === normalizedCity.toLowerCase(),
    );
    if (conflict) {
      throw new BranchConflictError(
        `Branch "${normalizedName}" in "${normalizedCity}" already exists`,
      );
    }

    const numericIds = this.runtime.data.branches.map((b) => {
      const match = b.id.match(/^BR-(\d+)$/);
      return match ? parseInt(match[1]!, 10) : 0;
    });
    const nextNum = Math.max(0, ...numericIds) + 1;
    const id = `BR-${String(nextNum).padStart(3, "0")}`;

    const newBranch: Branch = BranchSchema.parse({
      id,
      name: normalizedName,
      city: input.city.trim(),
      region: input.region.trim(),
      ...(input.coordinates ? { coordinates: input.coordinates } : {}),
      status: "active",
    });

    // Cold-start mechanic: push zero-filled daily history arrays onto every existing product
    // along the branch axis, matching createCatalogProduct's mirror loop along the product axis.
    this.runtime.data.branches.push(newBranch);
    const numDays = this.runtime.data.dates.length;
    for (let sIdx = 0; sIdx < this.runtime.data.products.length; sIdx += 1) {
      this.runtime.data.sales[sIdx]?.push(new Array(numDays).fill(0));
      this.runtime.data.onHand[sIdx]?.push(new Array(numDays).fill(0));
      this.runtime.data.demand[sIdx]?.push(new Array(numDays).fill(0));
    }

    await this.runtime.repo.saveBranch(newBranch);
    await this.recomputeAnalysisForProduct();

    return newBranch;
  }

  async updateBranch(id: string, input: UpdateBranch, user: User): Promise<Branch> {
    await ensureInitialized(this.runtime);
    if (!can(user.role, "branches:manage")) {
      throw new DecisionForbiddenError("Only administrators can manage branches");
    }

    const branch = this.runtime.data.branches.find((b) => b.id === id);
    if (!branch) {
      throw new BranchNotFoundError(`Branch ${id} not found`);
    }

    const nextName = (input.name ?? branch.name).trim();
    const nextCity = (input.city ?? branch.city).trim();
    if (
      nextName.toLowerCase() !== branch.name.trim().toLowerCase() ||
      nextCity.toLowerCase() !== branch.city.trim().toLowerCase()
    ) {
      const conflict = this.runtime.data.branches.find(
        (b) =>
          b.id !== id &&
          b.name.trim().toLowerCase() === nextName.toLowerCase() &&
          b.city.trim().toLowerCase() === nextCity.toLowerCase(),
      );
      if (conflict) {
        throw new BranchConflictError(`Branch "${nextName}" in "${nextCity}" already exists`);
      }
    }

    let changed = false;
    if (input.name !== undefined && input.name.trim() !== branch.name) {
      branch.name = input.name.trim();
      changed = true;
    }
    if (input.city !== undefined && input.city.trim() !== branch.city) {
      branch.city = input.city.trim();
      changed = true;
    }
    if (input.region !== undefined && input.region.trim() !== branch.region) {
      branch.region = input.region.trim();
      changed = true;
    }
    if (
      input.coordinates !== undefined &&
      (!branch.coordinates ||
        branch.coordinates[0] !== input.coordinates[0] ||
        branch.coordinates[1] !== input.coordinates[1])
    ) {
      branch.coordinates = input.coordinates;
      changed = true;
    }
    const prevStatus = branch.status ?? "active";
    if (input.status !== undefined && input.status !== prevStatus) {
      branch.status = input.status;
      changed = true;
    } else if (branch.status === undefined) {
      branch.status = "active";
    }

    if (changed) {
      await this.runtime.repo.saveBranch(branch);
      await this.recomputeAnalysisForProduct();
    }

    return BranchSchema.parse({ ...branch, status: branch.status ?? "active" });
  }

  private async recomputeAnalysisForProduct(sku?: string): Promise<void> {
    if (sku) {
      clearCommittedForSku(
        this.runtime.committedDeltas,
        this.runtime.committedRecommendationIds,
        sku,
      );
      for (const [alertId, adj] of this.runtime.alertAdjustments.entries()) {
        if (adj.sku === sku) this.runtime.alertAdjustments.delete(alertId);
      }
    } else {
      clearAllCommittedDeltas(
        this.runtime.committedDeltas,
        this.runtime.committedRecommendationIds,
      );
      this.runtime.alertAdjustments.clear();
    }
    this.runtime.analysis = computeActivePlan(this.runtime.data);
    this.runtime.scopedKpiCache.clear();
    await this.runtime.repo.saveAnalysis(this.runtime.analysis);
    await commitPlanVersion(this.runtime);
    if (sku) {
      for (const b of this.runtime.data.branches) {
        await recomputeForSku(b.id, sku);
      }
    }
  }
}

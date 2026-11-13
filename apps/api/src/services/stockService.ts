import {
  ActionRecordSchema,
  AuditEntrySchema,
  AuditListSchema,
  BranchDetailSchema,
  DEAD_VELOCITY_PER_DAY,
  DEFAULT_POLICY,
  MATERIAL_MIN_NET_BENEFIT,
  ProductDetailSchema,
  ProductDetailWithHistorySchema,
  ProductListResponseSchema,
  ProductSchema,
  RecommendationListSchema,
  RecommendationSchema,
  analyze,
  backtest,
  buildBranchDetail,
  buildProductDetail,
  can,
  isBranchInScope,
  matchesProductQuery,
  scopeBranches,
  type ActionRecord,
  type Analysis,
  type AuditEntry,
  type AuditList,
  type BranchDetail,
  type CreateProduct,
  type Dataset,
  type KpiSummary,
  type Product,
  type ProductChangeRecord,
  type ProductDetail,
  type ProductDetailWithHistory,
  type ProductListQuery,
  type ProductListResponse,
  type Recommendation,
  type RecommendationList,
  type RecommendationQuery,
  type RecommendationStatus,
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

// The morning plan is computed once per process. Approve and reject overlay status; they do not recompute velocity.
// SCALE: a new day or a policy edit is the point to recompute, per SKU, instead of rebuilding 500 x 15 series on every request.

export class StockService {
  private readonly decisions = new Map<string, Extract<RecommendationStatus, "APPROVED" | "REJECTED">>();
  private readonly scopedKpiCache = new Map<string, KpiSummary>();
  private audit: AuditEntry[] = [];

  private constructor(
    private readonly repo: StockRepository,
    private readonly data: Dataset,
    private analysis: Analysis,
  ) {}

  static async create(repo: StockRepository): Promise<StockService> {
    const data = await repo.loadDataset();
    // Mongo stores the morning plan from seed. Memory has nothing stored, so it computes once in this process.
    const analysis = (await repo.loadAnalysis()) ?? analyze(data, DEFAULT_POLICY);
    const service = new StockService(repo, data, analysis);
    const history = [...(await repo.listActions())].sort((a, b) => a.decidedAt.localeCompare(b.decidedAt));
    for (const action of history) service.decisions.set(action.recommendationId, action.status);
    service.audit = await repo.listAudit();
    return service;
  }

  get userRepo(): UserRepository {
    return this.repo.users;
  }

  repositoryKind(): "memory" | "mongo" {
    return this.repo.kind;
  }

  kpis(user?: User): KpiSummary {
    if (!user || user.role === "admin") {
      return this.analysis.kpis;
    }

    const allBranchIds = this.data.branches.map((b) => b.id);
    const scopedList = scopeBranches(user, allBranchIds);
    const cacheKey = [...scopedList].sort().join("|");
    const cached = this.scopedKpiCache.get(cacheKey);
    if (cached) return cached;

    const userBranches = new Set(scopedList);
    const branches = this.analysis.kpis.branches.filter((b) => userBranches.has(b.id));
    const branchRisk = this.analysis.kpis.branchRisk.filter((b) => userBranches.has(b.branchId));
    const coverGrid = this.analysis.kpis.coverGrid.filter((b) => userBranches.has(b.branchId));
    const branchIndices: number[] = [];
    for (let bIdx = 0; bIdx < this.data.branches.length; bIdx += 1) {
      const branch = this.data.branches[bIdx];
      if (branch && userBranches.has(branch.id)) branchIndices.push(bIdx);
    }

    let deadStockValue = 0;
    let lostSalesAtRisk = 0;
    let cashReleasable = 0;

    for (let sku = 0; sku < this.data.products.length; sku += 1) {
      const product = this.data.products[sku];
      if (!product) continue;
      const row = this.analysis.positions[sku];
      if (!row) continue;
      for (const bIdx of branchIndices) {
        const position = row[bIdx];
        if (!position) continue;
        if (position.status === "OVERSTOCK" && position.velocity < DEAD_VELOCITY_PER_DAY) {
          deadStockValue += position.onHand * product.cost;
        }
        if (position.status === "AT_RISK") {
          lostSalesAtRisk += position.lostUnits * product.price;
        }
        if (position.status === "OVERSTOCK") {
          cashReleasable += position.surplus * product.cost;
        }
      }
    }

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

    const result: KpiSummary = {
      ...this.analysis.kpis,
      branches,
      branchRisk,
      coverGrid,
      trend,
      backtest: scopedBacktest,
      deadStockValue: Math.round(deadStockValue * 100) / 100,
      lostSalesAtRisk: Math.round(lostSalesAtRisk * 100) / 100,
      cashReleasable: Math.round(cashReleasable * 100) / 100,
      stockoutRate: Math.round(avgStockoutRate * 1000) / 1000,
    };
    this.scopedKpiCache.set(cacheKey, result);
    return result;
  }

  list(query: RecommendationQuery, user?: User): RecommendationList {
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
    if (user && !isBranchInScope(user, id)) {
      return null;
    }

    const detail = buildBranchDetail(
      this.data,
      this.analysis.positions,
      this.analysis.recommendations,
      id,
    );
    if (!detail) return null;
    return BranchDetailSchema.parse({
      ...detail,
      recommendations: detail.recommendations.map((recommendation) => this.overlay(recommendation)),
    });
  }

  product(sku: string, user?: User): ProductDetail | null {
    const detail = buildProductDetail(
      this.data,
      DEFAULT_POLICY,
      this.analysis.positions,
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

  listAudit(user?: User): AuditList {
    if (user && !can(user.role, "audit:read")) {
      throw new DecisionForbiddenError("Staff cannot view audit log");
    }

    let entries = [...this.audit].sort((a, b) => b.at.localeCompare(a.at));
    if (user && user.role !== "admin") {
      entries = entries.filter(
        (e) =>
          isBranchInScope(user, e.branchId) ||
          (e.donorBranchId ? isBranchInScope(user, e.donorBranchId) : false),
      );
    }
    return AuditListSchema.parse({ entries });
  }

  async decide(id: string, status: "APPROVED" | "REJECTED", user?: User): Promise<Recommendation | null> {
    if (user && !can(user.role, "recommendations:decide")) {
      throw new DecisionForbiddenError("Staff cannot approve or reject actions");
    }

    const existing = this.analysis.recommendations.find((recommendation) => recommendation.id === id);
    if (!existing) return null;

    if (user && user.role !== "admin") {
      const inScope =
        isBranchInScope(user, existing.branchId) ||
        (existing.donorBranchId ? isBranchInScope(user, existing.donorBranchId) : false);
      if (!inScope) {
        throw new DecisionForbiddenError("Cannot decide action outside your assigned branches");
      }
    }

    const decidedAt = new Date().toISOString();
    const record: ActionRecord = ActionRecordSchema.parse({
      id: `${id}:${status}:${decidedAt}`,
      recommendationId: id,
      status,
      decidedAt,
    });
    const entry = AuditEntrySchema.parse({
      id: record.id,
      at: decidedAt,
      user: user ? user.name : DEMO_USER,
      recommendationId: id,
      decision: status,
      action: existing.action,
      sku: existing.sku,
      productName: existing.productName,
      branchId: existing.branchId,
      branchName: existing.branchName,
      donorBranchId: existing.donorBranchId,
      netBenefit: existing.netBenefit,
      reasonCodes: existing.reasonCodes,
      actedBy: user
        ? {
            userId: user.id,
            name: user.name,
            role: user.role,
          }
        : undefined,
    });
    await this.repo.saveAction(record);
    await this.repo.saveAudit(entry);
    this.decisions.set(id, status);
    this.audit.push(entry);
    return RecommendationSchema.parse(this.overlay(existing));
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

  async listCatalogProducts(query: ProductListQuery): Promise<ProductListResponse> {
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
      .map((p) => ({ ...p, status: p.status ?? "active" }));

    return ProductListResponseSchema.parse({
      products,
      total,
      page,
      limit,
      totalPages,
    });
  }

  async getCatalogProduct(sku: string): Promise<ProductDetailWithHistory | null> {
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
        `Selling price ($${effectivePrice}) must be greater than unit cost ($${effectiveCost})`,
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
    const numBranches = this.data.branches.length;
    const numDays = this.data.dates.length;
    const activeIndices: number[] = [];
    const activeProducts: Product[] = [];

    for (let i = 0; i < this.data.products.length; i++) {
      const p = this.data.products[i]!;
      if (p.status !== "archived") {
        activeIndices.push(i);
        activeProducts.push(p);
      }
    }

    const activeDataset: Dataset = {
      ...this.data,
      products: activeProducts,
      sales: activeIndices.map((i) => this.data.sales[i] ?? Array.from({ length: numBranches }, () => new Array(numDays).fill(0))),
      onHand: activeIndices.map((i) => this.data.onHand[i] ?? Array.from({ length: numBranches }, () => new Array(numDays).fill(0))),
      demand: activeIndices.map((i) => this.data.demand[i] ?? Array.from({ length: numBranches }, () => new Array(numDays).fill(0))),
    };

    this.analysis = analyze(activeDataset, DEFAULT_POLICY);
    this.scopedKpiCache.clear();
    await this.repo.saveAnalysis(this.analysis);
    for (const b of this.data.branches) {
      await recomputeForSku(b.id, sku);
    }
  }
}

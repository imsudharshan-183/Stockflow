import {
  ActionRecordSchema,
  AuditEntrySchema,
  AuditListSchema,
  BranchDetailSchema,
  DEAD_VELOCITY_PER_DAY,
  DEFAULT_POLICY,
  MATERIAL_MIN_NET_BENEFIT,
  ProductDetailSchema,
  RecommendationListSchema,
  RecommendationSchema,
  analyze,
  buildBranchDetail,
  buildProductDetail,
  can,
  isBranchInScope,
  scopeBranches,
  type ActionRecord,
  type Analysis,
  type AuditEntry,
  type AuditList,
  type BranchDetail,
  type Dataset,
  type KpiSummary,
  type ProductDetail,
  type Recommendation,
  type RecommendationList,
  type RecommendationQuery,
  type RecommendationStatus,
  type User,
} from "@stockflow/core";
import type { StockRepository } from "../repositories/types.js";
import type { UserRepository } from "../repositories/userTypes.js";

const DEMO_USER = "Demo Buyer";

export class DecisionForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionForbiddenError";
  }
}

// The morning plan is computed once per process. Approve and reject overlay status; they do not recompute velocity.
// SCALE: a new day or a policy edit is the point to recompute, per SKU, instead of rebuilding 500 x 15 series on every request.

export class StockService {
  private readonly decisions = new Map<string, Extract<RecommendationStatus, "APPROVED" | "REJECTED">>();
  private audit: AuditEntry[] = [];

  private constructor(
    private readonly repo: StockRepository,
    private readonly data: Dataset,
    private readonly analysis: Analysis,
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
    const userBranches = new Set(scopeBranches(user, allBranchIds));
    const branches = this.analysis.kpis.branches.filter((b) => userBranches.has(b.id));
    const branchRisk = this.analysis.kpis.branchRisk.filter((b) => userBranches.has(b.branchId));
    const coverGrid = this.analysis.kpis.coverGrid.filter((b) => userBranches.has(b.branchId));

    let deadStockValue = 0;
    let lostSalesAtRisk = 0;
    let cashReleasable = 0;

    for (let sku = 0; sku < this.data.products.length; sku += 1) {
      const product = this.data.products[sku];
      if (!product) continue;
      const row = this.analysis.positions[sku];
      if (!row) continue;
      for (let bIdx = 0; bIdx < this.data.branches.length; bIdx += 1) {
        const branch = this.data.branches[bIdx];
        if (!branch || !userBranches.has(branch.id)) continue;
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

    const stockoutRates = branchRisk.map((r) => r.stockoutRate);
    const avgStockoutRate =
      stockoutRates.length > 0 ? stockoutRates.reduce((sum, r) => sum + r, 0) / stockoutRates.length : 0;

    return {
      ...this.analysis.kpis,
      branches,
      branchRisk,
      coverGrid,
      deadStockValue: Math.round(deadStockValue * 100) / 100,
      lostSalesAtRisk: Math.round(lostSalesAtRisk * 100) / 100,
      cashReleasable: Math.round(cashReleasable * 100) / 100,
      stockoutRate: Math.round(avgStockoutRate * 1000) / 1000,
    };
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
      entries = entries.filter((e) => isBranchInScope(user, e.branchId));
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
}

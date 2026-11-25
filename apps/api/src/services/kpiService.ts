import {
  DEAD_VELOCITY_PER_DAY,
  DEFAULT_POLICY,
  KpisWithMetaResponseSchema,
  LifecycleRecommendationSchema,
  LiveOverviewResponseSchema,
  backtest,
  can,
  round2,
  round3,
  type Dataset,
  type KpisWithMetaResponse,
  type KpiSummary,
  type LifecycleRecommendation,
  type LiveOverviewResponse,
  type User,
} from "@stockflow/core";
import { latestSubmissionDates } from "../db.js";
import { diffCalendarDays, getBahrainToday } from "../utils/bahrainDate.js";
import { BranchNotFoundError, DecisionForbiddenError } from "./errors.js";
import { projectPositionFor } from "./projection.js";
import { evaluateDecisionLifecycle } from "./queueLifecycle.js";
import { ensureInitializedSyncIfPossible, type StockRuntimeState } from "./runtimeState.js";
import { isBranchInScope, isMaterialRecommendation, scopeBranches } from "./scope.js";

export class KpiService {
  constructor(private readonly runtime: StockRuntimeState) {}

  private accumulateProjectedKpis(branchIndices: readonly number[]): {
    deadStockValue: number;
    lostSalesAtRisk: number;
    cashReleasable: number;
    revenueAtRiskByBranch: Map<string, number>;
    categoryRisk: Array<{ category: string; atRiskCount: number; revenueAtRisk: number }>;
  } {
    let deadStockValue = 0;
    let lostSalesAtRisk = 0;
    let cashReleasable = 0;
    const revenueAtRiskByBranch = new Map<string, number>();
    const categoryRiskMap = new Map<
      string,
      { category: string; atRiskCount: number; revenueAtRisk: number }
    >();

    for (let sku = 0; sku < this.runtime.data.products.length; sku += 1) {
      const product = this.runtime.data.products[sku];
      if (!product) continue;
      for (const bIdx of branchIndices) {
        const branch = this.runtime.data.branches[bIdx];
        const position = projectPositionFor(
          this.runtime.data,
          this.runtime.analysis,
          this.runtime.committedDeltas,
          sku,
          bIdx,
        );
        if (!branch || !position) continue;
        if (position.status === "AT_RISK") {
          const risk = position.lostUnits * product.price;
          lostSalesAtRisk += risk;
          revenueAtRiskByBranch.set(branch.id, (revenueAtRiskByBranch.get(branch.id) ?? 0) + risk);
          const catRow = categoryRiskMap.get(product.category) ?? {
            category: product.category,
            atRiskCount: 0,
            revenueAtRisk: 0,
          };
          catRow.atRiskCount += 1;
          catRow.revenueAtRisk = round3(catRow.revenueAtRisk + risk);
          categoryRiskMap.set(product.category, catRow);
        }
        if (position.status === "OVERSTOCK") {
          const excessValue = position.surplus * product.cost;
          cashReleasable += excessValue;
          if (position.velocity < DEAD_VELOCITY_PER_DAY && position.surplus > 0) {
            deadStockValue += excessValue;
          }
        }
      }
    }

    const categoryRisk = [...categoryRiskMap.values()].sort(
      (left, right) =>
        right.revenueAtRisk - left.revenueAtRisk || left.category.localeCompare(right.category),
    );

    return { deadStockValue, lostSalesAtRisk, cashReleasable, revenueAtRiskByBranch, categoryRisk };
  }

  kpis(user?: User, branchId?: string): KpiSummary {
    ensureInitializedSyncIfPossible(this.runtime);
    // IMPORTANT: Post-plan scoping—@stockflow/core runs once on the full network so cross-branch donor
    // matching stays intact; this method slices KPIs to the caller's allowed branches afterward.
    if (!branchId && (!user || can(user.role, "dashboard:financial:network"))) {
      if (this.runtime.committedDeltas.size === 0) {
        return this.runtime.analysis.kpis;
      }
      const allBranchIndices = this.runtime.data.branches.flatMap((b, idx) =>
        b.status === "archived" ? [] : [idx],
      );
      const {
        deadStockValue,
        lostSalesAtRisk,
        cashReleasable,
        revenueAtRiskByBranch,
        categoryRisk,
      } = this.accumulateProjectedKpis(allBranchIndices);

      return {
        ...this.runtime.analysis.kpis,
        deadStockValue: round3(deadStockValue),
        lostSalesAtRisk: round3(lostSalesAtRisk),
        cashReleasable: round3(cashReleasable),
        branchRisk: this.runtime.analysis.kpis.branchRisk.map((row) => ({
          ...row,
          revenueAtRisk: round3(revenueAtRiskByBranch.get(row.branchId) ?? 0),
        })),
        categoryRisk,
      };
    }

    const scopedList = this.resolveScopedBranchIds(user, branchId);
    // IMPORTANT: Key cached rollups by sorted branch IDs + `planVersion` (physical stock/sales writes)
    // + `decisionVersion` (order overlay changes) so neither stale data nor cross-branch leaks occur.
    const cacheKey = `${[...scopedList].sort().join("|")}::v${this.runtime.planVersion}::d${this.runtime.decisionVersion}`;
    const cached = this.runtime.scopedKpiCache.get(cacheKey);
    if (cached) return cached;

    const userBranches = new Set(scopedList);
    const branches = this.runtime.analysis.kpis.branches.filter((b) => userBranches.has(b.id));
    const branchIdSet = new Set(branches.map((b) => b.id));
    const coverGrid = this.runtime.analysis.kpis.coverGrid.filter((b) =>
      userBranches.has(b.branchId),
    );
    const branchIndices: number[] = [];
    for (let bIdx = 0; bIdx < this.runtime.data.branches.length; bIdx += 1) {
      const branch = this.runtime.data.branches[bIdx];
      if (branch && branchIdSet.has(branch.id)) branchIndices.push(bIdx);
    }

    const {
      deadStockValue,
      lostSalesAtRisk,
      cashReleasable,
      revenueAtRiskByBranch,
      categoryRisk,
    } = this.accumulateProjectedKpis(branchIndices);

    const branchRisk = this.runtime.analysis.kpis.branchRisk
      .filter((b) => userBranches.has(b.branchId))
      .map((row) =>
        this.runtime.committedDeltas.size === 0
          ? row
          : { ...row, revenueAtRisk: round3(revenueAtRiskByBranch.get(row.branchId) ?? 0) },
      );

    const trend = this.runtime.data.dates.map((date, day) => {
      let stockouts = 0;
      let cells = 0;
      let salesValue = 0;
      let inventoryValue = 0;
      for (let sku = 0; sku < this.runtime.data.products.length; sku += 1) {
        const product = this.runtime.data.products[sku];
        const salesByBranch = this.runtime.data.sales[sku];
        const stockByBranch = this.runtime.data.onHand[sku];
        const demandByBranch = this.runtime.data.demand[sku];
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
      ...this.runtime.data,
      branches,
      sales: this.runtime.data.sales.map((byBranch) =>
        branchIndices.map((bIdx) => byBranch[bIdx] ?? []),
      ),
      onHand: this.runtime.data.onHand.map((byBranch) =>
        branchIndices.map((bIdx) => byBranch[bIdx] ?? []),
      ),
      demand: this.runtime.data.demand.map((byBranch) =>
        branchIndices.map((bIdx) => byBranch[bIdx] ?? []),
      ),
    };
    const scopedBacktest =
      branches.length > 0
        ? backtest(scopedDataset, DEFAULT_POLICY)
        : {
            windowDays: Math.min(DEFAULT_POLICY.backtestDays, this.runtime.data.dates.length),
            baselineStockoutDays: 0,
            engineStockoutDays: 0,
            stockoutDaysAvoided: 0,
            cashReleased: 0,
          };

    const stockoutRates = branchRisk.map((r) => r.stockoutRate);
    const avgStockoutRate =
      stockoutRates.length > 0
        ? stockoutRates.reduce((sum, r) => sum + r, 0) / stockoutRates.length
        : 0;

    const scopedPendingRecs = this.runtime.analysis.recommendations.filter((rec) => {
      if (!isMaterialRecommendation(rec)) return false;
      const status = this.runtime.decisions.get(rec.id) ?? rec.status;
      if (status !== "PENDING") return false;
      return (
        userBranches.has(rec.branchId) ||
        (rec.donorBranchId ? userBranches.has(rec.donorBranchId) : false)
      );
    });
    const pendingApprovalsCount = scopedPendingRecs.length;
    const backlogValue =
      Math.round(
        (scopedPendingRecs.reduce((acc, r) => acc + r.netBenefit, 0) + Number.EPSILON) * 100,
      ) / 100;
    const atRiskBranchCount = branchRisk.filter(
      (r) => r.stockoutRate > 0.05 || r.revenueAtRisk > 0,
    ).length;

    const result: KpiSummary = {
      ...this.runtime.analysis.kpis,
      branches,
      branchRisk,
      categoryRisk,
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
    this.runtime.scopedKpiCache.set(cacheKey, result);
    return result;
  }

  private resolveScopedBranchIds(user?: User, branchId?: string): string[] {
    if (user && !can(user.role, "dashboard:financial:scoped")) {
      throw new DecisionForbiddenError("Insufficient permission to view KPIs");
    }

    const activeBranchIds = this.runtime.data.branches
      .filter((b) => b.status !== "archived")
      .map((b) => b.id);
    const activeBranchSet = new Set(activeBranchIds);
    const allBranchIds = this.runtime.data.branches.map((b) => b.id);
    const allowedList = (user ? scopeBranches(user, activeBranchIds) : activeBranchIds).filter((id) =>
      activeBranchSet.has(id),
    );

    if (branchId) {
      if (user && user.role !== "admin" && !isBranchInScope(user, branchId)) {
        throw new DecisionForbiddenError("Access to branch forbidden");
      }
      if (!allBranchIds.includes(branchId)) {
        throw new BranchNotFoundError(`Branch ${branchId} not found`);
      }
      return [branchId];
    }
    return allowedList;
  }

  async liveOverview(user?: User, branchId?: string): Promise<LiveOverviewResponse> {
    ensureInitializedSyncIfPossible(this.runtime);
    const scopedBranchIds = this.resolveScopedBranchIds(user, branchId);
    const report = this.kpis(user, branchId);
    const branchIdSet = new Set(scopedBranchIds);
    const latest = await latestSubmissionDates(scopedBranchIds, this.runtime.repo.kind === "mongo");

    const nowMs = this.runtime.now();
    const computedAt = new Date(nowMs).toISOString();
    // IMPORTANT: Compare against Asia/Bahrain (UTC+3) today so midnight sales near UTC day
    // boundaries never misclassify yesterday's close as current or stale.
    const todayBahrain = getBahrainToday(nowMs).isoDate;
    const baselineDate = this.runtime.data.baselineThrough ?? this.runtime.data.asOf;
    const asOfDataDate = [baselineDate, ...latest.values()].sort().at(-1) ?? baselineDate;
    const reportingBranches = scopedBranchIds.map((id) => ({
      branchId: id,
      lastSubmitted: latest.get(id) ?? null,
    }));
    const staleDataDays = Math.max(0, diffCalendarDays(todayBahrain, asOfDataDate));
    const dataVersion = Math.max(1, this.runtime.planVersion);
    const decisionVersion = Math.max(1, this.runtime.decisionVersion);

    const eligibleTrend = report.trend.filter((point) => point.date <= asOfDataDate);
    const latest28 = eligibleTrend.slice(-28);
    const prior28 = eligibleTrend.length > 28 ? eligibleTrend.slice(-56, -28) : [];
    const avgOf = (rows: typeof latest28): number =>
      rows.length === 0 ? 0 : rows.reduce((sum, r) => sum + r.stockoutRate, 0) / rows.length;
    const latestAvg = avgOf(latest28);
    const priorAvg = prior28.length > 0 ? avgOf(prior28) : latestAvg;
    const delta28d = Math.round((latestAvg - priorAvg) * 10_000) / 10_000;
    const stockoutSparkline = latest28.map((p) => p.stockoutRate);

    const config = this.runtime.lifecycleConfig;
    const pendingRecommendations: LifecycleRecommendation[] = [];
    for (const rec of this.runtime.analysis.recommendations) {
      if (!isMaterialRecommendation(rec)) continue;
      const inScope =
        branchIdSet.has(rec.branchId) ||
        (rec.donorBranchId ? branchIdSet.has(rec.donorBranchId) : false);
      if (!inScope) continue;

      const evalResult = evaluateDecisionLifecycle({
        recExists: true,
        currentNetBenefit: rec.netBenefit,
        currentCoverDays: rec.metrics.coverDays ?? null,
        actionMeta: this.runtime.actionMeta.get(rec.id),
        order: this.runtime.orders.get(rec.id),
        orderMeta: this.runtime.orderLifecycleMeta.get(rec.id),
        nowMs,
        config,
      });

      if (evalResult.bucket !== "pending") continue;
      pendingRecommendations.push(
        LifecycleRecommendationSchema.parse({
          ...rec,
          status: evalResult.effectiveStatus,
          lifecycleState: evalResult.bucket,
          reopenBadge: evalResult.reopenBadge,
          canReopen: evalResult.canReopen,
          decidedAt: evalResult.decidedAt,
          rejectedUntil: evalResult.rejectedUntil,
        }),
      );
    }

    const shortages = this.runtime.data.products.flatMap((product, sku) => {
      if (product.status === "archived") return [];
      return this.runtime.data.branches.flatMap((branch, bIdx) => {
        if (!branchIdSet.has(branch.id)) return [];
        const position = projectPositionFor(this.runtime.data, this.runtime.analysis, this.runtime.committedDeltas, sku, bIdx);
        if (position?.status !== "AT_RISK" || position.coverDays === null || position.coverDays > product.leadTimeDays) return [];
        return [{ branchId: branch.id, branchName: branch.name, sku: product.sku, name: product.name, coverDays: position.coverDays }];
      });
    }).sort((a, b) => a.coverDays - b.coverDays || a.sku.localeCompare(b.sku)).slice(0, 5);

    const pendingEstimatedGain = round2(
      pendingRecommendations.reduce((sum, r) => sum + r.netBenefit, 0),
    );
    const pendingActionsCount = pendingRecommendations.length;

    const wrap = (value: number) => ({
      value,
      computedAt,
      dataVersion,
      decisionVersion,
    });

    const syncedReport: KpiSummary = {
      ...report,
      operational: {
        pendingApprovalsCount: pendingActionsCount,
        backlogValue: pendingEstimatedGain,
        atRiskBranchCount:
          report.operational?.atRiskBranchCount ??
          report.branchRisk.filter((r) => r.stockoutRate > 0.05 || r.revenueAtRisk > 0).length,
      },
    };

    return LiveOverviewResponseSchema.parse({
      report: syncedReport,
      meta: {
        computedAt,
        dataVersion,
        decisionVersion,
        todayBahrain,
        asOfDataDate,
        staleDataDays,
        reportingBranches,
      },
      metrics: {
        stockoutRate: wrap(syncedReport.stockoutRate),
        stockoutRateDelta28d: wrap(delta28d),
        overstockValue: wrap(syncedReport.cashReleasable),
        deadStockValue: wrap(syncedReport.deadStockValue),
        salesAtRisk: wrap(syncedReport.lostSalesAtRisk),
        pendingActionsCount: wrap(pendingActionsCount),
        pendingEstimatedGain: wrap(pendingEstimatedGain),
      },
      stockoutSparkline,
      handoffs: [...this.runtime.orders.values()]
        .filter((o) => o.status === "AWAITING_DONOR" && (branchIdSet.has(o.targetBranchId) || branchIdSet.has(o.sourceBranchId ?? "")))
        .sort((a, b) => Number(Boolean(b.escalatedAt)) - Number(Boolean(a.escalatedAt)) || a.createdAt.localeCompare(b.createdAt))
        .slice(0, 8)
        .map((o) => ({ id: o.id, sku: o.sku, productName: o.productName, units: o.quantity,
          source: o.sourceBranchName ?? o.sourceBranchId ?? "", destination: o.targetBranchName,
          needsRelease: !user || user.role === "admin" || isBranchInScope(user, o.sourceBranchId ?? ""), overdue: Boolean(o.escalatedAt) })),
      shortages,
      pendingRecommendations,
    });
  }

  async kpisWithMeta(user?: User, branchId?: string): Promise<KpisWithMetaResponse> {
    const live = await this.liveOverview(user, branchId);
    return KpisWithMetaResponseSchema.parse({
      ...live.report,
      meta: live.meta,
      metrics: live.metrics,
      stockoutSparkline: live.stockoutSparkline,
    });
  }
}

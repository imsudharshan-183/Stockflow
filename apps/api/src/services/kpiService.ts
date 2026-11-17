import {
  DEAD_VELOCITY_PER_DAY,
  DEFAULT_POLICY,
  backtest,
  can,
  round3,
  type Dataset,
  type KpiSummary,
  type User,
} from "@stockflow/core";
import { DecisionForbiddenError } from "./errors.js";
import { projectPositionFor } from "./projection.js";
import { ensureInitializedSyncIfPossible, type StockRuntimeState } from "./runtimeState.js";
import { isBranchInScope, scopeBranches } from "./scope.js";

export class KpiService {
  constructor(private readonly runtime: StockRuntimeState) {}

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
    ensureInitializedSyncIfPossible(this.runtime);
    if (!branchId && (!user || can(user.role, "dashboard:financial:network"))) {
      if (this.runtime.committedDeltas.size === 0) {
        return this.runtime.analysis.kpis;
      }
      const allBranchIndices = this.runtime.data.branches.map((_, idx) => idx);
      const { deadStockValue, lostSalesAtRisk, cashReleasable, revenueAtRiskByBranch } =
        this.accumulateProjectedKpis(allBranchIndices);

      return {
        ...this.runtime.analysis.kpis,
        deadStockValue: round3(deadStockValue),
        lostSalesAtRisk: round3(lostSalesAtRisk),
        cashReleasable: round3(cashReleasable),
        branchRisk: this.runtime.analysis.kpis.branchRisk.map((row) => ({
          ...row,
          revenueAtRisk: round3(revenueAtRiskByBranch.get(row.branchId) ?? 0),
        })),
      };
    }

    if (user && !can(user.role, "dashboard:financial:scoped")) {
      throw new DecisionForbiddenError("Insufficient permission to view KPIs");
    }

    const allBranchIds = this.runtime.data.branches.map((b) => b.id);
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
    const cached = this.runtime.scopedKpiCache.get(cacheKey);
    if (cached) return cached;

    const userBranches = new Set(scopedList);
    const branches = this.runtime.analysis.kpis.branches.filter((b) => userBranches.has(b.id));
    const coverGrid = this.runtime.analysis.kpis.coverGrid.filter((b) =>
      userBranches.has(b.branchId),
    );
    const branchIndices: number[] = [];
    for (let bIdx = 0; bIdx < this.runtime.data.branches.length; bIdx += 1) {
      const branch = this.runtime.data.branches[bIdx];
      if (branch && userBranches.has(branch.id)) branchIndices.push(bIdx);
    }

    const { deadStockValue, lostSalesAtRisk, cashReleasable, revenueAtRiskByBranch } =
      this.accumulateProjectedKpis(branchIndices);

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
}

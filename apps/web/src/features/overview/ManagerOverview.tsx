import { StockBrief } from "@/components/shared/StockBrief";
import { OverviewViews, QueueSummary } from "./OverviewViews";
import { TabsContent } from "@/components/ui/tabs";
import { Boxes, CircleDollarSign, ListOrdered, TriangleAlert } from "lucide-react";
import { FreshnessBanner } from "@/components/shared/FreshnessBanner";
import { PageHeader } from "@/components/shared/PageHeader";
import { PendingStockAlertsCard } from "@/components/shared/PendingStockAlertsCard";
import { Analytics } from "@/features/overview/Analytics";
import { KpiCard } from "@/features/overview/KpiCards";
import { ChartCard, weeklyPoints } from "@/features/overview/AdminOverview";
import { Shortages, TransferHandoffs } from "./Shortages";
import { NeedsAttentionStrip } from "@/features/overview/NeedsAttentionStrip";
import { ProofOfValuePanel } from "@/features/overview/ProofOfValuePanel";
import { useBahrainToday } from "@/hooks/useBahrainToday";
import type { LiveOverviewResponse } from "@/lib/api";
import {
  diffCalendarDays,
  formatBahrainTimeHm,
  formatDate,
  formatMoney,
  formatNumber,
} from "@/lib/format";
import { TOKENS } from "@/lib/tokens";
import type { KpiSummary, Recommendation } from "@stockflow/core";

interface ManagerOverviewProps {
  report: KpiSummary;
  recommendations: readonly Recommendation[];
  selectedLocation?: string | null;
  totalActions: number;
  live?: LiveOverviewResponse;
  isRefreshing?: boolean;
  onRefresh?: () => void;
  recommendationsLoading?: boolean;
  recommendationsError?: string | null;
  onRetryRecommendations?: () => void;
}

export function ManagerOverview({
  report,
  recommendations,
  selectedLocation = null,
  live,
  isRefreshing = false,
  onRefresh,
  recommendationsLoading = false,
  recommendationsError = null,
  onRetryRecommendations,
}: ManagerOverviewProps) {
  const weeks = weeklyPoints(report.trend);
  const today = useBahrainToday();
  const asOfDataDate = live?.meta.asOfDataDate ?? report.asOf;
  const staleDataDays = Math.max(0, diffCalendarDays(today.isoDate, asOfDataDate));
  const lastUpdatedHm = live ? formatBahrainTimeHm(live.meta.computedAt) : undefined;
  const branchNames = report.branches.map((b) => b.name).join(", ");
  const pendingApprovalsCount =
    live?.metrics.pendingActionsCount.value ??
    report.operational?.pendingApprovalsCount ??
    recommendations.filter((row) => row.status === "PENDING").length;
  const backlogValue =
    live?.metrics.pendingEstimatedGain.value ??
    report.operational?.backlogValue ??
    recommendations
      .filter((row) => row.status === "PENDING")
      .reduce((sum, row) => sum + row.netBenefit, 0);
  const atRiskCount = report.operational?.atRiskBranchCount ?? 0;
  const managerBranchId =
    selectedLocation ?? (report.branches.length === 1 ? (report.branches[0]?.id ?? null) : null);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cluster overview"
        lastUpdated={lastUpdatedHm}
        subtitle={`Today: ${today.displayDate} · Data through: ${formatDate(asOfDataDate)} · ${formatNumber(report.branches.length)} assigned branches (${branchNames})`}
        actions={
          <FreshnessBanner
            today={live?.meta.todayBahrain}
            branches={report.branches}
            reportingBranches={live?.meta.reportingBranches}
            staleDataDays={staleDataDays}
            isRefreshing={isRefreshing}
            onRefresh={onRefresh}
          />
        }
      />

      <OverviewViews>
        <TabsContent value="daily" className="space-y-5">
          <QueueSummary count={pendingApprovalsCount} gain={backlogValue} />
          <StockBrief branchId={selectedLocation ?? undefined} />
          <TransferHandoffs items={live?.handoffs} />

          <Shortages items={live?.shortages} />
          <NeedsAttentionStrip
            report={report}
            recommendations={recommendations}
            isLoading={recommendationsLoading}
            error={recommendationsError}
            onRetry={onRetryRecommendations}
          />

          <PendingStockAlertsCard branchId={managerBranchId} />

        </TabsContent>
        <TabsContent value="reports" className="space-y-5">
          <section className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard
              label="Pending approvals"
              value={formatNumber(pendingApprovalsCount)}
              note={`Action backlog: ${formatMoney(backlogValue)} estimated gain`}
              formula="Count of pending transfers, reorders, and markdowns touching your assigned stores."
              icon={ListOrdered}
              tone="gain"
              money={false}
              footerLabel="Awaiting cluster decision"
            />
            <KpiCard
              label="At-risk branches"
              value={`${formatNumber(atRiskCount)} / ${formatNumber(report.branches.length)}`}
              note="Assigned stores with elevated stockout risk or shelf deficit."
              formula="Count of your assigned branches where stockout rate exceeds 5% or positions are below reorder level."
              icon={TriangleAlert}
              tone="risk"
              money={false}
              footerLabel="Branches needing attention in cluster"
            />
            <KpiCard
              label="Cluster sales at risk"
              value={formatMoney(live?.metrics.salesAtRisk.value ?? report.lostSalesAtRisk)}
              note="Shelf revenue your assigned branches may miss before next delivery."
              formula="Expected lost units × retail price for positions below reorder level in your cluster."
              icon={CircleDollarSign}
              tone="info"
              footerLabel="Positions below reorder level in cluster"
            />
            <KpiCard
              label="Cluster overstock value"
              value={formatMoney(live?.metrics.overstockValue.value ?? report.cashReleasable)}
              note={`Includes ${formatMoney(live?.metrics.deadStockValue.value ?? report.deadStockValue)} dead stock in cluster (<1 unit/wk)`}
              formula="Stock above the 30-day sending branch floor × unit cost across your assigned branches."
              icon={Boxes}
              tone="warn"
              footerLabel="Surplus above 30-day sending branch floor in cluster"
            />
          </section>

          <Analytics
            report={report}
            rows={recommendations}
            selectedLocation={selectedLocation}
            recommendationsLoading={recommendationsLoading}
            recommendationsError={recommendationsError}
            onRetryRecommendations={onRetryRecommendations}
          />

          <ProofOfValuePanel
            backtest={report.backtest}
            scopeLabel={selectedLocation ? `${report.branches[0]?.name ?? selectedLocation}` : "Cluster"}
            branchCount={report.branches.length}
          />

          <section className="grid gap-6 lg:grid-cols-2">
            <ChartCard
              title="Cluster stockout rate trend"
              data={weeks}
              dataKey="stockoutRate"
              color={TOKENS.chart.stockoutRate}
              kind="rate"
            />
            <ChartCard
              title="Cluster inventory value trend"
              data={weeks}
              dataKey="inventoryValue"
              color={TOKENS.chart.inventoryValue}
              kind="money"
            />
          </section>

        </TabsContent>
      </OverviewViews>
    </div>
  );
}

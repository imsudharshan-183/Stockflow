import { StockBrief } from "@/components/shared/StockBrief";
import { DailySalesSimulation } from "@/components/shared/DailySalesSimulation";
import { OverviewViews, QueueSummary } from "./OverviewViews";
import { TabsContent } from "@/components/ui/tabs";
import { Boxes, CircleDollarSign, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import {
  Brush,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartCard as SharedChartCard } from "@/components/shared/ChartCard";
import { pickChartPoint, useChartDetail } from "@/components/shared/ChartDetailPopup";
import { FreshnessBanner } from "@/components/shared/FreshnessBanner";
import { PageHeader } from "@/components/shared/PageHeader";
import { PendingStockAlertsCard } from "@/components/shared/PendingStockAlertsCard";
import { Button } from "@/components/ui/button";
import { Analytics } from "@/features/overview/Analytics";
import { KpiCard } from "@/features/overview/KpiCards";
import { Shortages, TransferHandoffs } from "./Shortages";
import { NeedsAttentionStrip } from "@/features/overview/NeedsAttentionStrip";
import { useBahrainToday } from "@/hooks/useBahrainToday";
import type { LiveOverviewResponse } from "@/lib/api";
import {
  diffCalendarDays,
  formatBahrainTimeHm,
  formatDate,
  formatMoney,
  formatMoneyFull,
  formatNumber,
  formatPct,
} from "@/lib/format";
import { TOKENS } from "@/lib/tokens";
import type { KpiSummary, Recommendation, TrendPoint } from "@stockflow/core";

export interface WeekPoint {
  label: string;
  stockoutRate: number;
  inventoryValue: number;
}

export function weeklyPoints(trend: readonly TrendPoint[]): WeekPoint[] {
  const weeks: WeekPoint[] = [];
  for (let start = 0; start < trend.length; start += 7) {
    const slice = trend.slice(start, start + 7);
    const first = slice[0];
    const last = slice[slice.length - 1];
    if (!first || !last || slice.length === 0) continue;
    const stockoutRate = slice.reduce((sum, point) => sum + point.stockoutRate, 0) / slice.length;
    weeks.push({
      label: formatDate(first.date),
      stockoutRate,
      inventoryValue: last.inventoryValue,
    });
  }
  return weeks;
}

export function ChartCard({
  title,
  data,
  dataKey,
  color,
  kind,
}: {
  title: string;
  data: WeekPoint[];
  dataKey: "stockoutRate" | "inventoryValue";
  color: string;
  kind: "rate" | "money";
}) {
  const [rangeDays, setRangeDays] = useState<7 | 30 | 90>(90);
  const { showDetail } = useChartDetail();
  const sliced = useMemo(() => {
    const weeksToKeep = Math.max(1, Math.ceil(rangeDays / 7));
    return data.slice(-weeksToKeep);
  }, [data, rangeDays]);

  return (
    <SharedChartCard
      title={title}
      subtitle="Weekly rollup · click any point for exact metrics"
      helpKey={kind === "rate" ? "stockoutRate" : "overstockValue"}
      isEmpty={sliced.length === 0}
      tableData={{
        headers: ["Week", title],
        rows: sliced.map((w) => [
          w.label,
          kind === "rate" ? formatPct(w.stockoutRate) : formatMoneyFull(w.inventoryValue),
        ]),
      }}
      actions={
        <div className="flex items-center gap-1">
          {([7, 30, 90] as const).map((r) => (
            <Button
              key={r}
              type="button"
              variant={rangeDays === r ? "primary" : "ghost"}
              size="sm"
              onClick={() => setRangeDays(r)}
              className="h-7 px-2 text-xs"
            >
              {r}d
            </Button>
          ))}
        </div>
      }
    >
      <div className="h-60 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={sliced}
            className="cursor-pointer"
            onClick={(state, event) => {
              const point = pickChartPoint<WeekPoint>(state, event);
              if (!point) return;
              showDetail({
                targetCard: title,
                title,
                subtitle: `Week of ${point.label}`,
                metrics: [
                  { label: "Stockout rate", value: formatPct(point.stockoutRate) },
                  { label: "Inventory value", value: formatMoneyFull(point.inventoryValue) },
                  { label: "Selected window", value: `Last ${rangeDays} days` },
                ],
              });
            }}
          >
            <CartesianGrid stroke={TOKENS.chart.grid} strokeDasharray="3 3" strokeOpacity={0.6} />
            <XAxis
              dataKey="label"
              minTickGap={16}
              tick={{ fontSize: 11, fill: TOKENS.chart.axis }}
            />
            <YAxis
              tickFormatter={(value: number) =>
                kind === "rate" ? formatPct(value) : formatMoney(value)
              }
              tick={{ fontSize: 11, fill: TOKENS.chart.axis }}
              width={64}
            />
            <Tooltip
              cursor={{ stroke: TOKENS.chart.axis, strokeDasharray: "3 3" }}
              content={({ active, payload }) => {
                const point = payload?.[0]?.payload as WeekPoint | undefined;
                if (!active || !point) return null;
                return (
                  <div className="rounded-xl border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-card">
                    <p className="font-medium">Week of {point.label}</p>
                    {kind === "rate" ? (
                      <p className="mt-0.5 text-muted-foreground">
                        Stockout rate:{" "}
                        <span className="font-semibold text-foreground tabular-nums">
                          {formatPct(point.stockoutRate)}
                        </span>
                      </p>
                    ) : (
                      <p className="mt-0.5 text-muted-foreground">
                        Inventory value:{" "}
                        <span className="font-semibold text-foreground tabular-nums">
                          {formatMoneyFull(point.inventoryValue)}
                        </span>
                      </p>
                    )}
                  </div>
                );
              }}
            />
            <Legend />
            <Line
              type="monotone"
              dataKey={dataKey}
              name={title}
              stroke={color}
              dot={{ r: 3 }}
              activeDot={{ r: 5 }}
              strokeWidth={2}
            />
            {sliced.length > 3 ? (
              <Brush dataKey="label" height={20} stroke={TOKENS.chart.axis} fill={TOKENS.surface.tableHeader} />
            ) : null}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </SharedChartCard>
  );
}

interface AdminOverviewProps {
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

export function AdminOverview({
  report,
  recommendations,
  selectedLocation = null,
  totalActions,
  live,
  isRefreshing = false,
  onRefresh,
  recommendationsLoading = false,
  recommendationsError = null,
  onRetryRecommendations,
}: AdminOverviewProps) {
  const weeks = weeklyPoints(report.trend);
  const projected = recommendations.reduce((sum, row) => sum + row.netBenefit, 0);
  const today = useBahrainToday();
  const asOfDataDate = live?.meta.asOfDataDate ?? report.asOf;
  const staleDataDays = Math.max(0, diffCalendarDays(today.isoDate, asOfDataDate));
  const lastUpdatedHm = live ? formatBahrainTimeHm(live.meta.computedAt) : undefined;
  const pendingCount = live?.metrics.pendingActionsCount.value ?? totalActions;
  const pendingGain = live?.metrics.pendingEstimatedGain.value ?? projected;
  const stockoutRateValue = live?.metrics.stockoutRate.value ?? report.stockoutRate;
  const stockoutSparkline = live?.stockoutSparkline ?? report.trend.map((point) => point.stockoutRate);
  const stockoutDeltaOverride = live?.metrics.stockoutRateDelta28d.value;
  const overstockValue = live?.metrics.overstockValue.value ?? report.cashReleasable;
  const deadStockValue = live?.metrics.deadStockValue.value ?? report.deadStockValue;
  const salesAtRisk = live?.metrics.salesAtRisk.value ?? report.lostSalesAtRisk;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Network overview"
        lastUpdated={lastUpdatedHm}
        subtitle={`Today: ${today.displayDate} · Data through: ${formatDate(asOfDataDate)} · ${formatNumber(report.branches.length)} branches monitored`}
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
          <DailySalesSimulation />
          <QueueSummary count={pendingCount} gain={pendingGain} />
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

          <PendingStockAlertsCard
            scope={selectedLocation ? "branch" : "network"}
            branchId={selectedLocation}
          />

        </TabsContent>
        <TabsContent value="reports" className="space-y-5">
          <section className="grid gap-5 sm:grid-cols-3">
            <KpiCard
              label="Stockout rate"
              value={formatPct(stockoutRateValue)}
              note="Share of recent selling days with demand and an empty shelf."
              formula="Stockout branch-SKU days ÷ (branches × SKUs × 28)"
              icon={TriangleAlert}
              tone="risk"
              series={stockoutSparkline}
              deltaOverride={stockoutDeltaOverride}
              money={false}
              invertDelta
            />
            <KpiCard
              label="Overstock value"
              value={formatMoney(overstockValue)}
              note={`Includes ${formatMoney(deadStockValue)} dead stock (<1 unit/wk)`}
              formula="Stock above the 30-day sending branch floor × unit cost. Dead stock is the portion selling under one unit per week."
              icon={Boxes}
              tone="warn"
              footerLabel="Surplus above 30-day sending branch floor"
            />
            <KpiCard
              label="Sales at risk"
              value={formatMoney(salesAtRisk)}
              note="Shelf revenue a short branch may miss before next delivery."
              formula="Expected lost units × retail price for positions below their reorder level."
              icon={CircleDollarSign}
              tone="info"
              footerLabel="Positions below reorder level"
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

          <section className="grid gap-6 lg:grid-cols-2">
            <ChartCard
              title="Stockout rate trend"
              data={weeks}
              dataKey="stockoutRate"
              color={TOKENS.chart.stockoutRate}
              kind="rate"
            />
            <ChartCard
              title="Inventory value trend"
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

import { ArrowRight, Boxes, CircleDollarSign, TrendingUp, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
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
import { PageHeader } from "@/components/shared/PageHeader";
import { PendingStockAlertsCard } from "@/components/shared/PendingStockAlertsCard";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Analytics } from "@/features/overview/Analytics";
import { KpiCard } from "@/features/overview/KpiCards";
import {
  formatDate,
  formatMoney,
  formatMoneyFull,
  formatNumber,
  formatPct,
} from "@/lib/format";
import { TOKENS } from "@/lib/tokens";
import { cn } from "@/lib/utils";
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
              <Brush dataKey="label" height={20} stroke={TOKENS.chart.axis} />
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
  totalActions: number;
  recommendationsLoading?: boolean;
  recommendationsError?: string | null;
  onRetryRecommendations?: () => void;
}

export function AdminOverview({
  report,
  recommendations,
  totalActions,
  recommendationsLoading = false,
  recommendationsError = null,
  onRetryRecommendations,
}: AdminOverviewProps) {
  const weeks = weeklyPoints(report.trend);
  const avoided = report.backtest.stockoutDaysAvoided;
  const avoidedText =
    avoided >= 0
      ? `${formatNumber(avoided)} fewer stockout days`
      : `${formatNumber(Math.abs(avoided))} more stockout days`;
  const projected = recommendations.reduce((sum, row) => sum + row.netBenefit, 0);
  const pendingCount = recommendations.filter((row) => row.status === "PENDING").length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Network overview"
        subtitle={`As of ${formatDate(report.asOf)} · ${formatNumber(report.branches.length)} branches monitored`}
      />

      {/* Hero Panel */}
      <section className="hero-surface flex flex-col justify-between gap-4 rounded-2xl border border-border p-6 shadow-card lg:flex-row lg:items-center">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="transfer">Backtest verified</Badge>
            <span className="text-xs font-medium text-muted-foreground">
              {report.backtest.windowDays}-day replay window
            </span>
          </div>
          <h2 className="text-lg font-semibold tracking-tight text-foreground sm:text-xl">
            {totalActions > 0
              ? `${formatNumber(totalActions)} ranked actions worth ${formatMoney(projected)} in estimated gain`
              : "Evaluating today's network recommendations..."}
          </h2>
          <p className="text-sm text-muted-foreground">
            With StockFlow:{" "}
            <span className="font-medium text-foreground">{avoidedText}</span> and{" "}
            <span className="font-medium text-foreground">
              {formatMoney(report.backtest.cashReleased)}
            </span>{" "}
            capital released over the last {report.backtest.windowDays} days.
          </p>
        </div>

        <div className="shrink-0">
          <span className="hero-cta-glow inline-block rounded-xl">
            <Link
              to="/queue"
              className={cn(
                buttonVariants({ variant: "primary", size: "lg" }),
                "rounded-xl px-5 font-semibold",
              )}
            >
              Review {formatNumber(totalActions)} actions
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </span>
        </div>
      </section>

      {/* 4 Distinct Network KPI Cards */}
      <section className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Stockout rate"
          value={formatPct(report.stockoutRate)}
          note="Share of recent selling days with demand and an empty shelf."
          formula="Stockout branch-SKU days ÷ (branches × SKUs × 28)"
          icon={TriangleAlert}
          tone="risk"
          series={report.trend.map((point) => point.stockoutRate)}
          money={false}
          invertDelta
        />
        <KpiCard
          label="Overstock value"
          value={formatMoney(report.cashReleasable)}
          note={`Includes ${formatMoney(report.deadStockValue)} dead stock (<1 unit/wk)`}
          formula="Stock above the 30-day donor floor × unit cost. Dead stock is the portion selling under one unit per week."
          icon={Boxes}
          tone="warn"
          footerLabel="Surplus above 30-day donor floor"
        />
        <KpiCard
          label="Sales at risk"
          value={formatMoney(report.lostSalesAtRisk)}
          note="Shelf revenue a short branch may miss before next delivery."
          formula="Expected lost units × retail price for positions below their reorder level."
          icon={CircleDollarSign}
          tone="info"
          footerLabel="Positions below reorder level"
        />
        <KpiCard
          label="Estimated gain"
          value={formatMoney(projected)}
          note={`Across ${formatNumber(pendingCount)} pending / ${formatNumber(totalActions)} total actions`}
          formula="Sum of estimated gain across today's ranked transfers, reorders, and markdowns."
          icon={TrendingUp}
          tone="gain"
          footerLabel="Net of freight, purchase, and markdown costs"
        />
      </section>

      {/* Pending Staff Stock Alerts across all branches */}
      <PendingStockAlertsCard scope="network" />

      {/* Full Network Heatmap & Analytics */}
      <Analytics
        report={report}
        rows={recommendations}
        recommendationsLoading={recommendationsLoading}
        recommendationsError={recommendationsError}
        onRetryRecommendations={onRetryRecommendations}
      />

      {/* 90-Day Network Trend Charts */}
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

      {/* Action Queue Callout Card */}
      <Card className="rounded-2xl border border-border bg-card shadow-card">
        <CardContent className="flex flex-col items-start justify-between gap-4 py-2 sm:flex-row sm:items-center">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              Ready to act on today's recommendations?
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {`${formatNumber(pendingCount)} pending actions (${formatMoney(projected)} total estimated gain) are ready for review, batch approval, or drilldown in the Action Queue.`}
            </p>
          </div>
          <Link
            to="/queue"
            className={cn(buttonVariants({ variant: "secondary", size: "default" }), "shrink-0")}
          >
            View full queue
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}

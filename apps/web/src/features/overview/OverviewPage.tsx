import { useQuery } from "@tanstack/react-query";
import { Boxes, CircleDollarSign, Link2, TriangleAlert } from "lucide-react";
import { Link } from "react-router-dom";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ErrorBlock, LoadingBlock } from "@/components/shared/states";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Analytics } from "@/features/overview/Analytics";
import { KpiCard } from "@/features/overview/KpiCards";
import { queryKeys } from "@/hooks/queryKeys";
import { api } from "@/lib/api";
import { actionLabel, formatCover, formatDate, formatMoney, formatMoneyFull, formatNumber, formatPct } from "@/lib/format";
import type { TrendPoint } from "@stockflow/core";

interface WeekPoint {
  label: string;
  stockoutRate: number;
  inventoryValue: number;
}

export function OverviewPage() {
  const kpis = useQuery({ queryKey: queryKeys.kpis, queryFn: api.kpis });
  const queue = useQuery({ queryKey: queryKeys.recommendations({}), queryFn: () => api.recommendations({}) });

  if (kpis.isPending) return <LoadingBlock />;
  if (kpis.isError) return <ErrorBlock message={kpis.error.message} onRetry={() => void kpis.refetch()} />;

  const report = kpis.data;
  const weeks = weeklyPoints(report.trend);
  const avoided = report.backtest.stockoutDaysAvoided;
  const avoidedText =
    avoided >= 0
      ? `${formatNumber(avoided)} fewer stockout days`
      : `${formatNumber(Math.abs(avoided))} more stockout days`;
  const projected = queue.data?.recommendations.reduce((sum, row) => sum + row.netBenefit, 0) ?? 0;

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border bg-card px-6 py-4 shadow-card">
        {queue.data ? (
          <p className="text-sm">
            <span className="font-semibold">{formatNumber(queue.data.total)} actions today</span>
            <span className="text-muted-foreground">, projected net benefit </span>
            <span className="font-semibold">{formatMoney(projected)}</span>
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Loading today's actions</p>
        )}
      </div>

      <div className="brand-gradient rounded-xl px-6 py-5 text-white">
        <h1 className="text-2xl font-semibold tracking-tight">Today's network</h1>
        <p className="text-sm text-white/80">As of {formatDate(report.asOf)}. Ranked moves for 15 branches.</p>
      </div>

      <div className="rounded-2xl border border-[var(--lavender-200)] bg-[var(--lavender-50)] px-6 py-4 text-sm">
        With StockFlow: {avoidedText}, {formatMoney(report.backtest.cashReleased)} capital released over the last{" "}
        {report.backtest.windowDays} days.
      </div>

      <section className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Stockout rate"
          value={formatPct(report.stockoutRate)}
          note="Share of recent selling days with demand and an empty shelf."
          formula="Stockout branch-SKU days ÷ (branches × SKUs × 28)"
          icon={TriangleAlert}
          accent="#D4566B"
          series={report.trend.map((point) => point.stockoutRate)}
          money={false}
        />
        <KpiCard
          label="Excess inventory value"
          value={formatMoney(report.cashReleasable)}
          note={`of which dead stock ${formatMoney(report.deadStockValue)}`}
          formula="Stock above the 30-day floor × cost. Dead stock is the part selling under one unit a week."
          icon={Boxes}
          accent="#D9962B"
          series={report.trend.map((point) => point.inventoryValue)}
          money
        />
        <KpiCard
          label="Revenue at risk"
          value={formatMoney(report.lostSalesAtRisk)}
          note="Shelf price a short branch may miss before the next delivery."
          formula="Lost units × price for positions below the reorder point"
          icon={CircleDollarSign}
          accent="#6D5BD0"
          series={report.trend.map((point) => point.inventoryValue)}
          money
        />
        <KpiCard
          label="Capital releasable"
          value={formatMoney(report.cashReleasable)}
          note="Same figure as excess inventory value."
          formula="Surplus units above the 30-day donor floor × cost"
          icon={Link2}
          accent="#4F86E8"
          series={report.trend.map((point) => point.inventoryValue)}
          money
        />
      </section>

      {queue.data ? <Analytics report={report} rows={queue.data.recommendations} /> : null}

      <section className="grid gap-6 lg:grid-cols-2">
        <ChartCard title="Stockout rate" data={weeks} dataKey="stockoutRate" color="#7C6FD6" kind="rate" />
        <ChartCard title="Inventory value" data={weeks} dataKey="inventoryValue" color="#4FB3A9" kind="money" />
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Highest-benefit actions</h2>
          <Link className={buttonVariants({ variant: "link" })} to="/queue">
            Open the queue
          </Link>
        </div>
        {queue.isPending ? <LoadingBlock /> : null}
        {queue.isError ? <ErrorBlock message={queue.error.message} onRetry={() => void queue.refetch()} /> : null}
        {queue.data && queue.data.recommendations.length === 0 ? (
          <p className="text-sm text-muted-foreground">No actions today.</p>
        ) : null}
        {queue.data ? (
          <div className="overflow-x-auto rounded-2xl border bg-card shadow-card">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-[var(--lavender-50)] text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Rank</th>
                  <th className="px-3 py-2 font-medium">Action</th>
                  <th className="px-3 py-2 font-medium">SKU</th>
                  <th className="px-3 py-2 font-medium">Branch</th>
                  <th className="px-3 py-2 font-medium">Cover</th>
                  <th className="px-3 py-2 text-right font-medium">Net benefit</th>
                </tr>
              </thead>
              <tbody>
                {queue.data.recommendations.slice(0, 5).map((recommendation) => (
                  <tr key={recommendation.id} className="border-t">
                    <td className="px-3 py-2">{recommendation.rank}</td>
                    <td className="px-3 py-2">
                      <Badge tone={recommendation.action === "TRANSFER" ? "transfer" : recommendation.action === "REORDER" ? "reorder" : "markdown"}>
                        {actionLabel(recommendation.action)}
                      </Badge>
                    </td>
                    <td className="px-3 py-2">
                      <Link className="hover:underline" to={`/products/${recommendation.sku}`}>
                        {recommendation.productName}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <Link className="hover:underline" to={`/branches/${recommendation.branchId}`}>
                        {recommendation.branchName}
                      </Link>
                    </td>
                    <td className="px-3 py-2">{formatCover(recommendation.metrics.coverDays)}</td>
                    <td className="px-3 py-2 text-right">{formatMoneyFull(recommendation.netBenefit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function weeklyPoints(trend: readonly TrendPoint[]): WeekPoint[] {
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

function ChartCard({
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
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-56 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data}>
              <CartesianGrid stroke="#E7E2F8" strokeDasharray="3 3" />
              <XAxis dataKey="label" minTickGap={16} tick={{ fontSize: 11, fill: "#6B6785" }} />
              <YAxis
                tickFormatter={(value: number) => (kind === "rate" ? formatPct(value) : formatMoney(value))}
                tick={{ fontSize: 11, fill: "#6B6785" }}
                width={64}
              />
              <Tooltip
                content={({ active, payload }) => {
                  const point = payload?.[0]?.payload as WeekPoint | undefined;
                  if (!active || !point) return null;
                  return (
                    <div className="rounded-xl border bg-card px-3 py-2 text-xs shadow-card">
                      <p className="font-medium">Week of {point.label}</p>
                      {kind === "rate" ? (
                        <p>Stockout rate {formatPct(point.stockoutRate)}</p>
                      ) : (
                        <p>Inventory value {formatMoneyFull(point.inventoryValue)}</p>
                      )}
                    </div>
                  );
                }}
              />
              <Legend />
              <Line type="monotone" dataKey={dataKey} name={title} stroke={color} dot={{ r: 3 }} strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

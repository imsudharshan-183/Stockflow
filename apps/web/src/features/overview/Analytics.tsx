import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Bar,
  BarChart,
  Cell,
  LabelList,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartCard } from "@/components/shared/ChartCard";
import { useChartDetail } from "@/components/shared/ChartDetailPopup";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  formatCover,
  formatCoverCell,
  formatMoney,
  formatMoneyFull,
  formatNumber,
  formatPct,
} from "@/lib/format";
import { LABELS } from "@/lib/labels";
import { TOKENS } from "@/lib/tokens";
import { cn } from "@/lib/utils";
import {
  resolveRiskChart,
  type RiskChartRow,
} from "@/features/overview/riskChart";
import {
  formatProductDisplayName,
  type Action,
  type KpiSummary,
  type PositionStatus,
  type Recommendation,
} from "@stockflow/core";

export { resolveRiskChart, type RiskChartRow };

function renderBarEndLabel({
  x,
  y,
  width,
  height,
  value,
}: {
  x?: number | string;
  y?: number | string;
  width?: number | string;
  height?: number | string;
  value?: number | string | boolean | null;
}) {
  return (
    <text
      x={Number(x ?? 0) + Number(width ?? 0) + 6}
      y={Number(y ?? 0) + Number(height ?? 0) / 2}
      dominantBaseline="central"
      fill={TOKENS.chart.axis}
      className="text-[11px] font-medium tabular-nums"
    >
      {formatMoney(Number(value))}
    </text>
  );
}

const ACTION_CONFIG: Record<
  Action,
  { label: string; symbol: string; color: string; dotClass: string }
> = {
  TRANSFER: {
    label: "Transfer",
    symbol: "⇄",
    color: TOKENS.chart.transfer,
    dotClass: "bg-chart-transfer",
  },
  REORDER: {
    label: "Reorder",
    symbol: "+",
    color: TOKENS.chart.reorder,
    dotClass: "bg-chart-reorder",
  },
  MARKDOWN: {
    label: "Markdown",
    symbol: "↓",
    color: TOKENS.chart.markdown,
    dotClass: "bg-chart-markdown",
  },
};

export function Analytics({
  report,
  rows,
  selectedLocation = null,
  recommendationsLoading = false,
  recommendationsError,
  onRetryRecommendations,
}: {
  report: KpiSummary;
  rows: readonly Recommendation[];
  selectedLocation?: string | null;
  recommendationsLoading?: boolean;
  recommendationsError?: string | null;
  onRetryRecommendations?: () => void;
}) {
  const navigate = useNavigate();
  const { showDetail } = useChartDetail();
  const [hiddenActions, setHiddenActions] = useState<ReadonlySet<Action>>(new Set());

  const mix = useMemo(() => mixOf(rows), [rows]);
  const visibleMix = useMemo(
    () => mix.filter((m) => !hiddenActions.has(m.action) && m.value > 0),
    [mix, hiddenActions],
  );
  const totalMixCount = useMemo(
    () => mix.filter((m) => !hiddenActions.has(m.action)).reduce((sum, m) => sum + m.count, 0),
    [mix, hiddenActions],
  );
  const totalMixValue = useMemo(
    () => mix.filter((m) => !hiddenActions.has(m.action)).reduce((sum, m) => sum + m.value, 0),
    [mix, hiddenActions],
  );
  const fullMixCount = useMemo(() => mix.reduce((sum, m) => sum + m.count, 0), [mix]);

  const skus = useMemo(() => topSkus(rows, 8), [rows]);
  const skuById = useMemo(() => new Map(skus.map((s) => [s.sku, s])), [skus]);
  const riskChart = useMemo(
    () => resolveRiskChart(selectedLocation, report),
    [selectedLocation, report],
  );

  const toggleAction = (action: Action) => {
    setHiddenActions((prev) => {
      const next = new Set(prev);
      if (next.has(action)) {
        next.delete(action);
      } else if (next.size < mix.length - 1) {
        next.add(action);
      }
      return next;
    });
  };

  return (
    <section className="grid gap-6 xl:grid-cols-3">
      {/* 1. Action Mix Donut */}
      <ChartCard
        detailId="actionMix"
        title={LABELS.actionMix.label}
        subtitle="Click a slice for breakdown; toggle legend items to filter"
        helpKey="actionMix"
        heightClass="flex min-h-[16rem] flex-col justify-center"
        isLoading={recommendationsLoading}
        isError={Boolean(recommendationsError)}
        errorMessage={recommendationsError ?? undefined}
        onRetry={onRetryRecommendations}
        isEmpty={rows.length === 0}
        tableData={{
          headers: ["Action", "Count", "Estimated gain"],
          rows: mix.map((m) => [
            `${m.symbol} ${m.name}`,
            formatNumber(m.count),
            formatMoneyFull(m.value),
          ]),
        }}
      >
        <div className="@container w-full">
        <div className="flex w-full flex-col items-center gap-4 @[28rem]:flex-row @[28rem]:items-center">
          <div className="relative h-44 w-44 shrink-0 @[28rem]:h-52 @[28rem]:w-56">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart margin={{ top: 18, right: 28, bottom: 18, left: 28 }}>
                <Pie
                  data={visibleMix}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={40}
                  outerRadius={54}
                  paddingAngle={2}
                  labelLine={false}
                  label={({
                    cx,
                    cy,
                    midAngle,
                    outerRadius: oR,
                    payload,
                    percent,
                  }: {
                    cx?: number;
                    cy?: number;
                    midAngle?: number;
                    outerRadius?: number;
                    payload?: { symbol?: string };
                    percent?: number;
                  }) => {
                    if (
                      cx === undefined ||
                      cy === undefined ||
                      midAngle === undefined ||
                      oR === undefined ||
                      !percent ||
                      percent < 0.04
                    ) {
                      return null;
                    }
                    const rad = Math.PI / 180;
                    const r = oR + 11;
                    const x = cx + r * Math.cos(-midAngle * rad);
                    const y = cy + r * Math.sin(-midAngle * rad);
                    return (
                      <text
                        x={x}
                        y={y}
                        fill={TOKENS.chart.axis}
                        textAnchor={x >= cx ? "start" : "end"}
                        dominantBaseline="central"
                        className="text-[10px] font-semibold tabular-nums"
                      >
                        {`${payload?.symbol ?? ""} ${Math.round(percent * 100)}%`}
                      </text>
                    );
                  }}
                  onClick={(entry: {
                    action?: Action;
                    name?: string;
                    symbol?: string;
                    count?: number;
                    value?: number;
                    payload?: {
                      action?: Action;
                      name?: string;
                      symbol?: string;
                      count?: number;
                      value?: number;
                    };
                  }) => {
                    const item = entry?.payload ?? entry;
                    if (!item?.action) return;
                    const count = item.count ?? 0;
                    const value = item.value ?? 0;
                    showDetail({
                      targetCard: "actionMix",
                      title: `${item.symbol ?? ""} ${item.name ?? item.action} actions`.trim(),
                      subtitle: "Action Mix breakdown",
                      metrics: [
                        { label: "Recommendations", value: formatNumber(count) },
                        {
                          label: "Share of queue",
                          value: fullMixCount > 0 ? formatPct(count / fullMixCount) : "0%",
                        },
                        { label: "Total estimated gain", value: formatMoneyFull(value) },
                        {
                          label: "Average gain / action",
                          value: count > 0 ? formatMoneyFull(value / count) : formatMoneyFull(0),
                        },
                      ],
                      linkTo: `/queue?action=${item.action}`,
                      linkLabel: "Open in Queue →",
                    });
                  }}
                  className="cursor-pointer"
                >
                  {visibleMix.map((slice) => (
                    <Cell key={slice.name} fill={slice.color} />
                  ))}
                </Pie>
                <RechartsTooltip
                  formatter={(value, _name, item) => {
                    const sym = (item?.payload as { symbol?: string } | undefined)?.symbol ?? "";
                    const label = (item?.payload as { name?: string } | undefined)?.name ?? "";
                    return [formatMoneyFull(Number(value)), `${sym} ${label}`.trim()];
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-2 text-center">
              <span className="text-lg leading-tight font-semibold text-foreground tabular-nums">
                {formatNumber(totalMixCount)}
              </span>
              <span className="text-[10px] font-medium text-muted-foreground">actions</span>
              <span className="mt-0.5 text-xs font-semibold text-gain-text tabular-nums">
                {formatMoney(totalMixValue)}
              </span>
            </div>
          </div>

          <ul className="w-full min-w-0 flex-1 space-y-2 text-xs">
            {mix.map((slice) => {
              const hidden = hiddenActions.has(slice.action);
              return (
                <li key={slice.name} className="flex items-center justify-between gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => toggleAction(slice.action)}
                    aria-pressed={!hidden}
                    className={cn(
                      "h-7 gap-1.5 px-1.5 text-xs font-medium",
                      hidden ? "opacity-45 line-through" : "",
                    )}
                  >
                    <span className={cn("size-2.5 shrink-0 rounded-full", slice.dotClass)} />
                    <span aria-hidden="true" className="font-mono text-[11px]">
                      {slice.symbol}
                    </span>
                    <span>{slice.name}</span>
                  </Button>
                  <Link
                    to={`/queue?action=${slice.action}`}
                    className="shrink-0 text-right text-muted-foreground tabular-nums hover:text-primary hover:underline"
                  >
                    <span className="font-semibold text-foreground">{formatNumber(slice.count)}</span>{" "}
                    · {formatMoney(slice.value)}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
        </div>
      </ChartCard>

      {/* 2. Scope-Aware Risk Chart: Top 8 At-Risk Locations OR At-Risk by Category */}
      <ChartCard
        detailId="topLocations"
        title={LABELS[riskChart.titleKey].label}
        subtitle={riskChart.subtitle}
        helpKey={riskChart.titleKey}
        heightClass={riskChart.rows.length > 8 ? "h-80" : "h-64"}
        isEmpty={riskChart.rows.length === 0}
        tableData={{
          headers:
            riskChart.mode === "categories"
              ? ["Category", "AT_RISK SKUs", "Sales at risk"]
              : ["Location", "Stockout rate", "Sales at risk"],
          rows: riskChart.rows.map((row) => [
            row.label,
            riskChart.mode === "categories"
              ? formatNumber(row.atRiskCount ?? 0)
              : formatPct(row.stockoutRate ?? 0),
            formatMoneyFull(row.revenueAtRisk),
          ]),
        }}
      >
        <div className={riskChart.rows.length > 8 ? "h-80 w-full" : "h-64 w-full"}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={riskChart.rows}
              layout="vertical"
              margin={{ top: 4, left: 6, right: 64, bottom: 4 }}
            >
              <XAxis type="number" hide domain={[0, (dataMax: number) => Math.max(1, dataMax * 1.18)]} />
              <YAxis
                type="category"
                dataKey="label"
                width={116}
                axisLine={false}
                tickLine={false}
                interval={0}
                tickFormatter={(v: string) => (v.length > 16 ? `${v.slice(0, 15)}…` : v)}
                tick={{ fontSize: 11, fill: TOKENS.chart.axis }}
              />
              <RechartsTooltip
                cursor={{ fill: TOKENS.chart.grid, opacity: 0.2 }}
                formatter={(value) => [formatMoneyFull(Number(value)), LABELS.lostSalesAtRisk.label]}
              />
              <Bar
                dataKey="revenueAtRisk"
                name={LABELS.lostSalesAtRisk.label}
                fill={TOKENS.chart.revenueAtRisk}
                radius={[0, 4, 4, 0]}
                className="cursor-pointer"
                onClick={(entry: { payload?: RiskChartRow } & Partial<RiskChartRow>) => {
                  const item = entry?.payload ?? entry;
                  if (!item?.id) return;
                  if (riskChart.mode === "categories" && item.href) {
                    navigate(item.href);
                    return;
                  }
                  showDetail({
                    targetCard: "topLocations",
                    title: item.label ?? item.id,
                    subtitle: `Location ${item.id} · At-risk summary`,
                    metrics: [
                      { label: "Sales at risk", value: formatMoneyFull(item.revenueAtRisk ?? 0) },
                      { label: "Stockout rate", value: formatPct(item.stockoutRate ?? 0) },
                    ],
                    linkTo: item.href,
                    linkLabel: "View Branch →",
                  });
                }}
              >
                <LabelList dataKey="revenueAtRisk" content={renderBarEndLabel} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </ChartCard>

      {/* 3. Top SKUs by Estimated Gain */}
      <ChartCard
        detailId="topSkus"
        title={LABELS.topSkus.label}
        subtitle="Ranked by estimated gain · click a bar to inspect product"
        helpKey="topSkus"
        heightClass="h-64"
        isLoading={recommendationsLoading}
        isError={Boolean(recommendationsError)}
        errorMessage={recommendationsError ?? undefined}
        onRetry={onRetryRecommendations}
        isEmpty={skus.length === 0}
        tableData={{
          headers: ["Product", "SKU", "Estimated gain"],
          rows: skus.map((s) => [s.name, s.sku, formatMoneyFull(s.netBenefit)]),
        }}
      >
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={skus}
              layout="vertical"
              margin={{ top: 4, left: 6, right: 64, bottom: 4 }}
            >
              <XAxis type="number" hide domain={[0, (dataMax: number) => Math.max(1, dataMax * 1.18)]} />
              <YAxis
                type="category"
                dataKey="sku"
                width={136}
                axisLine={false}
                tickLine={false}
                interval={0}
                tick={({ x, y, payload }: { x?: number | string; y?: number | string; payload?: { value?: string } }) => {
                  const sku = String(payload?.value ?? "");
                  const row = skuById.get(sku);
                  const rawName = row ? formatProductDisplayName(row.name, row.sku) : sku;
                  const shortName = rawName.length > 20 ? `${rawName.slice(0, 19)}…` : rawName;
                  const cx = Number(x ?? 0);
                  const cy = Number(y ?? 0);
                  return (
                    <g transform={`translate(${cx},${cy})`}>
                      <text
                        x={-4}
                        y={-3}
                        textAnchor="end"
                        className="fill-foreground text-[11px] font-medium"
                      >
                        {shortName}
                      </text>
                      <text
                        x={-4}
                        y={9}
                        textAnchor="end"
                        className="fill-muted-foreground font-mono text-[9px]"
                      >
                        {sku}
                      </text>
                    </g>
                  );
                }}
              />
              <RechartsTooltip
                cursor={{ fill: TOKENS.chart.grid, opacity: 0.2 }}
                formatter={(value) => [formatMoneyFull(Number(value)), LABELS.netBenefit.label]}
                labelFormatter={(label) => {
                  const found = skuById.get(String(label));
                  return found
                    ? `${formatProductDisplayName(found.name, found.sku)} (${found.sku})`
                    : String(label);
                }}
              />
              <Bar
                dataKey="netBenefit"
                name={LABELS.netBenefit.label}
                fill={TOKENS.chart.transfer}
                radius={[0, 4, 4, 0]}
                className="cursor-pointer"
                onClick={(entry: {
                  sku?: string;
                  name?: string;
                  netBenefit?: number;
                  payload?: { sku?: string; name?: string; netBenefit?: number };
                }) => {
                  const item = entry?.payload ?? entry;
                  if (!item?.sku) return;
                  navigate(`/products/${item.sku}`);
                }}
              >
                <LabelList dataKey="netBenefit" content={renderBarEndLabel} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </ChartCard>

      {/* 4. Semantic 4-Band Stock Cover Heatmap */}
      <ChartCard
        detailId="coverHeatmap"
        title={LABELS.coverHeatmap.label}
        subtitle="Click any cell to inspect that location's inventory filtered by category and status"
        helpKey="coverHeatmap"
        className="xl:col-span-3"
        isEmpty={report.branches.length === 0}
        tableData={{
          headers: ["Location", ...report.categories],
          rows: report.branches.map((b) => [
            b.name,
            ...report.categories.map((cat) => {
              const cell = report.coverGrid.find(
                (item) => item.branchId === b.id && item.category === cat,
              );
              return formatCoverCell(cell?.coverDays ?? null);
            }),
          ]),
        }}
        actions={
          <div
            className="flex flex-wrap items-center gap-1.5 text-[11px]"
            aria-label="Days of stock left legend"
          >
            <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-risk-bg px-2 py-0.5 font-medium text-risk-text ring-1 ring-inset ring-risk-ring">
              &lt;14d At risk
            </span>
            <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-gain-bg px-2 py-0.5 font-medium text-gain-text ring-1 ring-inset ring-gain-ring">
              14–30d Healthy
            </span>
            <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-warn-bg px-2 py-0.5 font-medium text-warn-text ring-1 ring-inset ring-warn-ring">
              31–60d Elevated
            </span>
            <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-indigo-bg px-2 py-0.5 font-medium text-indigo-text ring-1 ring-inset ring-indigo-ring">
              &gt;60d Overstock
            </span>
          </div>
        }
      >
        <div className="overflow-x-auto pb-1">
          <Heatmap report={report} />
        </div>
      </ChartCard>
    </section>
  );
}

type CoverBand = {
  label: string;
  statusParam: PositionStatus | null;
  cellClass: string;
};

function classifyCoverBand(coverDays: number | null | undefined): CoverBand {
  if (
    coverDays === null ||
    coverDays === undefined ||
    !Number.isFinite(coverDays) ||
    coverDays >= 9999
  ) {
    return {
      label: "No demand (zero velocity SKU in category)",
      statusParam: "NEW",
      cellClass:
        "bg-neutral-bg text-muted-foreground ring-1 ring-inset ring-neutral-ring",
    };
  }
  if (coverDays < 14) {
    return {
      label: "At risk (below 14-day target)",
      statusParam: "AT_RISK",
      cellClass:
        "bg-risk-bg text-risk-text font-semibold ring-1 ring-inset ring-risk-ring",
    };
  }
  if (coverDays <= 30) {
    return {
      label: "Healthy (14–30 days target window)",
      statusParam: "HEALTHY",
      cellClass:
        "bg-gain-bg text-gain-text font-medium ring-1 ring-inset ring-gain-ring",
    };
  }
  if (coverDays <= 60) {
    return {
      label: "Elevated (31–60 days sending branch surplus window)",
      statusParam: "OVERSTOCK",
      cellClass:
        "bg-warn-bg text-warn-text font-medium ring-1 ring-inset ring-warn-ring",
    };
  }
  return {
    label: "Overstock (above 60-day threshold)",
    statusParam: "OVERSTOCK",
    cellClass:
      "bg-indigo-bg text-indigo-text font-semibold ring-1 ring-inset ring-indigo-ring",
  };
}

function Heatmap({ report }: { report: KpiSummary }) {
  return (
    <table className="w-full min-w-[980px] border-separate border-spacing-1.5 text-xs">
      <thead>
        <tr>
          <th className="sticky left-0 z-10 min-w-[140px] bg-card px-2.5 py-2 text-left text-[11px] font-semibold tracking-wider whitespace-nowrap text-muted-foreground uppercase">
            Location
          </th>
          {report.categories.map((category) => (
            <th
              key={category}
              className="min-w-[68px] px-2 py-2 text-center text-[11px] font-semibold tracking-wide whitespace-nowrap text-muted-foreground uppercase"
            >
              {category}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {report.branches.map((branch) => (
          <tr key={branch.id}>
            <th className="sticky left-0 z-10 bg-card px-2.5 py-1 text-left font-medium whitespace-nowrap text-foreground">
              <Link
                to={`/branches/${branch.id}`}
                className="transition-colors hover:text-primary hover:underline"
              >
                {branch.name}
              </Link>
            </th>
            {report.categories.map((category) => {
              const cell = report.coverGrid.find(
                (item) => item.branchId === branch.id && item.category === category,
              );
              const rawDays = cell?.coverDays ?? null;
              const band = classifyCoverBand(rawDays);
              const displayValue = formatCoverCell(rawDays);
              const detailText = `${branch.name} · ${category}: ${formatCover(rawDays)} — ${band.label}`;
              const targetUrl = `/branches/${branch.id}?cat=${encodeURIComponent(category)}${
                band.statusParam ? `&status=${band.statusParam}` : ""
              }`;

              return (
                <td key={category} className="p-0">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Link
                          to={targetUrl}
                          aria-label={detailText}
                          className={cn(
                            "flex h-9 min-w-[56px] items-center justify-center rounded-lg px-2 text-center text-xs tabular-nums transition-transform duration-100 hover:scale-[1.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
                            band.cellClass,
                          )}
                        >
                          {displayValue}
                        </Link>
                      }
                    />
                    <TooltipContent side="top" className="max-w-xs">
                      <p className="font-semibold">
                        {branch.name} · {category}
                      </p>
                      <p className="mt-0.5 text-[11px] opacity-90">
                        {LABELS.coverDays.label}: {formatCover(rawDays)} ({band.label})
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function mixOf(rows: readonly Recommendation[]) {
  return (["TRANSFER", "REORDER", "MARKDOWN"] as const).map((action) => {
    const matching = rows.filter((row) => row.action === action);
    const cfg = ACTION_CONFIG[action];
    return {
      action,
      name: cfg.label,
      symbol: cfg.symbol,
      count: matching.length,
      value: matching.reduce((sum, row) => sum + row.netBenefit, 0),
      color: cfg.color,
      dotClass: cfg.dotClass,
    };
  });
}

function topSkus(rows: readonly Recommendation[], limit: number) {
  const totals = new Map<
    string,
    { sku: string; name: string; netBenefit: number; count: number; units: number }
  >();
  for (const row of rows) {
    const current = totals.get(row.sku) ?? {
      sku: row.sku,
      name: formatProductDisplayName(row.productName, row.sku),
      netBenefit: 0,
      count: 0,
      units: 0,
    };
    current.netBenefit += row.netBenefit;
    current.count += 1;
    current.units += row.quantity;
    totals.set(row.sku, current);
  }
  return [...totals.values()]
    .sort((left, right) => right.netBenefit - left.netBenefit || left.sku.localeCompare(right.sku))
    .slice(0, limit);
}

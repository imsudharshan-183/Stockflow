import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartCard } from "@/components/shared/ChartCard";
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
  formatProductDisplayName,
  type Action,
  type KpiSummary,
  type PositionStatus,
  type Recommendation,
} from "@stockflow/core";

const ACTION_CONFIG: Record<
  Action,
  { label: string; color: string; dotClass: string }
> = {
  TRANSFER: {
    label: "Transfer",
    color: TOKENS.chart.transfer,
    dotClass: "bg-primary",
  },
  REORDER: {
    label: "Reorder",
    color: TOKENS.chart.reorder,
    dotClass: "bg-info",
  },
  MARKDOWN: {
    label: "Markdown",
    color: TOKENS.chart.markdown,
    dotClass: "bg-warn",
  },
};

export function Analytics({
  report,
  rows,
}: {
  report: KpiSummary;
  rows: readonly Recommendation[];
}) {
  const navigate = useNavigate();
  const [hiddenActions, setHiddenActions] = useState<ReadonlySet<Action>>(new Set());

  const mix = useMemo(() => mixOf(rows), [rows]);
  const visibleMix = useMemo(
    () => mix.filter((m) => !hiddenActions.has(m.action)),
    [mix, hiddenActions],
  );
  const skus = useMemo(() => topSkus(rows), [rows]);
  const branches = useMemo(() => report.branchRisk.slice(0, 5), [report.branchRisk]);

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
      {/* 1. Action Mix */}
      <ChartCard
        title={LABELS.actionMix.label}
        subtitle="Click a slice to filter the Action queue; click legend to toggle"
        helpKey="actionMix"
        isEmpty={rows.length === 0}
        tableData={{
          headers: ["Action", "Count", "Estimated gain"],
          rows: mix.map((m) => [m.name, formatNumber(m.count), formatMoneyFull(m.value)]),
        }}
      >
        <div className="grid items-center gap-3 sm:grid-cols-[124px_1fr]">
          <div className="mx-auto h-32 w-32">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={visibleMix}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={34}
                  outerRadius={52}
                  paddingAngle={2}
                  onClick={(entry: { action?: Action }) => {
                    if (entry?.action) navigate(`/queue?action=${entry.action}`);
                  }}
                  className="cursor-pointer"
                >
                  {visibleMix.map((slice) => (
                    <Cell key={slice.name} fill={slice.color} />
                  ))}
                </Pie>
                <RechartsTooltip formatter={(value) => formatMoneyFull(Number(value))} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <ul className="min-w-0 space-y-1.5 text-xs">
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
                      "h-7 gap-2 px-1.5 text-xs font-medium",
                      hidden ? "opacity-45 line-through" : "",
                    )}
                  >
                    <span className={cn("size-2.5 shrink-0 rounded-full", slice.dotClass)} />
                    <span>{slice.name}</span>
                  </Button>
                  <Link
                    to={`/queue?action=${slice.action}`}
                    className="text-muted-foreground tabular-nums hover:text-primary hover:underline"
                  >
                    <span className="font-medium text-foreground">{formatNumber(slice.count)}</span>{" "}
                    · {formatMoney(slice.value)}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      </ChartCard>

      {/* 2. Top At-Risk Locations */}
      <ChartCard
        title={LABELS.topRiskBranches.label}
        subtitle="Click a bar to open the location dashboard"
        helpKey="topRiskBranches"
        isEmpty={branches.length === 0}
        tableData={{
          headers: ["Location", "Stockout rate", "Sales at risk"],
          rows: branches.map((b) => [
            b.branchName,
            formatPct(b.stockoutRate),
            formatMoneyFull(b.revenueAtRisk),
          ]),
        }}
      >
        <div className="h-44 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={branches} layout="vertical" margin={{ left: 8, right: 12 }}>
              <CartesianGrid stroke={TOKENS.chart.grid} strokeDasharray="3 3" strokeOpacity={0.5} />
              <XAxis
                type="number"
                tickFormatter={(v: number) => formatMoney(v)}
                tick={{ fontSize: 10, fill: TOKENS.chart.axis }}
              />
              <YAxis
                type="category"
                dataKey="branchName"
                width={104}
                tick={{ fontSize: 10, fill: TOKENS.chart.axis }}
              />
              <RechartsTooltip
                cursor={{ fill: TOKENS.chart.grid, opacity: 0.2 }}
                formatter={(value) => [formatMoneyFull(Number(value)), LABELS.lostSalesAtRisk.label]}
              />
              <Bar
                dataKey="revenueAtRisk"
                name={LABELS.lostSalesAtRisk.label}
                fill={TOKENS.status.risk}
                radius={[0, 4, 4, 0]}
                className="cursor-pointer"
                onClick={(entry: { branchId?: string }) => {
                  if (entry?.branchId) navigate(`/branches/${entry.branchId}`);
                }}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </ChartCard>

      {/* 3. Top SKUs by Estimated Gain */}
      <ChartCard
        title={LABELS.topSkus.label}
        subtitle="Click a bar to open the product detail page"
        helpKey="topSkus"
        isEmpty={skus.length === 0}
        tableData={{
          headers: ["SKU", "Product", "Estimated gain"],
          rows: skus.map((s) => [s.sku, s.name, formatMoneyFull(s.netBenefit)]),
        }}
      >
        <div className="h-44 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={skus} layout="vertical" margin={{ left: 8, right: 12 }}>
              <CartesianGrid stroke={TOKENS.chart.grid} strokeDasharray="3 3" strokeOpacity={0.5} />
              <XAxis
                type="number"
                tickFormatter={(v: number) => formatMoney(v)}
                tick={{ fontSize: 10, fill: TOKENS.chart.axis }}
              />
              <YAxis
                type="category"
                dataKey="sku"
                width={84}
                tick={{ fontSize: 10, fill: TOKENS.chart.axis }}
              />
              <RechartsTooltip
                cursor={{ fill: TOKENS.chart.grid, opacity: 0.2 }}
                formatter={(value) => [formatMoneyFull(Number(value)), LABELS.netBenefit.label]}
                labelFormatter={(label) => {
                  const found = skus.find((s) => s.sku === String(label));
                  return found ? formatProductDisplayName(found.sku, found.name) : String(label);
                }}
              />
              <Bar
                dataKey="netBenefit"
                name={LABELS.netBenefit.label}
                fill={TOKENS.chart.transfer}
                radius={[0, 4, 4, 0]}
                className="cursor-pointer"
                onClick={(entry: { sku?: string }) => {
                  if (entry?.sku) navigate(`/products/${entry.sku}`);
                }}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </ChartCard>

      {/* 4. Semantic 4-Band Stock Cover Heatmap */}
      <ChartCard
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
            <span className="inline-flex items-center gap-1 rounded-md bg-risk-bg px-2 py-0.5 font-medium text-risk-text ring-1 ring-inset ring-risk-ring">
              &lt;14d At risk
            </span>
            <span className="inline-flex items-center gap-1 rounded-md bg-gain-bg px-2 py-0.5 font-medium text-gain-text ring-1 ring-inset ring-gain-ring">
              14–30d Healthy
            </span>
            <span className="inline-flex items-center gap-1 rounded-md bg-warn-bg px-2 py-0.5 font-medium text-warn-text ring-1 ring-inset ring-warn-ring">
              31–60d Elevated
            </span>
            <span className="inline-flex items-center gap-1 rounded-md bg-indigo-bg px-2 py-0.5 font-medium text-indigo-text ring-1 ring-inset ring-indigo-ring">
              &gt;60d Overstock
            </span>
          </div>
        }
      >
        <div className="overflow-x-auto">
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
      label: "Elevated (31–60 days donor surplus window)",
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
    <table className="w-full min-w-[780px] border-separate border-spacing-1.5 text-xs">
      <thead>
        <tr>
          <th className="sticky left-0 z-10 bg-card px-2.5 py-1.5 text-left text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
            Location
          </th>
          {report.categories.map((category) => (
            <th
              key={category}
              className="px-1.5 py-1.5 text-center text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
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
                            "flex h-9 min-w-[52px] items-center justify-center rounded-lg px-2 text-center text-xs tabular-nums transition-transform duration-100 hover:scale-[1.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
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
      count: matching.length,
      value: matching.reduce((sum, row) => sum + row.netBenefit, 0),
      color: cfg.color,
      dotClass: cfg.dotClass,
    };
  });
}

function topSkus(rows: readonly Recommendation[]) {
  const totals = new Map<string, { sku: string; name: string; netBenefit: number }>();
  for (const row of rows) {
    const current = totals.get(row.sku) ?? {
      sku: row.sku,
      name: row.productName,
      netBenefit: 0,
    };
    current.netBenefit += row.netBenefit;
    totals.set(row.sku, current);
  }
  return [...totals.values()]
    .sort((left, right) => right.netBenefit - left.netBenefit)
    .slice(0, 5);
}

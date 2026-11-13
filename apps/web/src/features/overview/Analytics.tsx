import { Link } from "react-router-dom";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip as RechartsTooltip } from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  formatCover,
  formatCoverCell,
  formatMoney,
  formatMoneyFull,
  formatNumber,
  formatPct,
} from "@/lib/format";
import { TOKENS } from "@/lib/tokens";
import { cn } from "@/lib/utils";
import type { Action, KpiSummary, Recommendation } from "@stockflow/core";

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
  const mix = mixOf(rows);
  const skus = topSkus(rows);
  const branches = report.branchRisk.slice(0, 5);

  return (
    <section className="grid gap-6 xl:grid-cols-3">
      {/* 1. Action Mix */}
      <Card className="rounded-2xl border border-border shadow-card">
        <CardHeader>
          <CardTitle>Action mix</CardTitle>
          <CardDescription>Count and projected value by action type</CardDescription>
        </CardHeader>
        <CardContent className="grid items-center gap-4 sm:grid-cols-[150px_1fr]">
          <div className="h-40">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={mix}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={42}
                  outerRadius={64}
                  paddingAngle={2}
                >
                  {mix.map((slice) => (
                    <Cell key={slice.name} fill={slice.color} />
                  ))}
                </Pie>
                <RechartsTooltip
                  formatter={(value) => formatMoneyFull(Number(value))}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <ul className="space-y-2.5 text-xs">
            {mix.map((slice) => (
              <li key={slice.name} className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 font-medium text-foreground">
                  <span className={cn("size-2.5 rounded-full", slice.dotClass)} />
                  {slice.name}
                </span>
                <span className="text-muted-foreground tabular-nums">
                  <span className="font-medium text-foreground">
                    {formatNumber(slice.count)}
                  </span>{" "}
                  · {formatMoney(slice.value)}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {/* 2. Top At-Risk Branches */}
      <Card className="rounded-2xl border border-border shadow-card">
        <CardHeader>
          <CardTitle>Top at-risk branches</CardTitle>
          <CardDescription>Highest stockout exposure and revenue at risk</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-divider-soft text-xs">
            {branches.map((branch) => (
              <li
                key={branch.branchId}
                className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
              >
                <Link
                  to={`/branches/${branch.branchId}`}
                  className="truncate font-medium text-foreground transition-colors hover:text-primary hover:underline"
                >
                  {branch.branchName}
                </Link>
                <span className="shrink-0 text-muted-foreground tabular-nums">
                  <span className="font-medium text-risk-text">
                    {formatPct(branch.stockoutRate)}
                  </span>{" "}
                  · {formatMoney(branch.revenueAtRisk)}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {/* 3. Top SKUs by Net Benefit */}
      <Card className="rounded-2xl border border-border shadow-card">
        <CardHeader>
          <CardTitle>Top SKUs by net benefit</CardTitle>
          <CardDescription>Highest total value across pending actions</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-divider-soft text-xs">
            {skus.map((sku) => (
              <li
                key={sku.sku}
                className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <Link
                    to={`/products/${sku.sku}`}
                    className="block truncate font-medium text-foreground transition-colors hover:text-primary hover:underline"
                  >
                    {sku.name}
                  </Link>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {sku.sku}
                  </span>
                </div>
                <span className="shrink-0 font-semibold text-foreground tabular-nums">
                  {formatMoneyFull(sku.netBenefit)}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {/* 4. Semantic 4-Band Cover Days Heatmap */}
      <Card className="rounded-2xl border border-border shadow-card xl:col-span-3">
        <CardHeader className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
          <div>
            <CardTitle>Cover days by branch and category</CardTitle>
            <CardDescription>
              Average days of supply on hand relative to policy thresholds (14d receiver target, 30d donor floor, 60d overstock cap)
            </CardDescription>
          </div>

          {/* Semantic Legend */}
          <div
            className="flex flex-wrap items-center gap-2 text-[11px]"
            aria-label="Cover days color legend"
          >
            <span className="inline-flex items-center gap-1.5 rounded-md bg-risk-bg px-2 py-0.5 font-medium text-risk-text ring-1 ring-inset ring-risk-ring">
              <span className="size-1.5 rounded-full bg-risk" />
              &lt;14d At risk
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-md bg-gain-bg px-2 py-0.5 font-medium text-gain-text ring-1 ring-inset ring-gain-ring">
              <span className="size-1.5 rounded-full bg-gain" />
              14–30d Healthy
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-md bg-warn-bg px-2 py-0.5 font-medium text-warn-text ring-1 ring-inset ring-warn-ring">
              <span className="size-1.5 rounded-full bg-warn" />
              31–60d Elevated
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-md bg-indigo-bg px-2 py-0.5 font-medium text-indigo-text ring-1 ring-inset ring-indigo-ring">
              <span className="size-1.5 rounded-full bg-primary" />
              &gt;60d Overstock
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-md bg-neutral-bg px-2 py-0.5 font-medium text-muted-foreground ring-1 ring-inset ring-neutral-ring">
              — No demand
            </span>
          </div>
        </CardHeader>

        <CardContent className="overflow-x-auto">
          <Heatmap report={report} />
        </CardContent>
      </Card>
    </section>
  );
}

type CoverBand = {
  label: string;
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
      cellClass:
        "bg-neutral-bg text-muted-foreground ring-1 ring-inset ring-neutral-ring",
    };
  }
  if (coverDays < 14) {
    return {
      label: "At risk (below 14-day target)",
      cellClass:
        "bg-risk-bg text-risk-text font-semibold ring-1 ring-inset ring-risk-ring",
    };
  }
  if (coverDays <= 30) {
    return {
      label: "Healthy (14–30 days target window)",
      cellClass:
        "bg-gain-bg text-gain-text font-medium ring-1 ring-inset ring-gain-ring",
    };
  }
  if (coverDays <= 60) {
    return {
      label: "Elevated (31–60 days donor surplus window)",
      cellClass:
        "bg-warn-bg text-warn-text font-medium ring-1 ring-inset ring-warn-ring",
    };
  }
  return {
    label: "Overstock (above 60-day threshold)",
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
            Branch
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

              return (
                <td key={category} className="p-0">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <div
                          tabIndex={0}
                          aria-label={detailText}
                          className={cn(
                            "flex h-9 min-w-[52px] items-center justify-center rounded-lg px-2 text-center text-xs tabular-nums transition-transform duration-100 hover:scale-[1.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
                            band.cellClass,
                          )}
                        >
                          {displayValue}
                        </div>
                      }
                    />
                    <TooltipContent side="top" className="max-w-xs">
                      <p className="font-semibold">
                        {branch.name} · {category}
                      </p>
                      <p className="mt-0.5 text-[11px] opacity-90">
                        Cover: {formatCover(rawDays)} ({band.label})
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

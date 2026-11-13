import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCover, formatMoney, formatNumber, formatPct } from "@/lib/format";
import type { KpiSummary, Recommendation } from "@stockflow/core";

const ACTION_COLOR = { TRANSFER: "#7C3AED", REORDER: "#3B82F6", MARKDOWN: "#D97706" } as const;

export function Analytics({ report, rows }: { report: KpiSummary; rows: Recommendation[] }) {
  const mix = mixOf(rows);
  const skus = topSkus(rows);
  const branches = report.branchRisk.slice(0, 5);
  return (
    <section className="grid gap-6 xl:grid-cols-2">
      <Card className="rounded-xl shadow-card">
        <CardHeader>
          <CardTitle>Action mix</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-[180px_1fr]">
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={mix} dataKey="value" nameKey="name" innerRadius={48} outerRadius={70}>
                  {mix.map((slice) => (
                    <Cell key={slice.name} fill={slice.color} />
                  ))}
                </Pie>
                <Tooltip formatter={(value) => formatMoney(Number(value))} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <ul className="space-y-2 text-sm">
            {mix.map((slice) => (
              <li key={slice.name} className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2">
                  <span className="size-2 rounded-full" style={{ background: slice.color }} />
                  {slice.name}
                </span>
                <span>
                  {formatNumber(slice.count)} · {formatMoney(slice.value)}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <Card className="rounded-xl shadow-card">
        <CardHeader>
          <CardTitle>Top at-risk branches</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm">
            {branches.map((branch) => (
              <li key={branch.branchId} className="flex items-center justify-between gap-3">
                <span>{branch.branchName}</span>
                <span className="text-muted-foreground">
                  {formatPct(branch.stockoutRate)} · {formatMoney(branch.revenueAtRisk)}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <Card className="rounded-xl shadow-card">
        <CardHeader>
          <CardTitle>Top SKUs by net benefit</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm">
            {skus.map((sku) => (
              <li key={sku.sku} className="flex items-center justify-between gap-3">
                <span>
                  {sku.name}
                  <span className="ml-2 text-xs text-muted-foreground">{sku.sku}</span>
                </span>
                <span>{formatMoney(sku.netBenefit)}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <Card className="rounded-xl shadow-card xl:col-span-2">
        <CardHeader>
          <CardTitle>Cover days by branch and category</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Heatmap report={report} />
        </CardContent>
      </Card>
    </section>
  );
}

function Heatmap({ report }: { report: KpiSummary }) {
  return (
    <table className="min-w-full border-separate border-spacing-1 text-[11px]">
      <thead>
        <tr>
          <th className="sticky left-0 bg-card px-2 text-left">Branch</th>
          {report.categories.map((category) => (
            <th key={category} className="px-1 font-medium text-muted-foreground">
              {category}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {report.branches.map((branch) => (
          <tr key={branch.id}>
            <th className="sticky left-0 bg-card px-2 text-left font-medium">{branch.name}</th>
            {report.categories.map((category) => {
              const cell = report.coverGrid.find((item) => item.branchId === branch.id && item.category === category);
              return (
                <td
                  key={category}
                  className="rounded px-1 py-1 text-center"
                  style={{ background: heatColor(cell?.coverDays ?? null) }}
                  title={cell?.coverDays === null || cell?.coverDays === undefined ? "No demand" : formatCover(cell.coverDays)}
                >
                  {cell?.coverDays === null || cell?.coverDays === undefined ? "—" : Math.round(cell.coverDays)}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function heatColor(coverDays: number | null): string {
  if (coverDays === null) return "#E7E2F8";
  const capped = Math.min(coverDays, 90) / 90;
  const alpha = 0.15 + capped * 0.75;
  return `rgba(109, 91, 208, ${alpha.toFixed(2)})`;
}

function mixOf(rows: Recommendation[]) {
  return (["TRANSFER", "REORDER", "MARKDOWN"] as const).map((action) => {
    const matching = rows.filter((row) => row.action === action);
    return {
      name: action === "TRANSFER" ? "Transfer" : action === "REORDER" ? "Reorder" : "Markdown",
      count: matching.length,
      value: matching.reduce((sum, row) => sum + row.netBenefit, 0),
      color: ACTION_COLOR[action],
    };
  });
}

function topSkus(rows: Recommendation[]) {
  const totals = new Map<string, { sku: string; name: string; netBenefit: number }>();
  for (const row of rows) {
    const current = totals.get(row.sku) ?? { sku: row.sku, name: row.productName, netBenefit: 0 };
    current.netBenefit += row.netBenefit;
    totals.set(row.sku, current);
  }
  return [...totals.values()].sort((left, right) => right.netBenefit - left.netBenefit).slice(0, 5);
}

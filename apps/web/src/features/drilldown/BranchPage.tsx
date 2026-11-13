import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/shared/states";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { queryKeys } from "@/hooks/queryKeys";
import { api } from "@/lib/api";
import { actionLabel, formatDate, formatMoney, formatMoneyFull, formatNumber, formatPct } from "@/lib/format";
import type { BranchTrendPoint } from "@stockflow/core";

export function BranchPage() {
  const { id } = useParams();
  const branch = useQuery({
    queryKey: queryKeys.branch(id ?? ""),
    queryFn: () => api.branch(id ?? ""),
    enabled: Boolean(id),
  });

  if (!id) return <EmptyBlock title="Missing branch" body="Open a branch from the queue." />;
  if (branch.isPending) return <LoadingBlock />;
  if (branch.isError) return <ErrorBlock message={branch.error.message} onRetry={() => void branch.refetch()} />;

  const detail = branch.data;
  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">{detail.branch.region}</p>
        <h1 className="text-2xl font-semibold tracking-tight">{detail.branch.name}</h1>
        <p className="text-sm text-muted-foreground">{detail.branch.city}</p>
      </div>
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Stockout rate" value={formatPct(detail.stockoutRate)} />
        <Stat
          label="Excess inventory value"
          value={formatMoney(detail.cashReleasable)}
          note={`of which dead stock ${formatMoney(detail.deadStockValue)}`}
        />
        <Stat label="Revenue at risk" value={formatMoney(detail.lostSalesAtRisk)} />
        <Stat label="Inventory value" value={formatMoney(detail.inventoryValue)} />
      </section>
      <Card>
        <CardHeader>
          <CardTitle>Sales and stock</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={detail.trend}>
                <CartesianGrid strokeDasharray="3 3" stroke="#94a3b8" strokeOpacity={0.4} />
                <XAxis dataKey="date" tickFormatter={formatDate} minTickGap={28} tick={{ fontSize: 12 }} />
                <YAxis yAxisId="sales" tick={{ fontSize: 12 }} width={48} />
                <YAxis yAxisId="stock" orientation="right" tick={{ fontSize: 12 }} width={56} />
                <Tooltip content={<BranchTip />} />
                <Legend />
                <Line yAxisId="sales" type="monotone" dataKey="salesUnits" name="Sales units" stroke="#b45309" dot={false} strokeWidth={2} />
                <Line yAxisId="stock" type="monotone" dataKey="onHandUnits" name="On hand" stroke="#0f766e" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Actions touching this branch</h2>
          <Link className="text-sm text-primary hover:underline" to={`/queue?branch=${detail.branch.id}`}>
            Filter the queue
          </Link>
        </div>
        {detail.recommendations.length === 0 ? (
          <EmptyBlock title="No actions" body="This branch has no transfer, reorder, or markdown today." />
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-muted/60 text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Action</th>
                  <th className="px-3 py-2 font-medium">SKU</th>
                  <th className="px-3 py-2 font-medium">Role</th>
                  <th className="px-3 py-2 text-right font-medium">Net benefit</th>
                </tr>
              </thead>
              <tbody>
                {detail.recommendations.slice(0, 12).map((recommendation) => (
                  <tr key={recommendation.id} className="border-t">
                    <td className="px-3 py-2">
                      <Badge tone={recommendation.action === "TRANSFER" ? "transfer" : recommendation.action === "REORDER" ? "reorder" : "markdown"}>
                        {actionLabel(recommendation.action)} {formatNumber(recommendation.quantity)}
                      </Badge>
                    </td>
                    <td className="px-3 py-2">
                      <Link className="hover:underline" to={`/products/${recommendation.sku}`}>
                        {recommendation.productName}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {recommendation.branchId === detail.branch.id
                        ? recommendation.donorBranchName
                          ? `Receive from ${recommendation.donorBranchName}`
                          : "This branch"
                        : `Send to ${recommendation.branchName}`}
                    </td>
                    <td className="px-3 py-2 text-right">{formatMoneyFull(recommendation.netBenefit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <Card className="rounded-xl transition duration-150 hover:-translate-y-0.5">
      <CardHeader>
        <CardTitle>{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-semibold">{value}</p>
        {note ? <p className="mt-1 text-xs text-muted-foreground">{note}</p> : null}
      </CardContent>
    </Card>
  );
}

function BranchTip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: BranchTrendPoint }>;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <div className="rounded-md border bg-card px-3 py-2 text-xs shadow-sm">
      <p className="font-medium">{formatDate(point.date)}</p>
      <p>Sales {formatNumber(point.salesUnits)} units ({formatMoneyFull(point.salesValue)})</p>
      <p>On hand {formatNumber(point.onHandUnits)}</p>
      <p>Stockout rate {formatPct(point.stockoutRate)}</p>
    </div>
  );
}

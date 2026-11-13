import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Filter } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/shared/states";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCard,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableToolbar,
} from "@/components/ui/table";
import {
  Tooltip as UiTooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { queryKeys } from "@/hooks/queryKeys";
import { api } from "@/lib/api";
import {
  actionLabel,
  formatDate,
  formatMoney,
  formatMoneyFull,
  formatNumber,
  formatPct,
  statusLabel,
} from "@/lib/format";
import { TOKENS } from "@/lib/tokens";
import { cn } from "@/lib/utils";
import { formatProductDisplayName, type BranchTrendPoint } from "@stockflow/core";

export function BranchPage() {
  const { id } = useParams();
  const branch = useQuery({
    queryKey: queryKeys.branch(id ?? ""),
    queryFn: () => api.branch(id ?? ""),
    enabled: Boolean(id),
  });

  if (!id) return <EmptyBlock title="Missing branch" body="Open a branch from the queue." />;
  if (branch.isPending) return <LoadingBlock />;
  if (branch.isError) {
    return <ErrorBlock message={branch.error.message} onRetry={() => void branch.refetch()} />;
  }

  const detail = branch.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title={detail.branch.name}
        subtitle={`${detail.branch.id} · ${detail.branch.city} · ${detail.branch.region} region`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to="/queue"
              className={cn(buttonVariants({ variant: "secondary", size: "sm" }))}
            >
              <ArrowLeft className="size-3.5" aria-hidden="true" />
              Back to queue
            </Link>
            <Link
              to={`/queue?branch=${detail.branch.id}`}
              className={cn(buttonVariants({ variant: "primary", size: "sm" }))}
            >
              <Filter className="size-3.5" aria-hidden="true" />
              Filter queue for branch
            </Link>
          </div>
        }
      />

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Stockout rate" value={formatPct(detail.stockoutRate)} />
        <Stat
          label="Excess inventory value"
          value={formatMoney(detail.cashReleasable)}
          note={`Includes ${formatMoney(detail.deadStockValue)} dead stock`}
        />
        <Stat label="Revenue at risk" value={formatMoney(detail.lostSalesAtRisk)} />
        <Stat label="Inventory value" value={formatMoney(detail.inventoryValue)} />
      </section>

      <Card className="rounded-2xl border border-border shadow-card">
        <CardHeader>
          <CardTitle>Sales and on-hand stock</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={detail.trend}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke={TOKENS.chart.grid}
                  strokeOpacity={0.6}
                />
                <XAxis
                  dataKey="date"
                  tickFormatter={formatDate}
                  minTickGap={28}
                  tick={{ fontSize: 11, fill: TOKENS.chart.axis }}
                />
                <YAxis
                  yAxisId="sales"
                  tick={{ fontSize: 11, fill: TOKENS.chart.axis }}
                  width={48}
                />
                <YAxis
                  yAxisId="stock"
                  orientation="right"
                  tick={{ fontSize: 11, fill: TOKENS.chart.axis }}
                  width={56}
                />
                <Tooltip content={<BranchTip />} />
                <Legend />
                <Line
                  yAxisId="sales"
                  type="monotone"
                  dataKey="salesUnits"
                  name="Sales units"
                  stroke={TOKENS.chart.markdown}
                  dot={false}
                  strokeWidth={2}
                />
                <Line
                  yAxisId="stock"
                  type="monotone"
                  dataKey="onHandUnits"
                  name="On hand"
                  stroke={TOKENS.chart.inventoryValue}
                  dot={false}
                  strokeWidth={2}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <TableCard>
        <TableToolbar>
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              Actions touching this branch
            </h2>
            <p className="text-xs text-muted-foreground">
              Showing up to 12 highest-benefit moves involving {detail.branch.name}
            </p>
          </div>
          <Link
            to={`/queue?branch=${detail.branch.id}`}
            className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
          >
            View all {formatNumber(detail.recommendations.length)} in queue
          </Link>
        </TableToolbar>

        {detail.recommendations.length === 0 ? (
          <div className="p-4">
            <EmptyBlock
              title="No actions"
              body="This branch has no transfer, reorder, or markdown today."
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table className="min-w-[680px]">
              <TableHeader>
                <tr className="border-b border-border">
                  <TableHead className="w-[120px]">Action</TableHead>
                  <TableHead className="w-[32%]">Product</TableHead>
                  <TableHead className="w-[28%]">Role</TableHead>
                  <TableHead className="w-[90px] text-right">Qty</TableHead>
                  <TableHead className="w-[110px] text-right">Net benefit</TableHead>
                  <TableHead className="w-[110px]">Status</TableHead>
                </tr>
              </TableHeader>
              <TableBody>
                {detail.recommendations.slice(0, 12).map((recommendation) => (
                  <TableRow key={recommendation.id}>
                    <TableCell>
                      <Badge
                        tone={
                          recommendation.action === "TRANSFER"
                            ? "transfer"
                            : recommendation.action === "REORDER"
                              ? "reorder"
                              : "markdown"
                        }
                      >
                        {actionLabel(recommendation.action)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <UiTooltip>
                        <TooltipTrigger
                          render={
                            <Link
                              className="block truncate font-semibold text-foreground hover:text-primary hover:underline"
                              to={`/products/${recommendation.sku}`}
                            >
                              {formatProductDisplayName(recommendation.productName, recommendation.sku)}
                            </Link>
                          }
                        />
                        <TooltipContent side="top">
                          {formatProductDisplayName(recommendation.productName, recommendation.sku)}
                        </TooltipContent>
                      </UiTooltip>
                      <span className="font-mono text-xs text-muted-foreground">
                        {recommendation.sku}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {recommendation.branchId === detail.branch.id
                        ? recommendation.donorBranchName
                          ? `Receive from ${recommendation.donorBranchName}`
                          : "Direct replenishment / clearance"
                        : `Send to ${recommendation.branchName}`}
                    </TableCell>
                    <TableCell className="text-right font-medium text-foreground tabular-nums">
                      {formatNumber(recommendation.quantity)}
                    </TableCell>
                    <TableCell className="text-right font-semibold text-foreground tabular-nums">
                      {formatMoneyFull(recommendation.netBenefit)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        tone={
                          recommendation.status === "APPROVED"
                            ? "approved"
                            : recommendation.status === "REJECTED"
                              ? "rejected"
                              : "pending"
                        }
                        dot
                      >
                        {statusLabel(recommendation.status)}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </TableCard>
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <Card className="rounded-2xl border border-border shadow-card transition duration-150 hover:-translate-y-0.5">
      <CardHeader className="pb-1">
        <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-semibold text-foreground tabular-nums">{value}</p>
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
    <div className="rounded-xl border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-card tabular-nums">
      <p className="font-semibold">{formatDate(point.date)}</p>
      <p className="mt-0.5">
        Sales: {formatNumber(point.salesUnits)} units ({formatMoneyFull(point.salesValue)})
      </p>
      <p>On hand: {formatNumber(point.onHandUnits)} units</p>
      <p>Stockout rate: {formatPct(point.stockoutRate)}</p>
    </div>
  );
}

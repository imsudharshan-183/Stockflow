import {
  formatProductDisplayName,
  type Policy,
  type PositionView,
  type SeriesPoint,
} from "@stockflow/core";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { pickChartPoint, useChartDetail } from "@/components/shared/ChartDetailPopup";
import { PageHeader } from "@/components/shared/PageHeader";
import { StockDeltaBadges } from "@/components/shared/StockDeltaBadges";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/shared/states";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
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
import { queryKeys } from "@/hooks/queryKeys";
import { useAuth } from "@/features/auth/AuthContext";
import { api } from "@/lib/api";
import {
  actionLabel,
  formatCover,
  formatDate,
  formatMoneyFull,
  formatNumber,
  formatReasonSentence,
  statusLabel,
} from "@/lib/format";
import { TOKENS } from "@/lib/tokens";
import { cn } from "@/lib/utils";

const STATUS_ORDER = { AT_RISK: 0, OVERSTOCK: 1, HEALTHY: 2, NEW: 3 } as const;

export function ProductPage() {
  const { sku } = useParams();
  const product = useQuery({
    queryKey: queryKeys.product(sku ?? ""),
    queryFn: () => api.product(sku ?? ""),
    enabled: Boolean(sku),
  });
  const [picked, setPicked] = useState<string | null>(null);

  if (!sku) return <EmptyBlock title="Missing SKU" body="Open a product from the queue." />;
  if (product.isPending) return <LoadingBlock />;
  if (product.isError) {
    return <ErrorBlock message={product.error.message} onRetry={() => void product.refetch()} />;
  }

  const detail = product.data;
  const positions = [...detail.positions].sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.lostUnits - a.lostUnits,
  );
  const selectedId =
    picked ??
    positions.find((position) => position.recommendation)?.branch.id ??
    positions[0]?.branch.id ??
    "";
  const position = positions.find((item) => item.branch.id === selectedId) ?? null;
  const series = detail.series.find((item) => item.branchId === selectedId);

  return (
    <div className="space-y-6">
      <PageHeader
        title={formatProductDisplayName(detail.product.name, detail.product.sku)}
        subtitle={`${detail.product.sku} · ${detail.product.category} · Retail ${formatMoneyFull(detail.product.price)} · Cost ${formatMoneyFull(detail.product.cost)} · Lead time ${formatNumber(detail.product.leadTimeDays)} days`}
        actions={
          <Link
            to="/queue"
            className={cn(buttonVariants({ variant: "secondary", size: "sm" }))}
          >
            <ArrowLeft className="size-3.5" aria-hidden="true" />
            Back to queue
          </Link>
        }
      />

      {position && series ? (
        <Logic
          position={position}
          points={series.points}
          policy={detail.policy}
          onBranch={(id) => setPicked(id)}
          branches={positions}
        />
      ) : (
        <EmptyBlock title="No branches" body="This SKU has no stock positions." />
      )}

      <TableCard>
        <TableToolbar>
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              Network positions across branches
            </h2>
            <p className="text-xs text-muted-foreground">
              Select a branch row to inspect its 90-day demand, stock, and cover charts above
            </p>
          </div>
        </TableToolbar>

        <div className="overflow-x-auto">
          <Table className="min-w-[860px] table-auto">
            <TableHeader>
              <tr className="border-b border-border">
                <TableHead className="w-[22%]">Branch</TableHead>
                <TableHead className="w-[110px]">Health</TableHead>
                <TableHead className="w-[100px] text-right">On hand</TableHead>
                <TableHead className="w-[160px] whitespace-nowrap">In transit / Reserved</TableHead>
                <TableHead className="w-[110px] text-right">Cover</TableHead>
                <TableHead className="w-[120px] text-right">Reorder level</TableHead>
                <TableHead className="w-auto">Recommended action</TableHead>
              </tr>
            </TableHeader>
            <TableBody>
              {positions.map((item) => {
                const isPicked = item.branch.id === selectedId;
                return (
                  <TableRow
                    key={item.branch.id}
                    data-state={isPicked ? "selected" : undefined}
                    onClick={() => setPicked(item.branch.id)}
                    className="cursor-pointer"
                  >
                    <TableCell>
                      <Button
                        variant="link"
                        size="sm"
                        onClick={(event) => {
                          event.stopPropagation();
                          setPicked(item.branch.id);
                        }}
                        className="h-auto p-0 font-semibold text-foreground hover:text-primary"
                      >
                        {item.branch.name}
                      </Button>
                      <div className="text-xs text-muted-foreground">{item.branch.id}</div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        tone={
                          item.status === "AT_RISK"
                            ? "risk"
                            : item.status === "OVERSTOCK"
                              ? "over"
                              : item.status === "HEALTHY"
                                ? "ok"
                                : "fresh"
                        }
                        dot
                      >
                        {item.status === "AT_RISK"
                          ? "At risk"
                          : item.status === "OVERSTOCK"
                            ? "Overstock"
                            : item.status === "HEALTHY"
                              ? "Healthy"
                              : "New"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-medium text-foreground tabular-nums">
                      {formatNumber(item.onHand)}
                    </TableCell>
                    <TableCell>
                      <StockDeltaBadges inTransit={item.inTransit} reserved={item.reserved} />
                    </TableCell>
                    <TableCell className="text-right text-foreground tabular-nums">
                      {formatCover(item.coverDays)}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground tabular-nums">
                      {formatNumber(item.reorderPoint)}
                    </TableCell>
                    <TableCell onClick={(event) => event.stopPropagation()}>
                      {item.recommendation ? (
                        <Link
                          className="inline-flex items-center gap-2 font-medium text-primary hover:underline"
                          to={`/queue?branch=${item.branch.id}`}
                        >
                          <Badge
                            tone={
                              item.recommendation.action === "TRANSFER"
                                ? "transfer"
                                : item.recommendation.action === "REORDER"
                                  ? "reorder"
                                  : "markdown"
                            }
                          >
                            {actionLabel(item.recommendation.action)}
                          </Badge>
                          <span className="tabular-nums">
                            {formatNumber(item.recommendation.quantity)} units (
                            {formatMoneyFull(item.recommendation.netBenefit)})
                          </span>
                        </Link>
                      ) : (
                        <span className="text-xs text-muted-foreground">None</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </TableCard>
    </div>
  );
}

function Logic({
  position,
  points,
  policy,
  branches,
  onBranch,
}: {
  position: PositionView;
  points: SeriesPoint[];
  policy: Policy;
  branches: PositionView[];
  onBranch: (id: string) => void;
}) {
  const { user } = useAuth();
  const { showDetail } = useChartDetail();
  const isBranchAllowed = !user || user.role === "admin" || user.branchIds.includes(position.branch.id);

  const salesRows = points.map((point) => ({
    date: point.date,
    sales: point.salesUnits,
    stock: point.onHand,
  }));
  const coverRows = points.map((point) => ({
    date: point.date,
    cover: position.velocity > 0 ? point.onHand / position.velocity : null,
  }));

  return (
    <div className="grid gap-5 lg:grid-cols-[310px_1fr]">
      <Card className="rounded-2xl border border-border shadow-card">
        <CardHeader>
          <CardTitle>Branch position details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <label className="block text-xs font-medium text-muted-foreground">
            Inspect branch
            <select
              className="mt-1.5 h-9 w-full rounded-xl border border-border bg-card px-3 text-xs font-medium text-foreground shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              value={position.branch.id}
              onChange={(event) => onBranch(event.target.value)}
            >
              {branches.map((item) => (
                <option key={item.branch.id} value={item.branch.id}>
                  {item.branch.name}
                </option>
              ))}
            </select>
          </label>

          <div>
            {isBranchAllowed && user?.role !== "staff" ? (
              <Link
                className="text-sm font-semibold text-primary hover:underline"
                to={`/branches/${position.branch.id}`}
              >
                Open {position.branch.name} branch page →
              </Link>
            ) : isBranchAllowed ? null : (
              <span className="text-xs text-muted-foreground">
                {position.branch.name} is outside your branch scope
              </span>
            )}
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground">
            Safety stock is {policy.serviceZ} × demand standard deviation × √lead time. Reorder
            point is daily demand × lead time + safety stock. At risk means on hand is below that
            point. Overstock means cover is above {policy.overstockCoverDays} days.
          </p>

          <dl className="grid grid-cols-2 gap-2.5 rounded-xl border border-border bg-secondary/30 p-3">
            <Mini label="On hand" value={`${formatNumber(position.onHand)} units`} />
            <Mini label="In transit" value={`${formatNumber(position.inTransit ?? 0)} units`} />
            <Mini label="Reserved" value={`${formatNumber(position.reserved ?? 0)} units`} />
            <Mini label="Daily demand" value={`${formatNumber(position.velocity)} / day`} />
            <Mini label="Std. dev." value={formatNumber(position.sigmaDemand)} />
            <Mini label="Lead time" value={`${formatNumber(position.leadTimeDays)} days`} />
            <Mini label="Safety stock" value={`${formatNumber(position.safetyStock)} units`} />
            <Mini label="Reorder level" value={`${formatNumber(position.reorderPoint)} units`} />
            <Mini label="Cover" value={formatCover(position.coverDays)} />
            <Mini label="In-stock days" value={formatNumber(position.inStockDays)} />
          </dl>

          {position.recommendation ? (
            <div className="rounded-xl border border-primary-ring bg-primary-soft p-3 text-xs">
              <div className="flex items-center justify-between gap-2">
                <Badge
                  tone={
                    position.recommendation.action === "TRANSFER"
                      ? "transfer"
                      : position.recommendation.action === "REORDER"
                        ? "reorder"
                        : "markdown"
                  }
                >
                  {actionLabel(position.recommendation.action)}{" "}
                  {formatNumber(position.recommendation.quantity)}
                </Badge>
                <Badge
                  tone={
                    position.recommendation.status === "APPROVED"
                      ? "approved"
                      : position.recommendation.status === "REJECTED"
                        ? "rejected"
                        : "pending"
                  }
                  dot
                >
                  {statusLabel(position.recommendation.status)}
                </Badge>
              </div>
              <p className="mt-2 leading-relaxed text-foreground">
                {formatReasonSentence(position.recommendation.reason)}
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No action for this branch today.</p>
          )}
        </CardContent>
      </Card>

      <div className="space-y-5">
        <Card className="rounded-2xl border border-border shadow-card">
          <CardHeader>
            <CardTitle>Sales and stock</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={salesRows}
                  className="cursor-pointer"
                  onClick={(state, event) => {
                    const row = pickChartPoint<{ date: string; sales: number; stock: number }>(
                      state,
                      event,
                    );
                    if (!row) return;
                    const delta = row.stock - position.reorderPoint;
                    showDetail({
                      title: `Sales & stock · ${position.branch.name}`,
                      subtitle: formatDate(row.date),
                      metrics: [
                        { label: "Sales units", value: formatNumber(row.sales) },
                        { label: "On hand units", value: formatNumber(row.stock) },
                        { label: "Reorder level", value: formatNumber(position.reorderPoint) },
                        {
                          label: "Net vs. reorder level",
                          value: `${delta >= 0 ? "+" : ""}${formatNumber(delta)} units`,
                        },
                      ],
                    });
                  }}
                >
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
                    width={36}
                  />
                  <YAxis
                    yAxisId="stock"
                    orientation="right"
                    tick={{ fontSize: 11, fill: TOKENS.chart.axis }}
                    width={40}
                  />
                  <Tooltip content={<UnitTip />} />
                  <Legend />
                  <Bar
                    yAxisId="sales"
                    dataKey="sales"
                    name="Sales"
                    fill={TOKENS.chart.markdown}
                  />
                  <Line
                    yAxisId="stock"
                    type="monotone"
                    dataKey="stock"
                    name="On hand"
                    stroke={TOKENS.chart.inventoryValue}
                    dot={false}
                    activeDot={{ r: 5 }}
                    strokeWidth={2}
                  />
                  <ReferenceLine
                    yAxisId="stock"
                    y={position.reorderPoint}
                    stroke={TOKENS.chart.reorder}
                    strokeDasharray="4 4"
                    label="Reorder"
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-2xl border border-border shadow-card">
          <CardHeader>
            <CardTitle>Days of stock left trajectory</CardTitle>
          </CardHeader>
          <CardContent>
            {position.velocity <= 0 ? (
              <p className="text-sm text-muted-foreground">
                No in-stock demand, so cover is not a number of days.
              </p>
            ) : (
              <div className="h-56 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={coverRows}
                    className="cursor-pointer"
                    onClick={(state, event) => {
                      const row = pickChartPoint<{ date: string; cover: number | null }>(
                        state,
                        event,
                      );
                      if (!row) return;
                      showDetail({
                        title: `Cover trajectory · ${position.branch.name}`,
                        subtitle: formatDate(row.date),
                        metrics: [
                          { label: "Days of stock left", value: formatCover(row.cover) },
                          {
                            label: "Target floor",
                            value: `${formatNumber(policy.receiverCoverDays)}d`,
                          },
                          {
                            label: "Donor floor",
                            value: `${formatNumber(policy.donorCoverDays)}d`,
                          },
                          {
                            label: "Overstock threshold",
                            value: `${formatNumber(policy.overstockCoverDays)}d`,
                          },
                        ],
                      });
                    }}
                  >
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
                    <YAxis tick={{ fontSize: 11, fill: TOKENS.chart.axis }} width={36} />
                    <Tooltip content={<CoverTip />} />
                    <Line
                      type="monotone"
                      dataKey="cover"
                      name="Days of stock left"
                      stroke={TOKENS.chart.netBenefit}
                      dot={false}
                      activeDot={{ r: 5 }}
                      strokeWidth={2}
                    />
                    <ReferenceLine
                      y={policy.receiverCoverDays}
                      stroke={TOKENS.chart.reorder}
                      strokeDasharray="4 4"
                      label="14d target"
                    />
                    <ReferenceLine
                      y={policy.donorCoverDays}
                      stroke={TOKENS.chart.markdown}
                      strokeDasharray="4 4"
                      label="30d donor floor"
                    />
                    <ReferenceLine
                      y={policy.overstockCoverDays}
                      stroke={TOKENS.chart.stockoutRate}
                      strokeDasharray="4 4"
                      label="60d overstock"
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="font-semibold text-foreground tabular-nums">{value}</dd>
    </div>
  );
}

function UnitTip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: { date: string; sales: number; stock: number } }>;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <div className="rounded-xl border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-card tabular-nums">
      <p className="font-semibold">{formatDate(point.date)}</p>
      <p className="mt-0.5">Sales: {formatNumber(point.sales)} units</p>
      <p>On hand: {formatNumber(point.stock)} units</p>
    </div>
  );
}

function CoverTip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: { date: string; cover: number | null } }>;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <div className="rounded-xl border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-card tabular-nums">
      <p className="font-semibold">{formatDate(point.date)}</p>
      <p className="mt-0.5">Cover: {formatCover(point.cover)}</p>
    </div>
  );
}

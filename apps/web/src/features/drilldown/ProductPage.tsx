import type { Policy, PositionView, SeriesPoint } from "@stockflow/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Bar } from "recharts";
import { ComposedChart } from "recharts";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/shared/states";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { queryKeys } from "@/hooks/queryKeys";
import { api } from "@/lib/api";
import { actionLabel, formatCover, formatDate, formatMoneyFull, formatNumber, statusLabel } from "@/lib/format";

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
  if (product.isError) return <ErrorBlock message={product.error.message} onRetry={() => void product.refetch()} />;

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
      <div>
        <p className="text-sm text-muted-foreground">{detail.product.category}</p>
        <h1 className="text-2xl font-semibold tracking-tight">{detail.product.name}</h1>
        <p className="text-sm text-muted-foreground">
          {detail.product.sku} · price {formatMoneyFull(detail.product.price)} · cost {formatMoneyFull(detail.product.cost)} · lead
          time {detail.product.leadTimeDays} days
        </p>
      </div>

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

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-muted/60 text-left text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Branch</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">On hand</th>
              <th className="px-3 py-2 font-medium">Cover</th>
              <th className="px-3 py-2 font-medium">Reorder point</th>
              <th className="px-3 py-2 font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((item) => (
              <tr
                key={item.branch.id}
                className={item.branch.id === selectedId ? "border-t bg-accent/60" : "border-t"}
              >
                <td className="px-3 py-2">
                  <button className="hover:underline" type="button" onClick={() => setPicked(item.branch.id)}>
                    {item.branch.name}
                  </button>
                </td>
                <td className="px-3 py-2">
                  <Badge tone={item.status === "AT_RISK" ? "risk" : item.status === "OVERSTOCK" ? "over" : item.status === "HEALTHY" ? "ok" : "fresh"}>
                    {item.status === "AT_RISK" ? "At risk" : item.status === "OVERSTOCK" ? "Overstock" : item.status === "HEALTHY" ? "Healthy" : "New"}
                  </Badge>
                </td>
                <td className="px-3 py-2">{formatNumber(item.onHand)}</td>
                <td className="px-3 py-2">{formatCover(item.coverDays)}</td>
                <td className="px-3 py-2">{formatNumber(item.reorderPoint)}</td>
                <td className="px-3 py-2">
                  {item.recommendation ? (
                    <Link className="hover:underline" to={`/queue?branch=${item.branch.id}`}>
                      {actionLabel(item.recommendation.action)} {formatNumber(item.recommendation.quantity)}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">None</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
    <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      <Card>
        <CardHeader>
          <CardTitle>Why this branch</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <label className="block text-xs text-muted-foreground">
            Branch
            <select
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
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
          <p>
            <Link className="hover:underline" to={`/branches/${position.branch.id}`}>
              {position.branch.name}
            </Link>
          </p>
          <p className="text-muted-foreground">
            Safety stock is {policy.serviceZ} × demand standard deviation × square root of lead time. Reorder point is
            daily demand × lead time + safety stock. At risk means on hand is below that point. Overstock means cover
            is above {policy.overstockCoverDays} days.
          </p>
          <dl className="grid grid-cols-2 gap-2">
            <Mini label="On hand" value={formatNumber(position.onHand)} />
            <Mini label="Daily demand" value={formatNumber(position.velocity)} />
            <Mini label="Std. dev." value={formatNumber(position.sigmaDemand)} />
            <Mini label="Lead time" value={`${position.leadTimeDays} days`} />
            <Mini label="Safety stock" value={formatNumber(position.safetyStock)} />
            <Mini label="Reorder point" value={formatNumber(position.reorderPoint)} />
            <Mini label="Cover" value={formatCover(position.coverDays)} />
            <Mini label="In-stock days" value={formatNumber(position.inStockDays)} />
          </dl>
          {position.recommendation ? (
            <div className="rounded-md bg-muted p-2">
              <p className="font-medium">
                {actionLabel(position.recommendation.action)} {formatNumber(position.recommendation.quantity)} ·{" "}
                {statusLabel(position.recommendation.status)}
              </p>
              <p className="mt-1">{position.recommendation.reason}</p>
            </div>
          ) : (
            <p className="text-muted-foreground">No action for this branch today.</p>
          )}
        </CardContent>
      </Card>
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Sales and stock</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={salesRows}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#94a3b8" strokeOpacity={0.4} />
                  <XAxis dataKey="date" tickFormatter={formatDate} minTickGap={28} tick={{ fontSize: 12 }} />
                  <YAxis yAxisId="sales" tick={{ fontSize: 12 }} width={36} />
                  <YAxis yAxisId="stock" orientation="right" tick={{ fontSize: 12 }} width={40} />
                  <Tooltip content={<UnitTip />} />
                  <Legend />
                  <Bar yAxisId="sales" dataKey="sales" name="Sales" fill="#b45309" />
                  <Line yAxisId="stock" type="monotone" dataKey="stock" name="On hand" stroke="#0f766e" dot={false} strokeWidth={2} />
                  <ReferenceLine yAxisId="stock" y={position.reorderPoint} stroke="#0369a1" strokeDasharray="4 4" label="Reorder" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Cover</CardTitle>
          </CardHeader>
          <CardContent>
            {position.velocity <= 0 ? (
              <p className="text-sm text-muted-foreground">No in-stock demand, so cover is not a number of days.</p>
            ) : (
              <div className="h-56 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={coverRows}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#94a3b8" strokeOpacity={0.4} />
                    <XAxis dataKey="date" tickFormatter={formatDate} minTickGap={28} tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 12 }} width={36} />
                    <Tooltip content={<CoverTip />} />
                    <Line type="monotone" dataKey="cover" name="Cover days" stroke="#0f766e" dot={false} strokeWidth={2} />
                    <ReferenceLine y={policy.receiverCoverDays} stroke="#0369a1" strokeDasharray="4 4" label="14-day target" />
                    <ReferenceLine y={policy.donorCoverDays} stroke="#a16207" strokeDasharray="4 4" label="Donor floor" />
                    <ReferenceLine y={policy.overstockCoverDays} stroke="#be123c" strokeDasharray="4 4" label="Overstock" />
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
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
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
    <div className="rounded-md border bg-card px-3 py-2 text-xs shadow-sm">
      <p className="font-medium">{formatDate(point.date)}</p>
      <p>Sales {formatNumber(point.sales)}</p>
      <p>On hand {formatNumber(point.stock)}</p>
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
    <div className="rounded-md border bg-card px-3 py-2 text-xs shadow-sm">
      <p className="font-medium">{formatDate(point.date)}</p>
      <p>Cover {formatCover(point.cover)}</p>
    </div>
  );
}

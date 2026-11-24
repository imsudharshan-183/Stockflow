import { useQuery } from "@tanstack/react-query";
import { CalendarDays, HelpCircle, Package, TrendingUp } from "lucide-react";
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { queryKeys } from "@/hooks/queryKeys";
import { api } from "@/lib/api";
import { formatCover, formatDate, formatMoneyPrecise, formatNumber } from "@/lib/format";
import type { LocationInventoryItem, Product } from "@stockflow/core";

export interface DailyEntryContextPanelProps {
  branchId: string;
  branchName?: string;
  sku: string;
  product?: Product;
}

function buildSparklinePoints(values: readonly number[], width = 240, height = 44): string {
  if (values.length === 0) return "";
  if (values.length === 1) {
    const y = height / 2;
    return `0,${y} ${width},${y}`;
  }
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = Math.max(max - min, 1);
  return values
    .map((val, idx) => {
      const x = Math.round((idx / (values.length - 1)) * width);
      const y = Math.round(height - ((val - min) / span) * (height - 8) - 4);
      return `${x},${y}`;
    })
    .join(" ");
}

function statusBadgeTone(status: LocationInventoryItem["status"]): "risk" | "over" | "approved" {
  if (status === "AT_RISK") return "risk";
  if (status === "OVERSTOCK") return "over";
  return "approved";
}

function statusLabel(status: LocationInventoryItem["status"]): string {
  if (status === "AT_RISK") return "At risk";
  if (status === "OVERSTOCK") return "Overstock";
  return "Healthy";
}

export function DailyEntryContextPanel({
  branchId,
  branchName,
  sku,
  product,
}: DailyEntryContextPanelProps) {
  const hasSelection = Boolean(branchId && sku);

  const historyQuery = useQuery({
    queryKey: queryKeys.salesEntries({ context: "panel", branch: branchId, sku, limit: 7 }),
    queryFn: () => api.listSalesEntries({ branch: branchId, sku, page: 1, limit: 7 }),
    enabled: hasSelection,
  });

  const inventoryQuery = useQuery({
    queryKey: queryKeys.locationInventory(branchId, { search: sku, limit: 20 }),
    queryFn: async () => {
      if (typeof api.locationInventory !== "function") {
        return null;
      }
      return api.locationInventory(branchId, { search: sku, limit: 20 });
    },
    enabled: hasSelection,
  });

  const entries = useMemo(() => {
    const list = historyQuery.data?.entries ?? [];
    return [...list].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 7);
  }, [historyQuery.data]);

  const latestEntry = entries[0] ?? null;
  const chronological = useMemo(() => [...entries].reverse(), [entries]);
  const sparkPoints = useMemo(
    () => buildSparklinePoints(chronological.map((e) => e.unitsSold)),
    [chronological],
  );

  const inventoryItem = useMemo(
    () => inventoryQuery.data?.items.find((item) => item.sku === sku) ?? null,
    [inventoryQuery.data, sku],
  );

  return (
    <Card className="rounded-2xl border border-border shadow-card" aria-label="Context">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">Context</CardTitle>
          {inventoryItem ? (
            <Badge tone={statusBadgeTone(inventoryItem.status)} dot>
              {statusLabel(inventoryItem.status)}
            </Badge>
          ) : null}
        </div>
        <CardDescription>
          {hasSelection
            ? `${product ? `${product.name} (${sku})` : sku} at ${branchName ?? branchId}`
            : "Last recorded stock, 7-day sales trend, and live cover days."}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {!hasSelection ? (
          <div className="flex items-start gap-2.5 rounded-xl border border-dashed border-border bg-secondary/30 p-4 text-xs text-muted-foreground">
            <HelpCircle className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
            <div className="space-y-1">
              <p className="font-medium text-foreground">No SKU selected yet</p>
              <p>
                Choose a location and search by product name, SKU code, category, or price to see recent sales history, previous end-of-day stock, and reorder levels.
              </p>
            </div>
          </div>
        ) : (
          <>
            {/* Last Entry */}
            <div className="rounded-xl border border-border bg-secondary/35 p-3.5">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                <CalendarDays className="size-3.5 text-primary" aria-hidden="true" />
                <span>Last entry</span>
              </div>
              {historyQuery.isPending ? (
                <p className="mt-2 text-xs text-muted-foreground">Loading recent history...</p>
              ) : latestEntry ? (
                <dl className="mt-2 grid grid-cols-3 gap-2 text-xs tabular-nums">
                  <div>
                    <dt className="text-muted-foreground">Date</dt>
                    <dd className="font-medium text-foreground">{formatDate(latestEntry.date)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Units sold</dt>
                    <dd className="font-semibold text-foreground">
                      {formatNumber(latestEntry.unitsSold)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">End-of-day stock</dt>
                    <dd className="font-semibold text-foreground">
                      {formatNumber(latestEntry.onHand)}
                    </dd>
                  </div>
                </dl>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">
                  No recorded entries yet for this SKU at {branchName ?? branchId}.
                </p>
              )}
            </div>

            {/* Current Stock Status */}
            <div className="rounded-xl border border-border bg-card p-3.5">
              <div className="flex items-center justify-between gap-2 text-xs font-semibold text-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <Package className="size-3.5 text-primary" aria-hidden="true" />
                  <span>Current stock status</span>
                </span>
                {product ? (
                  <span className="font-normal text-muted-foreground tabular-nums">
                    Price {formatMoneyPrecise(product.price)}
                  </span>
                ) : null}
              </div>

              {inventoryItem ? (
                <dl className="mt-2.5 grid grid-cols-3 gap-2 text-xs tabular-nums">
                  <div>
                    <dt className="text-muted-foreground">Cover</dt>
                    <dd className="font-semibold text-foreground">
                      {formatCover(inventoryItem.coverDays)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Reorder level</dt>
                    <dd className="font-semibold text-foreground">
                      {formatNumber(Math.round(inventoryItem.reorderPoint))} units
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Overstock surplus</dt>
                    <dd className="font-semibold text-foreground">
                      {(inventoryItem.surplus ?? 0) > 0
                        ? `${formatNumber(Math.round(inventoryItem.surplus ?? 0))} units`
                        : "None"}
                    </dd>
                  </div>
                </dl>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">
                  Stock status metrics are unavailable until plan inventory finishes loading.
                </p>
              )}
            </div>

            {/* 7-day Mini Sales Table + Sparkline */}
            <div className="space-y-2 rounded-xl border border-border bg-card p-3.5">
              <div className="flex items-center justify-between gap-2 text-xs font-semibold text-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <TrendingUp className="size-3.5 text-primary" aria-hidden="true" />
                  <span>Last 7 days sales</span>
                </span>
                <span className="font-normal text-muted-foreground tabular-nums">
                  {formatNumber(entries.length)} {entries.length === 1 ? "day" : "days"}
                </span>
              </div>

              {chronological.length >= 2 ? (
                <svg
                  viewBox="0 0 240 44"
                  className="h-11 w-full text-primary"
                  role="img"
                  aria-label="7-day unit sales sparkline"
                >
                  <polyline
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    points={sparkPoints}
                  />
                </svg>
              ) : null}

              {entries.length === 0 ? (
                <p className="text-xs text-muted-foreground">No 7-day sales rows yet.</p>
              ) : (
                <Table className="text-xs">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="h-7 px-2">Date</TableHead>
                      <TableHead className="h-7 px-2 text-right">Sold</TableHead>
                      <TableHead className="h-7 px-2 text-right">On hand</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {entries.map((entry) => (
                      <TableRow key={entry.id}>
                        <TableCell className="py-1.5 px-2 tabular-nums">
                          {formatDate(entry.date)}
                        </TableCell>
                        <TableCell className="py-1.5 px-2 text-right font-medium tabular-nums">
                          {formatNumber(entry.unitsSold)}
                        </TableCell>
                        <TableCell className="py-1.5 px-2 text-right tabular-nums">
                          {formatNumber(entry.onHand)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

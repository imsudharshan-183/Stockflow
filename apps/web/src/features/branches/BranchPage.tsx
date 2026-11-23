import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownToLine, ArrowLeft, ArrowUpDown, Download, Filter, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  Brush,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { toast } from "sonner";
import { ChartCard } from "@/components/shared/ChartCard";
import { pickChartPoint, useChartDetail } from "@/components/shared/ChartDetailPopup";
import { InfoPopover } from "@/components/shared/InfoPopover";
import { PageHeader } from "@/components/shared/PageHeader";
import { StockDeltaBadges } from "@/components/shared/StockDeltaBadges";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/shared/states";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/features/auth/AuthContext";
import { RecommendationDrawer } from "@/features/queue/RecommendationDrawer";
import { queryKeys } from "@/hooks/queryKeys";
import { api } from "@/lib/api";
import {
  actionLabel,
  formatCover,
  formatDate,
  formatMoney,
  formatMoneyFull,
  formatNumber,
  formatPct,
  statusLabel,
} from "@/lib/format";
import { LABELS, type LabelKey } from "@/lib/labels";
import { TOKENS } from "@/lib/tokens";
import { cn } from "@/lib/utils";
import {
  formatProductDisplayName,
  type LocationInventoryItem,
  type PositionStatus,
  type Recommendation,
} from "@stockflow/core";

type SortCol = "sku" | "name" | "category" | "onHand" | "coverDays" | "reorderPoint" | "status";

function positionBadgeTone(status: PositionStatus): "risk" | "ok" | "over" | "fresh" {
  switch (status) {
    case "AT_RISK":
      return "risk";
    case "HEALTHY":
      return "ok";
    case "OVERSTOCK":
      return "over";
    case "NEW":
      return "fresh";
  }
}

function positionLabel(status: PositionStatus): string {
  switch (status) {
    case "AT_RISK":
      return "At risk";
    case "HEALTHY":
      return "Healthy";
    case "OVERSTOCK":
      return "Overstock";
    case "NEW":
      return "New";
  }
}

function downloadCsv(filename: string, items: LocationInventoryItem[]): void {
  const header = "sku,name,category,onHand,daysOfStockLeft,reorderLevel,status,recommendedAction";
  const rows = items.map((item) => {
    const safeName = `"${item.name.replace(/"/g, '""')}"`;
    const safeCat = `"${item.category.replace(/"/g, '""')}"`;
    const cover = item.coverDays === null ? "" : String(item.coverDays);
    return [
      item.sku,
      safeName,
      safeCat,
      item.onHand,
      cover,
      item.reorderPoint,
      item.status,
      item.recommendedAction ?? "",
    ].join(",");
  });
  const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function BranchPage({
  forcedBranchId,
  readOnly = false,
}: {
  forcedBranchId?: string;
  readOnly?: boolean;
}) {
  const { id: paramId } = useParams();
  const id = forcedBranchId ?? paramId ?? "";
  const { user } = useAuth();
  const { showDetail } = useChartDetail();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const isStaff = user?.role === "staff";
  const canDecide = !readOnly && !isStaff;

  const activeTab = (searchParams.get("tab") as "needs" | "gives" | "markdowns" | null) ?? "needs";
  const search = searchParams.get("q") ?? "";
  const categoryFilter = searchParams.get("cat") ?? "";
  const statusFilter = (searchParams.get("status") as PositionStatus | null) ?? undefined;
  const sortBy = (searchParams.get("sortBy") as SortCol | null) ?? "coverDays";
  const sortDir = (searchParams.get("sortDir") as "asc" | "desc" | null) ?? "asc";
  const page = Math.max(1, Number(searchParams.get("page") ?? "1") || 1);
  const range = (searchParams.get("range") as "7" | "30" | "90" | null) ?? "30";
  const trendSku = searchParams.get("trendSku") ?? "";
  const trendCat = searchParams.get("trendCat") ?? "";

  const [drawerRec, setDrawerRec] = useState<Recommendation | null>(null);
  const [showSalesLine, setShowSalesLine] = useState(true);
  const [showOnHandLine, setShowOnHandLine] = useState(true);

  const updateParam = (updates: Record<string, string | undefined>) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(updates)) {
          if (v === undefined || v === "") {
            next.delete(k);
          } else {
            next.set(k, v);
          }
        }
        return next;
      },
      { replace: true },
    );
  };

  const summaryQuery = useQuery({
    queryKey: queryKeys.locationSummary(id),
    queryFn: () => api.locationSummary(id),
    enabled: Boolean(id),
  });

  const inventoryQuery = useQuery({
    queryKey: queryKeys.locationInventory(id, {
      search: search || undefined,
      category: categoryFilter || undefined,
      status: statusFilter,
      sortBy,
      sortDir,
      page,
      limit: 20,
    }),
    queryFn: () =>
      api.locationInventory(id, {
        search: search || undefined,
        category: categoryFilter || undefined,
        status: statusFilter,
        sortBy,
        sortDir,
        page,
        limit: 20,
      }),
    enabled: Boolean(id),
  });

  const trendQuery = useQuery({
    queryKey: queryKeys.locationTrend(id, {
      sku: trendSku || undefined,
      category: trendCat || undefined,
      range,
    }),
    queryFn: () =>
      api.locationTrend(id, {
        sku: trendSku || undefined,
        category: trendCat || undefined,
        range,
      }),
    enabled: Boolean(id),
  });

  const decideMutation = useMutation({
    mutationFn: ({ recId, decision }: { recId: string; decision: "approve" | "reject" }) =>
      api.decide(recId, decision),
    onSuccess: (updated, vars) => {
      toast.success(vars.decision === "approve" ? "Action approved" : "Action rejected");
      setDrawerRec(updated);
      void queryClient.invalidateQueries({ queryKey: queryKeys.locationSummary(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.locations });
      void queryClient.invalidateQueries({ queryKey: ["recommendations"] });
      void queryClient.invalidateQueries({ queryKey: ["kpis"] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Could not update decision");
    },
  });

  const categories = useMemo(() => {
    return inventoryQuery.data?.categories ?? [];
  }, [inventoryQuery.data]);

  const heatmapMatrix = useMemo(() => {
    const cells = summaryQuery.data?.categoryHeatmap ?? [];
    const cats = Array.from(new Set(cells.map((c) => c.category))).sort();
    const map = new Map<string, number>();
    for (const c of cells) {
      map.set(`${c.category}::${c.status}`, c.count);
    }
    return { cats, map };
  }, [summaryQuery.data]);

  if (!id) {
    return (
      <EmptyBlock
        title="No location selected"
        body="Choose a location from the sidebar or command palette (Ctrl+K) to inspect its stock health."
      />
    );
  }
  if (summaryQuery.isPending) return <LoadingBlock />;
  if (summaryQuery.isError) {
    return (
      <ErrorBlock
        message={summaryQuery.error.message}
        onRetry={() => void summaryQuery.refetch()}
      />
    );
  }

  const summary = summaryQuery.data;
  const inv = inventoryQuery.data;

  const toggleSort = (col: SortCol) => {
    const nextDir = sortBy === col && sortDir === "asc" ? "desc" : "asc";
    updateParam({ sortBy: col, sortDir: nextDir, page: "1" });
  };

  const handleExportCsv = async () => {
    try {
      const full = await api.locationInventory(id, {
        search: search || undefined,
        category: categoryFilter || undefined,
        status: statusFilter,
        sortBy,
        sortDir,
        page: 1,
        limit: 500,
      });
      downloadCsv(`${id}-inventory.csv`, full.items);
      toast.success(`Exported ${formatNumber(full.items.length)} rows`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed");
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={summary.branch.name}
        subtitle={`${summary.branch.id} · ${summary.branch.city}, ${summary.branch.region} region — Stock health, daily needs, and location inventory`}
        breadcrumbs={[
          { label: isStaff ? "Store" : "Locations", to: "/" },
          { label: summary.branch.name },
        ]}
        lastUpdated={formatDate(summary.asOf)}
        nextStep={
          canDecide && summary.kpis.pendingDecisions > 0
            ? {
                label: `${formatNumber(summary.kpis.pendingDecisions)} decisions waiting · Open queue`,
                to: `/queue?branch=${summary.branch.id}`,
              }
            : undefined
        }
        actions={
          !isStaff ? (
            <div className="flex flex-wrap items-center gap-2">
              <Link
                to="/"
                className={cn(buttonVariants({ variant: "secondary", size: "sm" }))}
              >
                <ArrowLeft className="size-3.5" aria-hidden="true" />
                Overview
              </Link>
              <Link
                to={`/queue?branch=${summary.branch.id}`}
                className={cn(buttonVariants({ variant: "primary", size: "sm" }))}
              >
                <Filter className="size-3.5" aria-hidden="true" />
                Queue for {summary.branch.id}
              </Link>
            </div>
          ) : null
        }
      />

      {/* 6-KPI Strip */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <KpiMiniCard labelKey="stockoutRate" value={formatPct(summary.kpis.stockoutRate)} />
        <KpiMiniCard labelKey="skusAtRisk" value={formatNumber(summary.kpis.skusAtRisk)} />
        <KpiMiniCard labelKey="overstockValue" value={formatMoney(summary.kpis.overstockValue)} />
        <KpiMiniCard labelKey="lostSalesAtRisk" value={formatMoney(summary.kpis.lostSalesAtRisk)} />
        <KpiMiniCard labelKey="cashReleasable" value={formatMoney(summary.kpis.cashReleasable)} />
        <KpiMiniCard labelKey="pendingDecisions" value={formatNumber(summary.kpis.pendingDecisions)} />
      </section>

      {/* What this location needs */}
      <Card className="rounded-2xl border border-border shadow-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">What this location needs</CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs
            value={activeTab}
            onValueChange={(val) => updateParam({ tab: String(val) })}
          >
            <TabsList className="mb-4 flex h-auto w-full flex-wrap justify-start gap-1 sm:w-fit">
              <TabsTrigger value="needs">
                Needs stock ({formatNumber(summary.totals.needsStockCount)} ·{" "}
                {formatMoney(summary.totals.needsStockValue)})
              </TabsTrigger>
              <TabsTrigger value="gives">
                Can give ({formatNumber(summary.totals.canGiveCount)} ·{" "}
                {formatMoney(summary.totals.canGiveValue)})
              </TabsTrigger>
              <TabsTrigger value="markdowns">
                Should mark down ({formatNumber(summary.totals.shouldMarkdownCount)} ·{" "}
                {formatMoney(summary.totals.shouldMarkdownValue)})
              </TabsTrigger>
            </TabsList>

            <TabsContent value="needs">
              <ActionListTable
                rows={summary.needsStock}
                mode="needs"
                leadTimeDaysBySku={summary.leadTimeDaysBySku}
                emptyTitle="No incoming stock needed"
                emptyBody="All SKUs at this location have enough days of stock left to cover lead time."
                onOpen={setDrawerRec}
              />
            </TabsContent>

            <TabsContent value="gives">
              <ActionListTable
                rows={summary.canGive}
                mode="gives"
                emptyTitle="No outgoing transfers"
                emptyBody="This location does not have surplus units matched to another store right now."
                onOpen={setDrawerRec}
              />
            </TabsContent>

            <TabsContent value="markdowns">
              <ActionListTable
                rows={summary.shouldMarkdown}
                mode="markdowns"
                emptyTitle="No markdowns recommended"
                emptyBody="No slow-moving overstock requires clearance pricing at this location."
                onOpen={setDrawerRec}
              />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* Stock Health: Cover Bands + Category x Status Heatmap + Top At-Risk SKUs */}
      <section className="grid gap-4 lg:grid-cols-3">
        <Card className="rounded-2xl border border-border shadow-card">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <span>Stock health bands</span>
              <InfoPopover labelKey="coverDays" />
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {summary.coverBands.map((band) => (
              <div key={band.band} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <Badge tone={positionBadgeTone(band.band)} dot>
                    {positionLabel(band.band)}
                  </Badge>
                  <span className="font-medium text-foreground tabular-nums">
                    {formatNumber(band.count)} SKUs ({formatPct(band.share)})
                  </span>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="rounded-2xl border border-border shadow-card">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <span>Category × status</span>
              <InfoPopover labelKey="coverHeatmap" />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[11px] uppercase text-muted-foreground">
                    <th className="py-1 pr-2">Category</th>
                    <th className="px-1.5 py-1 text-right">Risk</th>
                    <th className="px-1.5 py-1 text-right">Healthy</th>
                    <th className="px-1.5 py-1 text-right">Over</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {heatmapMatrix.cats.map((cat) => (
                    <tr key={cat}>
                      <td className="py-1.5 pr-2 font-medium text-foreground">{cat}</td>
                      {(["AT_RISK", "HEALTHY", "OVERSTOCK"] as const).map((st) => {
                        const count = heatmapMatrix.map.get(`${cat}::${st}`) ?? 0;
                        const active = categoryFilter === cat && statusFilter === st;
                        return (
                          <td key={st} className="px-1 py-1 text-right">
                            <Button
                              type="button"
                              variant={active ? "primary" : "ghost"}
                              size="sm"
                              onClick={() =>
                                updateParam({
                                  cat: active ? undefined : cat,
                                  trendCat: active ? undefined : cat,
                                  status: active ? undefined : st,
                                  page: "1",
                                })
                              }
                              className="h-6 min-w-8 px-1.5 text-xs tabular-nums"
                            >
                              {formatNumber(count)}
                            </Button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-2xl border border-border shadow-card">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <span>Top at-risk SKUs</span>
              <InfoPopover labelKey="lostSalesAtRisk" />
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {summary.topAtRiskSkus.length === 0 ? (
              <p className="text-xs text-muted-foreground">No SKUs are currently below reorder level.</p>
            ) : (
              summary.topAtRiskSkus.slice(0, 6).map((item) => (
                <Link
                  key={item.sku}
                  to={`/products/${item.sku}`}
                  className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-row-hover"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-foreground">
                      {formatProductDisplayName(item.sku, item.name)}
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {formatNumber(item.onHand)} on hand · {formatCover(item.coverDays)}
                    </span>
                  </span>
                  <Badge tone="risk" className="shrink-0">
                    {formatMoneyFull(item.lostSalesAtRisk)}
                  </Badge>
                </Link>
              ))
            )}
          </CardContent>
        </Card>
      </section>

      {/* Cross-filter chip */}
      {(categoryFilter || statusFilter) ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">Cross-filter active:</span>
          {categoryFilter ? (
            <Badge tone="reorder" className="gap-1.5 pl-2 pr-1">
              <span>Category: {categoryFilter}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Clear category cross-filter"
                onClick={() => updateParam({ cat: undefined, trendCat: undefined, page: "1" })}
                className="size-4 rounded-full p-0"
              >
                <X className="size-3" aria-hidden="true" />
              </Button>
            </Badge>
          ) : null}
          {statusFilter ? (
            <Badge tone={positionBadgeTone(statusFilter)} className="gap-1.5 pl-2 pr-1">
              <span>Status: {positionLabel(statusFilter)}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Clear status cross-filter"
                onClick={() => updateParam({ status: undefined, page: "1" })}
                className="size-4 rounded-full p-0"
              >
                <X className="size-3" aria-hidden="true" />
              </Button>
            </Badge>
          ) : null}
        </div>
      ) : null}

      {/* Location Inventory Table */}
      <TableCard>
        <TableToolbar className="flex-wrap justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={search}
              onChange={(e) => updateParam({ q: e.target.value, page: "1" })}
              placeholder="Search SKU or product..."
              className="h-8 w-52 text-xs"
              aria-label="Search location inventory"
            />
            <select
              value={categoryFilter}
              onChange={(e) => updateParam({ cat: e.target.value || undefined, page: "1" })}
              aria-label="Filter by category"
              className="h-8 rounded-lg border border-border bg-background px-2.5 text-xs text-foreground"
            >
              <option value="">All categories</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <select
              value={statusFilter ?? ""}
              onChange={(e) => updateParam({ status: e.target.value || undefined, page: "1" })}
              aria-label="Filter by status"
              className="h-8 rounded-lg border border-border bg-background px-2.5 text-xs text-foreground"
            >
              <option value="">All statuses</option>
              <option value="AT_RISK">At risk</option>
              <option value="HEALTHY">Healthy</option>
              <option value="OVERSTOCK">Overstock</option>
              <option value="NEW">New</option>
            </select>
            {(categoryFilter || statusFilter || search) ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => updateParam({ q: undefined, cat: undefined, status: undefined, page: "1" })}
                className="h-8 gap-1 px-2 text-xs"
              >
                <X className="size-3.5" aria-hidden="true" />
                Clear
              </Button>
            ) : null}
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void handleExportCsv()}
            className="h-8 gap-1.5 text-xs"
          >
            <Download className="size-3.5" aria-hidden="true" />
            Export CSV
          </Button>
        </TableToolbar>

        {inventoryQuery.isPending ? (
          <div className="p-6">
            <LoadingBlock />
          </div>
        ) : !inv || inv.items.length === 0 ? (
          <div className="p-6">
            <EmptyBlock
              title="No matching inventory"
              body="Try clearing the search or category/status filters to see all products at this location."
            />
          </div>
        ) : (
          <>
            <Table className="min-w-[920px] table-auto">
              <TableHeader>
                <TableRow>
                  <TableHead className="whitespace-nowrap">
                    <SortButton label="SKU" col="sku" active={sortBy} onSort={toggleSort} />
                  </TableHead>
                  <TableHead className="whitespace-nowrap">
                    <SortButton label="Product" col="name" active={sortBy} onSort={toggleSort} />
                  </TableHead>
                  <TableHead className="whitespace-nowrap">
                    <SortButton label="Category" col="category" active={sortBy} onSort={toggleSort} />
                  </TableHead>
                  <TableHead className="whitespace-nowrap text-right">
                    <SortButton label="On hand" col="onHand" active={sortBy} onSort={toggleSort} />
                  </TableHead>
                  <TableHead className="whitespace-nowrap">In transit / Reserved</TableHead>
                  <TableHead className="whitespace-nowrap text-right">
                    <span className="inline-flex items-center justify-end gap-1">
                      <SortButton
                        label={LABELS.coverDays.label}
                        col="coverDays"
                        active={sortBy}
                        onSort={toggleSort}
                      />
                      <InfoPopover labelKey="coverDays" />
                    </span>
                  </TableHead>
                  <TableHead className="text-right">
                    <span className="inline-flex items-center justify-end gap-1">
                      <SortButton
                        label={LABELS.reorderPoint.label}
                        col="reorderPoint"
                        active={sortBy}
                        onSort={toggleSort}
                      />
                      <InfoPopover labelKey="reorderPoint" />
                    </span>
                  </TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Recommended action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {inv.items.map((item) => (
                  <TableRow key={item.sku}>
                    <TableCell className="font-mono text-xs">{item.sku}</TableCell>
                    <TableCell className="font-medium">
                      <Link to={`/products/${item.sku}`} className="text-primary hover:underline">
                        {item.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{item.category}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(item.onHand)}</TableCell>
                    <TableCell>
                      <StockDeltaBadges inTransit={item.inTransit} reserved={item.reserved} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatCover(item.coverDays)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(item.reorderPoint)}
                    </TableCell>
                    <TableCell>
                      <Badge tone={positionBadgeTone(item.status)} dot>
                        {positionLabel(item.status)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {item.recommendedAction ? (
                        <Badge tone={item.recommendedAction.toLowerCase() as "transfer" | "reorder" | "markdown"}>
                          {actionLabel(item.recommendedAction)}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <div className="flex items-center justify-between border-t border-border px-4 py-3 text-xs text-muted-foreground">
              <span>
                Page {formatNumber(inv.page)} of {formatNumber(inv.totalPages)} ({formatNumber(inv.total)}{" "}
                SKUs)
              </span>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={inv.page <= 1}
                  onClick={() => updateParam({ page: String(inv.page - 1) })}
                >
                  Previous
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={inv.page >= inv.totalPages}
                  onClick={() => updateParam({ page: String(inv.page + 1) })}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </TableCard>

      {/* Trend Chart */}
      <ChartCard
        title={LABELS.locationTrend.label}
        subtitle={
          trendCat
            ? `Filtered to ${trendCat} · click legend items to toggle series`
            : "All categories · click legend items to toggle series"
        }
        helpKey="locationTrend"
        isLoading={trendQuery.isPending}
        isError={trendQuery.isError}
        errorMessage={trendQuery.error?.message}
        onRetry={() => void trendQuery.refetch()}
        isEmpty={(trendQuery.data?.points ?? []).length === 0}
        tableData={{
          headers: ["Date", "Sales units", "On hand"],
          rows: (trendQuery.data?.points ?? []).map((p) => [
            formatDate(p.date),
            formatNumber(p.salesUnits),
            formatNumber(p.onHandUnits),
          ]),
        }}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={trendCat}
              onChange={(e) => updateParam({ trendCat: e.target.value || undefined, trendSku: undefined })}
              aria-label="Trend category"
              className="h-7 rounded-lg border border-border bg-background px-2 text-xs text-foreground"
            >
              <option value="">All categories</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <div className="flex items-center gap-1">
              {(["7", "30", "90"] as const).map((r) => (
                <Button
                  key={r}
                  type="button"
                  variant={range === r ? "primary" : "secondary"}
                  size="sm"
                  onClick={() => updateParam({ range: r })}
                  className="h-7 px-2 text-xs"
                >
                  {r}d
                </Button>
              ))}
            </div>
          </div>
        }
      >
        <div className="h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={trendQuery.data?.points ?? []}
              className="cursor-pointer"
              onClick={(state, event) => {
                const point = pickChartPoint<{ date: string; salesUnits: number; onHandUnits: number }>(
                  state,
                  event,
                );
                if (!point) return;
                const branchLabel = summaryQuery.data?.branch.name ?? id;
                const scopeLabel = trendSku
                  ? `SKU ${trendSku}`
                  : trendCat
                    ? `Category: ${trendCat}`
                    : "All categories";
                showDetail({
                  targetCard: "locationTrend",
                  title: branchLabel,
                  subtitle: `Daily trend · ${formatDate(point.date)}`,
                  metrics: [
                    { label: "Sales units", value: formatNumber(point.salesUnits) },
                    { label: "On hand units", value: formatNumber(point.onHandUnits) },
                    { label: "Filter scope", value: scopeLabel },
                    { label: "Range", value: `Last ${range} days` },
                  ],
                });
              }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke={TOKENS.chart.grid} strokeOpacity={0.6} />
              <XAxis
                dataKey="date"
                tickFormatter={formatDate}
                minTickGap={24}
                tick={{ fontSize: 11, fill: TOKENS.chart.axis }}
              />
              <YAxis yAxisId="sales" tick={{ fontSize: 11, fill: TOKENS.chart.axis }} width={48} />
              <YAxis
                yAxisId="stock"
                orientation="right"
                tick={{ fontSize: 11, fill: TOKENS.chart.axis }}
                width={56}
              />
              <Tooltip
                cursor={{ stroke: TOKENS.chart.axis, strokeDasharray: "3 3" }}
                labelFormatter={(v) => formatDate(String(v))}
                formatter={(value) => formatNumber(Number(value))}
              />
              <Legend
                onClick={(e) => {
                  if (e.dataKey === "salesUnits") setShowSalesLine((p) => !p);
                  if (e.dataKey === "onHandUnits") setShowOnHandLine((p) => !p);
                }}
              />
              {showSalesLine ? (
                <Line
                  yAxisId="sales"
                  type="monotone"
                  dataKey="salesUnits"
                  name="Sales units"
                  stroke={TOKENS.chart.markdown}
                  dot={false}
                  activeDot={{ r: 5 }}
                  strokeWidth={2}
                />
              ) : null}
              {showOnHandLine ? (
                <Line
                  yAxisId="stock"
                  type="monotone"
                  dataKey="onHandUnits"
                  name="On hand"
                  stroke={TOKENS.chart.inventoryValue}
                  dot={false}
                  activeDot={{ r: 5 }}
                  strokeWidth={2}
                />
              ) : null}
              {(trendQuery.data?.points ?? []).length > 7 ? (
                <Brush
                  dataKey="date"
                  height={20}
                  stroke={TOKENS.chart.axis}
                  tickFormatter={formatDate}
                />
              ) : null}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </ChartCard>

      <RecommendationDrawer
        recommendation={drawerRec}
        open={Boolean(drawerRec)}
        onOpenChange={(open) => {
          if (!open) setDrawerRec(null);
        }}
        canDecide={canDecide}
        isApproving={decideMutation.isPending && decideMutation.variables?.decision === "approve"}
        isRejecting={decideMutation.isPending && decideMutation.variables?.decision === "reject"}
        onApprove={(row) => decideMutation.mutate({ recId: row.id, decision: "approve" })}
        onRequestReject={(row) => decideMutation.mutate({ recId: row.id, decision: "reject" })}
      />
    </div>
  );
}

function KpiMiniCard({ labelKey, value }: { labelKey: LabelKey; value: string }) {
  const entry = LABELS[labelKey];
  return (
    <Card className="rounded-2xl border border-border shadow-card">
      <CardHeader className="pb-1">
        <CardTitle className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
          <span className="truncate">{entry.label}</span>
          <InfoPopover labelKey={labelKey} />
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-xl font-semibold tracking-tight text-foreground tabular-nums">{value}</div>
      </CardContent>
    </Card>
  );
}

function SortButton({
  label,
  col,
  active,
  onSort,
}: {
  label: string;
  col: SortCol;
  active: SortCol;
  onSort: (col: SortCol) => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => onSort(col)}
      className={cn(
        "h-6 gap-1 px-1 text-[11px] font-semibold uppercase tracking-wide",
        active === col ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <span>{label}</span>
      <ArrowUpDown className="size-3" aria-hidden="true" />
    </Button>
  );
}

function ActionListTable({
  rows,
  mode,
  leadTimeDaysBySku,
  emptyTitle,
  emptyBody,
  onOpen,
}: {
  rows: Recommendation[];
  mode: "needs" | "gives" | "markdowns";
  leadTimeDaysBySku?: Record<string, number>;
  emptyTitle: string;
  emptyBody: string;
  onOpen: (rec: Recommendation) => void;
}) {
  if (rows.length === 0) {
    return <EmptyBlock title={emptyTitle} body={emptyBody} />;
  }

  return (
    <Table className="min-w-[680px] table-auto">
      <TableHeader>
        <TableRow>
          <TableHead className="whitespace-nowrap">Product</TableHead>
          <TableHead className="whitespace-nowrap">Action</TableHead>
          <TableHead className="whitespace-nowrap text-right">Units</TableHead>
          {mode === "needs" ? <TableHead className="whitespace-nowrap">Source / Arrival</TableHead> : null}
          {mode === "gives" ? <TableHead className="whitespace-nowrap">Destination</TableHead> : null}
          <TableHead className="whitespace-nowrap text-right">
            <span className="inline-flex items-center justify-end gap-1">
              <span>{LABELS.netBenefit.label}</span>
              <InfoPopover labelKey="netBenefit" />
            </span>
          </TableHead>
          <TableHead className="whitespace-nowrap">Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((rec) => (
          <TableRow
            key={rec.id}
            className="cursor-pointer hover:bg-row-hover"
            onClick={() => onOpen(rec)}
          >
            <TableCell className="font-medium">
              {formatProductDisplayName(rec.sku, rec.productName)}
            </TableCell>
            <TableCell>
              <Badge tone={rec.action.toLowerCase() as "transfer" | "reorder" | "markdown"}>
                {actionLabel(rec.action)}
              </Badge>
            </TableCell>
            <TableCell className="text-right tabular-nums">{formatNumber(rec.quantity)}</TableCell>
            {mode === "needs" ? (
              <TableCell className="text-xs text-muted-foreground">
                {rec.action === "TRANSFER" ? (
                  <span className="inline-flex items-center gap-1">
                    <ArrowDownToLine className="size-3 text-primary" aria-hidden="true" />
                    {rec.donorBranchName ?? rec.donorBranchId} · Today
                  </span>
                ) : (
                  <span>
                    {leadTimeDaysBySku?.[rec.sku] !== undefined
                      ? `Supplier · ${formatNumber(leadTimeDaysBySku[rec.sku]!)}d lead time`
                      : "Supplier · Lead time"}
                  </span>
                )}
              </TableCell>
            ) : null}
            {mode === "gives" ? (
              <TableCell className="text-xs text-muted-foreground">
                {rec.branchName} ({rec.branchId})
              </TableCell>
            ) : null}
            <TableCell className="text-right font-medium text-gain-text tabular-nums">
              {formatMoneyFull(rec.netBenefit)}
            </TableCell>
            <TableCell>
              <Badge tone={rec.status.toLowerCase() as "pending" | "approved" | "rejected"}>
                {statusLabel(rec.status)}
              </Badge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

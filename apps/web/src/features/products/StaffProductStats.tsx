import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ChevronLeft, ChevronRight, Package, PackageCheck, Search, X } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { OrderStatusBadge } from "@/components/shared/OrderStatusBadge";
import { PageHeader } from "@/components/shared/PageHeader";
import {
  STOCK_ALERT_CATEGORIES,
  StockAlertCategoryBadge,
  StockAlertStatusBadge,
} from "@/components/shared/StockAlertBadges";
import { StockDeltaBadges } from "@/components/shared/StockDeltaBadges";
import { EmptyBlock, ErrorBlock, TableSkeleton } from "@/components/shared/states";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCard,
  TableCardFooter,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableToolbar,
} from "@/components/ui/table";
import { useAuth } from "@/features/auth/AuthContext";
import { invalidateOperationalQueries, queryKeys } from "@/hooks/queryKeys";
import { resolveStaffActiveBranch, useLocationScope } from "@/hooks/useLocationScope";
import { api } from "@/lib/api";
import {
  actionLabel,
  alertResolutionLabel,
  formatCover,
  getBahrainTodayIso,
  formatDateTime,
  formatNumber,
} from "@/lib/format";
import { ORDER_ACTION_LABELS } from "@/lib/labels";
import {
  BAHRAIN_BRANCHES,
  CATALOG_CATEGORIES,
  formatProductDisplayName,
  type PositionStatus,
  type Product,
  type ProductListQuery,
  type StockAlert,
  type StockAlertCategory,
} from "@stockflow/core";

const CATEGORIES = ["All categories", ...CATALOG_CATEGORIES] as const;

function statusBadgeConfig(status: PositionStatus | undefined): { label: string; tone: BadgeTone } {
  switch (status) {
    case "AT_RISK":
      return { label: "At Risk", tone: "risk" };
    case "OVERSTOCK":
      return { label: "Overstock", tone: "over" };
    case "HEALTHY":
      return { label: "Healthy", tone: "ok" };
    case "NEW":
    default:
      return { label: "New", tone: "fresh" };
  }
}

export function StaffProductStats() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("All categories");
  const [page, setPage] = useState(1);
  const [flagTarget, setFlagTarget] = useState<Pick<Product, "sku" | "name"> | null>(null);
  const [entry, setEntry] = useState<{ branchId: string; sku: string; date: string } | null>(null);
  const saveEntry = useMutation({
    mutationFn: api.createSalesEntry,
    onSuccess: async () => {
      setEntry(null);
      toast.success("Store count saved");
      await invalidateOperationalQueries(queryClient);
    },
    onError: (err: Error) => toast.error(err.message),
  });
  const [flagCategory, setFlagCategory] = useState<StockAlertCategory>("CRITICAL_LOW");
  const [flagReportedQty, setFlagReportedQty] = useState("");
  const [flagNote, setFlagNote] = useState("");
  const limit = 25;

  const assignedBranchIds = useMemo(
    () => (user?.branchIds && user.branchIds.length > 0 ? user.branchIds : ["Store"]),
    [user?.branchIds],
  );
  const { selectedLocation, setSelectedLocation } = useLocationScope();
  const staffBranchId = resolveStaffActiveBranch(assignedBranchIds, selectedLocation) ?? "Store";

  const handleBranchSwitch = (nextBranchId: string) => {
    if (nextBranchId === staffBranchId) return;
    setSelectedLocation(nextBranchId);
    setPage(1);
    setFlagTarget(null);
  };

  const queryParams: ProductListQuery = useMemo(
    () => ({
      page,
      limit,
      branch: staffBranchId,
      category: selectedCategory === "All categories" ? undefined : selectedCategory,
      search: search.trim() ? search.trim() : undefined,
    }),
    [page, limit, staffBranchId, selectedCategory, search],
  );

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: queryKeys.catalogProducts(queryParams as unknown as Record<string, unknown>),
    queryFn: () => api.storeProducts(queryParams),
  });

  const staffBranchParam = staffBranchId !== "Store" ? staffBranchId : undefined;
  const alertsQuery = useQuery({
    queryKey: queryKeys.stockAlerts(staffBranchParam),
    queryFn: () => api.listStockAlerts(staffBranchParam),
    enabled: Boolean(user),
  });

  const flagMutation = useMutation({
    mutationFn: (payload: Parameters<typeof api.createStockAlert>[0]) =>
      api.createStockAlert(payload),
    onSuccess: async (created) => {
      toast.success(`Submitted stock alert for ${created.sku}`);
      setFlagTarget(null);
      setFlagCategory("CRITICAL_LOW");
      setFlagReportedQty("");
      setFlagNote("");
      await queryClient.invalidateQueries({ queryKey: queryKeys.stockAlerts() });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const incomingDeliveriesQuery = useQuery({
    queryKey: queryKeys.orders({ queue: "outgoing", status: "COMMITTED", branch: staffBranchId }),
    queryFn: () =>
      api.storeDeliveries(staffBranchId),
    enabled: Boolean(staffBranchId),
  });

  const receiveMutation = useMutation({
    mutationFn: (orderId: string) =>
      api.receiveDelivery(orderId, { comment: "Confirmed received on store floor" }),
    onSuccess: async (updated) => {
      toast.success(`Marked ${formatNumber(updated.quantity)} units as received (${updated.sku})`);
      await invalidateOperationalQueries(queryClient);
    },
    onError: (err: Error) => toast.error(err.message || "Unable to mark order as received"),
  });

  const incomingDeliveries = incomingDeliveriesQuery.data?.orders ?? [];

  const branchAlerts = useMemo(
    () => (alertsQuery.data?.alerts ?? []).filter((alert) => alert.branchId === staffBranchId),
    [alertsQuery.data?.alerts, staffBranchId],
  );

  const alertBySku = useMemo(() => {
    const map = new Map<string, StockAlert>();
    for (const alert of branchAlerts) {
      const existing = map.get(alert.sku);
      if (!existing || alert.status === "PENDING") {
        map.set(alert.sku, alert);
      }
    }
    return map;
  }, [branchAlerts]);

  const products = data?.products ?? [];
  const total = data?.total ?? 0;
  const totalPages = data?.totalPages ?? 1;
  const branchSummary = data?.branchSummary;
  const fallbackBranch = useMemo(
    () => BAHRAIN_BRANCHES.find((b) => b.id === staffBranchId) ?? null,
    [staffBranchId],
  );
  const branchMeta = branchSummary?.branch ?? fallbackBranch;
  const headerTitle = branchMeta ? `${branchMeta.name} (${branchMeta.id})` : `Store Inventory (${staffBranchId})`;
  const headerSubtitle = branchMeta
    ? `Store inventory · ${branchMeta.city}, ${branchMeta.region} region · Record stock, report issues and confirm deliveries`
    : `Branch ${staffBranchId} · Live shelf stock & cover days`;

  const handleSearchChange = (val: string) => {
    setSearch(val);
    setPage(1);
  };

  const handleCategoryChange = (cat: string) => {
    setSelectedCategory(cat);
    setPage(1);
  };

  const handleFlagSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!flagTarget || !flagNote.trim()) return;
    const rawQty = flagReportedQty.trim();
    const parsedReported =
      rawQty !== "" && Number.isFinite(Number(rawQty))
        ? Math.max(0, Math.floor(Number(rawQty)))
        : undefined;
    flagMutation.mutate({
      branchId: staffBranchId,
      sku: flagTarget.sku,
      category: flagCategory,
      ...(parsedReported !== undefined ? { reportedQty: parsedReported } : {}),
      note: flagNote.trim(),
    });
  };

  return (
    <div className="space-y-6">
      <Dialog open={entry !== null} onOpenChange={(open) => { if (!open && !saveEntry.isPending) setEntry(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Record daily stock</DialogTitle><DialogDescription>{entry?.branchId} · {entry?.sku} · {entry?.date}</DialogDescription></DialogHeader>
          <form className="space-y-3" onSubmit={(event) => {
            event.preventDefault();
            if (!entry) return;
            const fields = new FormData(event.currentTarget);
            saveEntry.mutate({ ...entry, unitsSold: Number(fields.get("sold")), onHand: Number(fields.get("stock")) });
          }}>
            <label>Units sold today<Input required name="sold" type="number" min="0" step="1" /></label>
            <label>End-of-day stock<Input required name="stock" type="number" min="0" step="1" /></label>
            <p className="text-xs text-muted-foreground">Saving updates this product’s daily entry for your store.</p>
            <Button type="submit" loading={saveEntry.isPending}>Save daily entry</Button>
          </form>
        </DialogContent>
      </Dialog>
      <PageHeader
        title={headerTitle}
        subtitle={headerSubtitle}
        breadcrumbs={[{ label: "Store" }, { label: "Store inventory" }]}
        actions={
          assignedBranchIds.length > 1 ? (
            <div
              role="tablist"
              aria-label="Assigned branches"
              className="flex flex-wrap items-center gap-1.5"
            >
              {assignedBranchIds.map((bId) => {
                const branch = BAHRAIN_BRANCHES.find((b) => b.id === bId);
                const isActive = bId === staffBranchId;
                return (
                  <Button
                    key={bId}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    size="sm"
                    variant={isActive ? "primary" : "secondary"}
                    onClick={() => handleBranchSwitch(bId)}
                  >
                    {branch ? `${branch.name} (${bId})` : bId}
                  </Button>
                );
              })}
            </div>
          ) : undefined
        }
      />

      <nav aria-label="Store tasks" className="flex flex-wrap gap-2">
        <a href="#weekly-stock-check-title" className={buttonVariants({ variant: "secondary", size: "sm" })}>
          Check shelf stock
        </a>
        <a href="#store-deliveries" className={buttonVariants({ variant: "secondary", size: "sm" })}>
          <PackageCheck aria-hidden="true" /> Receive deliveries{incomingDeliveriesQuery.isSuccess && ` (${formatNumber(incomingDeliveries.length)})`}
        </a>
        <a href="#store-alerts" className={buttonVariants({ variant: "secondary", size: "sm" })}>
          <AlertTriangle aria-hidden="true" /> Track alerts{alertsQuery.isSuccess && ` (${formatNumber(branchAlerts.length)})`}
        </a>
      </nav>

      {branchSummary ? (
        <div
          aria-label="Store inventory status summary"
          className="flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-card px-4 py-3 shadow-xs"
        >
          <Badge variant="secondary">
            Total SKUs: {formatNumber(branchSummary.totalSkus)}
          </Badge>
          <Badge tone="risk" dot>
            At Risk: {formatNumber(branchSummary.statusCounts.AT_RISK)}
          </Badge>
          <Badge tone="ok" dot>
            Healthy: {formatNumber(branchSummary.statusCounts.HEALTHY)}
          </Badge>
          <Badge tone="over" dot>
            Overstock: {formatNumber(branchSummary.statusCounts.OVERSTOCK)}
          </Badge>
          {branchSummary.statusCounts.NEW > 0 ? (
            <Badge tone="fresh" dot>
              New: {formatNumber(branchSummary.statusCounts.NEW)}
            </Badge>
          ) : null}
        </div>
      ) : null}

      <section aria-labelledby="weekly-stock-check-title" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-1">
          <div>
            <h2 id="weekly-stock-check-title" tabIndex={-1} className="scroll-mt-20 text-base font-semibold text-foreground">
              Weekly Stock Check
            </h2>
            <p className="text-sm text-muted-foreground">
              Walk your branch and flag anything missing, damaged, spoiled, or otherwise off during your regular check.
            </p>
          </div>
          <Badge variant="secondary">{staffBranchId}</Badge>
        </div>

        <TableCard>
        <TableToolbar>
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search SKU or name..."
                value={search}
                onChange={(e) => handleSearchChange(e.target.value)}
                className="pl-9"
              />
              {search ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute top-1/2 right-1.5 size-6 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={() => handleSearchChange("")}
                  aria-label="Clear search"
                >
                  <X className="size-3.5" />
                </Button>
              ) : null}
            </div>

            <select
              aria-label="Filter by category"
              className="h-9 rounded-lg border border-border bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
              value={selectedCategory}
              onChange={(e) => handleCategoryChange(e.target.value)}
            >
              {CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>

            {(search || selectedCategory !== "All categories") ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSearch("");
                  setSelectedCategory("All categories");
                  setPage(1);
                }}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Reset filters
              </Button>
            ) : null}
          </div>

          <div className="text-xs text-muted-foreground">
            Showing {products.length > 0 ? (page - 1) * limit + 1 : 0}–
            {Math.min(page * limit, total)} of {formatNumber(total)} products
          </div>
        </TableToolbar>

        {isPending ? (
          <TableSkeleton rows={8} />
        ) : isError ? (
          <div className="p-8">
            <ErrorBlock message={error?.message || "Failed to load store inventory"} onRetry={() => void refetch()} />
          </div>
        ) : products.length === 0 ? (
          <div className="p-8">
            <EmptyBlock
              title="No products found"
              body={
                search || selectedCategory !== "All categories"
                  ? "Try adjusting your search query or category filter."
                  : "No products currently assigned to this branch."
              }
            />
          </div>
        ) : (
          <Table className="min-w-[740px]">
            <TableHeader>
              <TableRow>
                <TableHead className="px-2.5">Product</TableHead>
                <TableHead className="px-2.5">Category</TableHead>
                <TableHead className="px-2.5 text-right whitespace-normal leading-tight">On Hand</TableHead>
                <TableHead className="px-2.5 whitespace-normal leading-tight w-[96px]">In transit / Reserved</TableHead>
                <TableHead className="px-2.5 text-right">Velocity</TableHead>
                <TableHead className="px-2.5 text-right whitespace-normal leading-tight">Cover Days</TableHead>
                <TableHead className="px-2.5">Health</TableHead>
                <TableHead className="px-2.5 text-right">Alert</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((p) => {
                const badge = statusBadgeConfig(p.stats?.status);
                const displayName = formatProductDisplayName(p.name, p.sku);
                const alert = alertBySku.get(p.sku);
                const canFlag = Boolean(p.stats && p.stats.status !== "NEW");

                return (
                  <TableRow key={p.sku}>
                    <TableCell className="px-2.5">
                      <div className="flex items-center gap-2">
                        <div className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40 text-muted-foreground">
                          <Package className="size-3.5" />
                        </div>
                        <div className="min-w-0 max-w-[175px]">
                          <p className="truncate font-medium text-foreground">{displayName}</p>
                          <p className="font-mono text-xs text-muted-foreground">{p.sku}</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="px-2.5 text-muted-foreground">{p.category}</TableCell>
                    <TableCell className="px-2.5 text-right font-medium tabular-nums text-foreground">
                      {formatNumber(p.stats?.onHand ?? 0)}
                      <p className="text-xs text-muted-foreground">{p.stats?.lastSubmission
                        ? p.stats.lastSubmission.date === getBahrainTodayIso()
                          ? `Reported · ${formatNumber(p.stats.lastSubmission.unitsSold)} sold`
                          : `Last reported ${p.stats.lastSubmission.date}`
                        : "No store entry"}</p>
                    </TableCell>
                    <TableCell className="px-2.5">
                      <StockDeltaBadges
                        inTransit={p.stats?.inTransit}
                        reserved={p.stats?.reserved}
                      />
                    </TableCell>
                    <TableCell className="px-2.5 text-right font-medium tabular-nums text-foreground">
                      {formatNumber(p.stats?.velocity ?? 0)}/d
                    </TableCell>
                    <TableCell className="px-2.5 text-right font-medium tabular-nums text-foreground">
                      {formatCover(p.stats?.coverDays)}
                    </TableCell>
                    <TableCell className="px-2.5">
                      <Badge tone={badge.tone}>{badge.label}</Badge>
                    </TableCell>
                    <TableCell className="px-2.5 text-right">
                      <Button size="sm" variant="secondary" onClick={() => setEntry({ branchId: staffBranchId, sku: p.sku, date: getBahrainTodayIso() })}>Record count</Button>
                      {!canFlag ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : alert?.status === "PENDING" ? (
                        <Badge tone="pending">Pending review</Badge>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setFlagTarget(p);
                            setFlagCategory(
                              p.stats?.status === "AT_RISK" ? "CRITICAL_LOW" : "COUNT_MISMATCH",
                            );
                            setFlagReportedQty("");
                            setFlagNote("");
                          }}
                        >
                          <AlertTriangle className="size-3.5" aria-hidden="true" />
                          Flag stock
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}

        <TableCardFooter>
          <div className="flex w-full items-center justify-between">
            <span className="text-xs text-muted-foreground">
              Page {page} of {totalPages}
            </span>
            <div className="flex items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                disabled={page <= 1}
                aria-label="Previous page"
              >
                <ChevronLeft className="size-4" />
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
                disabled={page >= totalPages}
                aria-label="Next page"
              >
                Next
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        </TableCardFooter>
      </TableCard>
      </section>

      <TableCard>
        <TableToolbar>
          <div>
            <h2 id="store-deliveries" tabIndex={-1} className="scroll-mt-20 text-sm font-semibold text-foreground">Incoming Deliveries</h2>
            <p className="text-xs text-muted-foreground">
              Committed shipments in transit to {staffBranchId} awaiting floor receipt confirmation
            </p>
          </div>
          <Badge tone={incomingDeliveries.length > 0 ? "approved" : "ok"}>
            {formatNumber(incomingDeliveries.length)} awaiting receipt
          </Badge>
        </TableToolbar>

        {incomingDeliveriesQuery.isPending ? (
          <TableSkeleton rows={2} />
        ) : incomingDeliveriesQuery.isError ? (
          <div className="p-6">
            <ErrorBlock
              message={incomingDeliveriesQuery.error.message || "Failed to load incoming deliveries"}
              onRetry={() => void incomingDeliveriesQuery.refetch()}
            />
          </div>
        ) : incomingDeliveries.length === 0 ? (
          <div className="p-6">
            <EmptyBlock
              title="No incoming shipments awaiting receipt"
              body={`Committed transfers or supplier reorders bound for ${staffBranchId} will appear here once dispatched.`}
            />
          </div>
        ) : (
          <Table className="min-w-[700px]">
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Source / Type</TableHead>
                <TableHead className="text-right">Quantity</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {incomingDeliveries.map((order) => (
                <TableRow key={order.id}>
                  <TableCell>
                    <p className="font-medium text-foreground">
                      {formatProductDisplayName(order.productName, order.sku)}
                    </p>
                    <p className="font-mono text-xs text-muted-foreground">{order.sku}</p>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {order.sourceBranchName
                      ? `${order.sourceBranchName} (${actionLabel(order.type)})`
                      : `${actionLabel(order.type)} · Supplier`}
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums text-foreground">
                    {formatNumber(order.quantity)} units
                  </TableCell>
                  <TableCell>
                    <OrderStatusBadge status={order.status} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={receiveMutation.isPending}
                      onClick={() => receiveMutation.mutate(order.id)}
                    >
                      <PackageCheck className="size-3.5" aria-hidden="true" />
                      {ORDER_ACTION_LABELS.markReceived}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </TableCard>

      <TableCard>
        <TableToolbar>
          <div>
            <h2 id="store-alerts" tabIndex={-1} className="scroll-mt-20 text-sm font-semibold text-foreground">Recent Branch Stock Alerts</h2>
            <p className="text-xs text-muted-foreground">
              Alerts submitted at {staffBranchId} and manager resolution outcomes
            </p>
          </div>
          <Badge variant="secondary">
            {formatNumber(branchAlerts.length)} {branchAlerts.length === 1 ? "alert" : "alerts"}
          </Badge>
        </TableToolbar>

        {alertsQuery.isPending ? (
          <TableSkeleton rows={3} />
        ) : alertsQuery.isError ? (
          <div className="p-6">
            <ErrorBlock
              message={alertsQuery.error.message || "Failed to load branch stock alerts"}
              onRetry={() => void alertsQuery.refetch()}
            />
          </div>
        ) : branchAlerts.length === 0 ? (
          <div className="p-6">
            <EmptyBlock
              title="No branch alerts submitted"
              body="Flag any shortage, damaged stock, or count mismatch above to notify your cluster manager."
            />
          </div>
        ) : (
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow>
                <TableHead>SKU</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Note &amp; shelf count</TableHead>
                <TableHead>Submitted</TableHead>
                <TableHead>Status &amp; resolution</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {branchAlerts.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <p className="font-mono text-xs font-medium text-foreground">{item.sku}</p>
                    {item.productName ? (
                      <p className="max-w-[200px] truncate text-xs text-muted-foreground">
                        {formatProductDisplayName(item.productName, item.sku)}
                      </p>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <StockAlertCategoryBadge category={item.category} />
                  </TableCell>
                  <TableCell className="max-w-xs">
                    <p className="truncate text-foreground">{item.note}</p>
                    {item.reportedQty !== undefined ? (
                      <p className="text-xs text-muted-foreground tabular-nums">
                        Reported shelf count: {formatNumber(item.reportedQty)} units
                      </p>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                    {formatDateTime(item.flaggedAt)}
                  </TableCell>
                  <TableCell>
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <StockAlertStatusBadge status={item.status} />
                        {item.resolution ? (
                          <span className="text-xs font-medium text-foreground">
                            {alertResolutionLabel(item.resolution.action)}
                          </span>
                        ) : null}
                        {item.linkedOrderStatus ? (
                          <OrderStatusBadge status={item.linkedOrderStatus} />
                        ) : null}
                        {item.status !== "PENDING" && item.decidedBy ? (
                          <span className="text-xs text-muted-foreground">
                            by {item.decidedBy.name}
                          </span>
                        ) : null}
                      </div>
                      {item.resolution?.comment ? (
                        <blockquote className="border-l-2 border-border pl-2 text-xs italic text-muted-foreground">
                          {item.resolution.comment}
                        </blockquote>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </TableCard>

      <Dialog
        open={Boolean(flagTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setFlagTarget(null);
            setFlagCategory("CRITICAL_LOW");
            setFlagReportedQty("");
            setFlagNote("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Flag stock alert</DialogTitle>
            <DialogDescription>
              Notify your cluster manager about a floor stock issue for{" "}
              <span className="font-medium text-foreground">
                {flagTarget ? `${flagTarget.sku} · ${formatProductDisplayName(flagTarget.name, flagTarget.sku)}` : ""}
              </span>{" "}
              at {staffBranchId}.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleFlagSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="stock-alert-category" className="text-xs font-medium text-foreground">
                Alert category
              </label>
              <select
                id="stock-alert-category"
                value={flagCategory}
                onChange={(e) => setFlagCategory(e.target.value as StockAlertCategory)}
                className="h-9 w-full rounded-lg border border-border bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
              >
                {STOCK_ALERT_CATEGORIES.map((cat) => (
                  <option key={cat.value} value={cat.value}>
                    {cat.label}
                  </option>
                ))}
              </select>
              {STOCK_ALERT_CATEGORIES.find((cat) => cat.value === flagCategory)?.helper ? (
                <p className="text-xs text-muted-foreground">
                  {STOCK_ALERT_CATEGORIES.find((cat) => cat.value === flagCategory)?.helper}
                </p>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <label htmlFor="critical-stock-reported-qty" className="text-xs font-medium text-foreground">
                Physical shelf count (optional)
              </label>
              <Input
                id="critical-stock-reported-qty"
                type="number"
                min={0}
                step={1}
                placeholder="Observed units on shelf"
                value={flagReportedQty}
                onChange={(e) => setFlagReportedQty(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="critical-stock-note" className="text-xs font-medium text-foreground">
                Floor observation note
              </label>
              <Input
                id="critical-stock-note"
                placeholder="e.g., Front display nearly empty, damaged units, or count mismatch"
                value={flagNote}
                onChange={(e) => setFlagNote(e.target.value)}
                maxLength={500}
                required
              />
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setFlagTarget(null);
                  setFlagCategory("CRITICAL_LOW");
                  setFlagReportedQty("");
                  setFlagNote("");
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!flagNote.trim() || flagMutation.isPending}>
                {flagMutation.isPending ? "Submitting..." : "Submit alert"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

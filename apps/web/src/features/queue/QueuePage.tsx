import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  ChevronRight,
  PackageCheck,
  Plus,
  Repeat2,
  RotateCcw,
  Search,
  Send,
  X,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { DonorPicker } from "@/components/shared/DonorPicker";
import { OrderStatusBadge } from "@/components/shared/OrderStatusBadge";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyBlock, ErrorBlock, TableSkeleton } from "@/components/shared/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { QUEUE_PAGE_SIZE } from "@/config";
import { useAuth } from "@/features/auth/AuthContext";
import {
  OrderDrawer,
  type OrderActionCapabilities,
} from "@/features/queue/OrderDrawer";
import { ApproveQuantityDialog } from "@/features/queue/ApproveQuantityDialog";
import { RequestStockDialog } from "@/features/queue/RequestStockDialog";
import { invalidateOperationalQueries, queryKeys } from "@/hooks/queryKeys";
import { useLocationScope } from "@/hooks/useLocationScope";
import { api, type LifecycleOrder, type QueueLifecycleView } from "@/lib/api";
import {
  actionLabel,
  formatCover,
  formatMoney,
  formatMoneyFull,
  formatNumber,
  orderOriginLabel,
} from "@/lib/format";
import {
  ORDER_ACTION_LABELS,
  ORDER_STATUS_LABELS,
  QUEUE_TAB_LABELS,
} from "@/lib/labels";
import {
  canTransition,
  formatProductDisplayName,
  matchesProductQuery,
  type OrderOwnership,
  type OrderQueueTab,
  type OrderStatus,
  type OrderType,
  type QuantityChangeReason,
  type ReplenishmentOrder,
  type User,
} from "@stockflow/core";

export function QueuePage() {
  const { user } = useAuth();
  const canDecide = user ? user.role === "admin" || user.role === "manager" : false;
  const { selectedLocation } = useLocationScope();
  const [params, setParams] = useSearchParams();
  const filters = readFilters(params);
  const effectiveBranch = filters.branch || selectedLocation || undefined;

  const activeQuery = {
    queue: filters.tab,
    branch: effectiveBranch,
    category: filters.category || undefined,
    type: isOrderType(filters.type) ? filters.type : undefined,
    status: filters.tab === "outgoing" && isOrderStatus(filters.status) ? filters.status : undefined,
    ...(filters.tab === "suggested" ? { view: filters.view } : {}),
  };

  const kpisQuery = useQuery({
    queryKey: queryKeys.kpis(effectiveBranch),
    queryFn: () => api.kpis(effectiveBranch),
  });

  const ordersQuery = useQuery({
    queryKey: queryKeys.orders(activeQuery),
    queryFn: () => api.listOrders(activeQuery),
  });

  const incomingCountQuery = useQuery({
    queryKey: queryKeys.orders({ queue: "incoming", branch: effectiveBranch }),
    queryFn: () => api.listOrders({ queue: "incoming", branch: effectiveBranch }),
  });

  const [search, setSearch] = useState("");
  const [openOrderId, setOpenOrderId] = useState<string | null>(null);
  const lastTriggerRowIdRef = useRef<string | null>(null);

  const [requestDialogOpen, setRequestDialogOpen] = useState(false);
  const [declineTarget, setDeclineTarget] = useState<ReplenishmentOrder | null>(null);
  const [declineComment, setDeclineComment] = useState("");
  const [approveTarget, setApproveTarget] = useState<{
    order: ReplenishmentOrder;
    requiresAdminOverride: boolean;
  } | null>(null);
  const [donorModalTarget, setDonorModalTarget] = useState<{
    mode: "reroute" | "request";
    order: ReplenishmentOrder;
  } | null>(null);
  const [donorModalSelection, setDonorModalSelection] = useState<string | null>(null);
  const [donorModalComment, setDonorModalComment] = useState("");

  const queryClient = useQueryClient();

  const invalidateAll = () => invalidateOperationalQueries(queryClient);

  const commitMutation = useMutation({
    mutationFn: ({
      id,
      approvedQty,
      dispositionCode,
      comment,
      force,
    }: {
      id: string;
      approvedQty?: number;
      dispositionCode?: QuantityChangeReason;
      comment?: string;
      force?: boolean;
    }) =>
      api.commitOrder(id, {
        ...(approvedQty !== undefined ? { approvedQty } : {}),
        ...(dispositionCode ? { dispositionCode } : {}),
        ...(comment ? { comment } : {}),
        ...(force ? { force } : {}),
      }),
    onSuccess: async (updated) => {
      toast.success(
        updated.type === "TRANSFER" && updated.sourceBranchId
          ? `Sent ${formatNumber(updated.quantity)} units for ${updated.sku}`
          : `Approved ${actionLabel(updated.type).toLowerCase()} for ${updated.sku}`,
      );
      setApproveTarget(null);
      await invalidateAll();
    },
    onError: (err: Error) => toast.error(err.message || "Unable to approve order"),
  });

  const requestTransferMutation = useMutation({
    mutationFn: ({
      id,
      sourceBranchId,
      comment,
    }: {
      id: string;
      sourceBranchId?: string;
      comment?: string;
    }) =>
      api.requestOrderTransfer(id, {
        ...(sourceBranchId ? { sourceBranchId } : {}),
        ...(comment ? { comment } : {}),
      }),
    onSuccess: async (updated) => {
      toast.success(
        `Sent transfer request for ${updated.sku} to ${updated.sourceBranchName ?? updated.sourceBranchId}`,
      );
      setDonorModalTarget(null);
      setDonorModalSelection(null);
      setDonorModalComment("");
      await invalidateAll();
    },
    onError: (err: Error) => toast.error(err.message || "Unable to request transfer from sending branch"),
  });

  const declineMutation = useMutation({
    mutationFn: ({ id, comment }: { id: string; comment: string }) =>
      api.declineOrder(id, { comment }),
    onSuccess: async (updated) => {
      toast.success(`Declined order for ${updated.sku}`);
      setDeclineTarget(null);
      setDeclineComment("");
      await invalidateAll();
    },
    onError: (err: Error) => toast.error(err.message || "Unable to decline order"),
  });

  const rerouteMutation = useMutation({
    mutationFn: ({
      id,
      sourceBranchId,
      comment,
    }: {
      id: string;
      sourceBranchId: string;
      comment?: string;
    }) => api.rerouteOrder(id, { sourceBranchId, ...(comment ? { comment } : {}) }),
    onSuccess: async (updated) => {
      toast.success(
        `Rerouted ${updated.sku} request to ${updated.sourceBranchName ?? updated.sourceBranchId}`,
      );
      setDonorModalTarget(null);
      setDonorModalSelection(null);
      setDonorModalComment("");
      await invalidateAll();
    },
    onError: (err: Error) => toast.error(err.message || "Unable to reroute transfer"),
  });

  const cancelMutation = useMutation({
    mutationFn: ({ id }: { id: string }) => api.cancelOrder(id, {}),
    onSuccess: async (updated) => {
      toast.success(`Cancelled request for ${updated.sku}`);
      await invalidateAll();
    },
    onError: (err: Error) => toast.error(err.message || "Unable to cancel request"),
  });

  const receiveMutation = useMutation({
    mutationFn: ({ id }: { id: string }) => api.receiveOrder(id, {}),
    onSuccess: async (updated) => {
      toast.success(`Marked ${formatNumber(updated.quantity)} units as received (${updated.sku})`);
      await invalidateAll();
    },
    onError: (err: Error) => toast.error(err.message || "Unable to mark order as received"),
  });

  const reopenMutation = useMutation({
    mutationFn: ({ id, comment }: { id: string; comment?: string }) => api.reopenOrder(id, comment),
    onSuccess: async (updated) => {
      toast.success(`Reopened ${updated.sku} back into Pending`);
      await invalidateAll();
    },
    onError: (err: Error) => toast.error(err.message || "Unable to reopen order"),
  });

  const isAnyMutating =
    commitMutation.isPending ||
    requestTransferMutation.isPending ||
    declineMutation.isPending ||
    rerouteMutation.isPending ||
    cancelMutation.isPending ||
    receiveMutation.isPending ||
    reopenMutation.isPending;

  const serverRows = useMemo(() => ordersQuery.data?.orders ?? [], [ordersQuery.data]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return serverRows;
    return serverRows.filter(
      (row) =>
        matchesProductQuery(row, q) ||
        row.targetBranchName.toLowerCase().includes(q) ||
        row.targetBranchId.toLowerCase().includes(q) ||
        (row.sourceBranchName?.toLowerCase().includes(q) ?? false) ||
        (row.sourceBranchId?.toLowerCase().includes(q) ?? false),
    );
  }, [serverRows, search]);

  const pageCount = Math.max(1, Math.ceil(filteredRows.length / QUEUE_PAGE_SIZE));
  const page = Math.min(filters.page, pageCount);
  const startIndex = (page - 1) * QUEUE_PAGE_SIZE;
  const visible = useMemo(
    () => filteredRows.slice(startIndex, startIndex + QUEUE_PAGE_SIZE),
    [filteredRows, startIndex],
  );

  const totalWorth = useMemo(
    () =>
      ordersQuery.data?.totalNetBenefit ??
      serverRows.reduce(
        (sum, row) => sum + (row.approvedNetBenefitBhd ?? row.engineSnapshot.netBenefitBhd),
        0,
      ),
    [ordersQuery.data?.totalNetBenefit, serverRows],
  );
  const headerCount = ordersQuery.data?.total ?? serverRows.length;
  const filteredWorth = useMemo(
    () =>
      filteredRows.reduce(
        (sum, row) => sum + (row.approvedNetBenefitBhd ?? row.engineSnapshot.netBenefitBhd),
        0,
      ),
    [filteredRows],
  );

  const openOrder = useMemo(
    () => serverRows.find((row) => row.id === openOrderId) ?? null,
    [serverRows, openOrderId],
  );

  const incomingCount = incomingCountQuery.data?.total ?? 0;

  const hasActiveFilters = Boolean(
    search.trim() || filters.branch || filters.category || filters.type || filters.status,
  );

  function writeFilters(next: Partial<QueueFilters>) {
    const merged: QueueFilters = { ...filters, page: 1, ...next };
    const upcoming = new URLSearchParams();
    if (merged.tab !== "suggested") upcoming.set("tab", merged.tab);
    if (merged.tab === "suggested" && merged.view !== "pending") {
      upcoming.set("view", merged.view);
    }
    if (merged.branch) upcoming.set("branch", merged.branch);
    if (merged.category) upcoming.set("category", merged.category);
    if (merged.type) upcoming.set("type", merged.type);
    if (merged.tab === "outgoing" && merged.status) upcoming.set("status", merged.status);
    if (merged.page > 1) upcoming.set("page", String(merged.page));
    setParams(upcoming);
  }

  function clearAllFilters() {
    setSearch("");
    writeFilters({ branch: "", category: "", type: "", status: "" });
  }

  function handleCommitAction(order: ReplenishmentOrder) {
    const requiresAdminOverride = Boolean(
      user?.role === "admin" &&
        order.type === "TRANSFER" &&
        (order.status === "AWAITING_DONOR" || order.status === "OPEN_REQUEST"),
    );
    setApproveTarget({ order, requiresAdminOverride });
  }

  function handleRequestTransferAction(order: ReplenishmentOrder) {
    if (order.sourceBranchId) {
      requestTransferMutation.mutate({
        id: order.id,
        sourceBranchId: order.sourceBranchId,
      });
      return;
    }
    setDonorModalTarget({ mode: "request", order });
    setDonorModalSelection(null);
    setDonorModalComment("");
  }

  function handleOpenReroute(order: ReplenishmentOrder) {
    setDonorModalTarget({
      mode: order.status === "OPEN_REQUEST" && !order.sourceBranchId ? "request" : "reroute",
      order,
    });
    setDonorModalSelection(null);
    setDonorModalComment("");
  }

  function openRowDrawer(rowId: string) {
    lastTriggerRowIdRef.current = rowId;
    setOpenOrderId(rowId);
  }

  function handleDrawerOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      const returnId = lastTriggerRowIdRef.current;
      setOpenOrderId(null);
      if (returnId) {
        window.requestAnimationFrame(() => {
          document.querySelector<HTMLElement>(`[data-row-id="${returnId}"]`)?.focus();
        });
      }
    }
  }

  const branches = kpisQuery.data?.branches ?? [];
  const categories = kpisQuery.data?.categories ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Action queue"
        subtitle={
          ordersQuery.data
            ? `${formatNumber(headerCount)} ${filters.tab === "suggested" ? `${lifecycleViewLabel(filters.view).toLowerCase()} ` : ""}orders in view · ${formatMoney(totalWorth)} estimated gain`
            : "Governed replenishment queue across transfers, stock requests, and store orders."
        }
        actions={
          canDecide ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() => setRequestDialogOpen(true)}
            >
              <Plus className="size-4" aria-hidden="true" />
              Request Stock
            </Button>
          ) : undefined
        }
      />

      {/* Three Queue Tabs + Lifecycle Status Filter */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          value={filters.tab}
          onValueChange={(val) => {
            const nextTab = isOrderQueueTab(String(val)) ? (String(val) as OrderQueueTab) : "suggested";
            writeFilters({ tab: nextTab, status: "" });
          }}
        >
          <TabsList className="h-auto min-h-9 w-full flex-wrap justify-start rounded-xl bg-secondary p-1 sm:w-fit">
            <TabsTrigger value="suggested" className="rounded-lg px-3 text-xs font-medium">
              {QUEUE_TAB_LABELS.suggested}
            </TabsTrigger>
            <TabsTrigger value="incoming" className="rounded-lg px-3 text-xs font-medium">
              <span>{QUEUE_TAB_LABELS.incoming}</span>
              {incomingCount > 0 ? (
                <Badge tone="over" className="ml-1 px-1.5 py-0 text-[10px]">
                  {formatNumber(incomingCount)}
                </Badge>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="outgoing" className="rounded-lg px-3 text-xs font-medium">
              {QUEUE_TAB_LABELS.outgoing}
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {filters.tab === "suggested" ? (
          <div
            className="flex flex-wrap items-center gap-1 rounded-xl border border-border bg-secondary/70 p-1"
            role="group"
            aria-label="Queue lifecycle status"
          >
            {(
              [
                { value: "pending", label: "Pending" },
                { value: "in_progress", label: "In progress" },
                { value: "decided", label: "Decided" },
              ] as const
            ).map((opt) => (
              <Button
                key={opt.value}
                type="button"
                size="xs"
                variant={filters.view === opt.value ? "primary" : "ghost"}
                aria-pressed={filters.view === opt.value}
                onClick={() => writeFilters({ view: opt.value })}
                className="rounded-lg px-2.5 text-xs font-medium"
              >
                {opt.label}
              </Button>
            ))}
          </div>
        ) : null}
      </div>

      {/* Table Card */}
      <TableCard>
        <TableToolbar>
          <div className="flex flex-1 flex-wrap items-center gap-2">
            <div className="relative min-w-[200px] flex-1 sm:max-w-[260px]">
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                type="search"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  if (filters.page > 1) writeFilters({ page: 1 });
                }}
                placeholder="Search SKU, product, or branch..."
                aria-label="Search SKU or product"
                className="h-9 rounded-xl border-border bg-card pr-8 pl-8 text-xs shadow-xs"
              />
              {search ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  tooltip="Clear search"
                  aria-label="Clear search"
                  onClick={() => setSearch("")}
                  className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground"
                >
                  <X className="size-3" aria-hidden="true" />
                </Button>
              ) : null}
            </div>

            <ToolbarSelect
              ariaLabel="Filter by branch"
              value={filters.branch}
              onChange={(branch) => writeFilters({ branch })}
            >
              <option value="">All branches</option>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </ToolbarSelect>

            <ToolbarSelect
              ariaLabel="Filter by category"
              value={filters.category}
              onChange={(category) => writeFilters({ category })}
            >
              <option value="">All categories</option>
              {categories.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </ToolbarSelect>

            {filters.tab !== "incoming" ? (
              <ToolbarSelect
                ariaLabel="Filter by type"
                value={filters.type}
                onChange={(type) => writeFilters({ type })}
              >
                <option value="">All types</option>
                <option value="TRANSFER">Transfers</option>
                <option value="REORDER">Reorders</option>
                <option value="MARKDOWN">Markdowns</option>
              </ToolbarSelect>
            ) : null}

            {filters.tab === "outgoing" ? (
              <ToolbarSelect
                ariaLabel="Filter by status"
                value={filters.status}
                onChange={(status) => writeFilters({ status })}
              >
                <option value="">All statuses</option>
                <option value="OPEN_REQUEST">{ORDER_STATUS_LABELS.OPEN_REQUEST}</option>
                <option value="AWAITING_DONOR">{ORDER_STATUS_LABELS.AWAITING_DONOR}</option>
                <option value="COMMITTED">{ORDER_STATUS_LABELS.COMMITTED}</option>
                <option value="RECEIVED">{ORDER_STATUS_LABELS.RECEIVED}</option>
                <option value="REJECTED">{ORDER_STATUS_LABELS.REJECTED}</option>
                <option value="CANCELLED">{ORDER_STATUS_LABELS.CANCELLED}</option>
              </ToolbarSelect>
            ) : null}
          </div>

          <div className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
            {ordersQuery.data ? (
              <span>
                Showing <span className="font-medium text-foreground">{formatNumber(visible.length)}</span>{" "}
                of <span className="font-medium text-foreground">{formatNumber(filteredRows.length)}</span>{" "}
                · <span className="font-semibold text-foreground">{formatMoney(filteredWorth)}</span> net
                benefit
              </span>
            ) : (
              <span>Loading orders...</span>
            )}
            {hasActiveFilters ? (
              <Button variant="ghost" size="sm" onClick={clearAllFilters}>
                Clear filters
              </Button>
            ) : null}
          </div>
        </TableToolbar>

        {ordersQuery.isPending ? (
          <div className="p-4">
            <TableSkeleton rows={8} />
          </div>
        ) : ordersQuery.isError ? (
          <div className="p-4">
            <ErrorBlock message={ordersQuery.error.message} onRetry={() => void ordersQuery.refetch()} />
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="p-4">
            <EmptyBlock
              title={
                filters.tab === "incoming"
                  ? "No incoming stock requests to fulfil"
                  : filters.tab === "outgoing"
                    ? "No stock requests submitted"
                    : "No suggested orders"
              }
              body={
                hasActiveFilters
                  ? "No orders match your active filters."
                  : filters.tab === "incoming"
                    ? "Requests from other branches asking to transfer surplus stock from your stores will appear here."
                    : filters.tab === "outgoing"
                      ? "Use Request Stock to submit a replenishment request from another sending branch or supplier."
                      : "There are no open replenishment suggestions right now."
              }
              action={
                hasActiveFilters ? (
                  <Button variant="secondary" size="sm" onClick={clearAllFilters}>
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table className="min-w-[920px]">
              <TableHeader>
                <tr className="border-b border-border">
                  <TableHead className="w-[100px] px-3">Type</TableHead>
                  <TableHead className="w-[24%] px-3">Product</TableHead>
                  <TableHead className="w-[180px] px-3">Route</TableHead>
                  <TableHead className="w-[72px] px-3 text-right">Qty</TableHead>
                  {filters.tab === "incoming" ? (
                    <>
                      <TableHead className="w-[125px] px-3 text-right">Sending branch surplus</TableHead>
                      <TableHead className="w-[130px] px-3 text-right">Sending cover after</TableHead>
                    </>
                  ) : (
                    <TableHead className="w-[125px] px-3 text-right">Estimated gain</TableHead>
                  )}
                  <TableHead className="w-[130px] px-3">Status</TableHead>
                  <TableHead className="px-3 text-right">Actions</TableHead>
                </tr>
              </TableHeader>
              <TableBody>
                {visible.map((order) => {
                  const caps = getOrderCapabilities(order, user, filters.tab);

                  return (
                    <TableRow
                      key={order.id}
                      data-row-id={order.id}
                      tabIndex={0}
                      onClick={() => openRowDrawer(order.id)}
                      onKeyDown={(event) => {
                        if (event.target !== event.currentTarget) return;
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          openRowDrawer(order.id);
                        }
                      }}
                      className="cursor-pointer"
                    >
                      <TableCell className="px-3">
                        <div className="flex flex-col items-start gap-1">
                          <Badge
                            tone={
                              order.type === "TRANSFER"
                                ? "transfer"
                                : order.type === "REORDER"
                                  ? "reorder"
                                  : "markdown"
                            }
                          >
                            {actionLabel(order.type)}
                          </Badge>
                          <span className="text-[11px] text-muted-foreground">
                            {orderOriginLabel(order.origin)}
                          </span>
                        </div>
                      </TableCell>

                      <TableCell className="px-3">
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <div className="truncate font-semibold text-foreground">
                                {formatProductDisplayName(order.productName, order.sku)}
                              </div>
                            }
                          />
                          <TooltipContent side="top">
                            {formatProductDisplayName(order.productName, order.sku)}
                          </TooltipContent>
                        </Tooltip>
                        <div className="truncate text-xs text-muted-foreground">
                          <span className="font-mono">{order.sku}</span> · {order.category}
                        </div>
                      </TableCell>

                      <TableCell className="px-3">
                        {order.sourceBranchName ? (
                          <div className="min-w-0">
                            <div className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                              <span className="truncate">{order.sourceBranchName}</span>
                              <ArrowRight className="size-3 shrink-0" aria-hidden="true" />
                            </div>
                            <div className="truncate text-sm font-medium text-foreground">
                              {order.targetBranchName}
                            </div>
                          </div>
                        ) : (
                          <div>
                            <div className="truncate text-sm font-medium text-foreground">
                              {order.targetBranchName}
                            </div>
                            <div className="text-xs text-muted-foreground">{order.targetBranchId}</div>
                          </div>
                        )}
                      </TableCell>

                      <TableCell className="px-3 text-right font-medium text-foreground tabular-nums">
                        {formatNumber(order.quantity)}
                      </TableCell>

                      {filters.tab === "incoming" ? (
                        <>
                          <TableCell className="px-3 text-right font-medium text-foreground tabular-nums">
                            {order.donorAvailableSurplus !== undefined
                              ? `${formatNumber(order.donorAvailableSurplus)} units`
                              : "—"}
                          </TableCell>
                          <TableCell className="px-3 text-right text-foreground tabular-nums">
                            {formatCover(order.donorCoverDaysAfter)}
                          </TableCell>
                        </>
                      ) : (
                        <TableCell className="px-3 text-right font-semibold text-foreground tabular-nums">
                          {formatMoneyFull(
                            order.approvedNetBenefitBhd ?? order.engineSnapshot.netBenefitBhd,
                          )}
                        </TableCell>
                      )}

                      <TableCell className="px-3">
                        <div className="flex flex-col items-start gap-1">
                          <OrderStatusBadge status={order.status} />
                          {order.isEscalated ? (
                            <Badge tone="risk" className="px-1.5 py-0 text-[10px]">
                              Escalated
                            </Badge>
                          ) : null}
                          {order.reopenBadge ? (
                            <Badge
                              tone={order.reopenBadge.kind === "worsened" ? "risk" : "over"}
                              className="px-1.5 py-0 text-[10px]"
                            >
                              {order.reopenBadge.label}
                            </Badge>
                          ) : null}
                        </div>
                      </TableCell>

                      <TableCell className="px-3 text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="inline-flex flex-wrap items-center justify-end gap-1.5">
                          {canDecide && order.canReopen ? (
                            <Button
                              variant="secondary"
                              size="xs"
                              disabled={isAnyMutating}
                              onClick={() => reopenMutation.mutate({ id: order.id })}
                            >
                              <RotateCcw className="size-3.5" aria-hidden="true" />
                              Reopen
                            </Button>
                          ) : null}

                          {caps.canRelease ? (
                            <Button
                              variant="soft-success"
                              size="xs"
                              disabled={isAnyMutating}
                              onClick={() => handleCommitAction(order)}
                            >
                              <Check className="size-3.5" aria-hidden="true" />
                              {ORDER_ACTION_LABELS.sendStock}
                            </Button>
                          ) : null}

                          {caps.canCommit ? (
                            <Button
                              variant="soft-success"
                              size="xs"
                              disabled={isAnyMutating}
                              onClick={() => handleCommitAction(order)}
                            >
                              <Check className="size-3.5" aria-hidden="true" />
                              {ORDER_ACTION_LABELS.approve}
                            </Button>
                          ) : null}

                          {caps.canRequestTransfer ? (
                            <Button
                              variant="primary"
                              size="xs"
                              disabled={isAnyMutating}
                              onClick={() => handleRequestTransferAction(order)}
                            >
                              <Send className="size-3" aria-hidden="true" />
                              {ORDER_ACTION_LABELS.requestTransfer}
                            </Button>
                          ) : null}

                          {caps.canDecline ? (
                            <Button
                              variant="soft-danger"
                              size="xs"
                              disabled={isAnyMutating}
                              onClick={() => {
                                setDeclineTarget(order);
                                setDeclineComment("");
                              }}
                            >
                              <X className="size-3.5" aria-hidden="true" />
                              {ORDER_ACTION_LABELS.decline}
                            </Button>
                          ) : null}

                          {caps.canReroute ? (
                            <Button
                              variant="outline"
                              size="xs"
                              disabled={isAnyMutating}
                              onClick={() => handleOpenReroute(order)}
                            >
                              <Repeat2 className="size-3.5" aria-hidden="true" />
                              {order.sourceBranchId
                                ? ORDER_ACTION_LABELS.reroute
                                : ORDER_ACTION_LABELS.chooseSender}
                            </Button>
                          ) : null}

                          {caps.canCancel ? (
                            <Button
                              variant="ghost"
                              size="xs"
                              disabled={isAnyMutating}
                              onClick={() => cancelMutation.mutate({ id: order.id })}
                            >
                              {ORDER_ACTION_LABELS.cancel}
                            </Button>
                          ) : null}

                          {caps.canReceive ? (
                            <Button
                              variant="primary"
                              size="xs"
                              disabled={isAnyMutating}
                              onClick={() => receiveMutation.mutate({ id: order.id })}
                            >
                              <PackageCheck className="size-3.5" aria-hidden="true" />
                              {ORDER_ACTION_LABELS.markReceived}
                            </Button>
                          ) : null}

                          <Button
                            variant="ghost"
                            size="icon-xs"
                            tooltip="Inspect details"
                            aria-label={`Inspect ${order.productName}`}
                            onClick={() => openRowDrawer(order.id)}
                            className="text-muted-foreground hover:text-foreground"
                          >
                            <ChevronRight className="size-4" aria-hidden="true" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {ordersQuery.data && filteredRows.length > 0 ? (
          <TableCardFooter>
            <span className="tabular-nums">
              Rows {formatNumber(startIndex + 1)}–
              {formatNumber(Math.min(startIndex + visible.length, filteredRows.length))} of{" "}
              {formatNumber(filteredRows.length)}
            </span>
            {pageCount > 1 ? (
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={page <= 1}
                  onClick={() => writeFilters({ page: page - 1 })}
                >
                  Previous
                </Button>
                <span className="text-xs font-medium text-foreground tabular-nums">
                  Page {page} of {pageCount}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={page >= pageCount}
                  onClick={() => writeFilters({ page: page + 1 })}
                >
                  Next
                </Button>
              </div>
            ) : null}
          </TableCardFooter>
        ) : null}
      </TableCard>

      <OrderDrawer
        order={openOrder}
        open={openOrder !== null}
        onOpenChange={handleDrawerOpenChange}
        capabilities={
          openOrder
            ? getOrderCapabilities(openOrder, user, filters.tab)
            : {
                canCommit: false,
                canRequestTransfer: false,
                canRelease: false,
                canDecline: false,
                canReroute: false,
                canCancel: false,
                canReceive: false,
              }
        }
        isBusy={isAnyMutating}
        onCommit={handleCommitAction}
        onRequestTransfer={handleRequestTransferAction}
        onDecline={(o) => {
          setDeclineTarget(o);
          setDeclineComment("");
        }}
        onReroute={handleOpenReroute}
        onCancel={(o) => cancelMutation.mutate({ id: o.id })}
        onReceive={(o) => receiveMutation.mutate({ id: o.id })}
      />

      <RequestStockDialog
        open={requestDialogOpen}
        onOpenChange={setRequestDialogOpen}
        defaultBranchId={effectiveBranch ?? null}
      />

      {/* Decline Dialog (Comment Required) */}
      <Dialog
        open={declineTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeclineTarget(null);
            setDeclineComment("");
          }
        }}
      >
        <DialogContent className="max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle>Decline replenishment order</DialogTitle>
            <DialogDescription>
              Provide a reason for declining{" "}
              <span className="font-medium text-foreground">
                {declineTarget ? `${declineTarget.sku} · ${declineTarget.targetBranchName}` : ""}
              </span>
              . Your comment is recorded in the order audit trail.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label htmlFor="decline-comment" className="text-xs font-medium text-foreground">
              Decline reason (required)
            </label>
            <Input
              id="decline-comment"
              placeholder="e.g., Shelf promotion needs surplus at sending branch"
              value={declineComment}
              onChange={(e) => setDeclineComment(e.target.value)}
              maxLength={500}
              required
            />
          </div>
          <DialogFooter>
            <Button
              variant="secondary"
              disabled={declineMutation.isPending}
              onClick={() => {
                setDeclineTarget(null);
                setDeclineComment("");
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={declineMutation.isPending}
              disabled={!declineComment.trim()}
              onClick={() => {
                if (declineTarget && declineComment.trim()) {
                  declineMutation.mutate({
                    id: declineTarget.id,
                    comment: declineComment.trim(),
                  });
                }
              }}
            >
              Confirm decline
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Approve / Send Stock Quantity Dialog (with optional Admin Override) */}
      <ApproveQuantityDialog
        order={approveTarget?.order ?? null}
        open={approveTarget !== null}
        isSubmitting={commitMutation.isPending}
        requiresAdminOverride={approveTarget?.requiresAdminOverride ?? false}
        onOpenChange={(open) => {
          if (!open) {
            setApproveTarget(null);
          }
        }}
        onConfirm={(payload) => {
          if (!approveTarget) return;
          commitMutation.mutate({
            id: approveTarget.order.id,
            ...payload,
          });
        }}
      />

      {/* Reroute / Select Sending Branch Dialog */}
      <Dialog
        open={donorModalTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDonorModalTarget(null);
            setDonorModalSelection(null);
            setDonorModalComment("");
          }
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto rounded-2xl">
          <DialogHeader>
            <DialogTitle>
              {donorModalTarget?.mode === "reroute"
                ? "Reroute to another sending branch"
                : "Select sending branch"}
            </DialogTitle>
            <DialogDescription>
              Choose an eligible sending branch for{" "}
              <span className="font-medium text-foreground">
                {donorModalTarget
                  ? `${formatNumber(donorModalTarget.order.quantity)} units of ${donorModalTarget.order.sku}`
                  : ""}
              </span>
              .
            </DialogDescription>
          </DialogHeader>

          {donorModalTarget ? (
            <div className="space-y-4">
              <DonorPicker
                sku={donorModalTarget.order.sku}
                targetBranchId={donorModalTarget.order.targetBranchId}
                quantity={donorModalTarget.order.quantity}
                selectedDonorId={donorModalSelection}
                onSelectDonor={setDonorModalSelection}
                excludeBranchId={
                  donorModalTarget.mode === "reroute"
                    ? donorModalTarget.order.sourceBranchId
                    : null
                }
              />

              <div className="space-y-1.5">
                <label htmlFor="donor-modal-comment" className="text-xs font-medium text-foreground">
                  Note to sending branch (optional)
                </label>
                <Input
                  id="donor-modal-comment"
                  placeholder="Optional delivery or urgency context..."
                  value={donorModalComment}
                  onChange={(e) => setDonorModalComment(e.target.value)}
                  maxLength={500}
                />
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button
              variant="secondary"
              disabled={rerouteMutation.isPending || requestTransferMutation.isPending}
              onClick={() => {
                setDonorModalTarget(null);
                setDonorModalSelection(null);
                setDonorModalComment("");
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={rerouteMutation.isPending || requestTransferMutation.isPending}
              disabled={!donorModalSelection}
              onClick={() => {
                if (!donorModalTarget || !donorModalSelection) return;
                const cleanComment = donorModalComment.trim() || undefined;
                if (donorModalTarget.mode === "reroute") {
                  rerouteMutation.mutate({
                    id: donorModalTarget.order.id,
                    sourceBranchId: donorModalSelection,
                    ...(cleanComment ? { comment: cleanComment } : {}),
                  });
                } else {
                  requestTransferMutation.mutate({
                    id: donorModalTarget.order.id,
                    sourceBranchId: donorModalSelection,
                    ...(cleanComment ? { comment: cleanComment } : {}),
                  });
                }
              }}
            >
              Send request to sending branch
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function buildOwnership(order: ReplenishmentOrder, user: User): OrderOwnership {
  const ownsTarget = user.role === "admin" || user.branchIds.includes(order.targetBranchId);
  const ownsSource = Boolean(
    order.sourceBranchId && (user.role === "admin" || user.branchIds.includes(order.sourceBranchId)),
  );
  const intraCluster =
    order.type === "TRANSFER" &&
    Boolean(order.sourceBranchId) &&
    (user.role === "admin" ||
      (user.role === "manager" &&
        user.branchIds.includes(order.targetBranchId) &&
        user.branchIds.includes(order.sourceBranchId!)));
  const isRequester = order.requestedBy?.userId === user.id;
  return { ownsTarget, ownsSource, intraCluster, isRequester };
}

function getOrderCapabilities(
  rawOrder: LifecycleOrder,
  user: User | null,
  tab: OrderQueueTab,
): OrderActionCapabilities {
  const order: ReplenishmentOrder =
    rawOrder.status === "REJECTED" && rawOrder.lifecycleState === "pending"
      ? { ...rawOrder, status: rawOrder.origin === "ENGINE" ? "SUGGESTED" : "OPEN_REQUEST" }
      : rawOrder;

  if (!user || user.role === "staff") {
    const canReceiveStaff = Boolean(
      user &&
        order.status === "COMMITTED" &&
        user.branchIds.includes(order.targetBranchId) &&
        canTransition(order, user, "RECEIVE", {
          ownsTarget: true,
          ownsSource: false,
          intraCluster: false,
          isRequester: false,
        }).allowed,
    );
    return {
      canCommit: false,
      canRequestTransfer: false,
      canRelease: false,
      canDecline: false,
      canReroute: false,
      canCancel: false,
      canReceive: canReceiveStaff,
    };
  }

  const ownership = buildOwnership(order, user);
  const canCommitRaw = canTransition(order, user, "COMMIT", { ...ownership, hasComment: true }).allowed;
  const canRelease =
    tab === "incoming" && order.status === "AWAITING_DONOR" && canCommitRaw;
  const canCommit =
    tab === "suggested" &&
    canCommitRaw &&
    (user.role === "admin" || order.type !== "TRANSFER" || ownership.intraCluster);

  const canRequestTransfer =
    tab === "suggested" &&
    order.type === "TRANSFER" &&
    (order.status === "SUGGESTED" || order.status === "OPEN_REQUEST") &&
    !ownership.intraCluster &&
    canTransition(order, user, "REQUEST_TRANSFER", {
      ...ownership,
      targetDonorBranchId: order.sourceBranchId ?? "DONOR_PICKER",
    }).allowed;

  const canDecline = canTransition(order, user, "DECLINE", {
    ...ownership,
    hasComment: true,
  }).allowed;

  const canReroute =
    tab === "outgoing" &&
    order.type === "TRANSFER" &&
    (user.role === "admin" || ownership.ownsTarget) &&
    canTransition(order, user, "REROUTE", {
      ...ownership,
      targetDonorBranchId: "REROUTE_DONOR",
    }).allowed;

  const canCancel = canTransition(order, user, "CANCEL", ownership).allowed;
  const canReceive =
    order.status === "COMMITTED" && canTransition(order, user, "RECEIVE", ownership).allowed;

  return {
    canCommit,
    canRequestTransfer,
    canRelease,
    canDecline,
    canReroute,
    canCancel,
    canReceive,
  };
}

function ToolbarSelect({
  ariaLabel,
  value,
  onChange,
  children,
}: {
  ariaLabel: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="h-9 rounded-xl border border-border bg-card px-3 text-xs font-medium text-foreground shadow-xs transition-colors outline-none hover:border-input focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      {children}
    </select>
  );
}

interface QueueFilters {
  tab: OrderQueueTab;
  view: QueueLifecycleView;
  branch: string;
  category: string;
  type: string;
  status: string;
  page: number;
}

function readFilters(params: URLSearchParams): QueueFilters {
  const page = Number(params.get("page") ?? "1");
  const rawTab = params.get("tab") ?? "suggested";
  const rawView = params.get("view") ?? "pending";
  return {
    tab: isOrderQueueTab(rawTab) ? rawTab : "suggested",
    view: isLifecycleView(rawView) ? rawView : "pending",
    branch: params.get("branch") ?? "",
    category: params.get("category") ?? "",
    type: params.get("type") ?? "",
    status: params.get("status") ?? "",
    page: Number.isFinite(page) && page > 0 ? Math.floor(page) : 1,
  };
}

function isLifecycleView(value: string): value is QueueLifecycleView {
  return value === "pending" || value === "in_progress" || value === "decided";
}

function lifecycleViewLabel(view: QueueLifecycleView): string {
  if (view === "in_progress") return "In progress";
  if (view === "decided") return "Decided";
  return "Pending";
}

function isOrderQueueTab(value: string): value is OrderQueueTab {
  return value === "suggested" || value === "incoming" || value === "outgoing";
}

function isOrderType(value: string): value is OrderType {
  return value === "TRANSFER" || value === "REORDER" || value === "MARKDOWN";
}

function isOrderStatus(value: string): value is OrderStatus {
  return (
    value === "SUGGESTED" ||
    value === "OPEN_REQUEST" ||
    value === "AWAITING_DONOR" ||
    value === "COMMITTED" ||
    value === "RECEIVED" ||
    value === "REJECTED" ||
    value === "CANCELLED"
  );
}

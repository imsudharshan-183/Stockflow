import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, ChevronRight, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
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
import { RecommendationDrawer } from "@/features/queue/RecommendationDrawer";
import { queryKeys } from "@/hooks/queryKeys";
import { useLocationScope } from "@/hooks/useLocationScope";
import { api } from "@/lib/api";
import {
  REASON_LABELS,
  actionLabel,
  formatMoney,
  formatMoneyFull,
  formatNumber,
  statusLabel,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  formatProductDisplayName,
  matchesProductQuery,
  type Action,
  type Recommendation,
  type RecommendationQuery,
  type RecommendationStatus,
} from "@stockflow/core";

export function QueuePage() {
  const { user } = useAuth();
  const canDecide = user ? user.role === "admin" || user.role === "manager" : true;
  const { selectedLocation } = useLocationScope();
  const [params, setParams] = useSearchParams();
  const filters = readFilters(params);
  const effectiveBranch = filters.branch || selectedLocation || undefined;
  const query: RecommendationQuery = { ...toQuery(filters), branch: effectiveBranch };

  const kpis = useQuery({
    queryKey: queryKeys.kpis(effectiveBranch),
    queryFn: () => api.kpis(effectiveBranch),
  });
  const list = useQuery({
    queryKey: queryKeys.recommendations(query),
    queryFn: () => api.recommendations(query),
  });

  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const lastTriggerRowIdRef = useRef<string | null>(null);

  // Reject confirmation dialog state (shared by single row, drawer, and batch reject)
  const [rejectTargets, setRejectTargets] = useState<readonly Recommendation[] | null>(null);

  const client = useQueryClient();

  const invalidateAll = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["recommendations"] }),
      client.invalidateQueries({ queryKey: ["kpis"] }),
      client.invalidateQueries({ queryKey: ["branch"] }),
      client.invalidateQueries({ queryKey: ["product"] }),
      client.invalidateQueries({ queryKey: ["audit"] }),
    ]);
  };

  const singleDecision = useMutation({
    mutationFn: (input: { id: string; decision: "approve" | "reject" }) =>
      api.decide(input.id, input.decision),
    onSuccess: async (_data, input) => {
      toast.success(input.decision === "approve" ? "Action approved" : "Action rejected");
      setSelected((prev) => {
        if (!prev.has(input.id)) return prev;
        const next = new Set(prev);
        next.delete(input.id);
        return next;
      });
      if (input.decision === "reject") {
        setRejectTargets(null);
      }
      await invalidateAll();
    },
    onError: (err: Error) => {
      toast.error(err.message || "Unable to record decision");
    },
  });

  const batchDecision = useMutation({
    mutationFn: (input: { ids: readonly string[]; decision: "approve" | "reject"; reasonCode?: string }) =>
      api.decideBatch(input.ids, input.decision, input.reasonCode),
    onSuccess: async (data, input) => {
      const counts = { ok: 0, already_decided: 0, forbidden: 0, not_found: 0 };
      for (const item of data.results) {
        counts[item.status] += 1;
      }
      const actionLabel = input.decision === "approve" ? "Approved" : "Rejected";
      const parts: string[] = [];
      if (counts.ok > 0) parts.push(`${actionLabel} ${formatNumber(counts.ok)}`);
      if (counts.already_decided > 0) parts.push(`Already decided ${formatNumber(counts.already_decided)}`);
      if (counts.forbidden > 0) parts.push(`Forbidden ${formatNumber(counts.forbidden)}`);
      if (counts.not_found > 0) parts.push(`Not found ${formatNumber(counts.not_found)}`);
      const summary = parts.length > 0 ? parts.join(" · ") : `${actionLabel} ${formatNumber(0)}`;
      if (counts.forbidden > 0 || counts.not_found > 0) {
        toast.warning(summary);
      } else {
        toast.success(summary);
      }
      setSelected(new Set());
      setRejectTargets(null);
      await invalidateAll();
    },
    onError: (err: Error) => {
      toast.error(err.message || "Batch decision failed");
    },
  });

  const serverRows = useMemo(() => list.data?.recommendations ?? [], [list.data]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return serverRows;
    return serverRows.filter(
      (row) =>
        matchesProductQuery(row, q) ||
        row.branchName.toLowerCase().includes(q) ||
        (row.donorBranchName?.toLowerCase().includes(q) ?? false),
    );
  }, [serverRows, search]);

  const pageCount = Math.max(1, Math.ceil(filteredRows.length / QUEUE_PAGE_SIZE));
  const page = Math.min(filters.page, pageCount);
  const startIndex = (page - 1) * QUEUE_PAGE_SIZE;
  const visible = useMemo(
    () => filteredRows.slice(startIndex, startIndex + QUEUE_PAGE_SIZE),
    [filteredRows, startIndex],
  );

  // Reconcile selection when visible/filtered rows change
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const validPendingIds = new Set(
        filteredRows.filter((row) => row.status === "PENDING").map((row) => row.id),
      );
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (validPendingIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [filteredRows]);

  const totalWorth = useMemo(
    () => serverRows.reduce((sum, row) => sum + row.netBenefit, 0),
    [serverRows],
  );
  const filteredWorth = useMemo(
    () => filteredRows.reduce((sum, row) => sum + row.netBenefit, 0),
    [filteredRows],
  );

  const pendingOnPage = useMemo(
    () => visible.filter((row) => row.status === "PENDING"),
    [visible],
  );
  const selectedOnPageCount = useMemo(
    () => pendingOnPage.filter((row) => selected.has(row.id)).length,
    [pendingOnPage, selected],
  );
  const allPendingSelected =
    pendingOnPage.length > 0 && selectedOnPageCount === pendingOnPage.length;
  const somePendingSelected = selectedOnPageCount > 0 && !allPendingSelected;

  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = somePendingSelected;
    }
  }, [somePendingSelected]);

  const selectedRows = useMemo(
    () => filteredRows.filter((row) => row.status === "PENDING" && selected.has(row.id)),
    [filteredRows, selected],
  );
  const selectedWorth = useMemo(
    () => selectedRows.reduce((sum, row) => sum + row.netBenefit, 0),
    [selectedRows],
  );

  const openRecommendation = useMemo(
    () => serverRows.find((row) => row.id === openId) ?? null,
    [serverRows, openId],
  );

  const hasActiveFilters = Boolean(
    search.trim() || filters.branch || filters.category || filters.action || filters.status,
  );

  function writeFilters(next: Partial<Filters>) {
    const merged: Filters = { ...filters, page: 1, ...next };
    const upcoming = new URLSearchParams();
    if (merged.branch) upcoming.set("branch", merged.branch);
    if (merged.category) upcoming.set("category", merged.category);
    if (merged.action) upcoming.set("action", merged.action);
    if (merged.status) upcoming.set("status", merged.status);
    if (merged.page > 1) upcoming.set("page", String(merged.page));
    setParams(upcoming);
  }

  function clearAllFilters() {
    setSearch("");
    setParams(new URLSearchParams());
    setSelected(new Set());
  }

  function openRowDrawer(rowId: string) {
    lastTriggerRowIdRef.current = rowId;
    setOpenId(rowId);
  }

  function handleDrawerOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      const returnId = lastTriggerRowIdRef.current;
      setOpenId(null);
      if (returnId) {
        window.requestAnimationFrame(() => {
          const rowEl = document.querySelector<HTMLElement>(`[data-row-id="${returnId}"]`);
          rowEl?.focus();
        });
      }
    }
  }

  const activeTabValue = filters.action || "ALL";
  const branches = kpis.data?.branches ?? [];
  const categories = kpis.data?.categories ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Action queue"
        subtitle={
          list.data
            ? `${formatNumber(serverRows.length)} actions · ${formatMoney(totalWorth)} estimated gain`
            : "Ranked by estimated gain."
        }
      />

      {/* Action Type Tabs synced with Action filter */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          value={activeTabValue}
          onValueChange={(val) => {
            const nextAction = val === "ALL" ? "" : String(val);
            writeFilters({ action: nextAction });
          }}
        >
          <TabsList className="h-auto min-h-9 w-full flex-wrap justify-start rounded-xl bg-secondary p-1 sm:w-fit">
            <TabsTrigger value="ALL" className="rounded-lg px-3 text-xs font-medium">
              All
            </TabsTrigger>
            <TabsTrigger value="TRANSFER" className="rounded-lg px-3 text-xs font-medium">
              Transfers
            </TabsTrigger>
            <TabsTrigger value="REORDER" className="rounded-lg px-3 text-xs font-medium">
              Reorders
            </TabsTrigger>
            <TabsTrigger value="MARKDOWN" className="rounded-lg px-3 text-xs font-medium">
              Markdowns
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Table Card */}
      <TableCard>
        {/* Attached Toolbar Strip */}
        <TableToolbar>
          <div className="flex flex-1 flex-wrap items-center gap-2">
            {/* Search Input */}
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
                placeholder="Search SKU or product..."
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

            {/* Branch Select (only place in the app for queue branch filter) */}
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

            {/* Category Select */}
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

            {/* Status Select */}
            <ToolbarSelect
              ariaLabel="Filter by status"
              value={filters.status}
              onChange={(status) => writeFilters({ status })}
            >
              <option value="">All statuses</option>
              <option value="PENDING">Pending</option>
              <option value="APPROVED">Approved</option>
              <option value="REJECTED">Rejected</option>
            </ToolbarSelect>
          </div>

          <div className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
            {list.data ? (
              <span>
                Showing <span className="font-medium text-foreground">{formatNumber(visible.length)}</span>{" "}
                of <span className="font-medium text-foreground">{formatNumber(filteredRows.length)}</span>{" "}
                · <span className="font-semibold text-foreground">{formatMoney(filteredWorth)}</span> net
                benefit
              </span>
            ) : (
              <span>Loading queue...</span>
            )}
            {hasActiveFilters ? (
              <Button variant="ghost" size="sm" onClick={clearAllFilters}>
                Clear filters
              </Button>
            ) : null}
          </div>
        </TableToolbar>

        {/* Loading, Error, Empty, or Rows */}
        {list.isPending ? (
          <div className="p-4">
            <TableSkeleton rows={8} />
          </div>
        ) : list.isError ? (
          <div className="p-4">
            <ErrorBlock message={list.error.message} onRetry={() => void list.refetch()} />
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="p-4">
            <EmptyBlock
              title="No matching actions"
              body={
                hasActiveFilters
                  ? "No recommendations match your active filters."
                  : "There are no recommendations in the queue today."
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
          <>
            {/* Desktop & Tablet Fixed-Layout Table (>= 768px) */}
            <div className="hidden md:block">
              <Table className="min-w-[920px]">
                <TableHeader>
                  <tr className="border-b border-border">
                    {canDecide ? (
                      <TableHead className="w-9 px-2.5 text-center xl:w-10 xl:px-3">
                        <input
                          ref={selectAllRef}
                          type="checkbox"
                          aria-label="Select visible pending actions"
                          checked={allPendingSelected}
                          disabled={pendingOnPage.length === 0}
                          onChange={(event) => {
                            const next = new Set(selected);
                            for (const row of pendingOnPage) {
                              if (event.target.checked) next.add(row.id);
                              else next.delete(row.id);
                            }
                            setSelected(next);
                          }}
                          className="size-4 rounded border-input accent-primary focus-visible:ring-2 focus-visible:ring-primary/40"
                        />
                        <span className="sr-only">Select</span>
                      </TableHead>
                    ) : null}
                    <TableHead className="hidden w-11 px-2 lg:table-cell xl:w-14 xl:px-2.5">Rank</TableHead>
                    <TableHead className="w-[88px] px-2 xl:w-[112px] xl:px-2.5">Action</TableHead>
                    <TableHead className="w-[24%] border-r border-divider-soft px-3 xl:w-[28%]">
                      Product
                    </TableHead>
                    <TableHead className="w-[136px] px-2.5 lg:w-[152px] xl:w-[196px] xl:px-3">
                      Branch(es)
                    </TableHead>
                    <TableHead className="w-[54px] border-r border-divider-soft px-2.5 text-right xl:w-[72px] xl:px-3">
                      Qty
                    </TableHead>
                    <TableHead className="w-[100px] pr-4 pl-2.5 text-right xl:w-[116px] xl:pr-5">
                      Estimated gain
                    </TableHead>
                    <TableHead
                      className={cn(
                        "w-[98px] px-3 xl:w-[110px]",
                        canDecide ? "border-r border-divider-soft" : "",
                      )}
                    >
                      Status
                    </TableHead>
                    {canDecide ? (
                      <TableHead className="w-[92px] px-2.5 text-right xl:w-[104px] xl:px-3">
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    ) : (
                      <TableHead className="w-9 px-2 text-right">
                        <span className="sr-only">Details</span>
                      </TableHead>
                    )}
                  </tr>
                </TableHeader>

                <TableBody>
                  {visible.map((row) => {
                    const isSelected = selected.has(row.id);
                    const isRowApproving =
                      singleDecision.isPending &&
                      singleDecision.variables?.id === row.id &&
                      singleDecision.variables.decision === "approve";
                    const isRowRejecting =
                      singleDecision.isPending &&
                      singleDecision.variables?.id === row.id &&
                      singleDecision.variables.decision === "reject";
                    const isRowBusy = isRowApproving || isRowRejecting || batchDecision.isPending;

                    return (
                      <TableRow
                        key={row.id}
                        data-row-id={row.id}
                        data-state={isSelected ? "selected" : undefined}
                        tabIndex={0}
                        aria-label={`${actionLabel(row.action)} ${row.productName} at ${row.branchName}, net benefit ${formatMoneyFull(row.netBenefit)}`}
                        onClick={() => openRowDrawer(row.id)}
                        onKeyDown={(event) => {
                          if (event.target !== event.currentTarget) return;
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            openRowDrawer(row.id);
                          }
                        }}
                        className="cursor-pointer"
                      >
                        {canDecide ? (
                          <TableCell
                            className="w-9 px-2.5 text-center xl:w-10 xl:px-3"
                            onClick={(event) => event.stopPropagation()}
                          >
                            <input
                              type="checkbox"
                              aria-label={`Select ${row.productName}`}
                              disabled={row.status !== "PENDING"}
                              checked={isSelected}
                              onChange={(event) => {
                                const next = new Set(selected);
                                if (event.target.checked) next.add(row.id);
                                else next.delete(row.id);
                                setSelected(next);
                              }}
                              className="size-4 rounded border-input accent-primary disabled:opacity-40"
                            />
                          </TableCell>
                        ) : null}

                        {/* Rank (hidden 768-1023px) */}
                        <TableCell className="hidden px-2 text-xs font-medium text-muted-foreground tabular-nums lg:table-cell xl:px-2.5">
                          {row.rank}
                        </TableCell>

                        {/* Action Badge */}
                        <TableCell className="px-2 xl:px-2.5">
                          <Badge
                            tone={
                              row.action === "TRANSFER"
                                ? "transfer"
                                : row.action === "REORDER"
                                  ? "reorder"
                                  : "markdown"
                            }
                          >
                            {actionLabel(row.action)}
                          </Badge>
                        </TableCell>

                        {/* Product (Group 1 boundary) */}
                        <TableCell className="border-r border-divider-soft px-3">
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <div className="truncate font-semibold text-foreground">
                                  {formatProductDisplayName(row.productName, row.sku)}
                                </div>
                              }
                            />
                            <TooltipContent side="top">
                              {formatProductDisplayName(row.productName, row.sku)}
                            </TooltipContent>
                          </Tooltip>
                          <div
                            className="truncate text-xs text-muted-foreground"
                            title={`${row.sku} · ${row.category}`}
                          >
                            <span>{row.sku}</span>
                            <span className="hidden lg:inline"> · {row.category}</span>
                          </div>
                        </TableCell>

                        {/* Branch(es) */}
                        <TableCell className="px-2.5 xl:px-3">
                          {row.donorBranchName ? (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                                      <span className="truncate">{row.donorBranchName}</span>
                                      <ArrowRight className="size-3 shrink-0" aria-hidden="true" />
                                    </div>
                                    <div className="truncate text-sm font-medium text-foreground">
                                      {row.branchName}
                                    </div>
                                  </div>
                                }
                              />
                              <TooltipContent side="top">
                                Transfer from {row.donorBranchName} to {row.branchName}
                              </TooltipContent>
                            </Tooltip>
                          ) : (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <div className="truncate text-sm text-foreground">
                                    {row.branchName}
                                  </div>
                                }
                              />
                              <TooltipContent side="top">{row.branchName}</TooltipContent>
                            </Tooltip>
                          )}
                        </TableCell>

                        {/* Quantity (Group 2 boundary, right-aligned) */}
                        <TableCell className="border-r border-divider-soft px-2.5 text-right font-medium text-foreground tabular-nums xl:px-3">
                          {formatNumber(row.quantity)}
                        </TableCell>

                        {/* Net Benefit (right-aligned, most prominent number) */}
                        <TableCell className="pr-4 pl-2.5 text-right font-semibold text-foreground tabular-nums xl:pr-5">
                          {formatMoneyFull(row.netBenefit)}
                        </TableCell>

                        {/* Status (Group 3 boundary) */}
                        <TableCell
                          className={cn(
                            "px-3",
                            canDecide ? "border-r border-divider-soft" : "",
                          )}
                        >
                          <Badge
                            tone={
                              row.status === "APPROVED"
                                ? "approved"
                                : row.status === "REJECTED"
                                  ? "rejected"
                                  : "pending"
                            }
                            dot
                          >
                            {statusLabel(row.status)}
                          </Badge>
                        </TableCell>

                        {/* Actions (Group 4: horizontal icon buttons + chevron affordance) */}
                        {canDecide ? (
                          <TableCell
                            className="px-2.5 text-right xl:px-3"
                            onClick={(event) => event.stopPropagation()}
                          >
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                variant="soft-success"
                                size="icon-xs"
                                tooltip="Approve action"
                                aria-label={`Approve ${row.productName}`}
                                disabled={row.status !== "PENDING" || isRowBusy}
                                loading={isRowApproving}
                                onClick={() =>
                                  singleDecision.mutate({ id: row.id, decision: "approve" })
                                }
                              >
                                <Check className="size-3.5" aria-hidden="true" />
                              </Button>
                              <Button
                                variant="soft-danger"
                                size="icon-xs"
                                tooltip="Reject action"
                                aria-label={`Reject ${row.productName}`}
                                disabled={row.status !== "PENDING" || isRowBusy}
                                loading={isRowRejecting}
                                onClick={() => setRejectTargets([row])}
                              >
                                <X className="size-3.5" aria-hidden="true" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                tooltip="Inspect details"
                                aria-label={`Inspect ${row.productName}`}
                                onClick={() => openRowDrawer(row.id)}
                                className="ml-0.5 text-muted-foreground hover:text-foreground"
                              >
                                <ChevronRight
                                  className="size-4 shrink-0 transition-transform duration-150 group-hover/row:translate-x-0.5"
                                  aria-hidden="true"
                                />
                              </Button>
                            </div>
                          </TableCell>
                        ) : (
                          <TableCell
                            className="px-2 text-right"
                            onClick={(event) => event.stopPropagation()}
                          >
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              tooltip="Inspect details"
                              aria-label={`Inspect ${row.productName}`}
                              onClick={() => openRowDrawer(row.id)}
                              className="text-muted-foreground hover:text-foreground"
                            >
                              <ChevronRight className="size-4" aria-hidden="true" />
                            </Button>
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            {/* Mobile Compact Card List (< 768px) */}
            <div className="divide-y divide-border md:hidden" role="list" aria-label="Action queue">
              {visible.map((row) => {
                const isSelected = selected.has(row.id);
                const isRowApproving =
                  singleDecision.isPending &&
                  singleDecision.variables?.id === row.id &&
                  singleDecision.variables.decision === "approve";
                const isRowRejecting =
                  singleDecision.isPending &&
                  singleDecision.variables?.id === row.id &&
                  singleDecision.variables.decision === "reject";
                const isRowBusy = isRowApproving || isRowRejecting || batchDecision.isPending;

                return (
                  <div
                    key={row.id}
                    role="listitem"
                    data-row-id={row.id}
                    tabIndex={0}
                    onClick={() => openRowDrawer(row.id)}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        openRowDrawer(row.id);
                      }
                    }}
                    className={cn(
                      "cursor-pointer space-y-2.5 p-4 transition-colors hover:bg-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50",
                      isSelected ? "bg-row-selected" : "",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Badge
                          tone={
                            row.action === "TRANSFER"
                              ? "transfer"
                              : row.action === "REORDER"
                                ? "reorder"
                                : "markdown"
                          }
                        >
                          {actionLabel(row.action)}
                        </Badge>
                        <Badge
                          tone={
                            row.status === "APPROVED"
                              ? "approved"
                              : row.status === "REJECTED"
                                ? "rejected"
                                : "pending"
                          }
                          dot
                        >
                          {statusLabel(row.status)}
                        </Badge>
                      </div>
                      <span className="text-sm font-semibold text-foreground tabular-nums">
                        {formatMoneyFull(row.netBenefit)}
                      </span>
                    </div>

                    <div>
                      <p className="font-semibold text-foreground">
                        {formatProductDisplayName(row.productName, row.sku)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {row.sku} · {row.category} · {formatNumber(row.quantity)} units
                      </p>
                      <p className="mt-0.5 text-xs text-foreground">
                        {row.donorBranchName
                          ? `${row.donorBranchName} → ${row.branchName}`
                          : row.branchName}
                      </p>
                    </div>

                    {canDecide ? (
                      <div
                        className="flex items-center justify-between gap-2 pt-1"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                          <input
                            type="checkbox"
                            disabled={row.status !== "PENDING"}
                            checked={isSelected}
                            onChange={(event) => {
                              const next = new Set(selected);
                              if (event.target.checked) next.add(row.id);
                              else next.delete(row.id);
                              setSelected(next);
                            }}
                            className="size-4 rounded border-input accent-primary"
                          />
                          Select
                        </label>
                        <div className="flex items-center gap-1.5">
                          <Button
                            variant="soft-success"
                            size="xs"
                            disabled={row.status !== "PENDING" || isRowBusy}
                            loading={isRowApproving}
                            onClick={() =>
                              singleDecision.mutate({ id: row.id, decision: "approve" })
                            }
                          >
                            <Check className="size-3" aria-hidden="true" />
                            Approve
                          </Button>
                          <Button
                            variant="soft-danger"
                            size="xs"
                            disabled={row.status !== "PENDING" || isRowBusy}
                            loading={isRowRejecting}
                            onClick={() => setRejectTargets([row])}
                          >
                            <X className="size-3" aria-hidden="true" />
                            Reject
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* Table Card Footer (Result count + Pagination) */}
        {list.data && filteredRows.length > 0 ? (
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

      {/* Sticky Bottom Batch Action Bar (visible only when rows are selected) */}
      {canDecide && selectedRows.length > 0 ? (
        <div
          role="region"
          aria-label="Batch actions"
          className="sticky bottom-4 z-40 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border border-t-2 border-t-primary bg-card px-5 py-3 shadow-pop"
        >
          <div className="flex items-center gap-2 text-sm tabular-nums">
            <span className="font-semibold text-foreground">
              {formatNumber(selectedRows.length)} selected
            </span>
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground">
              Total estimated gain{" "}
              <span className="font-semibold text-foreground">
                {formatMoneyFull(selectedWorth)}
              </span>
            </span>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={batchDecision.isPending}
              onClick={() => setSelected(new Set())}
            >
              Clear
            </Button>
            <Button
              variant="soft-danger"
              size="sm"
              disabled={batchDecision.isPending}
              onClick={() => setRejectTargets(selectedRows)}
            >
              <X className="size-3.5" aria-hidden="true" />
              Reject selected
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={
                batchDecision.isPending && batchDecision.variables?.decision === "approve"
              }
              disabled={batchDecision.isPending}
              onClick={() =>
                batchDecision.mutate({
                  ids: selectedRows.map((r) => r.id),
                  decision: "approve",
                })
              }
            >
              <Check className="size-3.5" aria-hidden="true" />
              Approve selected
            </Button>
          </div>
        </div>
      ) : null}

      {/* Right-Hand Recommendation Detail Drawer */}
      <RecommendationDrawer
        recommendation={openRecommendation}
        open={openRecommendation !== null}
        onOpenChange={handleDrawerOpenChange}
        canDecide={canDecide}
        isApproving={
          Boolean(
            openRecommendation &&
              singleDecision.isPending &&
              singleDecision.variables?.id === openRecommendation.id &&
              singleDecision.variables.decision === "approve",
          )
        }
        isRejecting={
          Boolean(
            openRecommendation &&
              singleDecision.isPending &&
              singleDecision.variables?.id === openRecommendation.id &&
              singleDecision.variables.decision === "reject",
          )
        }
        onApprove={(row) => singleDecision.mutate({ id: row.id, decision: "approve" })}
        onRequestReject={(row) => setRejectTargets([row])}
      />

      {/* Shared Reason-Code Reject Confirmation Dialog */}
      <Dialog
        open={rejectTargets !== null && rejectTargets.length > 0}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setRejectTargets(null);
        }}
      >
        <DialogContent className="max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle>
              {rejectTargets && rejectTargets.length > 1
                ? `Reject ${formatNumber(rejectTargets.length)} selected actions?`
                : `Reject ${rejectTargets?.[0] ? formatProductDisplayName(rejectTargets[0].productName, rejectTargets[0].sku) : "action"}?`}
            </DialogTitle>
            <DialogDescription>
              Rejection records an audit log entry with the recommendation's reason codes and
              excludes {rejectTargets && rejectTargets.length > 1 ? "these moves" : "this move"} from
              execution.
            </DialogDescription>
          </DialogHeader>

          {rejectTargets && rejectTargets.length > 0 ? (
            <div className="space-y-3 text-xs">
              <div className="rounded-xl border border-border bg-secondary/40 p-3">
                <p className="font-medium text-foreground">
                  Audit reason codes to record:
                </p>
                <div className="mt-2 space-y-1.5">
                  {Array.from(
                    new Set(rejectTargets.flatMap((item) => item.reasonCodes)),
                  ).map((code) => (
                    <div key={code} className="flex flex-wrap items-baseline gap-2">
                      <Badge variant="secondary" className="shrink-0 font-mono text-[11px]">
                        {code}
                      </Badge>
                      <span className="text-muted-foreground">{REASON_LABELS[code]}</span>
                    </div>
                  ))}
                </div>
              </div>
              <p className="text-muted-foreground tabular-nums">
                Foregone estimated gain:{" "}
                <span className="font-semibold text-foreground">
                  {formatMoneyFull(
                    rejectTargets.reduce((sum, item) => sum + item.netBenefit, 0),
                  )}
                </span>
              </p>
            </div>
          ) : null}

          <DialogFooter>
            <Button
              variant="secondary"
              size="default"
              disabled={singleDecision.isPending || batchDecision.isPending}
              onClick={() => setRejectTargets(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="default"
              loading={
                (singleDecision.isPending && singleDecision.variables?.decision === "reject") ||
                (batchDecision.isPending && batchDecision.variables?.decision === "reject")
              }
              onClick={() => {
                if (!rejectTargets || rejectTargets.length === 0) return;
                if (rejectTargets.length === 1 && rejectTargets[0]) {
                  singleDecision.mutate({ id: rejectTargets[0].id, decision: "reject" });
                } else {
                  batchDecision.mutate({
                    ids: rejectTargets.map((item) => item.id),
                    decision: "reject",
                    reasonCode: rejectTargets[0]?.reasonCodes[0] ?? "MANUAL_REVIEW",
                  });
                }
              }}
            >
              Confirm reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
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

interface Filters {
  branch: string;
  category: string;
  action: string;
  status: string;
  page: number;
}

function readFilters(params: URLSearchParams): Filters {
  const page = Number(params.get("page") ?? "1");
  return {
    branch: params.get("branch") ?? "",
    category: params.get("category") ?? "",
    action: params.get("action") ?? "",
    status: params.get("status") ?? "",
    page: Number.isFinite(page) && page > 0 ? Math.floor(page) : 1,
  };
}

function toQuery(filters: Filters): RecommendationQuery {
  return {
    branch: filters.branch || undefined,
    category: filters.category || undefined,
    action: isAction(filters.action) ? filters.action : undefined,
    status: isStatus(filters.status) ? filters.status : undefined,
  };
}

function isAction(value: string): value is Action {
  return value === "TRANSFER" || value === "REORDER" || value === "MARKDOWN";
}

function isStatus(value: string): value is RecommendationStatus {
  return value === "PENDING" || value === "APPROVED" || value === "REJECTED";
}

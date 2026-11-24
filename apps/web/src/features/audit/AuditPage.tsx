import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { OrderEventRow } from "@/components/shared/OrderEventRow";
import { OrderStatusBadge } from "@/components/shared/OrderStatusBadge";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyBlock, ErrorBlock, TableSkeleton } from "@/components/shared/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { TableCard, TableCardFooter, TableToolbar } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { queryKeys } from "@/hooks/queryKeys";
import { useLocationScope } from "@/hooks/useLocationScope";
import { api } from "@/lib/api";
import {
  REASON_LABELS,
  actionLabel,
  formatMoneyFull,
  formatNumber,
  formatReasonSentence,
  orderOriginLabel,
} from "@/lib/format";
import { ORDER_STATUS_LABELS } from "@/lib/labels";
import { formatProductDisplayName, matchesProductQuery } from "@stockflow/core";

export function AuditPage() {
  const { selectedLocation } = useLocationScope();
  const branchParam = selectedLocation ?? undefined;
  const ordersQuery = useQuery({
    queryKey: queryKeys.orders({ branch: branchParam }),
    queryFn: () => api.listOrders({ branch: branchParam }),
  });

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");

  const threads = useMemo(() => {
    const all = ordersQuery.data?.orders ?? [];
    return all
      .filter((order) => !order.isVirtual && order.events.length > 0)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [ordersQuery.data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return threads.filter((order) => {
      if (statusFilter && order.status !== statusFilter) return false;
      if (typeFilter && order.type !== typeFilter) return false;
      if (!q) return true;
      const eventMatch = order.events.some(
        (ev) =>
          ev.actor.name.toLowerCase().includes(q) ||
          (ev.comment?.toLowerCase().includes(q) ?? false),
      );
      return (
        matchesProductQuery(order, q) ||
        order.id.toLowerCase().includes(q) ||
        order.targetBranchName.toLowerCase().includes(q) ||
        order.targetBranchId.toLowerCase().includes(q) ||
        (order.sourceBranchName?.toLowerCase().includes(q) ?? false) ||
        (order.sourceBranchId?.toLowerCase().includes(q) ?? false) ||
        eventMatch
      );
    });
  }, [threads, search, statusFilter, typeFilter]);

  const hasFilters = Boolean(search.trim() || statusFilter || typeFilter);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Audit log"
        subtitle={
          ordersQuery.data
            ? `${formatNumber(threads.length)} audited order threads · newest update first`
            : "One chronological event thread per replenishment order."
        }
      />

      <TableCard>
        <TableToolbar>
          <div className="flex flex-1 flex-wrap items-center gap-2">
            <div className="relative min-w-[200px] flex-1 sm:max-w-[280px]">
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search SKU, branch, actor, or comment..."
                aria-label="Search audit log"
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

            <select
              aria-label="Filter by order type"
              value={typeFilter}
              onChange={(event) => setTypeFilter(event.target.value)}
              className="h-9 rounded-xl border border-border bg-card px-3 text-xs font-medium text-foreground shadow-xs transition-colors outline-none hover:border-input focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              <option value="">All types</option>
              <option value="TRANSFER">Transfer</option>
              <option value="REORDER">Reorder</option>
              <option value="MARKDOWN">Markdown</option>
            </select>

            <select
              aria-label="Filter by status"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              className="h-9 rounded-xl border border-border bg-card px-3 text-xs font-medium text-foreground shadow-xs transition-colors outline-none hover:border-input focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              <option value="">All statuses</option>
              <option value="OPEN_REQUEST">{ORDER_STATUS_LABELS.OPEN_REQUEST}</option>
              <option value="AWAITING_DONOR">{ORDER_STATUS_LABELS.AWAITING_DONOR}</option>
              <option value="COMMITTED">{ORDER_STATUS_LABELS.COMMITTED}</option>
              <option value="RECEIVED">{ORDER_STATUS_LABELS.RECEIVED}</option>
              <option value="REJECTED">{ORDER_STATUS_LABELS.REJECTED}</option>
              <option value="CANCELLED">{ORDER_STATUS_LABELS.CANCELLED}</option>
            </select>
          </div>

          <div className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
            {ordersQuery.data ? (
              <span>
                Showing <span className="font-medium text-foreground">{formatNumber(filtered.length)}</span>{" "}
                of <span className="font-medium text-foreground">{formatNumber(threads.length)}</span>
              </span>
            ) : (
              <span>Loading audit log...</span>
            )}
            {hasFilters ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSearch("");
                  setStatusFilter("");
                  setTypeFilter("");
                }}
              >
                Clear filters
              </Button>
            ) : null}
          </div>
        </TableToolbar>

        {ordersQuery.isPending ? (
          <div className="p-4">
            <TableSkeleton rows={6} />
          </div>
        ) : ordersQuery.isError ? (
          <div className="p-4">
            <ErrorBlock
              message={ordersQuery.error.message}
              onRetry={() => void ordersQuery.refetch()}
            />
          </div>
        ) : threads.length === 0 ? (
          <div className="p-4">
            <EmptyBlock
              title="No audited orders yet"
              body="Submit, send, decline, or mark an order as received in the queue to record its immutable event thread here."
              action={
                <Link to="/queue">
                  <Button variant="secondary" size="sm">
                    Open action queue
                  </Button>
                </Link>
              }
            />
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-4">
            <EmptyBlock
              title="No matching order threads"
              body="No audited replenishment orders match your current search or filter."
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setSearch("");
                    setStatusFilter("");
                    setTypeFilter("");
                  }}
                >
                  Clear filters
                </Button>
              }
            />
          </div>
        ) : (
          <div className="space-y-4 p-4">
            {filtered.map((order) => (
              <Card
                key={order.id}
                data-thread-id={order.id}
                className="rounded-xl border border-border bg-card shadow-xs"
              >
                <CardHeader className="flex flex-col gap-2 border-b border-border/70 pb-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
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
                      <OrderStatusBadge status={order.status} />
                      <Badge variant="outline">{orderOriginLabel(order.origin)}</Badge>
                      {order.linkedAlertId ? (
                        <Badge variant="secondary" className="font-mono text-[11px]">
                          Alert {order.linkedAlertId}
                        </Badge>
                      ) : null}
                      <span className="font-mono text-[11px] text-muted-foreground">{order.id}</span>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <Link
                        to={`/products/${order.sku}`}
                        className="font-semibold text-foreground hover:text-primary hover:underline"
                      >
                        {formatProductDisplayName(order.productName, order.sku)}
                      </Link>
                      <span className="font-mono text-xs text-muted-foreground">{order.sku}</span>
                      <span className="text-muted-foreground">·</span>
                      {order.sourceBranchName ? (
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <Link
                            to={`/branches/${order.sourceBranchId}`}
                            className="hover:text-foreground hover:underline"
                          >
                            {order.sourceBranchName}
                          </Link>
                          <ArrowRight className="size-3" aria-hidden="true" />
                          <Link
                            to={`/branches/${order.targetBranchId}`}
                            className="font-medium text-foreground hover:text-primary hover:underline"
                          >
                            {order.targetBranchName}
                          </Link>
                        </span>
                      ) : (
                        <Link
                          to={`/branches/${order.targetBranchId}`}
                          className="text-xs font-medium text-foreground hover:text-primary hover:underline"
                        >
                          {order.targetBranchName}
                        </Link>
                      )}
                    </div>
                  </div>

                  <div className="flex shrink-0 flex-wrap items-baseline gap-3 text-xs tabular-nums sm:flex-col sm:items-end sm:gap-0.5">
                    <span className="font-semibold text-foreground">
                      {formatNumber(order.quantity)} units
                    </span>
                    <span className="text-muted-foreground">
                      Estimated gain{" "}
                      {formatMoneyFull(
                        order.approvedNetBenefitBhd ?? order.engineSnapshot.netBenefitBhd,
                      )}
                    </span>
                  </div>
                </CardHeader>

                <CardContent className="space-y-3 pt-3">
                  {/* Read-only System Rationale Chips */}
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[11px] font-medium text-muted-foreground">
                        System rationale:
                      </span>
                      {order.engineSnapshot.reasonCodes.map((code) => (
                        <Tooltip key={code}>
                          <TooltipTrigger
                            render={
                              <span tabIndex={0} className="inline-flex">
                                <Badge
                                  variant="secondary"
                                  className="font-mono text-[10px] tracking-tight"
                                >
                                  {code}
                                </Badge>
                              </span>
                            }
                          />
                          <TooltipContent side="top">{REASON_LABELS[code]}</TooltipContent>
                        </Tooltip>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {formatReasonSentence(order.engineSnapshot.reason)}
                    </p>
                  </div>

                  {/* Chronological Event Status Chain */}
                  <ol className="space-y-2 border-l-2 border-border pl-4" aria-label="Order event history">
                    {order.events.map((ev) => (
                      <OrderEventRow key={ev.id} event={ev} variant="timeline" />
                    ))}
                  </ol>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {ordersQuery.data && filtered.length > 0 ? (
          <TableCardFooter>
            <span className="tabular-nums">
              {formatNumber(filtered.length)} order{" "}
              {filtered.length === 1 ? "thread" : "threads"}
            </span>
          </TableCardFooter>
        ) : null}
      </TableCard>
    </div>
  );
}

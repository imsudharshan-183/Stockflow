import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "@/features/auth/AuthContext";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/shared/states";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { priorityOf, QUEUE_PAGE_SIZE } from "@/config";
import { queryKeys } from "@/hooks/queryKeys";
import { api } from "@/lib/api";
import {
  REASON_LABELS,
  actionLabel,
  formatCover,
  formatMoney,
  formatMoneyFull,
  formatNumber,
  statusLabel,
} from "@/lib/format";
import type { Action, Recommendation, RecommendationQuery, RecommendationStatus } from "@stockflow/core";

export function QueuePage() {
  const { user } = useAuth();
  const canDecide = user ? user.role === "admin" || user.role === "manager" : true;
  const [params, setParams] = useSearchParams();
  const filters = readFilters(params);
  const query = toQuery(filters);
  const kpis = useQuery({ queryKey: queryKeys.kpis, queryFn: api.kpis });
  const list = useQuery({
    queryKey: queryKeys.recommendations(query),
    queryFn: () => api.recommendations(query),
  });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const client = useQueryClient();
  const decision = useMutation({
    mutationFn: (input: { id: string; decision: "approve" | "reject" }) => api.decide(input.id, input.decision),
    onSuccess: async (_data, input) => {
      toast.success(input.decision === "approve" ? "Approved" : "Rejected");
      await client.invalidateQueries({ queryKey: ["recommendations"] });
      await client.invalidateQueries({ queryKey: ["branch"] });
      await client.invalidateQueries({ queryKey: ["product"] });
      await client.invalidateQueries({ queryKey: ["audit"] });
    },
  });

  const rows = list.data?.recommendations ?? [];
  const pageCount = Math.max(1, Math.ceil(rows.length / QUEUE_PAGE_SIZE));
  const page = Math.min(filters.page, pageCount);
  const visible = showAll ? rows : rows.slice((page - 1) * QUEUE_PAGE_SIZE, page * QUEUE_PAGE_SIZE);
  const worth = rows.reduce((sum, row) => sum + row.netBenefit, 0);
  const pendingOnPage = visible.filter((row) => row.status === "PENDING");
  const allPendingSelected = pendingOnPage.length > 0 && pendingOnPage.every((row) => selected.has(row.id));
  const open = useMemo(() => rows.find((row) => row.id === openId) ?? null, [rows, openId]);

  function write(next: Partial<Filters>) {
    const merged: Filters = { ...filters, page: 1, ...next };
    const upcoming = new URLSearchParams();
    if (merged.branch) upcoming.set("branch", merged.branch);
    if (merged.category) upcoming.set("category", merged.category);
    if (merged.action) upcoming.set("action", merged.action);
    if (merged.status) upcoming.set("status", merged.status);
    if (merged.page > 1) upcoming.set("page", String(merged.page));
    setParams(upcoming);
    setSelected(new Set());
  }

  async function decideMany(ids: readonly string[], kind: "approve" | "reject") {
    await Promise.all(ids.map((id) => api.decide(id, kind)));
    setSelected(new Set());
    await client.invalidateQueries({ queryKey: ["recommendations"] });
    await client.invalidateQueries({ queryKey: ["branch"] });
    await client.invalidateQueries({ queryKey: ["product"] });
    await client.invalidateQueries({ queryKey: ["audit"] });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Action queue"
        subtitle={
          list.data
            ? `${formatNumber(rows.length)} actions · ${formatMoney(worth)} projected net benefit`
            : "Ranked by net benefit."
        }
      />

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Filter label="Branch" value={filters.branch} onChange={(branch) => write({ branch })}>
          <option value="">All branches</option>
          {kpis.data?.branches.map((branch) => (
            <option key={branch.id} value={branch.id}>
              {branch.name}
            </option>
          ))}
        </Filter>
        <Filter label="Category" value={filters.category} onChange={(category) => write({ category })}>
          <option value="">All categories</option>
          {kpis.data?.categories.map((category) => (
            <option key={category} value={category}>
              {category}
            </option>
          ))}
        </Filter>
        <Filter label="Action" value={filters.action} onChange={(action) => write({ action })}>
          <option value="">All actions</option>
          <option value="TRANSFER">Transfer</option>
          <option value="REORDER">Reorder</option>
          <option value="MARKDOWN">Markdown</option>
        </Filter>
        <Filter label="Status" value={filters.status} onChange={(status) => write({ status })}>
          <option value="">All statuses</option>
          <option value="PENDING">Pending</option>
          <option value="APPROVED">Approved</option>
          <option value="REJECTED">Rejected</option>
        </Filter>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2">
          {canDecide ? (
            <Button
              size="sm"
              disabled={pendingOnPage.filter((row) => selected.has(row.id)).length === 0 || decision.isPending}
              onClick={() =>
                void decideMany(
                  pendingOnPage.filter((row) => selected.has(row.id)).map((row) => row.id),
                  "approve",
                )
              }
            >
              {decision.isPending ? <Spinner data-icon="inline-start" /> : null}
              Approve selected
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={() => setShowAll((current) => !current)}>
            {showAll ? "Show top 50" : "Show all"}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          {list.data ? `${formatNumber(list.data.total)} actions` : "Loading actions"}
        </p>
        {decision.isError ? <p className="text-sm text-destructive">{decision.error.message}</p> : null}
      </div>

      {list.isPending ? <LoadingBlock /> : null}
      {list.isError ? <ErrorBlock message={list.error.message} onRetry={() => void list.refetch()} /> : null}
      {list.data && rows.length === 0 ? (
        <EmptyBlock title="No actions match" body="Clear a filter to see the rest of the queue." />
      ) : null}

      {list.data && rows.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[880px] text-sm">
            <thead className="bg-muted/60 text-left text-muted-foreground">
              <tr>
                {canDecide ? (
                  <th className="px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label="Select pending actions on this page"
                      checked={allPendingSelected}
                      onChange={(event) => {
                        const next = new Set(selected);
                        for (const row of pendingOnPage) {
                          if (event.target.checked) next.add(row.id);
                          else next.delete(row.id);
                        }
                        setSelected(next);
                      }}
                    />
                  </th>
                ) : null}
                <th className="px-3 py-2 font-medium">Rank</th>
                <th className="px-3 py-2 font-medium">Action</th>
                <th className="px-3 py-2 font-medium">SKU</th>
                <th className="px-3 py-2 font-medium">Branch</th>
                <th className="px-3 py-2 font-medium">Qty</th>
                <th className="px-3 py-2 text-right font-medium">Net benefit</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium"> </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={row.id} className="border-t align-top">
                  {canDecide ? (
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label={`Select ${row.productName}`}
                        disabled={row.status !== "PENDING"}
                        checked={selected.has(row.id)}
                        onChange={(event) => {
                          const next = new Set(selected);
                          if (event.target.checked) next.add(row.id);
                          else next.delete(row.id);
                          setSelected(next);
                        }}
                      />
                    </td>
                  ) : null}
                  <td className="px-3 py-2">{row.rank}</td>
                  <td className="px-3 py-2">
                    <Badge tone={row.action === "TRANSFER" ? "transfer" : row.action === "REORDER" ? "reorder" : "markdown"}>
                      {actionLabel(row.action)}
                    </Badge>
                  </td>
                  <td className="px-3 py-2">
                    <Link className={buttonVariants({ variant: "link", size: "sm" })} to={`/products/${row.sku}`}>
                      {row.productName}
                    </Link>
                    <p className="text-xs text-muted-foreground">{row.category}</p>
                  </td>
                  <td className="px-3 py-2">
                    <Link className={buttonVariants({ variant: "link", size: "sm" })} to={`/branches/${row.branchId}`}>
                      {row.branchName}
                    </Link>
                    {row.donorBranchName ? (
                      <p className="text-xs text-muted-foreground">from {row.donorBranchName}</p>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">{formatNumber(row.quantity)}</td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Badge tone={priorityOf(row.netBenefit)}>{priorityOf(row.netBenefit)}</Badge>
                      {formatMoneyFull(row.netBenefit)}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={row.status === "APPROVED" ? "approved" : row.status === "REJECTED" ? "rejected" : "pending"}>
                      {statusLabel(row.status)}
                    </Badge>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setOpenId(row.id)}>
                        Why
                      </Button>
                      {canDecide ? (
                        <>
                          <Button
                            size="sm"
                            disabled={row.status !== "PENDING" || decision.isPending}
                            onClick={() => decision.mutate({ id: row.id, decision: "approve" })}
                          >
                            {decision.isPending && decision.variables?.id === row.id && decision.variables.decision === "approve" ? (
                              <Spinner data-icon="inline-start" />
                            ) : null}
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={row.status !== "PENDING" || decision.isPending}
                            onClick={() => decision.mutate({ id: row.id, decision: "reject" })}
                          >
                            {decision.isPending && decision.variables?.id === row.id && decision.variables.decision === "reject" ? (
                              <Spinner data-icon="inline-start" />
                            ) : null}
                            Reject
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {list.data && pageCount > 1 && !showAll ? (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => write({ page: page - 1 })}>
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {pageCount}
          </span>
          <Button size="sm" variant="outline" disabled={page >= pageCount} onClick={() => write({ page: page + 1 })}>
            Next
          </Button>
        </div>
      ) : null}

      <Sheet
        open={open !== null}
        onOpenChange={(next) => {
          if (!next) setOpenId(null);
        }}
      >
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{open ? open.productName : "Action"}</SheetTitle>
            <SheetDescription>{open ? `${actionLabel(open.action)} · ${open.branchName}` : ""}</SheetDescription>
          </SheetHeader>
          {open ? <ReasonBody recommendation={open} /> : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function ReasonBody({ recommendation }: { recommendation: Recommendation }) {
  const metrics = recommendation.metrics;
  return (
    <div className="space-y-4 text-sm">
      <p>{recommendation.reason}</p>
      <div>
        <h3 className="font-medium">Reason codes</h3>
        <ul className="mt-2 space-y-1">
          {recommendation.reasonCodes.map((code) => (
            <li key={code} className="rounded-md bg-muted px-2 py-1">
              <span className="font-medium">{code}</span>
              <span className="text-muted-foreground">: {REASON_LABELS[code]}</span>
            </li>
          ))}
        </ul>
      </div>
      <dl className="grid grid-cols-2 gap-2">
        <Fact label="On hand" value={formatNumber(metrics.onHand)} />
        <Fact label="Daily demand" value={formatNumber(metrics.velocity)} />
        <Fact label="Cover" value={formatCover(metrics.coverDays)} />
        <Fact label="Safety stock" value={formatNumber(metrics.safetyStock)} />
        <Fact label="Reorder point" value={formatNumber(metrics.reorderPoint)} />
        <Fact label="Lost units" value={formatNumber(metrics.lostUnits)} />
        <Fact label="Lost margin avoided" value={formatMoneyFull(metrics.lostMarginAvoided)} />
        <Fact label="Carrying cost saved" value={formatMoneyFull(metrics.carryingCostSaved)} />
        <Fact label="Transfer cost" value={formatMoneyFull(metrics.transferCost)} />
        <Fact label="Markdown cost" value={formatMoneyFull(metrics.markdownCost)} />
        <Fact label="Net benefit" value={formatMoneyFull(recommendation.netBenefit)} />
        <Fact label="Donor cover" value={formatCover(metrics.donorCoverDays)} />
      </dl>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border px-2 py-1.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Filter({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs text-muted-foreground">{label}</span>
      <select
        className="h-9 w-full rounded-md border border-input bg-background px-2"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
    </label>
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

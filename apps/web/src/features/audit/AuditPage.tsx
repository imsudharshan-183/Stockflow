import { useQuery } from "@tanstack/react-query";
import { Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyBlock, ErrorBlock, TableSkeleton } from "@/components/shared/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { queryKeys } from "@/hooks/queryKeys";
import { api } from "@/lib/api";
import {
  REASON_LABELS,
  actionLabel,
  formatDateTime,
  formatMoneyFull,
  formatNumber,
  statusLabel,
} from "@/lib/format";

export function AuditPage() {
  const audit = useQuery({ queryKey: queryKeys.audit, queryFn: api.audit });
  const [search, setSearch] = useState("");
  const [decisionFilter, setDecisionFilter] = useState<string>("");

  const entries = useMemo(() => audit.data?.entries ?? [], [audit.data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter((entry) => {
      if (decisionFilter && entry.decision !== decisionFilter) return false;
      if (!q) return true;
      return (
        entry.sku.toLowerCase().includes(q) ||
        entry.productName.toLowerCase().includes(q) ||
        entry.branchName.toLowerCase().includes(q) ||
        entry.branchId.toLowerCase().includes(q) ||
        entry.user.toLowerCase().includes(q)
      );
    });
  }, [entries, search, decisionFilter]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Audit log"
        subtitle={
          audit.data
            ? `${formatNumber(entries.length)} recorded decisions · newest first`
            : "Every approve and reject decision, newest first."
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
                placeholder="Search SKU, branch, or user..."
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
              aria-label="Filter by decision"
              value={decisionFilter}
              onChange={(event) => setDecisionFilter(event.target.value)}
              className="h-9 rounded-xl border border-border bg-card px-3 text-xs font-medium text-foreground shadow-xs transition-colors outline-none hover:border-input focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              <option value="">All decisions</option>
              <option value="APPROVED">Approved</option>
              <option value="REJECTED">Rejected</option>
            </select>
          </div>

          <div className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
            {audit.data ? (
              <span>
                Showing <span className="font-medium text-foreground">{formatNumber(filtered.length)}</span>{" "}
                of <span className="font-medium text-foreground">{formatNumber(entries.length)}</span>
              </span>
            ) : (
              <span>Loading audit log...</span>
            )}
            {search || decisionFilter ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSearch("");
                  setDecisionFilter("");
                }}
              >
                Clear filters
              </Button>
            ) : null}
          </div>
        </TableToolbar>

        {audit.isPending ? (
          <div className="p-4">
            <TableSkeleton rows={6} />
          </div>
        ) : audit.isError ? (
          <div className="p-4">
            <ErrorBlock message={audit.error.message} onRetry={() => void audit.refetch()} />
          </div>
        ) : entries.length === 0 ? (
          <div className="p-4">
            <EmptyBlock
              title="No decisions yet"
              body="Approve or reject an action in the queue and it will appear here with its reason codes."
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
              title="No matching audit entries"
              body="No recorded decisions match your current search or filter."
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setSearch("");
                    setDecisionFilter("");
                  }}
                >
                  Clear filters
                </Button>
              }
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table className="min-w-[880px]">
              <TableHeader>
                <tr className="border-b border-border">
                  <TableHead className="w-[156px]">Time</TableHead>
                  <TableHead className="w-[148px]">User</TableHead>
                  <TableHead className="w-[108px]">Decision</TableHead>
                  <TableHead className="w-[104px]">Action</TableHead>
                  <TableHead className="w-[22%]">Product</TableHead>
                  <TableHead className="w-[160px]">Branch</TableHead>
                  <TableHead className="w-[110px] text-right">Net benefit</TableHead>
                  <TableHead className="w-auto">Reason codes</TableHead>
                </tr>
              </TableHeader>
              <TableBody>
                {filtered.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                      {formatDateTime(entry.at)}
                    </TableCell>
                    <TableCell>
                      <div className="truncate font-medium text-foreground">{entry.user}</div>
                      {entry.actedBy ? (
                        <div className="mt-0.5">
                          <Badge tone={entry.actedBy.role} className="px-2 py-0 text-[10px]">
                            {entry.actedBy.role}
                          </Badge>
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Badge
                        tone={entry.decision === "APPROVED" ? "approved" : "rejected"}
                        dot
                      >
                        {statusLabel(entry.decision)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        tone={
                          entry.action === "TRANSFER"
                            ? "transfer"
                            : entry.action === "REORDER"
                              ? "reorder"
                              : "markdown"
                        }
                      >
                        {actionLabel(entry.action)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Link
                        to={`/products/${entry.sku}`}
                        className="block truncate font-semibold text-foreground hover:text-primary hover:underline"
                      >
                        {entry.productName}
                      </Link>
                      <div className="truncate font-mono text-xs text-muted-foreground">
                        {entry.sku}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Link
                        to={`/branches/${entry.branchId}`}
                        className="block truncate font-medium text-foreground hover:text-primary hover:underline"
                      >
                        {entry.branchName}
                      </Link>
                      <div className="truncate text-xs text-muted-foreground">
                        {entry.branchId}
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-semibold text-foreground tabular-nums">
                      {formatMoneyFull(entry.netBenefit)}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {entry.reasonCodes.map((code) => (
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
                            <TooltipContent side="top">
                              {REASON_LABELS[code]}
                            </TooltipContent>
                          </Tooltip>
                        ))}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {audit.data && filtered.length > 0 ? (
          <TableCardFooter>
            <span className="tabular-nums">
              {formatNumber(filtered.length)} audit{" "}
              {filtered.length === 1 ? "entry" : "entries"}
            </span>
          </TableCardFooter>
        ) : null}
      </TableCard>
    </div>
  );
}

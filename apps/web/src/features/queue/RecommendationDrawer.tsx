import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Check, ExternalLink, X } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { queryKeys } from "@/hooks/queryKeys";
import { api } from "@/lib/api";
import {
  REASON_LABELS,
  actionLabel,
  formatCover,
  formatMoney,
  formatMoneyFull,
  formatNumber,
  formatPct,
  statusLabel,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { formatProductDisplayName, type Recommendation } from "@stockflow/core";

export interface RecommendationDrawerProps {
  recommendation: Recommendation | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canDecide: boolean;
  isApproving: boolean;
  isRejecting: boolean;
  onApprove: (row: Recommendation) => void;
  onRequestReject: (row: Recommendation) => void;
}

export function RecommendationDrawer({
  recommendation,
  open,
  onOpenChange,
  canDecide,
  isApproving,
  isRejecting,
  onApprove,
  onRequestReject,
}: RecommendationDrawerProps) {
  const branchId = recommendation?.branchId ?? "";
  const sku = recommendation?.sku ?? "";

  const branchQuery = useQuery({
    queryKey: queryKeys.branch(branchId),
    queryFn: () => api.branch(branchId),
    enabled: open && Boolean(branchId),
  });

  const productQuery = useQuery({
    queryKey: queryKeys.product(sku),
    queryFn: () => api.product(sku),
    enabled: open && Boolean(sku),
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex flex-col gap-0 p-0">
        {recommendation ? (
          <>
            <SheetHeader className="border-b border-border bg-card px-6 py-4 pr-12">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  tone={
                    recommendation.action === "TRANSFER"
                      ? "transfer"
                      : recommendation.action === "REORDER"
                        ? "reorder"
                        : "markdown"
                  }
                >
                  {actionLabel(recommendation.action)}
                </Badge>
                <Badge
                  tone={
                    recommendation.status === "APPROVED"
                      ? "approved"
                      : recommendation.status === "REJECTED"
                        ? "rejected"
                        : "pending"
                  }
                  dot
                >
                  {statusLabel(recommendation.status)}
                </Badge>
                <span className="text-xs font-medium text-muted-foreground tabular-nums">
                  Rank #{recommendation.rank}
                </span>
              </div>
              <SheetTitle className="mt-1 text-base font-semibold tracking-tight text-foreground">
                {formatProductDisplayName(recommendation.productName, recommendation.sku)}
              </SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{recommendation.sku}</span>
                <span>·</span>
                <span>{recommendation.category}</span>
                <span>·</span>
                {recommendation.donorBranchName ? (
                  <span className="inline-flex items-center gap-1 font-medium text-foreground">
                    {recommendation.donorBranchName}
                    <ArrowRight className="size-3 text-muted-foreground" aria-hidden="true" />
                    {recommendation.branchName}
                  </span>
                ) : (
                  <span className="font-medium text-foreground">{recommendation.branchName}</span>
                )}
              </SheetDescription>
            </SheetHeader>

            <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5 text-sm">
              {/* Section 1: Rationale */}
              <section className="space-y-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Recommendation rationale
                </h3>
                <div className="rounded-xl border border-border bg-secondary/40 p-3.5 text-sm leading-relaxed text-foreground">
                  {recommendation.reason}
                </div>

                <div className="grid grid-cols-2 gap-2.5">
                  <div className="rounded-xl border border-border bg-card p-3">
                    <p className="text-xs font-medium text-muted-foreground">Why now</p>
                    <p className="mt-1 text-xs leading-snug text-foreground">
                      {recommendation.action === "MARKDOWN" ? (
                        <>
                          On hand is{" "}
                          <span className="font-semibold tabular-nums">
                            {formatNumber(recommendation.metrics.onHand)}
                          </span>{" "}
                          units ({formatCover(recommendation.metrics.coverDays)}) with no receiving
                          branch short of stock.
                        </>
                      ) : recommendation.action === "TRANSFER" ? (
                        <>
                          Receiver cover is{" "}
                          <span className="font-semibold tabular-nums">
                            {formatCover(recommendation.metrics.coverDays)}
                          </span>{" "}
                          (below 14d target); donor holds{" "}
                          <span className="font-semibold tabular-nums">
                            {formatCover(recommendation.metrics.donorCoverDays)}
                          </span>
                          .
                        </>
                      ) : (
                        <>
                          On hand is{" "}
                          <span className="font-semibold tabular-nums">
                            {formatNumber(recommendation.metrics.onHand)}
                          </span>{" "}
                          vs reorder point{" "}
                          <span className="font-semibold tabular-nums">
                            {formatNumber(recommendation.metrics.reorderPoint)}
                          </span>{" "}
                          (safety stock {formatNumber(recommendation.metrics.safetyStock)}).
                        </>
                      )}
                    </p>
                  </div>

                  <div className="rounded-xl border border-border bg-card p-3">
                    <p className="text-xs font-medium text-muted-foreground">If ignored</p>
                    <p className="mt-1 text-xs leading-snug text-foreground">
                      {recommendation.metrics.lostUnits > 0 ? (
                        <>
                          Est.{" "}
                          <span className="font-semibold text-risk-text tabular-nums">
                            {formatNumber(recommendation.metrics.lostUnits)} lost units
                          </span>{" "}
                          ({formatMoneyFull(recommendation.metrics.lostMarginAvoided)} margin at
                          risk) over lead time.
                        </>
                      ) : (
                        <>
                          Continues tying up capital with{" "}
                          <span className="font-semibold text-warn-text tabular-nums">
                            {formatMoneyFull(recommendation.metrics.carryingCostSaved)}
                          </span>{" "}
                          in avoidable holding cost.
                        </>
                      )}
                    </p>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground">Reason codes</p>
                  <div className="flex flex-wrap gap-1.5">
                    {recommendation.reasonCodes.map((code) => (
                      <Tooltip key={code}>
                        <TooltipTrigger
                          render={
                            <Badge variant="secondary" className="cursor-help font-mono text-[11px]">
                              {code}
                            </Badge>
                          }
                        />
                        <TooltipContent side="top">{REASON_LABELS[code]}</TooltipContent>
                      </Tooltip>
                    ))}
                  </div>
                </div>
              </section>

              {/* Section 2: Net benefit math */}
              <section className="space-y-2.5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Net benefit math ({formatNumber(recommendation.quantity)} units)
                </h3>
                <div className="overflow-hidden rounded-xl border border-border bg-card">
                  <dl className="divide-y divide-border text-xs">
                    <div className="flex items-center justify-between px-3.5 py-2">
                      <dt className="text-muted-foreground">+ Lost margin avoided</dt>
                      <dd className="font-medium text-gain-text tabular-nums">
                        {formatMoneyFull(recommendation.metrics.lostMarginAvoided)}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between px-3.5 py-2">
                      <dt className="text-muted-foreground">+ Carrying cost saved</dt>
                      <dd className="font-medium text-gain-text tabular-nums">
                        {formatMoneyFull(recommendation.metrics.carryingCostSaved)}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between px-3.5 py-2">
                      <dt className="text-muted-foreground">− Transfer freight cost</dt>
                      <dd className="font-medium text-muted-foreground tabular-nums">
                        {formatMoneyFull(recommendation.metrics.transferCost)}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between px-3.5 py-2">
                      <dt className="text-muted-foreground">− Markdown margin cost</dt>
                      <dd className="font-medium text-muted-foreground tabular-nums">
                        {formatMoneyFull(recommendation.metrics.markdownCost)}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between bg-table-header px-3.5 py-2.5 text-sm font-semibold text-foreground">
                      <dt>Projected net benefit</dt>
                      <dd className="tabular-nums">{formatMoneyFull(recommendation.netBenefit)}</dd>
                    </div>
                  </dl>
                </div>

                <div className="grid grid-cols-3 gap-2 text-xs">
                  <MetricTile label="On hand" value={formatNumber(recommendation.metrics.onHand)} />
                  <MetricTile
                    label="Daily velocity"
                    value={`${formatNumber(recommendation.metrics.velocity)}/d`}
                  />
                  <MetricTile label="Cover" value={formatCover(recommendation.metrics.coverDays)} />
                </div>
              </section>

              {/* Section 3: Compact Branch Summary */}
              <section className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Branch summary
                  </h3>
                  <Link
                    to={`/branches/${recommendation.branchId}`}
                    onClick={() => onOpenChange(false)}
                    className={cn(
                      buttonVariants({ variant: "ghost", size: "xs" }),
                      "gap-1 px-2 text-xs text-primary hover:text-primary-hover",
                    )}
                  >
                    Open full page
                    <ExternalLink className="size-3" aria-hidden="true" />
                  </Link>
                </div>

                {branchQuery.isPending ? (
                  <Skeleton className="h-20 w-full rounded-xl" />
                ) : branchQuery.data ? (
                  <div className="rounded-xl border border-border bg-card p-3.5">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold text-foreground">
                          {branchQuery.data.branch.name}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {branchQuery.data.branch.city} · {branchQuery.data.branch.region}
                        </p>
                      </div>
                      <div className="text-right text-xs">
                        <p className="text-muted-foreground">Stockout rate</p>
                        <p className="font-semibold text-foreground tabular-nums">
                          {formatPct(branchQuery.data.stockoutRate)}
                        </p>
                      </div>
                    </div>
                    <div className="mt-2.5 grid grid-cols-3 gap-2 border-t border-border pt-2.5 text-xs">
                      <div>
                        <p className="text-muted-foreground">Inventory</p>
                        <p className="font-medium text-foreground tabular-nums">
                          {formatMoney(branchQuery.data.inventoryValue)}
                        </p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Excess stock</p>
                        <p className="font-medium text-foreground tabular-nums">
                          {formatMoney(branchQuery.data.cashReleasable)}
                        </p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Rev at risk</p>
                        <p className="font-medium text-foreground tabular-nums">
                          {formatMoney(branchQuery.data.lostSalesAtRisk)}
                        </p>
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">Branch summary unavailable.</p>
                )}
              </section>

              {/* Section 4: Compact SKU Summary */}
              <section className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    SKU summary
                  </h3>
                  <Link
                    to={`/products/${recommendation.sku}`}
                    onClick={() => onOpenChange(false)}
                    className={cn(
                      buttonVariants({ variant: "ghost", size: "xs" }),
                      "gap-1 px-2 text-xs text-primary hover:text-primary-hover",
                    )}
                  >
                    Open full page
                    <ExternalLink className="size-3" aria-hidden="true" />
                  </Link>
                </div>

                {productQuery.isPending ? (
                  <Skeleton className="h-20 w-full rounded-xl" />
                ) : productQuery.data ? (
                  <div className="rounded-xl border border-border bg-card p-3.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-foreground">
                          {formatProductDisplayName(
                            productQuery.data.product.name,
                            productQuery.data.product.sku,
                          )}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {productQuery.data.product.sku} · Lead time{" "}
                          {productQuery.data.product.leadTimeDays}d
                        </p>
                      </div>
                      <div className="shrink-0 text-right text-xs tabular-nums">
                        <p className="text-muted-foreground">Price / Cost</p>
                        <p className="font-semibold text-foreground">
                          {formatMoneyFull(productQuery.data.product.price)} /{" "}
                          {formatMoneyFull(productQuery.data.product.cost)}
                        </p>
                      </div>
                    </div>
                    <div className="mt-2.5 grid grid-cols-3 gap-2 border-t border-border pt-2.5 text-xs">
                      <div>
                        <p className="text-muted-foreground">At-risk branches</p>
                        <p className="font-medium text-risk-text tabular-nums">
                          {
                            productQuery.data.positions.filter((p) => p.status === "AT_RISK")
                              .length
                          }
                        </p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Overstock</p>
                        <p className="font-medium text-warn-text tabular-nums">
                          {
                            productQuery.data.positions.filter((p) => p.status === "OVERSTOCK")
                              .length
                          }
                        </p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Healthy</p>
                        <p className="font-medium text-gain-text tabular-nums">
                          {
                            productQuery.data.positions.filter((p) => p.status === "HEALTHY")
                              .length
                          }
                        </p>
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">SKU summary unavailable.</p>
                )}
              </section>
            </div>

            {canDecide ? (
              <div className="flex items-center justify-end gap-2.5 border-t border-border bg-card px-6 py-4">
                <Button
                  variant="soft-danger"
                  size="default"
                  disabled={recommendation.status !== "PENDING" || isApproving || isRejecting}
                  loading={isRejecting}
                  onClick={() => onRequestReject(recommendation)}
                >
                  <X className="size-4" aria-hidden="true" />
                  Reject
                </Button>
                <Button
                  variant="primary"
                  size="default"
                  disabled={recommendation.status !== "PENDING" || isApproving || isRejecting}
                  loading={isApproving}
                  onClick={() => onApprove(recommendation)}
                >
                  <Check className="size-4" aria-hidden="true" />
                  Approve
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-xs font-semibold text-foreground tabular-nums">{value}</dd>
    </div>
  );
}

import { ArrowRight, Check, ExternalLink, PackageCheck, Repeat2, X } from "lucide-react";
import { Link } from "react-router-dom";
import { OrderStatusBadge } from "@/components/shared/OrderStatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  REASON_LABELS,
  actionLabel,
  formatCover,
  formatDateTime,
  formatDistanceKm,
  formatMoneyFull,
  formatMoneyPrecise,
  formatNumber,
  formatReasonSentence,
  orderOriginLabel,
  orderStatusLabel,
} from "@/lib/format";
import {
  ORDER_ACTION_LABELS,
  getOrderEventDisplayLabel,
  quantityReasonLabel,
} from "@/lib/labels";
import { cn } from "@/lib/utils";
import { formatProductDisplayName, type ReplenishmentOrder } from "@stockflow/core";

export interface OrderActionCapabilities {
  canCommit: boolean;
  canRequestTransfer: boolean;
  canRelease: boolean;
  canDecline: boolean;
  canReroute: boolean;
  canCancel: boolean;
  canReceive: boolean;
}

export interface OrderDrawerProps {
  order: ReplenishmentOrder | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  capabilities: OrderActionCapabilities;
  isBusy: boolean;
  onCommit: (order: ReplenishmentOrder) => void;
  onRequestTransfer: (order: ReplenishmentOrder) => void;
  onDecline: (order: ReplenishmentOrder) => void;
  onReroute: (order: ReplenishmentOrder) => void;
  onCancel: (order: ReplenishmentOrder) => void;
  onReceive: (order: ReplenishmentOrder) => void;
}

export function OrderDrawer({
  order,
  open,
  onOpenChange,
  capabilities,
  isBusy,
  onCommit,
  onRequestTransfer,
  onDecline,
  onReroute,
  onCancel,
  onReceive,
}: OrderDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex flex-col gap-0 p-0 sm:max-w-lg">
        {order ? (
          <>
            <SheetHeader className="border-b border-border bg-card px-6 py-4 pr-12">
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
                {order.isEscalated ? <Badge tone="risk">24h Escalated</Badge> : null}
              </div>

              <SheetTitle className="mt-2 text-lg leading-snug font-semibold text-foreground">
                {formatProductDisplayName(order.productName, order.sku)}
              </SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <span className="font-mono">{order.sku}</span>
                <span>·</span>
                <span>{order.category}</span>
                <span>·</span>
                <span>
                  {order.sourceBranchName
                    ? `${order.sourceBranchName} → ${order.targetBranchName}`
                    : order.targetBranchName}
                </span>
              </SheetDescription>
            </SheetHeader>

            <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
              {/* Summary Strip */}
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-border bg-card p-3.5 shadow-xs">
                  <p className="text-xs text-muted-foreground">Order quantity</p>
                  <p className="mt-1 text-xl font-semibold text-foreground tabular-nums">
                    {formatNumber(order.quantity)} units
                  </p>
                  {order.engineSnapshot.qty !== undefined &&
                  order.engineSnapshot.qty !== order.quantity ? (
                    <p className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
                      Engine suggested: {formatNumber(order.engineSnapshot.qty)} units
                    </p>
                  ) : null}
                </div>
                <div className="rounded-xl border border-border bg-card p-3.5 shadow-xs">
                  <p className="text-xs text-muted-foreground">Estimated gain</p>
                  <p className="mt-1 text-xl font-semibold text-foreground tabular-nums">
                    {formatMoneyFull(
                      order.approvedNetBenefitBhd ?? order.engineSnapshot.netBenefitBhd,
                    )}
                  </p>
                </div>
              </div>

              {/* Freight & Live Sending Branch State */}
              {order.type === "TRANSFER" && order.sourceBranchId ? (
                <div className="rounded-xl border border-border bg-secondary/40 p-4 text-xs">
                  <p className="font-semibold text-foreground">Transfer &amp; sending branch capacity</p>
                  <dl className="mt-2 grid grid-cols-2 gap-2 tabular-nums">
                    <div>
                      <dt className="text-muted-foreground">Distance</dt>
                      <dd className="font-medium text-foreground">
                        {order.engineSnapshot.distanceKm !== null &&
                        order.engineSnapshot.distanceKm !== undefined
                          ? formatDistanceKm(order.engineSnapshot.distanceKm)
                          : "—"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Freight cost</dt>
                      <dd className="font-medium text-foreground">
                        {(order.approvedFreightCostBhd ?? order.engineSnapshot.freightCostBhd) !==
                        undefined
                          ? formatMoneyPrecise(
                              (order.approvedFreightCostBhd ??
                                order.engineSnapshot.freightCostBhd)!,
                            )
                          : "—"}
                      </dd>
                    </div>
                    {order.donorAvailableSurplus !== undefined ? (
                      <div>
                        <dt className="text-muted-foreground">Sending branch available surplus</dt>
                        <dd className="font-medium text-foreground">
                          {formatNumber(order.donorAvailableSurplus)} units
                        </dd>
                      </div>
                    ) : null}
                    {order.donorCoverDaysAfter !== undefined ? (
                      <div>
                        <dt className="text-muted-foreground">Sending branch cover after sending</dt>
                        <dd className="font-medium text-foreground">
                          {formatCover(order.donorCoverDaysAfter)}
                        </dd>
                      </div>
                    ) : null}
                  </dl>
                </div>
              ) : null}

              {/* Read-only System Rationale */}
              <div className="space-y-2 rounded-xl border border-border bg-card p-4">
                <p className="text-xs font-semibold text-foreground">System rationale (read-only)</p>
                <p className="text-xs text-muted-foreground">
                  {formatReasonSentence(order.engineSnapshot.reason)}
                </p>
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {order.engineSnapshot.reasonCodes.map((code) => (
                    <Badge
                      key={code}
                      variant="secondary"
                      title={REASON_LABELS[code]}
                      className="font-mono text-[10px]"
                    >
                      {code}
                    </Badge>
                  ))}
                </div>
              </div>

              {/* Immutable Event Trail */}
              <div className="space-y-2">
                <p className="text-xs font-semibold text-foreground">
                  Audit trail ({formatNumber(order.events.length)})
                </p>
                {order.events.length === 0 ? (
                  <p className="rounded-xl border border-border bg-secondary/30 p-3 text-xs text-muted-foreground">
                    Virtual engine suggestion — materializes into an audited order on first action.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {order.events.map((ev) => (
                      <div key={ev.id} className="rounded-xl border border-border bg-card p-3 text-xs">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-semibold text-foreground">
                              {getOrderEventDisplayLabel(ev)}
                            </span>
                            <span className="inline-flex items-center gap-1 text-muted-foreground">
                              {ev.fromStatus ? (
                                <>
                                  <span>{orderStatusLabel(ev.fromStatus)}</span>
                                  <ArrowRight className="size-3" aria-hidden="true" />
                                </>
                              ) : null}
                              <span className="font-medium text-foreground">
                                {orderStatusLabel(ev.toStatus)}
                              </span>
                            </span>
                            {ev.isAdminOverride ? <Badge tone="over">Override</Badge> : null}
                            {ev.engineQty !== undefined &&
                            ev.approvedQty !== undefined &&
                            ev.engineQty !== ev.approvedQty ? (
                              <Badge variant="outline" className="text-[10px] tabular-nums">
                                {`Engine: ${formatNumber(ev.engineQty)} -> Approved: ${formatNumber(ev.approvedQty)}${
                                  ev.dispositionCode
                                    ? ` (${quantityReasonLabel(ev.dispositionCode)})`
                                    : ""
                                }`}
                              </Badge>
                            ) : null}
                          </div>
                          <span className="text-muted-foreground tabular-nums">
                            {formatDateTime(ev.at)}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center gap-1.5 text-muted-foreground">
                          <span>{ev.actor.name}</span>
                          <Badge tone={ev.actor.role} className="px-1.5 py-0 text-[10px]">
                            {ev.actor.role}
                          </Badge>
                        </div>
                        {ev.comment ? (
                          <blockquote className="mt-2 border-l-2 border-border pl-3 text-xs italic text-foreground">
                            {ev.comment}
                          </blockquote>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Navigation links */}
              <div className="flex flex-wrap gap-2">
                <Link
                  to={`/branches/${order.targetBranchId}`}
                  className={cn(buttonVariants({ variant: "outline", size: "xs" }))}
                >
                  Open {order.targetBranchName}
                  <ExternalLink className="size-3" aria-hidden="true" />
                </Link>
                <Link
                  to={`/products/${order.sku}`}
                  className={cn(buttonVariants({ variant: "outline", size: "xs" }))}
                >
                  Open {order.sku}
                  <ExternalLink className="size-3" aria-hidden="true" />
                </Link>
              </div>
            </div>

            {/* Footer actions */}
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-card px-6 py-4">
              {capabilities.canCancel ? (
                <Button variant="ghost" size="sm" disabled={isBusy} onClick={() => onCancel(order)}>
                  Cancel request
                </Button>
              ) : null}
              {capabilities.canDecline ? (
                <Button
                  variant="soft-danger"
                  size="sm"
                  disabled={isBusy}
                  onClick={() => onDecline(order)}
                >
                  <X className="size-3.5" aria-hidden="true" />
                  {ORDER_ACTION_LABELS.decline}
                </Button>
              ) : null}
              {capabilities.canReroute ? (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={isBusy}
                  onClick={() => onReroute(order)}
                >
                  <Repeat2 className="size-3.5" aria-hidden="true" />
                  {order.sourceBranchId
                    ? ORDER_ACTION_LABELS.reroute
                    : ORDER_ACTION_LABELS.chooseSender}
                </Button>
              ) : null}
              {capabilities.canRequestTransfer ? (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={isBusy}
                  onClick={() => onRequestTransfer(order)}
                >
                  {ORDER_ACTION_LABELS.requestTransfer}
                </Button>
              ) : null}
              {capabilities.canRelease || capabilities.canCommit ? (
                <Button
                  variant="soft-success"
                  size="sm"
                  disabled={isBusy}
                  onClick={() => onCommit(order)}
                >
                  <Check className="size-3.5" aria-hidden="true" />
                  {capabilities.canRelease
                    ? ORDER_ACTION_LABELS.sendStock
                    : ORDER_ACTION_LABELS.approve}
                </Button>
              ) : null}
              {capabilities.canReceive ? (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={isBusy}
                  onClick={() => onReceive(order)}
                >
                  <PackageCheck className="size-3.5" aria-hidden="true" />
                  {ORDER_ACTION_LABELS.markReceived}
                </Button>
              ) : null}
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

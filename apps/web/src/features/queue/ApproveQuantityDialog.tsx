import { AlertTriangle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
  actionLabel,
  formatMoneyFull,
  formatMoneyPrecise,
  formatNumber,
} from "@/lib/format";
import { ORDER_ACTION_LABELS, QUANTITY_REASON_LABELS } from "@/lib/labels";
import {
  DEFAULT_POLICY,
  QuantityChangeReasonSchema,
  computeActionBenefitForQuantity,
  round3,
  totalTransferCostBreakdown,
  type QuantityChangeReason,
  type ReplenishmentOrder,
} from "@stockflow/core";

export interface ApproveQuantityConfirmPayload {
  approvedQty: number;
  dispositionCode?: QuantityChangeReason;
  comment?: string;
  force?: boolean;
}

export interface ApproveQuantityDialogProps {
  order: ReplenishmentOrder | null;
  open: boolean;
  isSubmitting: boolean;
  requiresAdminOverride: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (payload: ApproveQuantityConfirmPayload) => void;
}

const REASON_OPTIONS = QuantityChangeReasonSchema.options;

export function ApproveQuantityDialog({
  order,
  open,
  isSubmitting,
  requiresAdminOverride,
  onOpenChange,
  onConfirm,
}: ApproveQuantityDialogProps) {
  const engineQty = order ? (order.engineSnapshot.qty ?? order.quantity) : 0;

  const [qtyInput, setQtyInput] = useState("");
  const [reason, setReason] = useState<QuantityChangeReason | "">("");
  const [comment, setComment] = useState("");

  useEffect(() => {
    if (open && order) {
      setQtyInput(String(order.engineSnapshot.qty ?? order.quantity));
      setReason("");
      setComment("");
    }
  }, [open, order]);

  const minQty = order?.type === "TRANSFER" ? DEFAULT_POLICY.minTransferQty : 1;
  const maxQty = useMemo(() => {
    if (!order) return 0;
    if (order.type === "TRANSFER") {
      return order.donorAvailableSurplus !== undefined
        ? Math.min(engineQty, order.donorAvailableSurplus)
        : engineQty;
    }
    if (order.type === "REORDER") {
      return engineQty * 2;
    }
    return engineQty;
  }, [order, engineQty]);

  const trimmedQty = qtyInput.trim();
  const isWholeInt = /^\d+$/.test(trimmedQty);
  const parsedQty = isWholeInt ? Number(trimmedQty) : Number.NaN;
  const hasInsufficientSurplus = Boolean(
    order?.type === "TRANSFER" &&
      order.donorAvailableSurplus !== undefined &&
      order.donorAvailableSurplus < DEFAULT_POLICY.minTransferQty,
  );
  const isOutOfRange =
    !isWholeInt ||
    !Number.isSafeInteger(parsedQty) ||
    parsedQty < minQty ||
    parsedQty > maxQty;
  const isChanged = !isOutOfRange && parsedQty !== engineQty;
  const isReorderBoosted = Boolean(
    order?.type === "REORDER" && !isOutOfRange && parsedQty > engineQty,
  );

  const computedEconomics = useMemo(() => {
    if (!order || !isWholeInt || parsedQty <= 0) {
      return {
        netBenefitBhd: order?.engineSnapshot.netBenefitBhd ?? 0,
        freightCostBhd: order?.engineSnapshot.freightCostBhd ?? 0,
      };
    }
    if (parsedQty === engineQty) {
      return {
        netBenefitBhd: order.engineSnapshot.netBenefitBhd,
        freightCostBhd: order.engineSnapshot.freightCostBhd ?? 0,
      };
    }
    if (
      order.engineSnapshot.unitPrice !== undefined &&
      order.engineSnapshot.unitCost !== undefined
    ) {
      const benefit = computeActionBenefitForQuantity({
        type: order.type,
        quantity: parsedQty,
        unitPrice: order.engineSnapshot.unitPrice,
        unitCost: order.engineSnapshot.unitCost,
        distanceKm: order.engineSnapshot.distanceKm ?? 0,
        targetLostUnits: order.engineSnapshot.metrics?.lostUnits ?? 0,
        targetCoverDays: order.engineSnapshot.metrics?.coverDays ?? null,
        targetVelocity: order.engineSnapshot.metrics?.velocity ?? 0,
        donorCoverDays: order.engineSnapshot.metrics?.donorCoverDays ?? null,
        donorVelocity: order.engineSnapshot.donorVelocity ?? 0,
      });
      return {
        netBenefitBhd: benefit.netBenefitBhd,
        freightCostBhd: benefit.freightCostBhd,
      };
    }
    const freightCostBhd =
      order.type === "TRANSFER"
        ? totalTransferCostBreakdown(
            parsedQty,
            order.engineSnapshot.distanceKm ?? 0,
            DEFAULT_POLICY,
          ).totalCost
        : 0;
    const scale = engineQty > 0 ? parsedQty / engineQty : 1;
    return {
      netBenefitBhd: round3(order.engineSnapshot.netBenefitBhd * scale),
      freightCostBhd,
    };
  }, [order, isWholeInt, parsedQty, engineQty]);

  const reasonValid = !isChanged || (reason !== "" && QuantityChangeReasonSchema.safeParse(reason).success);
  const commentRequired = isReorderBoosted || requiresAdminOverride;
  const commentValid = !commentRequired || comment.trim().length > 0;
  const canSubmit =
    Boolean(order) &&
    !hasInsufficientSurplus &&
    !isOutOfRange &&
    reasonValid &&
    commentValid &&
    !isSubmitting;

  const confirmLabel = requiresAdminOverride
    ? "Confirm override approval"
    : order?.type === "TRANSFER" && order.status === "AWAITING_DONOR"
      ? `Confirm ${ORDER_ACTION_LABELS.sendStock}`
      : `Confirm ${ORDER_ACTION_LABELS.approve}`;

  const rangeErrorText = useMemo(() => {
    if (!order) return null;
    if (hasInsufficientSurplus) {
      return `Sending branch only has ${formatNumber(order.donorAvailableSurplus ?? 0)} units available (minimum transfer is ${formatNumber(minQty)}). Decline or reroute instead.`;
    }
    if (!trimmedQty || !isWholeInt) {
      return "Enter a whole number quantity.";
    }
    if (parsedQty < minQty || parsedQty > maxQty) {
      return `Allowed range for ${actionLabel(order.type).toLowerCase()}: ${formatNumber(minQty)} to ${formatNumber(maxQty)} units.`;
    }
    return null;
  }, [order, hasInsufficientSurplus, trimmedQty, isWholeInt, parsedQty, minQty, maxQty]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md rounded-2xl">
        <DialogHeader>
          <DialogTitle>
            {requiresAdminOverride
              ? "Admin override approval"
              : order?.type === "TRANSFER" && order.status === "AWAITING_DONOR"
                ? `${ORDER_ACTION_LABELS.sendStock} quantity`
                : `${ORDER_ACTION_LABELS.approve} quantity`}
          </DialogTitle>
          <DialogDescription>
            {order ? (
              <>
                <span className="font-mono font-medium text-foreground">{order.sku}</span>
                {" · "}
                <span>
                  {order.sourceBranchName
                    ? `${order.sourceBranchName} → ${order.targetBranchName}`
                    : order.targetBranchName}
                </span>
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        {order ? (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!canSubmit || !order) return;
              onConfirm({
                approvedQty: parsedQty,
                ...(isChanged && reason ? { dispositionCode: reason } : {}),
                ...(comment.trim() ? { comment: comment.trim() } : {}),
                ...(requiresAdminOverride ? { force: true } : {}),
              });
            }}
          >
            {requiresAdminOverride ? (
              <div className="rounded-xl border border-over-text/30 bg-over-bg px-3 py-2 text-xs text-over-text">
                Approving a transfer request still waiting for a sending branch requires an override comment.
              </div>
            ) : null}

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="approve-qty-input" className="text-xs font-medium text-foreground">
                  Approved quantity
                </label>
                <span className="text-xs font-medium text-muted-foreground tabular-nums">
                  Engine suggested: {formatNumber(engineQty)}
                </span>
              </div>
              <Input
                id="approve-qty-input"
                type="number"
                inputMode="numeric"
                step={1}
                min={minQty}
                max={Math.max(minQty, maxQty)}
                value={qtyInput}
                onChange={(e) => setQtyInput(e.target.value)}
                aria-describedby="approve-qty-hint"
                className="tabular-nums"
              />
              <p id="approve-qty-hint" className="text-[11px] text-muted-foreground tabular-nums">
                {order.type === "TRANSFER"
                  ? `Range: ${formatNumber(minQty)}–${formatNumber(Math.max(minQty, maxQty))} units${
                      order.donorAvailableSurplus !== undefined
                        ? ` (sending branch surplus: ${formatNumber(order.donorAvailableSurplus)})`
                        : ""
                    }`
                  : order.type === "REORDER"
                    ? `Range: 1–${formatNumber(maxQty)} units (up to 2x engine suggestion)`
                    : `Range: 1–${formatNumber(maxQty)} units`}
              </p>
              {rangeErrorText ? (
                <p role="alert" className="text-xs font-medium text-risk-text">
                  {rangeErrorText}
                </p>
              ) : null}
            </div>

            {isReorderBoosted ? (
              <div
                role="status"
                className="flex items-start gap-2 rounded-xl border border-over-text/30 bg-over-bg px-3 py-2 text-xs text-over-text"
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>
                  Approving more than the engine suggested reorder quantity ({formatNumber(engineQty)} units). Please enter a short justification comment below.
                </span>
              </div>
            ) : null}

            <div className="grid grid-cols-2 gap-3 rounded-xl border border-border bg-secondary/40 p-3 text-xs tabular-nums">
              <div>
                <p className="text-muted-foreground">Estimated gain</p>
                <p className="mt-0.5 text-sm font-semibold text-foreground">
                  {formatMoneyFull(computedEconomics.netBenefitBhd)}
                </p>
                {isChanged ? (
                  <p className="text-[11px] text-muted-foreground">
                    Engine estimate: {formatMoneyFull(order.engineSnapshot.netBenefitBhd)}
                  </p>
                ) : null}
              </div>
              {order.type === "TRANSFER" ? (
                <div>
                  <p className="text-muted-foreground">Transfer freight</p>
                  <p className="mt-0.5 text-sm font-semibold text-foreground">
                    {formatMoneyPrecise(computedEconomics.freightCostBhd)}
                  </p>
                </div>
              ) : (
                <div>
                  <p className="text-muted-foreground">Action type</p>
                  <p className="mt-0.5 text-sm font-semibold text-foreground">
                    {actionLabel(order.type)}
                  </p>
                </div>
              )}
            </div>

            {isChanged ? (
              <div className="space-y-1.5">
                <label htmlFor="approve-qty-reason" className="text-xs font-medium text-foreground">
                  Quantity change reason (required)
                </label>
                <select
                  id="approve-qty-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value as QuantityChangeReason | "")}
                  className="h-9 w-full rounded-lg border border-input bg-card px-2.5 text-sm text-foreground shadow-xs focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
                  required
                >
                  <option value="">Select reason...</option>
                  {REASON_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>
                      {QUANTITY_REASON_LABELS[opt]}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {isChanged || commentRequired ? (
              <div className="space-y-1.5">
                <label htmlFor="approve-qty-comment" className="text-xs font-medium text-foreground">
                  {requiresAdminOverride
                    ? "Override comment (required)"
                    : isReorderBoosted
                      ? "Comment (required above 1x engine suggestion)"
                      : "Comment (optional)"}
                </label>
                <Input
                  id="approve-qty-comment"
                  placeholder={
                    requiresAdminOverride
                      ? "e.g., Urgent weekend allocation approved by ops"
                      : "e.g., Rounded down to full cartons"
                  }
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  maxLength={500}
                  required={commentRequired}
                />
              </div>
            ) : null}

            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                disabled={isSubmitting}
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={isSubmitting} disabled={!canSubmit}>
                {confirmLabel}
              </Button>
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

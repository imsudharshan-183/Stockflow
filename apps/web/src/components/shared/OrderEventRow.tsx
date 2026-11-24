import { ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  formatDateTime,
  formatNumber,
  orderStatusLabel,
} from "@/lib/format";
import { getOrderEventDisplayLabel, quantityReasonLabel } from "@/lib/labels";
import type { OrderEvent } from "@stockflow/core";

interface OrderEventRowProps {
  event: OrderEvent;
  variant: "timeline" | "card";
}

/**
 * Shared immutable OrderEvent entry used across the Audit timeline and the Queue order drawer.
 */
export function OrderEventRow({ event: ev, variant }: OrderEventRowProps) {
  const transitionAndBadges = (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="font-semibold text-foreground">{getOrderEventDisplayLabel(ev)}</span>
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        {ev.fromStatus ? (
          <>
            <span>{orderStatusLabel(ev.fromStatus)}</span>
            <ArrowRight className="size-3" aria-hidden="true" />
          </>
        ) : null}
        <span className="font-medium text-foreground">{orderStatusLabel(ev.toStatus)}</span>
      </span>
      {variant === "timeline" ? (
        <>
          <span aria-hidden="true" className="text-muted-foreground">
            ·
          </span>
          <span className="text-muted-foreground">{ev.actor.name}</span>
          <Badge tone={ev.actor.role} className="px-1.5 py-0 text-[10px]">
            {ev.actor.role}
          </Badge>
        </>
      ) : null}
      {ev.isAdminOverride ? <Badge tone="over">Override</Badge> : null}
      {ev.engineQty !== undefined &&
      ev.approvedQty !== undefined &&
      ev.engineQty !== ev.approvedQty ? (
        <Badge
          variant="outline"
          className={variant === "timeline" ? "text-[11px] tabular-nums" : "text-[10px] tabular-nums"}
        >
          {`Engine: ${formatNumber(ev.engineQty)} -> Approved: ${formatNumber(ev.approvedQty)}${
            ev.dispositionCode ? ` (${quantityReasonLabel(ev.dispositionCode)})` : ""
          }`}
        </Badge>
      ) : null}
    </div>
  );

  const commentBlock = ev.comment ? (
    <blockquote
      className={
        variant === "card"
          ? "mt-2 border-l-2 border-border pl-3 text-xs italic text-foreground"
          : "border-l-2 border-border pl-3 text-xs italic text-foreground"
      }
    >
      {ev.comment}
    </blockquote>
  ) : null;

  if (variant === "timeline") {
    return (
      <li className="space-y-1 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {transitionAndBadges}
          <span className="text-muted-foreground tabular-nums">{formatDateTime(ev.at)}</span>
        </div>
        {commentBlock}
      </li>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {transitionAndBadges}
        <span className="text-muted-foreground tabular-nums">{formatDateTime(ev.at)}</span>
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-muted-foreground">
        <span>{ev.actor.name}</span>
        <Badge tone={ev.actor.role} className="px-1.5 py-0 text-[10px]">
          {ev.actor.role}
        </Badge>
      </div>
      {commentBlock}
    </div>
  );
}

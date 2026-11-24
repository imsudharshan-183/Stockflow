import { Badge, type BadgeTone } from "@/components/ui/badge";
import { orderStatusLabel } from "@/lib/format";
import type { OrderStatus } from "@stockflow/core";

function orderStatusTone(status: OrderStatus): BadgeTone {
  switch (status) {
    case "SUGGESTED":
      return "pending";
    case "OPEN_REQUEST":
      return "reorder";
    case "AWAITING_DONOR":
      return "over";
    case "COMMITTED":
      return "approved";
    case "RECEIVED":
      return "ok";
    case "REJECTED":
      return "rejected";
    case "CANCELLED":
      return "staff";
  }
}

/** Semantic status pill for governed replenishment orders. */
export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return (
    <Badge tone={orderStatusTone(status)} dot>
      {orderStatusLabel(status)}
    </Badge>
  );
}

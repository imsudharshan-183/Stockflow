import type { LiveOverviewResponse } from "@stockflow/core";
import { ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCover, formatNumber } from "@/lib/format";

export function TransferHandoffs({ items }: { items: LiveOverviewResponse["handoffs"] }) {
  if (!items?.length) return null;
  return (
    <Card>
      <CardHeader><CardTitle>Transfers awaiting release</CardTitle></CardHeader>
      <CardContent>
        <ul className="divide-y divide-border">
          {items.map((order) => (
            <li key={order.id} className="py-2 text-sm">
              <Link className="font-medium underline" to={`/queue?tab=${order.needsRelease ? "incoming" : "outgoing"}&order=${encodeURIComponent(order.id)}`}>
                {order.productName} · {formatNumber(order.units)} units · {order.source} → {order.destination}
              </Link>
              <p className="text-muted-foreground">
                {order.overdue ? "Overdue · " : ""}
                {order.needsRelease ? "Review release request" : `Waiting for ${order.source}`}
              </p>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export function Shortages({ items }: { items: LiveOverviewResponse["shortages"] }) {
  if (!items?.length) return null;
  return (
    <Card>
      <CardHeader><CardTitle>Stock may run out before the next delivery</CardTitle></CardHeader>
      <CardContent>
        <ul className="divide-y divide-border">
          {items.map((item) => (
            <li key={`${item.branchId}-${item.sku}`}>
              <Link to={`/products/${encodeURIComponent(item.sku)}?branch=${encodeURIComponent(item.branchId)}`}
                className="group flex items-center gap-2 rounded-lg px-2 py-2 text-sm hover:bg-row-hover focus-visible:outline-ring">
                <span className="min-w-0 flex-1">
                  <span className="block font-medium group-hover:underline">{item.name}</span>
                  <span className="block text-xs text-muted-foreground">{item.branchName}</span>
                </span>
                <Badge tone="risk">{formatCover(item.coverDays)} left</Badge>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

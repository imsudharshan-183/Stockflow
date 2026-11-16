import { Badge } from "@/components/ui/badge";
import { formatNumber } from "@/lib/format";

/** Renders live projected in-transit and reserved stock counts using shared Badge and number formatting. */
export function StockDeltaBadges({
  inTransit = 0,
  reserved = 0,
}: {
  inTransit?: number;
  reserved?: number;
}) {
  if (inTransit <= 0 && reserved <= 0) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {inTransit > 0 ? (
        <Badge tone="transfer">{formatNumber(inTransit)} in transit</Badge>
      ) : null}
      {reserved > 0 ? (
        <Badge tone="pending">{formatNumber(reserved)} reserved</Badge>
      ) : null}
    </div>
  );
}

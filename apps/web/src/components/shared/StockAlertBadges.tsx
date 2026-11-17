import { Badge, type BadgeTone } from "@/components/ui/badge";
import type { StockAlertCategory, StockAlertStatus } from "@stockflow/core";

export const STOCK_ALERT_CATEGORIES: ReadonlyArray<{
  value: StockAlertCategory;
  label: string;
  helper: string;
  tone: BadgeTone;
}> = [
  {
    value: "CRITICAL_LOW",
    label: "Critical low",
    helper: "Shelf is nearly empty or already out of stock.",
    tone: "risk",
  },
  {
    value: "DAMAGED_SHRINKAGE",
    label: "Damaged / Spoiled / Shrinkage",
    helper: "Broken packaging, early spoilage, or any product that can't be sold.",
    tone: "markdown",
  },
  {
    value: "COUNT_MISMATCH",
    label: "Count mismatch",
    helper: "Physical shelf count differs from the system on-hand balance.",
    tone: "reorder",
  },
  {
    value: "OTHER",
    label: "Other",
    helper: "Any other shelf or floor stock issue your manager should inspect.",
    tone: "fresh",
  },
];

const CATEGORY_META = Object.fromEntries(
  STOCK_ALERT_CATEGORIES.map((item) => [item.value, item]),
) as Record<StockAlertCategory, (typeof STOCK_ALERT_CATEGORIES)[number]>;

/** Renders a semantic category pill for a store staff stock alert. */
export function StockAlertCategoryBadge({ category }: { category: StockAlertCategory }) {
  const meta = CATEGORY_META[category] ?? CATEGORY_META.CRITICAL_LOW;
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

/** Renders the review status pill for a store staff stock alert. */
export function StockAlertStatusBadge({ status }: { status: StockAlertStatus }) {
  switch (status) {
    case "APPROVED":
      return <Badge tone="approved">Approved</Badge>;
    case "REJECTED":
      return <Badge tone="rejected">Rejected</Badge>;
    case "PENDING":
    default:
      return <Badge tone="pending">Pending</Badge>;
  }
}

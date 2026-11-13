import type { Action, ReasonCode, RecommendationStatus } from "@stockflow/core";

const moneyCompact = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});
const moneyFull = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const pct = new Intl.NumberFormat("en-US", {
  style: "percent",
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const num = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const day = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const stamp = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
});

export function formatMoney(value: number): string {
  return moneyCompact.format(value);
}

export function formatMoneyFull(value: number): string {
  return moneyFull.format(value);
}

export function formatPct(value: number): string {
  return pct.format(value);
}

export function formatNumber(value: number): string {
  return num.format(value);
}

export function formatCover(days: number | null): string {
  if (days === null) return "No demand";
  return `${formatNumber(days)} days`;
}

export function formatDate(iso: string): string {
  return day.format(new Date(`${iso.slice(0, 10)}T00:00:00Z`));
}

export function formatDateTime(iso: string): string {
  return stamp.format(new Date(iso));
}

export const REASON_LABELS: Record<ReasonCode, string> = {
  BELOW_REORDER_POINT: "On hand is below the reorder point",
  OVERSTOCK_COVER: "Cover is above 60 days",
  RECEIVER_BELOW_TARGET: "Receiver is under the 14-day target",
  DONOR_SURPLUS: "Donor holds more than 30 days of cover plus safety stock",
  NO_DONOR: "No surplus transfer covers the gap",
  NO_RECEIVER: "No branch is short of this SKU",
  LOST_SALES_AT_RISK: "Sales may be lost over the lead time",
  CARRYING_COST: "Holding cost of the surplus units",
  FREIGHT_LIMITS_QTY: "Freight cost limits how many units are worth moving",
  ZERO_VELOCITY: "No demand on days that had stock",
  REORDER_TO_TARGET: "Buy up to the cover target",
  MARKDOWN_CLEARANCE: "Clear surplus that nobody else needs",
  MIN_TRANSFER_MET: "Quantity meets the minimum transfer",
};

export function actionLabel(action: Action): string {
  if (action === "TRANSFER") return "Transfer";
  if (action === "REORDER") return "Reorder";
  return "Markdown";
}

export function statusLabel(status: RecommendationStatus): string {
  if (status === "APPROVED") return "Approved";
  if (status === "REJECTED") return "Rejected";
  return "Pending";
}

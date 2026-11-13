import type { Action, ReasonCode, RecommendationStatus } from "@stockflow/core";

const moneyCompact = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

const moneyWhole = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const moneyCents = new Intl.NumberFormat("en-US", {
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

const intFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

const subOneDecimalFormat = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

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

/**
 * Compact currency for headers and KPI cards ($37.3K, $1.2M).
 * Values under $1,000 use whole dollars ($318); non-zero values under $1 show cents ($0.45).
 */
export function formatMoney(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "$0";
  const abs = Math.abs(value);
  if (abs < 1) return moneyCents.format(value);
  if (abs < 1000) return moneyWhole.format(Math.round(value));
  return moneyCompact.format(value);
}

/**
 * Whole dollars with separators for tables and detail views ($318, $1,240).
 * No cents anywhere unless a non-zero value is under $1.
 */
export function formatMoneyFull(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "$0";
  const abs = Math.abs(value);
  if (abs < 1) return moneyCents.format(value);
  return moneyWhole.format(Math.round(value));
}

export function formatPct(value: number): string {
  if (!Number.isFinite(value)) return "0.0%";
  return pct.format(value);
}

/**
 * Integers with separators (e.g. 1,240).
 * Preserves 1 decimal only for non-zero fractional rates under 1 (e.g. 0.4 daily velocity).
 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "0";
  const abs = Math.abs(value);
  if (abs < 1) return subOneDecimalFormat.format(value);
  return intFormat.format(Math.round(value));
}

/**
 * Cover days formatter. Engine uses 999999 (NO_DEMAND_COVER) on positions with 0 velocity;
 * averaging across SKUs in a category can yield values > 9999 when some SKUs have zero velocity.
 */
export function formatCover(days: number | null | undefined): string {
  if (days === null || days === undefined || !Number.isFinite(days) || days >= 9999) {
    return "No demand";
  }
  if (days > 365) {
    return "365+ days";
  }
  return `${formatNumber(days)} days`;
}

export function formatCoverCell(days: number | null | undefined): string {
  if (days === null || days === undefined || !Number.isFinite(days) || days >= 9999) {
    return "—";
  }
  if (days > 90) {
    return "90d+";
  }
  return `${Math.round(days)}d`;
}

/**
 * Normalizes extreme or raw floating-point cover days in natural-language rationale sentences.
 */
export function formatReasonSentence(reason: string): string {
  if (!reason) return "";
  return reason.replace(/(\d{4,}(?:\.\d+)?)\s+days of cover/g, (_match, p1) => {
    const num = parseFloat(p1);
    if (num >= 9999) return "unlimited days of cover";
    if (num > 365) return "365+ days of cover";
    return `${formatNumber(Math.round(num))} days of cover`;
  });
}

export function formatDate(iso: string): string {
  if (!iso) return "—";
  const datePart = iso.slice(0, 10);
  const parsed = new Date(`${datePart}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return iso;
  return day.format(parsed);
}

export function formatDateTime(iso: string): string {
  if (!iso) return "—";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return stamp.format(parsed);
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

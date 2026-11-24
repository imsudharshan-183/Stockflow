import type {
  Action,
  OrderEventAction,
  OrderOrigin,
  OrderStatus,
  ReasonCode,
  RecommendationStatus,
  StockAlertResolutionAction,
} from "@stockflow/core";

const moneyBhd = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});

const wholeMoneyFormat = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const compactDecimalFormat = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
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

function formatCompactMagnitude(abs: number): string {
  const roundedFils = Math.round(abs * 1000) / 1000;
  if (roundedFils === 0) return "0";
  if (roundedFils < 1) return moneyBhd.format(roundedFils);
  const roundedWhole = Math.round(abs);
  if (roundedWhole < 1_000) return wholeMoneyFormat.format(roundedWhole);
  const k = Math.round((abs / 1_000) * 10) / 10;
  if (k < 1_000) return `${compactDecimalFormat.format(k)}K`;
  const m = Math.round((abs / 1_000_000) * 10) / 10;
  return `${compactDecimalFormat.format(m)}M`;
}

function formatFullMagnitude(abs: number): string {
  const roundedFils = Math.round(abs * 1000) / 1000;
  if (roundedFils === 0) return "0";
  if (roundedFils < 1) return moneyBhd.format(roundedFils);
  return wholeMoneyFormat.format(Math.round(abs));
}

/**
 * Compact Bahraini Dinar (BHD) currency formatter for KPI cards, summary badges, and axes
 * (e.g. BD 0.750, BD 420, BD 9.4K, BD 1.2M).
 */
export function formatMoney(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "BD 0";
  const sign = value < 0 ? "-" : "";
  const formatted = formatCompactMagnitude(Math.abs(value));
  return formatted === "0" ? "BD 0" : `${sign}BD ${formatted}`;
}

export const formatMoneyCompact = formatMoney;

/**
 * Full-precision Bahraini Dinar (BHD) currency formatter for tables and detail panels:
 * whole BD with thousands separators, preserving 3 decimals (fils) only below BD 1
 * (e.g. BD 0.750, BD 186, BD 1,241).
 */
export function formatMoneyFull(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "BD 0";
  const sign = value < 0 ? "-" : "";
  const formatted = formatFullMagnitude(Math.abs(value));
  return formatted === "0" ? "BD 0" : `${sign}BD ${formatted}`;
}

/**
 * Exact 3-decimal (fils) Bahraini Dinar formatter for unit costs, freight rate constants,
 * and line-item methodology disclosures (e.g. BD 1.500, BD 0.150, BD 0.250).
 */
export function formatMoneyPrecise(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "BD 0.000";
  const sign = value < 0 ? "-" : "";
  return `${sign}BD ${moneyBhd.format(Math.abs(value))}`;
}

export function formatDistanceKm(km: number): string {
  if (!Number.isFinite(km) || km < 0) return "—";
  return `${subOneDecimalFormat.format(km)} km`;
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

export function orderStatusLabel(status: OrderStatus): string {
  switch (status) {
    case "SUGGESTED":
      return "Suggested";
    case "OPEN_REQUEST":
      return "Open Request";
    case "AWAITING_DONOR":
      return "Awaiting Donor";
    case "COMMITTED":
      return "Committed";
    case "RECEIVED":
      return "Received";
    case "REJECTED":
      return "Declined";
    case "CANCELLED":
      return "Cancelled";
  }
}

export function orderOriginLabel(origin: OrderOrigin): string {
  switch (origin) {
    case "ENGINE":
      return "Engine";
    case "MANAGER_REQUEST":
      return "Manager Request";
    case "ALERT_ESCALATION":
      return "Alert Escalation";
  }
}

export function orderEventActionLabel(action: OrderEventAction): string {
  switch (action) {
    case "CREATED":
      return "Created";
    case "REQUEST_TRANSFER":
      return "Requested transfer";
    case "COMMIT":
      return "Committed";
    case "DECLINE":
      return "Declined";
    case "REROUTE":
      return "Rerouted";
    case "CANCEL":
      return "Cancelled";
    case "RECEIVE":
      return "Received";
    case "ESCALATE":
      return "Escalated";
    case "MIGRATED":
      return "Migrated";
  }
}

export function alertResolutionLabel(action: StockAlertResolutionAction): string {
  switch (action) {
    case "CONVERTED_TO_REQUEST":
      return "Requested Replenishment";
    case "LOGGED_ADJUSTMENT":
      return "Logged Adjustment";
    case "ACKNOWLEDGED":
      return "Acknowledged";
    case "DISMISSED":
      return "Dismissed";
  }
}

export function formatCoordinates(coordinates?: readonly [number, number]): string {
  if (!coordinates) return "—";
  const lat = (Math.round(coordinates[0] * 10_000) / 10_000).toFixed(4);
  const lng = (Math.round(coordinates[1] * 10_000) / 10_000).toFixed(4);
  return `${lat}, ${lng}`;
}

export {
  BAHRAIN_TIME_ZONE,
  diffCalendarDays,
  formatBahrainDate,
  formatBahrainDateTime,
  formatBahrainTimeHm,
  getBahrainToday,
  type BahrainToday,
} from "./bahrainDate";

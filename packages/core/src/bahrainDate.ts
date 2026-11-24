/**
 * Pure Asia/Bahrain (UTC+3) calendar date and timestamp helpers shared between API and Web.
 * All callers pass an explicit clock timestamp (`now`) so `@stockflow/core` stays deterministic.
 */
export const BAHRAIN_TIME_ZONE = "Asia/Bahrain";

const bahrainNumericDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: BAHRAIN_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const bahrainPartsFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: BAHRAIN_TIME_ZONE,
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const calendarDateFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
  year: "numeric",
});

export interface BahrainToday {
  isoDate: string;
  displayDate: string;
  timeHm: string;
}

function partsMap(
  formatter: Intl.DateTimeFormat,
  date: Date,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") out[part.type] = part.value;
  }
  return out;
}

function toValidDate(isoOrMs: string | number | Date): Date | null {
  const date =
    typeof isoOrMs === "number"
      ? new Date(isoOrMs)
      : typeof isoOrMs === "string"
        ? new Date(isoOrMs)
        : isoOrMs;
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Formats an explicit timestamp (`now`) into Asia/Bahrain ISO date, display date, and HH:mm time.
 */
export function getBahrainToday(now: Date | number): BahrainToday {
  const date = typeof now === "number" ? new Date(now) : now;
  const numParts = partsMap(bahrainNumericDateFormatter, date);
  const textParts = partsMap(bahrainPartsFormatter, date);

  const year = numParts.year ?? "1970";
  const month = numParts.month ?? "01";
  const dayNum = numParts.day ?? "01";
  const isoDate = `${year}-${month}-${dayNum}`;

  const weekday = textParts.weekday ?? "";
  const day = textParts.day ?? String(Number(dayNum));
  const monthName = textParts.month ?? "";
  const displayDate = `${weekday}, ${day} ${monthName} ${textParts.year ?? year}`;

  const hour = (textParts.hour ?? "00").padStart(2, "0");
  const minute = (textParts.minute ?? "00").padStart(2, "0");
  const timeHm = `${hour}:${minute}`;

  return { isoDate, displayDate, timeHm };
}

export function formatBahrainTimeHm(isoOrMs: string | number | Date): string {
  const date = toValidDate(isoOrMs);
  return date ? getBahrainToday(date).timeHm : "—";
}

export function formatBahrainDateTime(isoOrMs: string | number | Date): string {
  const date = toValidDate(isoOrMs);
  if (!date) return "—";
  const textParts = partsMap(bahrainPartsFormatter, date);
  const hour = (textParts.hour ?? "00").padStart(2, "0");
  const minute = (textParts.minute ?? "00").padStart(2, "0");
  return `${textParts.day ?? ""} ${textParts.month ?? ""} ${textParts.year ?? ""}, ${hour}:${minute}`.trim();
}

export function formatBahrainDate(isoDate: string): string {
  if (!isoDate) return "—";
  const datePart = isoDate.slice(0, 10);
  const parsed = new Date(`${datePart}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return isoDate;
  const parts = partsMap(calendarDateFormatter, parsed);
  return `${parts.day ?? ""} ${parts.month ?? ""} ${parts.year ?? ""}`.trim();
}

/**
 * Signed integer calendar days: laterIso - earlierIso.
 */
export function diffCalendarDays(laterIso: string, earlierIso: string): number {
  const [y1, m1, d1] = laterIso.slice(0, 10).split("-").map(Number);
  const [y2, m2, d2] = earlierIso.slice(0, 10).split("-").map(Number);
  if (!y1 || !m1 || !d1 || !y2 || !m2 || !d2) return 0;
  const t1 = Date.UTC(y1, m1 - 1, d1);
  const t2 = Date.UTC(y2, m2 - 1, d2);
  return Math.round((t1 - t2) / 86_400_000);
}

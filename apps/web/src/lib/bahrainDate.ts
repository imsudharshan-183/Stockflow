import {
  diffCalendarDays,
  formatBahrainDateTime,
  formatBahrainTimeHm,
  getBahrainToday as coreGetBahrainToday,
  type BahrainToday,
} from "@stockflow/core";

export { diffCalendarDays, formatBahrainDateTime, formatBahrainTimeHm, type BahrainToday };

// Always anchor "today" and date arithmetic to Asia/Bahrain (UTC+3) so browsers in other
// time zones do not validate daily sales entries or flag stale banners against the wrong calendar day.
export function getBahrainToday(now: Date | number = Date.now()): BahrainToday {
  return coreGetBahrainToday(now);
}

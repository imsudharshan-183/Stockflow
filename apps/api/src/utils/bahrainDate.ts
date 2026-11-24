import {
  diffCalendarDays,
  getBahrainToday as coreGetBahrainToday,
  type BahrainToday,
} from "@stockflow/core";

export { diffCalendarDays, type BahrainToday };

/**
 * Computes today's business date and HH:mm time in Asia/Bahrain (UTC+3).
 * Accepts an injectable clock timestamp for deterministic tests.
 */
export function getBahrainToday(now: Date | number = Date.now()): BahrainToday {
  return coreGetBahrainToday(now);
}

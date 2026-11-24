// DECISION: Default 3-day active/snooze windows match Bahrain retail replenishment cadences—long enough
// for floor teams to receive approved stock or ignore unchanged rejections, short enough to resurface.
export const DEFAULT_APPROVED_ACTIVE_DAYS = 3;
export const DEFAULT_REJECT_SNOOZE_DAYS = 3;
// DECISION: Cap undo/reopen at 24 hours so historical fulfilled audits do not mutate live stock projections later.
export const DEFAULT_REOPEN_WINDOW_HOURS = 24;

export interface QueueLifecycleConfig {
  approvedActiveDays: number;
  rejectSnoozeDays: number;
  reopenWindowHours: number;
}

export function readQueueLifecycleConfig(
  source: NodeJS.ProcessEnv = process.env,
  overrides?: Partial<QueueLifecycleConfig>,
): QueueLifecycleConfig {
  const parsePositiveDays = (raw: string | undefined, fallback: number): number => {
    if (!raw?.trim()) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    approvedActiveDays:
      overrides?.approvedActiveDays ??
      parsePositiveDays(source.APPROVED_ACTIVE_DAYS, DEFAULT_APPROVED_ACTIVE_DAYS),
    rejectSnoozeDays:
      overrides?.rejectSnoozeDays ??
      parsePositiveDays(source.REJECT_SNOOZE_DAYS, DEFAULT_REJECT_SNOOZE_DAYS),
    reopenWindowHours:
      overrides?.reopenWindowHours ?? DEFAULT_REOPEN_WINDOW_HOURS,
  };
}

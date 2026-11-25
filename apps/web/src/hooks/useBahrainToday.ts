import { useEffect, useState } from "react";
import { getBahrainToday, type BahrainToday } from "@/lib/bahrainDate";

/**
 * Returns Asia/Bahrain's current business date and re-checks every minute so the
 * date label updates at Bahrain midnight even if a browser tab remains open.
 */
// Refresh at Bahrain midnight (and on tab resume, since browsers throttle background timers) so
// date pickers and stale-data badges flip at 00:00 UTC+3 without requiring a manual page reload.
const defaultNow = () => Date.now();

export function useBahrainToday(nowFn: () => number = defaultNow): BahrainToday {
  const [today, setToday] = useState<BahrainToday>(() => getBahrainToday(nowFn()));

  useEffect(() => {
    const sync = () => {
      const next = getBahrainToday(nowFn());
      setToday((prev) =>
        prev.isoDate === next.isoDate && prev.displayDate === next.displayDate ? prev : next,
      );
    };
    sync();
    const timer = window.setInterval(sync, 60_000);
    return () => window.clearInterval(timer);
  }, [nowFn]);

  return today;
}

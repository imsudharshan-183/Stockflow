import { useEffect, useState } from "react";
import { getBahrainToday, type BahrainToday } from "@/lib/bahrainDate";

/**
 * Returns Asia/Bahrain's current business date and re-checks every minute so the
 * date label updates at Bahrain midnight even if a browser tab remains open.
 */
export function useBahrainToday(nowFn: () => number = () => Date.now()): BahrainToday {
  const [today, setToday] = useState<BahrainToday>(() => getBahrainToday(nowFn()));

  useEffect(() => {
    setToday(getBahrainToday(nowFn()));
    const timer = window.setInterval(() => {
      const next = getBahrainToday(nowFn());
      setToday((prev) => (prev.isoDate === next.isoDate && prev.displayDate === next.displayDate ? prev : next));
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [nowFn]);

  return today;
}

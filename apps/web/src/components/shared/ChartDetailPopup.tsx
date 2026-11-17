import { X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";

export interface ChartDetailMetric {
  label: string;
  value: string;
}

export interface ChartDetailPayload {
  title: string;
  subtitle?: string;
  metrics: ChartDetailMetric[];
}

interface ChartDetailContextValue {
  detail: ChartDetailPayload | null;
  showDetail: (payload: ChartDetailPayload) => void;
  clearDetail: () => void;
}

const ChartDetailContext = createContext<ChartDetailContextValue | null>(null);

export function ChartDetailProvider({ children }: { children: ReactNode }) {
  const [detail, setDetail] = useState<ChartDetailPayload | null>(null);

  const showDetail = useCallback((payload: ChartDetailPayload) => {
    setDetail(payload);
  }, []);

  const clearDetail = useCallback(() => {
    setDetail(null);
  }, []);

  useEffect(() => {
    if (!detail) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDetail(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [detail]);

  return (
    <ChartDetailContext.Provider value={{ detail, showDetail, clearDetail }}>
      {children}
      {detail ? <ChartDetailPopup detail={detail} onClose={clearDetail} /> : null}
    </ChartDetailContext.Provider>
  );
}

export function useChartDetail(): ChartDetailContextValue {
  const ctx = useContext(ChartDetailContext);
  if (!ctx) {
    throw new Error("useChartDetail must be used inside ChartDetailProvider");
  }
  return ctx;
}

/**
 * Extracts the clicked chart datum cleanly from a Recharts CategoricalChartState
 * whether the user clicked directly on a point/bar or along its vertical tooltip band.
 */
export function pickChartPoint<T>(state: unknown, rows: readonly T[]): T | undefined {
  if (!state || typeof state !== "object") return undefined;
  const candidate = state as {
    activePayload?: Array<{ payload?: unknown }>;
    activeTooltipIndex?: number;
  };
  const activePayload = candidate.activePayload?.[0]?.payload;
  if (activePayload !== undefined) {
    return activePayload as T;
  }
  if (
    typeof candidate.activeTooltipIndex === "number" &&
    candidate.activeTooltipIndex >= 0 &&
    candidate.activeTooltipIndex < rows.length
  ) {
    return rows[candidate.activeTooltipIndex];
  }
  return undefined;
}

function ChartDetailPopup({
  detail,
  onClose,
}: {
  detail: ChartDetailPayload;
  onClose: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-label={`${detail.title} details`}
      className="fixed right-4 bottom-4 z-50 w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-border bg-popover p-4 text-popover-foreground shadow-lg"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-foreground">{detail.title}</h3>
          {detail.subtitle ? (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{detail.subtitle}</p>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label="Close chart details"
          className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden="true" />
        </Button>
      </div>

      <dl className="mt-3 space-y-1.5 border-t border-border/70 pt-3 text-xs">
        {detail.metrics.map((metric) => (
          <div key={metric.label} className="flex items-baseline justify-between gap-4">
            <dt className="text-muted-foreground">{metric.label}</dt>
            <dd className="font-semibold text-foreground tabular-nums">{metric.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

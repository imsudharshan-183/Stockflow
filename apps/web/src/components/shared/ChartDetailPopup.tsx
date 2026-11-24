import { X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { Link, useLocation } from "react-router-dom";
import { Button, buttonVariants } from "@/components/ui/button";
import { useAuth } from "@/features/auth/AuthContext";
import { cn } from "@/lib/utils";

interface ChartDetailMetric {
  label: string;
  value: string;
}

export interface ChartDetailPayload {
  targetCard?: string;
  title: string;
  subtitle?: string;
  metrics: ChartDetailMetric[];
  linkTo?: string;
  linkLabel?: string;
}

export interface ChartDetailContextValue {
  detail: ChartDetailPayload | null;
  showDetail: (payload: ChartDetailPayload) => void;
  clearDetail: () => void;
}

const ChartDetailContext = createContext<ChartDetailContextValue | null>(null);

export function ChartDetailProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const userId = user?.id ?? null;
  const [detail, setDetail] = useState<ChartDetailPayload | null>(null);

  const showDetail = useCallback((payload: ChartDetailPayload) => {
    setDetail(payload);
  }, []);

  const clearDetail = useCallback(() => {
    setDetail(null);
  }, []);

  // IMPORTANT: Clear any open chart details on logout, user switch, or route change so
  // privileged financial metrics (e.g., admin BD figures) never survive across sessions or views.
  useEffect(() => {
    setDetail(null);
  }, [userId, pathname]);

  const activeDetail = userId ? detail : null;

  useEffect(() => {
    if (!activeDetail) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDetail(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeDetail]);

  return (
    <ChartDetailContext.Provider value={{ detail: activeDetail, showDetail, clearDetail }}>
      {children}
      {activeDetail && !activeDetail.targetCard ? (
        <div className="mt-4">
          <ChartDetailStrip detail={activeDetail} onClose={clearDetail} />
        </div>
      ) : null}
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
 * Extracts the clicked chart datum strictly when Recharts reports a non-empty
 * `activePayload` and ignores pointer releases inside `.recharts-brush` so
 * dragging the date-range Brush never accidentally triggers the detail popup.
 */
export function pickChartPoint<T>(state: unknown, event?: unknown): T | undefined {
  if (event && typeof event === "object" && "target" in event) {
    const target = (event as { target?: unknown }).target;
    if (target instanceof Element && target.closest(".recharts-brush")) {
      return undefined;
    }
  }
  if (!state || typeof state !== "object") return undefined;
  const candidate = state as {
    activePayload?: Array<{ payload?: unknown }>;
  };
  if (!Array.isArray(candidate.activePayload) || candidate.activePayload.length === 0) {
    return undefined;
  }
  return candidate.activePayload[0]?.payload as T | undefined;
}

export function ChartDetailStrip({
  detail,
  onClose,
}: {
  detail: ChartDetailPayload;
  onClose: () => void;
}) {
  return (
    <div
      role="region"
      aria-live="polite"
      aria-label={`${detail.title} details`}
      className="mt-3 rounded-xl border border-border bg-secondary/40 p-3 text-foreground"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="truncate text-xs font-semibold text-foreground">{detail.title}</h4>
          {detail.subtitle ? (
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{detail.subtitle}</p>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label="Close chart details"
          className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden="true" />
        </Button>
      </div>

      <dl className="mt-2 grid gap-x-4 gap-y-1.5 border-t border-border/70 pt-2 text-xs sm:grid-cols-2">
        {detail.metrics.map((metric) => (
          <div key={metric.label} className="flex items-baseline justify-between gap-2">
            <dt className="truncate text-muted-foreground">{metric.label}</dt>
            <dd className="shrink-0 font-semibold text-foreground tabular-nums">{metric.value}</dd>
          </div>
        ))}
      </dl>

      {detail.linkTo && detail.linkLabel ? (
        <div className="mt-2.5 flex justify-end border-t border-border/70 pt-2">
          <Link
            to={detail.linkTo}
            onClick={onClose}
            className={cn(buttonVariants({ variant: "primary", size: "sm" }), "h-7 px-3 text-xs")}
          >
            {detail.linkLabel}
          </Link>
        </div>
      ) : null}
    </div>
  );
}

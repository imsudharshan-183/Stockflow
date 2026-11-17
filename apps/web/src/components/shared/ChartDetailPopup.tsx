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

export interface ChartDetailMetric {
  label: string;
  value: string;
}

export interface ChartDetailPayload {
  title: string;
  subtitle?: string;
  metrics: ChartDetailMetric[];
  linkTo?: string;
  linkLabel?: string;
}

interface ChartDetailContextValue {
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

  // IMPORTANT: Clear any open chart popup on logout, user switch, or route change so
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
      {activeDetail ? <ChartDetailPopup detail={activeDetail} onClose={clearDetail} /> : null}
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

      {detail.linkTo && detail.linkLabel ? (
        <div className="mt-3 border-t border-border/70 pt-3">
          <Link
            to={detail.linkTo}
            onClick={onClose}
            className={cn(buttonVariants({ variant: "primary", size: "sm" }), "w-full justify-center")}
          >
            {detail.linkLabel}
          </Link>
        </div>
      ) : null}
    </div>
  );
}

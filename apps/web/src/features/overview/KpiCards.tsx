import { ArrowDownRight, ArrowUpRight, Info, type LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatMoney, formatPct } from "@/lib/format";
import { TOKENS } from "@/lib/tokens";
import { cn } from "@/lib/utils";

export type KpiTone = "risk" | "warn" | "info" | "gain" | "primary";

const TONE_STYLES: Record<
  KpiTone,
  { border: string; iconBox: string; stroke: string }
> = {
  risk: {
    border: "border-l-risk",
    iconBox: "bg-risk-bg text-risk-text ring-1 ring-inset ring-risk-ring",
    stroke: TOKENS.status.risk,
  },
  warn: {
    border: "border-l-warn",
    iconBox: "bg-warn-bg text-warn-text ring-1 ring-inset ring-warn-ring",
    stroke: TOKENS.status.warn,
  },
  info: {
    border: "border-l-info",
    iconBox: "bg-info-bg text-info-text ring-1 ring-inset ring-info-ring",
    stroke: TOKENS.status.info,
  },
  gain: {
    border: "border-l-gain",
    iconBox: "bg-gain-bg text-gain-text ring-1 ring-inset ring-gain-ring",
    stroke: TOKENS.status.gain,
  },
  primary: {
    border: "border-l-primary",
    iconBox: "bg-primary-soft text-primary-text ring-1 ring-inset ring-primary-ring",
    stroke: TOKENS.brand.primary,
  },
};

export function KpiCard({
  label,
  value,
  note,
  formula,
  icon: Icon,
  tone,
  series,
  deltaOverride,
  money = false,
  invertDelta = false,
  footerLabel,
}: {
  label: string;
  value: string;
  note: string;
  formula: string;
  icon: LucideIcon;
  tone: KpiTone;
  series?: number[];
  deltaOverride?: number;
  money?: boolean;
  invertDelta?: boolean;
  footerLabel?: string;
}) {
  const palette = TONE_STYLES[tone];
  const hasTrend = Array.isArray(series) && series.length >= 2;
  const delta = deltaOverride !== undefined ? deltaOverride : hasTrend ? windowDelta(series) : 0;
  const rising = delta >= 0;
  const isFavorable = invertDelta ? !rising : rising;

  return (
    <Card
      className={cn(
        "rounded-2xl border border-border border-l-4 bg-card shadow-card transition duration-150 hover:-translate-y-0.5",
        palette.border,
      )}
    >
      <CardContent className="flex h-full flex-col justify-between gap-3">
        <div className="flex items-start justify-between gap-2">
          <span
            className={cn(
              "flex size-9 items-center justify-center rounded-xl",
              palette.iconBox,
            )}
          >
            <Icon className="size-4" aria-hidden="true" />
          </span>
          <Tooltip>
            <TooltipTrigger
              className="rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              aria-label={`${label} formula`}
            >
              <Info className="size-4" aria-hidden="true" />
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">{formula}</TooltipContent>
          </Tooltip>
        </div>

        <div>
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight text-foreground tabular-nums">
            {value}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{note}</p>
        </div>

        {hasTrend ? (
          <div className="flex items-end justify-between gap-3 border-t border-divider-soft pt-2.5">
            <Sparkline values={series} color={palette.stroke} />
            <p
              className={cn(
                "flex items-center gap-1 text-xs font-medium tabular-nums",
                isFavorable ? "text-gain-text" : "text-risk-text",
              )}
            >
              {rising ? (
                <ArrowUpRight className="size-3.5 shrink-0" aria-hidden="true" />
              ) : (
                <ArrowDownRight className="size-3.5 shrink-0" aria-hidden="true" />
              )}
              {money ? formatMoney(Math.abs(delta)) : formatPct(Math.abs(delta))}
              <span className="font-normal text-muted-foreground">vs prior 28d</span>
            </p>
          </div>
        ) : footerLabel ? (
          <div className="border-t border-divider-soft pt-2.5 text-[11px] text-muted-foreground">
            {footerLabel}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Sparkline({ values, color }: { values: number[]; color: string }) {
  const points = values.slice(-28);
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const path = points
    .map((value, index) => {
      const x = Math.round(((index / (points.length - 1)) * 96) * 10) / 10;
      const y = Math.round((28 - ((value - min) / span) * 24) * 10) / 10;
      return `${index === 0 ? "M" : "L"}${x} ${y}`;
    })
    .join(" ");
  return (
    <svg viewBox="0 0 96 32" className="h-7 w-24 shrink-0" aria-hidden="true">
      <path d={path} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function windowDelta(values: number[]): number {
  const recent = values.slice(-28);
  const prior = values.slice(-56, -28);
  if (prior.length === 0) {
    const first = recent[0] ?? 0;
    const last = recent[recent.length - 1] ?? 0;
    return last - first;
  }
  return mean(recent) - mean(prior);
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

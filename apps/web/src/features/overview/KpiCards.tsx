import { ArrowDownRight, ArrowUpRight, Info, type LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatMoney, formatPct } from "@/lib/format";

export function KpiCard({
  label,
  value,
  note,
  formula,
  icon: Icon,
  accent,
  series,
  money,
}: {
  label: string;
  value: string;
  note: string;
  formula: string;
  icon: LucideIcon;
  accent: string;
  series: number[];
  money: boolean;
}) {
  const delta = windowDelta(series);
  const rising = delta >= 0;
  return (
    <Card className="rounded-xl border-l-4 shadow-card transition duration-150 hover:-translate-y-0.5" style={{ borderLeftColor: accent }}>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-2">
          <span className="flex size-9 items-center justify-center rounded-xl text-white" style={{ background: accent }}>
            <Icon className="size-4" />
          </span>
          <Tooltip>
            <TooltipTrigger className="text-muted-foreground" aria-label={`${label} formula`}>
              <Info className="size-4" />
            </TooltipTrigger>
            <TooltipContent>{formula}</TooltipContent>
          </Tooltip>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="text-2xl font-semibold tracking-tight">{value}</p>
          <p className="mt-1 text-xs text-muted-foreground">{note}</p>
        </div>
        <div className="flex items-end justify-between gap-3">
          <Sparkline values={series} color={accent} />
          <p className={`flex items-center gap-1 text-xs ${rising ? "text-emerald-700" : "text-red-600"}`}>
            {rising ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
            {money ? formatMoney(Math.abs(delta)) : formatPct(Math.abs(delta))}
            <span className="text-muted-foreground">vs prior 28 days</span>
          </p>
        </div>
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
      const x = (index / (points.length - 1)) * 96;
      const y = 28 - ((value - min) / span) * 24;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg viewBox="0 0 96 32" className="h-8 w-24" aria-hidden="true">
      <path d={path} fill="none" stroke={color} strokeWidth="2" />
    </svg>
  );
}

function windowDelta(values: number[]): number {
  const recent = values.slice(-28);
  const prior = values.slice(-56, -28);
  return mean(recent) - mean(prior);
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

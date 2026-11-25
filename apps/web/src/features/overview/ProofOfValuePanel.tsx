import { CheckCircle2, Info, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatMoney, formatMoneyFull, formatNumber, formatPct } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { BacktestResult } from "@stockflow/core";

export function ProofOfValuePanel({
  backtest,
  scopeLabel = "Network",
}: {
  backtest: BacktestResult;
  scopeLabel?: string;
}) {
  const baseline = Math.max(0, backtest.baselineStockoutDays);
  const withEngine = Math.max(0, backtest.engineStockoutDays);
  const avoided = Math.max(0, backtest.stockoutDaysAvoided);
  const reductionShare = baseline > 0 ? avoided / baseline : 0;
  const engineBarPct = baseline > 0 ? Math.min(100, Math.round((withEngine / baseline) * 100)) : 0;

  return (
    <Card
      role="region"
      aria-label="Proof of value counterfactual replay"
      className="rounded-2xl border border-border bg-card shadow-card"
    >
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 pb-2">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="ok" dot>
              Simulation on sample data · {formatNumber(backtest.windowDays)}-day replay
            </Badge>
            <span className="text-xs text-muted-foreground">{scopeLabel} counterfactual comparison</span>
          </div>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4 text-gain-text" aria-hidden="true" />
            <span>Stockout days avoided &amp; capital released</span>
          </CardTitle>
        </div>

        <Tooltip>
          <TooltipTrigger
            aria-label="Backtest replay assumptions"
            className="inline-flex items-center gap-1 rounded-lg border border-border bg-secondary/50 px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <Info className="size-3.5" aria-hidden="true" />
            <span>Methodology</span>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm space-y-1 text-xs">
            <p className="font-semibold">Counterfactual replay methodology</p>
            <p>
              Replays the last {formatNumber(backtest.windowDays)} days of recorded sales, stock,
              and historical receipts day by day, applying the exact transfer, reorder, and
              markdown quantities the engine recommends each morning (transfers and markdowns release
              unit cost immediately; reorders arrive after supplier lead time). See{" "}
              <span className="font-mono">docs/DECISIONS.md</span>.
            </p>
          </TooltipContent>
        </Tooltip>
      </CardHeader>

      <CardContent className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
        <div className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-baseline justify-between text-xs">
              <span className="font-medium text-muted-foreground">
                Without StockFlow (observed baseline stockout SKU-days)
              </span>
              <span className="font-semibold text-risk-text tabular-nums">
                {formatNumber(baseline)} days
              </span>
            </div>
            <div className="h-3 w-full overflow-hidden rounded-full bg-secondary">
              <div className="h-full w-full rounded-full bg-risk" />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-baseline justify-between text-xs">
              <span className="font-medium text-muted-foreground">
                With StockFlow (projected stockout SKU-days after plan actions)
              </span>
              <span className="font-semibold text-gain-text tabular-nums">
                {formatNumber(withEngine)} days
              </span>
            </div>
            <div className="h-3 w-full overflow-hidden rounded-full bg-secondary">
              <div
                className={cn("h-full rounded-full bg-gain transition-all")}
                style={{ width: `${engineBarPct}%` }}
              />
            </div>
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground">
            Assumptions: Replays the last {formatNumber(backtest.windowDays)} days of recorded sales
            and stock (retaining historical receipts), applying the same transfer, reorder, and
            markdown actions the engine would have recommended each morning, and compares the
            resulting stockout days and cash freed against what actually happened. Reference:{" "}
            <span className="font-mono text-foreground">docs/DECISIONS.md</span> (Counterfactual
            Backtest / Assumptions section).
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
          <div className="rounded-xl border border-gain-ring bg-gain-bg/60 p-3.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-gain-text">
              <CheckCircle2 className="size-3.5 shrink-0" aria-hidden="true" />
              <span>Stockout days avoided</span>
            </div>
            <p className="mt-1 text-2xl font-semibold tracking-tight text-foreground tabular-nums">
              {formatNumber(avoided)}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
              {formatPct(reductionShare)} reduction over {formatNumber(backtest.windowDays)} days
            </p>
          </div>

          <div className="rounded-xl border border-border bg-secondary/40 p-3.5">
            <p className="text-xs font-medium text-muted-foreground">Capital released</p>
            <p className="mt-1 text-2xl font-semibold tracking-tight text-foreground tabular-nums">
              {formatMoney(backtest.cashReleased)}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
              Exact: {formatMoneyFull(backtest.cashReleased)}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

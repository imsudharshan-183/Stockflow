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
  branchCount,
}: {
  backtest: BacktestResult;
  scopeLabel?: string;
  branchCount?: number;
}) {
  const windowDays = Math.max(1, backtest.windowDays);
  const baseline = Math.max(0, backtest.baselineStockoutDays);
  const withEngine = Math.max(0, backtest.engineStockoutDays);
  const avoided = Math.max(0, backtest.stockoutDaysAvoided);
  const baselinePerDay = baseline / windowDays;
  const withEnginePerDay = withEngine / windowDays;
  const reductionShare = baseline > 0 ? avoided / baseline : 0;
  const baselineBarPct = baseline > 0 ? 100 : 0;
  const engineBarPct = baseline > 0 ? Math.min(100, Math.round((withEngine / baseline) * 100)) : 0;
  const storePhrase =
    branchCount === 1
      ? "at 1 store"
      : branchCount && branchCount > 1
        ? `across ${formatNumber(branchCount)} stores`
        : "across your stores";

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
              {formatNumber(backtest.windowDays)}-day replay
            </Badge>
            <span className="text-xs text-muted-foreground">{scopeLabel} · sample data</span>
          </div>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4 text-gain-text" aria-hidden="true" />
            <span>Estimated impact over the last {formatNumber(backtest.windowDays)} days</span>
          </CardTitle>
        </div>

        <Tooltip>
          <TooltipTrigger
            aria-label="How this simulation works"
            className="inline-flex items-center gap-1 rounded-lg border border-border bg-secondary/50 px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <Info className="size-3.5" aria-hidden="true" />
            <span>How it works</span>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm space-y-1 text-xs">
            <p className="font-semibold">Daily replay comparison</p>
            <p>
              Replays the last {formatNumber(backtest.windowDays)} days of sales, stock, and
              deliveries day by day, applying StockFlow&apos;s morning transfer, reorder, and
              markdown recommendations against what actually happened.
            </p>
          </TooltipContent>
        </Tooltip>
      </CardHeader>

      <CardContent className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
        <div className="space-y-4">
          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs">
              <span className="font-medium text-muted-foreground">Without StockFlow</span>
              <span className="tabular-nums">
                <span className="font-semibold text-risk-text">
                  {formatNumber(baselinePerDay)} products/day
                </span>{" "}
                <span className="font-normal text-muted-foreground">
                  ({formatNumber(baseline)} SKU-days)
                </span>
              </span>
            </div>
            <div className="h-3 w-full overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-risk transition-all"
                style={{ width: `${baselineBarPct}%` }}
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs">
              <span className="font-medium text-muted-foreground">With StockFlow</span>
              <span className="tabular-nums">
                <span className="font-semibold text-gain-text">
                  {formatNumber(withEnginePerDay)} products/day
                </span>{" "}
                <span className="font-normal text-muted-foreground">
                  ({formatNumber(withEngine)} SKU-days)
                </span>
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
            Average products out of stock each day {storePhrase} over the last{" "}
            {formatNumber(backtest.windowDays)} days (1 SKU-day = 1 product out of stock for 1 day).
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
          <div className="rounded-xl border border-gain-ring bg-gain-bg/60 p-3.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-gain-text">
              <CheckCircle2 className="size-3.5 shrink-0" aria-hidden="true" />
              <span>Fewer stockouts</span>
            </div>
            <p className="mt-1 text-2xl font-semibold tracking-tight text-foreground tabular-nums">
              {formatPct(reductionShare)}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
              {formatNumber(baselinePerDay)} → {formatNumber(withEnginePerDay)} products/day ·{" "}
              {formatNumber(avoided)} SKU-days avoided
            </p>
          </div>

          <div className="rounded-xl border border-border bg-secondary/40 p-3.5">
            <p className="text-xs font-medium text-muted-foreground">Cash freed</p>
            <p className="mt-1 text-2xl font-semibold tracking-tight text-foreground tabular-nums">
              {formatMoney(backtest.cashReleased)}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
              {formatMoneyFull(backtest.cashReleased)} from transfers &amp; markdowns
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

import { ArrowLeftRight, ArrowRight, PackageMinus, TriangleAlert } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/shared/states";
import { formatCover, formatMoney, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { KpiSummary, Recommendation } from "@stockflow/core";

export function NeedsAttentionStrip({
  report,
  recommendations,
  isLoading = false,
  error = null,
  onRetry,
}: {
  report: KpiSummary;
  recommendations: readonly Recommendation[];
  isLoading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}) {
  const summary = useMemo(() => {
    const pending = recommendations.filter((row) => row.status === "PENDING");
    const reorders = pending.filter((row) => row.action === "REORDER");
    const transfers = pending.filter((row) => row.action === "TRANSFER");
    const markdowns = pending.filter((row) => row.action === "MARKDOWN");

    const topReorder = [...reorders].sort(
      (a, b) =>
        (a.metrics.coverDays ?? Number.MAX_SAFE_INTEGER) -
          (b.metrics.coverDays ?? Number.MAX_SAFE_INTEGER) || b.netBenefit - a.netBenefit,
    )[0];
    const topTransfer = [...transfers].sort((a, b) => b.netBenefit - a.netBenefit)[0];
    const topMarkdown = [...markdowns].sort((a, b) => b.netBenefit - a.netBenefit)[0];

    return {
      reorderCount: reorders.length,
      reorderGain: reorders.reduce((sum, r) => sum + r.netBenefit, 0),
      topReorder,
      transferCount: transfers.length,
      transferGain: transfers.reduce((sum, r) => sum + r.netBenefit, 0),
      topTransfer,
      markdownCount: markdowns.length,
      markdownGain: markdowns.reduce((sum, r) => sum + r.netBenefit, 0),
      topMarkdown,
    };
  }, [recommendations]);

  if (isLoading) {
    return (
      <section aria-label="Needs attention today" className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Needs attention today</h2>
        </div>
        <LoadingBlock />
      </section>
    );
  }

  if (error) {
    return (
      <section aria-label="Needs attention today" className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Needs attention today</h2>
        <ErrorBlock message={error} onRetry={onRetry ?? (() => undefined)} />
      </section>
    );
  }

  if (!summary.reorderCount && !summary.transferCount && !summary.markdownCount) {
    return (
      <section aria-label="Needs attention today" className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Needs attention today</h2>
        <EmptyBlock
          title="No urgent actions pending"
          body="All ranked recommendations for this scope have been reviewed."
        />
      </section>
    );
  }

  const cards = [
    {
      key: "stockout",
      count: summary.reorderCount,
      title: "Soonest stockout risk",
      badgeTone: "reorder" as const,
      badgeLabel: "Reorder",
      icon: TriangleAlert,
      borderClass: "border-l-info",
      iconBoxClass: "bg-info-bg text-info-text ring-1 ring-inset ring-info-ring",
      headline: `${formatNumber(summary.reorderCount)} reorders`,
      amount: `${formatMoney(summary.reorderGain)} est. gain`,
      detail: summary.topReorder
        ? `${summary.topReorder.productName} · ${formatCover(summary.topReorder.metrics.coverDays)} left (${summary.topReorder.branchName})`
        : `${formatMoney(report.lostSalesAtRisk)} sales at risk across scope`,
      to: "/queue?type=REORDER",
      cta: "Review reorders",
    },
    {
      key: "transfer",
      count: summary.transferCount,
      title: "Largest transfer opportunity",
      badgeTone: "transfer" as const,
      badgeLabel: "Transfer",
      icon: ArrowLeftRight,
      borderClass: "border-l-primary",
      iconBoxClass: "bg-indigo-bg text-indigo-text ring-1 ring-inset ring-indigo-ring",
      headline: `${formatNumber(summary.transferCount)} transfers`,
      amount: `${formatMoney(summary.transferGain)} est. gain`,
      detail: summary.topTransfer
        ? `${summary.topTransfer.productName} · ${summary.topTransfer.donorBranchName ?? "Surplus"} → ${summary.topTransfer.branchName}`
        : "No pending inter-branch transfers in this scope",
      to: "/queue?type=TRANSFER",
      cta: "Review transfers",
    },
    {
      key: "markdown",
      count: summary.markdownCount,
      title: "Markdown & overstock clearance",
      badgeTone: "markdown" as const,
      badgeLabel: "Markdown",
      icon: PackageMinus,
      borderClass: "border-l-warn",
      iconBoxClass: "bg-warn-bg text-warn-text ring-1 ring-inset ring-warn-ring",
      headline: `${formatNumber(summary.markdownCount)} markdowns`,
      amount: `${formatMoney(summary.markdownGain)} est. gain`,
      detail: summary.topMarkdown
        ? `${summary.topMarkdown.productName} · ${formatNumber(summary.topMarkdown.quantity)} units (${summary.topMarkdown.branchName})`
        : `${formatMoney(report.cashReleasable)} surplus above 30-day floor`,
      to: "/queue?type=MARKDOWN",
      cta: "Review markdowns",
    },
  ];

  return (
    <section aria-label="Needs attention today" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-foreground">Needs attention today</h2>
        <Link to="/queue?status=PENDING" className="text-xs font-medium text-primary hover:underline">
          See all pending actions →
        </Link>
      </div>

      <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))]">
        {cards.filter((card) => card.count > 0).map((card) => {
          const Icon = card.icon;
          return (
            <Card
              key={card.key}
              className={cn(
                "rounded-2xl border border-border border-l-4 bg-card shadow-card transition duration-150 hover:-translate-y-0.5",
                card.borderClass,
              )}
            >
              <CardContent className="flex h-full flex-col justify-between gap-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span
                      className={cn(
                        "flex size-8 shrink-0 items-center justify-center rounded-xl",
                        card.iconBoxClass,
                      )}
                    >
                      <Icon className="size-4" aria-hidden="true" />
                    </span>
                    <p className="truncate text-xs font-medium text-muted-foreground">{card.title}</p>
                  </div>
                  <Badge tone={card.badgeTone} className="shrink-0">
                    {card.badgeLabel}
                  </Badge>
                </div>

                <div>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-lg font-semibold text-foreground tabular-nums">
                      {card.headline}
                    </p>
                    <p className="text-xs font-semibold text-gain-text tabular-nums">{card.amount}</p>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{card.detail}</p>
                </div>

                <div className="border-t border-divider-soft pt-2">
                  <Link
                    to={card.to}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
                  >
                    <span>{card.cta}</span>
                    <ArrowRight className="size-3.5" aria-hidden="true" />
                  </Link>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </section>
  );
}

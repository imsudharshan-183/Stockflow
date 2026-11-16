import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Boxes, Check, CircleDollarSign, ListOrdered, TriangleAlert, X } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { PageHeader } from "@/components/shared/PageHeader";
import { StockAlertCategoryBadge } from "@/components/shared/StockAlertBadges";
import { EmptyBlock } from "@/components/shared/states";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Analytics } from "@/features/overview/Analytics";
import { KpiCard } from "@/features/overview/KpiCards";
import { ChartCard, weeklyPoints } from "@/features/overview/AdminOverview";
import { queryKeys } from "@/hooks/queryKeys";
import { api } from "@/lib/api";
import {
  formatDate,
  formatDateTime,
  formatMoney,
  formatNumber,
} from "@/lib/format";
import { TOKENS } from "@/lib/tokens";
import { cn } from "@/lib/utils";
import type { KpiSummary, Recommendation } from "@stockflow/core";

interface ManagerOverviewProps {
  report: KpiSummary;
  recommendations: readonly Recommendation[];
  totalActions: number;
}

export function ManagerOverview({ report, recommendations }: ManagerOverviewProps) {
  const queryClient = useQueryClient();
  const weeks = weeklyPoints(report.trend);
  const branchNames = report.branches.map((b) => b.name).join(", ");
  const pendingApprovalsCount =
    report.operational?.pendingApprovalsCount ??
    recommendations.filter((row) => row.status === "PENDING").length;
  const backlogValue =
    report.operational?.backlogValue ??
    recommendations
      .filter((row) => row.status === "PENDING")
      .reduce((sum, row) => sum + row.netBenefit, 0);
  const atRiskCount = report.operational?.atRiskBranchCount ?? 0;

  const alertsQuery = useQuery({
    queryKey: queryKeys.stockAlerts,
    queryFn: () => api.listStockAlerts(),
  });

  const decideAlertMutation = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "approve" | "reject" }) =>
      decision === "approve" ? api.approveStockAlert(id) : api.rejectStockAlert(id),
    onSuccess: async (updated) => {
      toast.success(
        `Stock alert for ${updated.sku} ${updated.status === "APPROVED" ? "approved" : "rejected"}`,
      );
      await queryClient.invalidateQueries({ queryKey: queryKeys.stockAlerts });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const pendingAlerts = (alertsQuery.data?.alerts ?? []).filter((a) => a.status === "PENDING");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cluster overview"
        subtitle={`As of ${formatDate(report.asOf)} · ${formatNumber(report.branches.length)} assigned branches (${branchNames})`}
      />

      {/* Manager Cluster Hero Panel */}
      <section className="hero-surface flex flex-col justify-between gap-4 rounded-2xl border border-border p-6 shadow-card lg:flex-row lg:items-center">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="manager">Cluster Operations</Badge>
            <span className="text-xs font-medium text-muted-foreground">
              {formatNumber(report.branches.length)} branches assigned ({report.branches.map((b) => b.id).join(", ")})
            </span>
          </div>
          <h2 className="text-lg font-semibold tracking-tight text-foreground sm:text-xl">
            {pendingApprovalsCount > 0
              ? `${formatNumber(pendingApprovalsCount)} pending approvals worth ${formatMoney(backlogValue)} in cluster estimated gain`
              : "All cluster recommendations reviewed"}
          </h2>
          <p className="text-sm text-muted-foreground">
            Reviewing inventory actions touching:{" "}
            <span className="font-medium text-foreground">{branchNames}</span>. Decisions apply to your cluster only.
          </p>
        </div>

        <div className="shrink-0">
          <span className="hero-cta-glow inline-block rounded-xl">
            <Link
              to="/queue"
              className={cn(
                buttonVariants({ variant: "primary", size: "lg" }),
                "rounded-xl px-5 font-semibold",
              )}
            >
              Review cluster queue
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </span>
        </div>
      </section>

      {/* 4 Focused Manager KPI Cards */}
      <section className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Pending approvals"
          value={formatNumber(pendingApprovalsCount)}
          note={`Action backlog: ${formatMoney(backlogValue)} estimated gain`}
          formula="Count of pending transfers, reorders, and markdowns touching your assigned stores."
          icon={ListOrdered}
          tone="gain"
          money={false}
          footerLabel="Awaiting cluster decision"
        />
        <KpiCard
          label="At-risk branches"
          value={`${formatNumber(atRiskCount)} / ${formatNumber(report.branches.length)}`}
          note="Assigned stores with elevated stockout risk or shelf deficit."
          formula="Count of your assigned branches where stockout rate exceeds 5% or positions are below reorder level."
          icon={TriangleAlert}
          tone="risk"
          money={false}
          footerLabel="Branches needing attention in cluster"
        />
        <KpiCard
          label="Cluster sales at risk"
          value={formatMoney(report.lostSalesAtRisk)}
          note="Shelf revenue your assigned branches may miss before next delivery."
          formula="Expected lost units × retail price for positions below reorder level in your cluster."
          icon={CircleDollarSign}
          tone="info"
          footerLabel="Positions below reorder level in cluster"
        />
        <KpiCard
          label="Cluster overstock value"
          value={formatMoney(report.cashReleasable)}
          note={`Includes ${formatMoney(report.deadStockValue)} dead stock in cluster (<1 unit/wk)`}
          formula="Stock above the 30-day donor floor × unit cost across your assigned branches."
          icon={Boxes}
          tone="warn"
          footerLabel="Surplus above 30-day donor floor in cluster"
        />
      </section>

      {/* Scoped Pending Staff Stock Alerts */}
      <Card className="rounded-2xl border border-border bg-card shadow-card">
        <CardHeader className="flex flex-row items-center justify-between gap-4 border-b border-border/70 pb-4">
          <div>
            <CardTitle>Pending branch stock alerts</CardTitle>
            <CardDescription>
              Staff floor escalations in your assigned branches awaiting approval or rejection.
            </CardDescription>
          </div>
          <Badge tone={pendingAlerts.length > 0 ? "pending" : "ok"}>
            {formatNumber(pendingAlerts.length)} pending
          </Badge>
        </CardHeader>
        <CardContent className="p-0">
          {pendingAlerts.length === 0 ? (
            <div className="p-6">
              <EmptyBlock
                title="No pending branch stock alerts"
                body="Branch staff escalations in your assigned stores will appear here for cluster review."
              />
            </div>
          ) : (
            <Table className="min-w-[760px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Branch</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Flagged by</TableHead>
                  <TableHead>Category &amp; note</TableHead>
                  <TableHead>Submitted</TableHead>
                  <TableHead className="text-right">Decision</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pendingAlerts.map((alert) => (
                  <TableRow key={alert.id}>
                    <TableCell className="font-medium text-foreground">
                      {alert.branchName ? `${alert.branchId} · ${alert.branchName}` : alert.branchId}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-foreground">
                      {alert.sku}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{alert.flaggedBy.name}</TableCell>
                    <TableCell className="max-w-md">
                      <div className="flex flex-wrap items-center gap-2">
                        <StockAlertCategoryBadge category={alert.category} />
                        <span className="truncate text-foreground">{alert.note}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDateTime(alert.flaggedAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex items-center gap-1.5">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={decideAlertMutation.isPending}
                          onClick={() => decideAlertMutation.mutate({ id: alert.id, decision: "approve" })}
                        >
                          <Check className="size-3.5" aria-hidden="true" />
                          Approve
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={decideAlertMutation.isPending}
                          onClick={() => decideAlertMutation.mutate({ id: alert.id, decision: "reject" })}
                        >
                          <X className="size-3.5" aria-hidden="true" />
                          Reject
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Scoped Cover Grid Heatmap & Analytics (strictly manager's branches) */}
      <Analytics report={report} rows={recommendations} />

      {/* Cluster Trend Charts */}
      <section className="grid gap-6 lg:grid-cols-2">
        <ChartCard
          title="Cluster stockout rate trend"
          data={weeks}
          dataKey="stockoutRate"
          color={TOKENS.chart.stockoutRate}
          kind="rate"
        />
        <ChartCard
          title="Cluster inventory value trend"
          data={weeks}
          dataKey="inventoryValue"
          color={TOKENS.chart.inventoryValue}
          kind="money"
        />
      </section>

      {/* Queue Callout Card */}
      <Card className="rounded-2xl border border-border bg-card shadow-card">
        <CardContent className="flex flex-col items-start justify-between gap-4 py-2 sm:flex-row sm:items-center">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              Ready to decide on cluster recommendations?
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {`${formatNumber(pendingApprovalsCount)} actions (${formatMoney(backlogValue)} estimated gain) are pending your decision in the Action Queue.`}
            </p>
          </div>
          <Link
            to="/queue"
            className={cn(buttonVariants({ variant: "secondary", size: "default" }), "shrink-0")}
          >
            Open cluster queue
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}

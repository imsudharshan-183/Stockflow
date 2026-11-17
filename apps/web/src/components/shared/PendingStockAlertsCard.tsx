import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { toast } from "sonner";
import { StockAlertCategoryBadge } from "@/components/shared/StockAlertBadges";
import { EmptyBlock } from "@/components/shared/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { queryKeys } from "@/hooks/queryKeys";
import { api } from "@/lib/api";
import { formatDateTime, formatNumber } from "@/lib/format";

interface PendingStockAlertsCardProps {
  scope?: "branch" | "network";
}

export function PendingStockAlertsCard({ scope = "branch" }: PendingStockAlertsCardProps) {
  const queryClient = useQueryClient();

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
  const isNetwork = scope === "network";

  return (
    <Card className="rounded-2xl border border-border bg-card shadow-card">
      <CardHeader className="flex flex-row items-center justify-between gap-4 border-b border-border/70 pb-4">
        <div>
          <CardTitle>Pending branch stock alerts</CardTitle>
          <CardDescription>
            {isNetwork
              ? "Staff floor escalations across all branches awaiting approval or rejection."
              : "Staff floor escalations in your assigned branches awaiting approval or rejection."}
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
              body={
                isNetwork
                  ? "Branch staff escalations across the network will appear here for review."
                  : "Branch staff escalations in your assigned stores will appear here for cluster review."
              }
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
  );
}

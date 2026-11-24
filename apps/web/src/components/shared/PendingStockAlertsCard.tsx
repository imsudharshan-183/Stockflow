import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { DonorPicker } from "@/components/shared/DonorPicker";
import { StockAlertCategoryBadge } from "@/components/shared/StockAlertBadges";
import { EmptyBlock } from "@/components/shared/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { invalidateOperationalQueries, queryKeys } from "@/hooks/queryKeys";
import { api } from "@/lib/api";
import { formatDateTime, formatNumber } from "@/lib/format";
import type {
  ResolveStockAlert,
  StockAlert,
  StockAlertResolutionAction,
} from "@stockflow/core";

interface PendingStockAlertsCardProps {
  scope?: "branch" | "network";
  branchId?: string | null;
}

const RESOLUTION_OPTIONS: ReadonlyArray<{
  value: StockAlertResolutionAction;
  label: string;
}> = [
  { value: "CONVERTED_TO_REQUEST", label: "Request Replenishment" },
  { value: "LOGGED_ADJUSTMENT", label: "Log Adjustment" },
  { value: "ACKNOWLEDGED", label: "Acknowledge" },
  { value: "DISMISSED", label: "Dismiss" },
];

export function PendingStockAlertsCard({
  scope = "branch",
  branchId = null,
}: PendingStockAlertsCardProps) {
  const queryClient = useQueryClient();
  const branchParam = branchId || undefined;

  const alertsQuery = useQuery({
    queryKey: queryKeys.stockAlerts(branchParam),
    queryFn: () => api.listStockAlerts(branchParam),
  });

  const [resolveTarget, setResolveTarget] = useState<StockAlert | null>(null);
  const [action, setAction] = useState<StockAlertResolutionAction>("CONVERTED_TO_REQUEST");
  const [orderType, setOrderType] = useState<"TRANSFER" | "REORDER">("TRANSFER");
  const [quantity, setQuantity] = useState("20");
  const [sourceBranchId, setSourceBranchId] = useState<string | null>(null);
  const [adjustmentMode, setAdjustmentMode] = useState<"count" | "delta">("count");
  const [adjustedOnHand, setAdjustedOnHand] = useState("");
  const [adjustmentDelta, setAdjustmentDelta] = useState("");
  const [comment, setComment] = useState("");

  const resetDialog = () => {
    setResolveTarget(null);
    setAction("CONVERTED_TO_REQUEST");
    setOrderType("TRANSFER");
    setQuantity("20");
    setSourceBranchId(null);
    setAdjustmentMode("count");
    setAdjustedOnHand("");
    setAdjustmentDelta("");
    setComment("");
  };

  const openResolveDialog = (alert: StockAlert) => {
    setResolveTarget(alert);
    setAction("CONVERTED_TO_REQUEST");
    setOrderType("TRANSFER");
    setQuantity("20");
    setSourceBranchId(null);
    setAdjustmentMode("count");
    setAdjustedOnHand(alert.reportedQty !== undefined ? String(alert.reportedQty) : "");
    setAdjustmentDelta("");
    setComment("");
  };

  const resolveMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: ResolveStockAlert }) =>
      api.resolveStockAlert(id, payload),
    onSuccess: async (res) => {
      if (res.order) {
        toast.success(`Resolved ${res.alert.sku} and created order ${res.order.id}`);
      } else {
        toast.success(`Resolved stock alert for ${res.alert.sku}`);
      }
      resetDialog();
      await invalidateOperationalQueries(queryClient);
    },
    onError: (err: Error) => toast.error(err.message || "Unable to resolve stock alert"),
  });

  const pendingAlerts = (alertsQuery.data?.alerts ?? []).filter((a) => a.status === "PENDING");
  const isNetwork = scope === "network";

  const parsedQty = Number.isFinite(Number(quantity)) ? Math.floor(Number(quantity)) : 0;
  const parsedCount =
    adjustedOnHand.trim() !== "" && Number.isFinite(Number(adjustedOnHand))
      ? Math.floor(Number(adjustedOnHand))
      : undefined;
  const parsedDelta =
    adjustmentDelta.trim() !== "" && Number.isFinite(Number(adjustmentDelta))
      ? Math.trunc(Number(adjustmentDelta))
      : undefined;

  const canSubmit = (() => {
    if (!resolveTarget || resolveMutation.isPending) return false;
    if (action === "DISMISSED") return comment.trim().length > 0;
    if (action === "CONVERTED_TO_REQUEST") return parsedQty > 0;
    if (action === "LOGGED_ADJUSTMENT") {
      if (adjustmentMode === "count") {
        return parsedCount !== undefined && parsedCount >= 0;
      }
      return parsedDelta !== undefined && parsedDelta !== 0;
    }
    return true;
  })();

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!resolveTarget || !canSubmit) return;
    const trimmedComment = comment.trim() || undefined;

    if (action === "CONVERTED_TO_REQUEST") {
      resolveMutation.mutate({
        id: resolveTarget.id,
        payload: {
          action,
          orderType,
          quantity: parsedQty,
          ...(orderType === "TRANSFER" && sourceBranchId ? { sourceBranchId } : {}),
          ...(trimmedComment ? { comment: trimmedComment } : {}),
        },
      });
      return;
    }

    if (action === "LOGGED_ADJUSTMENT") {
      resolveMutation.mutate({
        id: resolveTarget.id,
        payload: {
          action,
          ...(adjustmentMode === "count" && parsedCount !== undefined
            ? { adjustedOnHand: parsedCount }
            : {}),
          ...(adjustmentMode === "delta" && parsedDelta !== undefined
            ? { adjustmentDelta: parsedDelta }
            : {}),
          ...(trimmedComment ? { comment: trimmedComment } : {}),
        },
      });
      return;
    }

    resolveMutation.mutate({
      id: resolveTarget.id,
      payload: {
        action,
        ...(trimmedComment ? { comment: trimmedComment } : {}),
      },
    });
  };

  return (
    <>
      <Card className="rounded-2xl border border-border bg-card shadow-card">
        <CardHeader className="flex flex-row items-center justify-between gap-4 border-b border-border/70 pb-4">
          <div>
            <CardTitle>Pending branch stock alerts</CardTitle>
            <CardDescription>
              {isNetwork
                ? "Staff floor escalations across all branches awaiting structured resolution."
                : "Staff floor escalations in your assigned branches awaiting resolution."}
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
                  <TableHead>Category, count &amp; note</TableHead>
                  <TableHead>Submitted</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pendingAlerts.map((alert) => (
                  <TableRow key={alert.id}>
                    <TableCell className="font-medium text-foreground">
                      {alert.branchName ? `${alert.branchId} · ${alert.branchName}` : alert.branchId}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      <Link
                        to={`/products/${alert.sku}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {alert.sku}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{alert.flaggedBy.name}</TableCell>
                    <TableCell className="max-w-md">
                      <div className="flex flex-wrap items-center gap-2">
                        <StockAlertCategoryBadge category={alert.category} />
                        {alert.reportedQty !== undefined ? (
                          <Badge variant="outline" className="tabular-nums">
                            Count: {formatNumber(alert.reportedQty)}
                          </Badge>
                        ) : null}
                        <span className="truncate text-foreground">{alert.note}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDateTime(alert.flaggedAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={resolveMutation.isPending}
                        onClick={() => openResolveDialog(alert)}
                      >
                        <ClipboardCheck className="size-3.5" aria-hidden="true" />
                        Resolve
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={resolveTarget !== null}
        onOpenChange={(open) => {
          if (!open) resetDialog();
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto rounded-2xl">
          <DialogHeader>
            <DialogTitle>Resolve stock alert</DialogTitle>
            <DialogDescription>
              Choose how to resolve{" "}
              <span className="font-medium text-foreground">
                {resolveTarget ? `${resolveTarget.sku} at ${resolveTarget.branchId}` : ""}
              </span>
              {resolveTarget?.reportedQty !== undefined
                ? ` · Reported physical count: ${formatNumber(resolveTarget.reportedQty)} units`
                : ""}
              .
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Resolution path">
              {RESOLUTION_OPTIONS.map((opt) => (
                <Button
                  key={opt.value}
                  type="button"
                  size="xs"
                  variant={action === opt.value ? "primary" : "outline"}
                  onClick={() => setAction(opt.value)}
                >
                  {opt.label}
                </Button>
              ))}
            </div>

            {action === "CONVERTED_TO_REQUEST" && resolveTarget ? (
              <div className="space-y-3 rounded-xl border border-border bg-secondary/30 p-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <label htmlFor="resolve-order-type" className="text-xs font-medium text-foreground">
                      Order type
                    </label>
                    <select
                      id="resolve-order-type"
                      aria-label="Order type"
                      value={orderType}
                      onChange={(e) => {
                        const next = e.target.value === "REORDER" ? "REORDER" : "TRANSFER";
                        setOrderType(next);
                        if (next !== "TRANSFER") setSourceBranchId(null);
                      }}
                      className="h-9 w-full rounded-xl border border-border bg-card px-3 text-xs font-medium text-foreground"
                    >
                      <option value="TRANSFER">Transfer from donor</option>
                      <option value="REORDER">Supplier Reorder</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label htmlFor="resolve-qty" className="text-xs font-medium text-foreground">
                      Quantity
                    </label>
                    <Input
                      id="resolve-qty"
                      type="number"
                      min={1}
                      step={1}
                      value={quantity}
                      onChange={(e) => setQuantity(e.target.value)}
                      required
                    />
                  </div>
                </div>

                {orderType === "TRANSFER" && parsedQty > 0 ? (
                  <DonorPicker
                    sku={resolveTarget.sku}
                    targetBranchId={resolveTarget.branchId}
                    quantity={parsedQty}
                    selectedDonorId={sourceBranchId}
                    onSelectDonor={setSourceBranchId}
                    allowUnassigned
                  />
                ) : null}
              </div>
            ) : null}

            {action === "LOGGED_ADJUSTMENT" ? (
              <div className="space-y-3 rounded-xl border border-border bg-secondary/30 p-3">
                <div className="flex flex-wrap gap-1.5">
                  <Button
                    type="button"
                    size="xs"
                    variant={adjustmentMode === "count" ? "secondary" : "ghost"}
                    onClick={() => setAdjustmentMode("count")}
                  >
                    Set physical on-hand count
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant={adjustmentMode === "delta" ? "secondary" : "ghost"}
                    onClick={() => setAdjustmentMode("delta")}
                  >
                    Enter unit adjustment (+/-)
                  </Button>
                </div>

                {adjustmentMode === "count" ? (
                  <div className="space-y-1">
                    <label htmlFor="resolve-adjusted-onhand" className="text-xs font-medium text-foreground">
                      Physical on-hand count
                    </label>
                    <Input
                      id="resolve-adjusted-onhand"
                      type="number"
                      min={0}
                      step={1}
                      placeholder="Verified shelf quantity"
                      value={adjustedOnHand}
                      onChange={(e) => setAdjustedOnHand(e.target.value)}
                      required
                    />
                  </div>
                ) : (
                  <div className="space-y-1">
                    <label htmlFor="resolve-adjustment-delta" className="text-xs font-medium text-foreground">
                      Adjustment delta (e.g., -5 for shrinkage)
                    </label>
                    <Input
                      id="resolve-adjustment-delta"
                      type="number"
                      step={1}
                      placeholder="-5"
                      value={adjustmentDelta}
                      onChange={(e) => setAdjustmentDelta(e.target.value)}
                      required
                    />
                  </div>
                )}
              </div>
            ) : null}

            <div className="space-y-1.5">
              <label htmlFor="resolve-comment" className="text-xs font-medium text-foreground">
                {action === "DISMISSED" ? "Dismissal reason (required)" : "Resolution comment"}
              </label>
              <Input
                id="resolve-comment"
                placeholder={
                  action === "DISMISSED"
                    ? "Required explanation visible to store staff..."
                    : "Optional note visible to store staff..."
                }
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                maxLength={500}
                required={action === "DISMISSED"}
              />
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                disabled={resolveMutation.isPending}
                onClick={resetDialog}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant={action === "DISMISSED" ? "destructive" : "primary"}
                loading={resolveMutation.isPending}
                disabled={!canSubmit}
              >
                Confirm resolution
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

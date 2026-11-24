import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { DonorPicker } from "@/components/shared/DonorPicker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/features/auth/AuthContext";
import { queryKeys } from "@/hooks/queryKeys";
import { api } from "@/lib/api";
import { formatProductDisplayName } from "@stockflow/core";

export interface RequestStockDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultBranchId?: string | null;
}

export function RequestStockDialog({
  open,
  onOpenChange,
  defaultBranchId = null,
}: RequestStockDialogProps) {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const locationsQuery = useQuery({
    queryKey: queryKeys.locations,
    queryFn: () => api.locations(),
    enabled: open,
  });

  const productsQuery = useQuery({
    queryKey: queryKeys.catalogProducts({ status: "active", page: 1, limit: 100 }),
    queryFn: () => api.listCatalogProducts({ status: "active", page: 1, limit: 100 }),
    enabled: open,
  });

  const scopedBranches = useMemo(() => {
    const all = (locationsQuery.data?.locations ?? []).map((item) => item.branch);
    if (!user || user.role === "admin") return all;
    return all.filter((b) => user.branchIds.includes(b.id));
  }, [locationsQuery.data?.locations, user]);

  const products = useMemo(
    () => productsQuery.data?.products ?? [],
    [productsQuery.data?.products],
  );

  const [targetBranchId, setTargetBranchId] = useState("");
  const [sku, setSku] = useState("");
  const [orderType, setOrderType] = useState<"TRANSFER" | "REORDER">("TRANSFER");
  const [quantity, setQuantity] = useState("20");
  const [sourceBranchId, setSourceBranchId] = useState<string | null>(null);
  const [comment, setComment] = useState("");

  useEffect(() => {
    if (!open) return;
    if (defaultBranchId && scopedBranches.some((b) => b.id === defaultBranchId)) {
      setTargetBranchId(defaultBranchId);
    } else if (!targetBranchId && scopedBranches[0]) {
      setTargetBranchId(scopedBranches[0].id);
    }
  }, [open, defaultBranchId, scopedBranches, targetBranchId]);

  useEffect(() => {
    if (!open) return;
    if (!sku && products[0]) {
      setSku(products[0].sku);
    }
  }, [open, products, sku]);

  const parsedQty = Number.isFinite(Number(quantity)) ? Math.floor(Number(quantity)) : 0;

  const createMutation = useMutation({
    mutationFn: (payload: Parameters<typeof api.createOrder>[0]) => api.createOrder(payload),
    onSuccess: async (created) => {
      toast.success(
        created.sourceBranchId
          ? `Requested ${created.quantity} units of ${created.sku} from ${created.sourceBranchId}`
          : `Created ${created.type.toLowerCase()} request for ${created.sku}`,
      );
      setSourceBranchId(null);
      setComment("");
      onOpenChange(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["orders"] }),
        queryClient.invalidateQueries({ queryKey: ["kpis"] }),
        queryClient.invalidateQueries({ queryKey: ["audit"] }),
        queryClient.invalidateQueries({ queryKey: ["stockAlerts"] }),
      ]);
    },
    onError: (err: Error) => {
      toast.error(err.message || "Unable to create replenishment request");
    },
  });

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!targetBranchId || !sku || parsedQty <= 0) return;
    createMutation.mutate({
      type: orderType,
      sku,
      targetBranchId,
      ...(orderType === "TRANSFER" && sourceBranchId ? { sourceBranchId } : {}),
      quantity: parsedQty,
      ...(comment.trim() ? { comment: comment.trim() } : {}),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto rounded-2xl">
        <DialogHeader>
          <DialogTitle>Request stock replenishment</DialogTitle>
          <DialogDescription>
            Submit an inter-branch transfer request (with ranked sending branches) or supplier reorder.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="request-target-branch" className="text-xs font-medium text-foreground">
                Receiving branch
              </label>
              <select
                id="request-target-branch"
                aria-label="Receiving branch"
                value={targetBranchId}
                onChange={(e) => {
                  setTargetBranchId(e.target.value);
                  setSourceBranchId(null);
                }}
                className="h-9 w-full rounded-xl border border-border bg-card px-3 text-xs font-medium text-foreground shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                required
              >
                {scopedBranches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.id} · {b.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="request-order-type" className="text-xs font-medium text-foreground">
                Replenishment type
              </label>
              <select
                id="request-order-type"
                aria-label="Replenishment type"
                value={orderType}
                onChange={(e) => {
                  const next = e.target.value === "REORDER" ? "REORDER" : "TRANSFER";
                  setOrderType(next);
                  if (next !== "TRANSFER") setSourceBranchId(null);
                }}
                className="h-9 w-full rounded-xl border border-border bg-card px-3 text-xs font-medium text-foreground shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <option value="TRANSFER">Inter-branch Transfer</option>
                <option value="REORDER">Supplier Reorder</option>
              </select>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5 sm:col-span-2">
              <label htmlFor="request-sku" className="text-xs font-medium text-foreground">
                Product / SKU
              </label>
              <select
                id="request-sku"
                aria-label="Product SKU"
                value={sku}
                onChange={(e) => {
                  setSku(e.target.value);
                  setSourceBranchId(null);
                }}
                className="h-9 w-full rounded-xl border border-border bg-card px-3 text-xs font-medium text-foreground shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                required
              >
                {products.map((p) => (
                  <option key={p.sku} value={p.sku}>
                    {p.sku} · {formatProductDisplayName(p.name, p.sku)}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="request-qty" className="text-xs font-medium text-foreground">
                Quantity
              </label>
              <Input
                id="request-qty"
                type="number"
                min={1}
                step={1}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                required
              />
            </div>
          </div>

          {orderType === "TRANSFER" && sku && targetBranchId && parsedQty > 0 ? (
            <DonorPicker
              sku={sku}
              targetBranchId={targetBranchId}
              quantity={parsedQty}
              selectedDonorId={sourceBranchId}
              onSelectDonor={setSourceBranchId}
              allowUnassigned
            />
          ) : null}

          <div className="space-y-1.5">
            <label htmlFor="request-comment" className="text-xs font-medium text-foreground">
              Request note (optional)
            </label>
            <Input
              id="request-comment"
              placeholder="Why this replenishment is needed..."
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              maxLength={500}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => onOpenChange(false)}
              disabled={createMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={createMutation.isPending}
              disabled={!targetBranchId || !sku || parsedQty <= 0}
            >
              Submit request
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

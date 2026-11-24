import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, MapPin } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { queryKeys } from "@/hooks/queryKeys";
import { api } from "@/lib/api";
import {
  formatCover,
  formatDistanceKm,
  formatMoneyFull,
  formatMoneyPrecise,
  formatNumber,
} from "@/lib/format";
import { ORDER_STATUS_LABELS } from "@/lib/labels";
import { cn } from "@/lib/utils";

export interface DonorPickerProps {
  sku: string;
  targetBranchId: string;
  quantity: number;
  selectedDonorId: string | null;
  onSelectDonor: (branchId: string | null) => void;
  excludeBranchId?: string | null;
  allowUnassigned?: boolean;
}

/**
 * Ranked transfer donor selector backed by GET /api/orders/donor-candidates.
 * Shows Haversine distance, BHD freight, donor post-release cover days, and net benefit.
 */
export function DonorPicker({
  sku,
  targetBranchId,
  quantity,
  selectedDonorId,
  onSelectDonor,
  excludeBranchId = null,
  allowUnassigned = false,
}: DonorPickerProps) {
  const validQuery = Boolean(sku && targetBranchId && quantity > 0);
  const candidatesQuery = useQuery({
    queryKey: queryKeys.donorCandidates({
      sku,
      target: targetBranchId,
      qty: Math.max(1, Math.floor(quantity)),
    }),
    queryFn: () =>
      api.donorCandidates({
        sku,
        target: targetBranchId,
        qty: Math.max(1, Math.floor(quantity)),
        limit: 10,
      }),
    enabled: validQuery,
  });

  if (!validQuery) {
    return null;
  }

  const candidates = (candidatesQuery.data?.candidates ?? []).filter(
    (c) => !excludeBranchId || c.branchId !== excludeBranchId,
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium text-foreground">
          Ranked sending branches (ordered by estimated gain)
        </span>
        {allowUnassigned ? (
          <Button
            type="button"
            variant={selectedDonorId === null ? "secondary" : "ghost"}
            size="xs"
            onClick={() => onSelectDonor(null)}
          >
            Leave unassigned ({ORDER_STATUS_LABELS.OPEN_REQUEST})
          </Button>
        ) : null}
      </div>

      {candidatesQuery.isPending ? (
        <div className="space-y-2">
          <Skeleton className="h-14 w-full rounded-xl" />
          <Skeleton className="h-14 w-full rounded-xl" />
        </div>
      ) : candidatesQuery.isError ? (
        <div className="rounded-xl border border-risk-ring bg-risk-bg px-3 py-2 text-xs text-risk-text">
          {candidatesQuery.error.message || "Unable to load ranked sending branches"}
        </div>
      ) : candidates.length === 0 ? (
        <div className="rounded-xl border border-border bg-secondary/40 px-3 py-2.5 text-xs text-muted-foreground">
          No eligible sending branches with at least 30 days cover + safety stock for this SKU.
        </div>
      ) : (
        <div className="space-y-2" role="listbox" aria-label="Ranked sending branches">
          {candidates.slice(0, 3).map((candidate) => {
            const isSelected = selectedDonorId === candidate.branchId;
            return (
              <Button
                key={candidate.branchId}
                type="button"
                role="option"
                aria-selected={isSelected}
                variant={isSelected ? "secondary" : "outline"}
                onClick={() => onSelectDonor(candidate.branchId)}
                className={cn(
                  "h-auto w-full flex-col items-stretch justify-start gap-1.5 rounded-xl px-3 py-2.5 text-left whitespace-normal",
                  isSelected ? "border-primary bg-primary-soft/40 ring-1 ring-primary/40" : "",
                )}
              >
                <div className="flex w-full items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1.5 font-medium text-foreground">
                    {isSelected ? (
                      <CheckCircle2 className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                    ) : (
                      <MapPin className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    )}
                    <span className="truncate">
                      {candidate.branchId} · {candidate.branchName}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {candidate.isPartial ? (
                      <Badge tone="over">Partial: {formatNumber(candidate.offeredQty)} units</Badge>
                    ) : null}
                    <span className="text-xs font-semibold text-foreground tabular-nums">
                      {formatMoneyFull(candidate.netBenefitBhd)} estimated gain
                    </span>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
                  <span>{formatDistanceKm(candidate.distanceKm)}</span>
                  <span>Freight: {formatMoneyPrecise(candidate.freightCostBhd)}</span>
                  <span>Surplus: {formatNumber(candidate.availableSurplusUnits)} units</span>
                  <span>Sending branch cover after: {formatCover(candidate.donorCoverDaysAfter)}</span>
                </div>
              </Button>
            );
          })}
        </div>
      )}
    </div>
  );
}

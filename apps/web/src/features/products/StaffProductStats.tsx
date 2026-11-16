import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ChevronLeft, ChevronRight, Package, Search, X } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyBlock, ErrorBlock, TableSkeleton } from "@/components/shared/states";
import { Badge, type BadgeTone } from "@/components/ui/badge";
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
import {
  Table,
  TableBody,
  TableCard,
  TableCardFooter,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableToolbar,
} from "@/components/ui/table";
import { useAuth } from "@/features/auth/AuthContext";
import { queryKeys } from "@/hooks/queryKeys";
import { api } from "@/lib/api";
import { formatCover, formatNumber } from "@/lib/format";
import {
  CATALOG_CATEGORIES,
  formatProductDisplayName,
  type PositionStatus,
  type Product,
  type ProductListQuery,
  type StockAlert,
} from "@stockflow/core";

const CATEGORIES = ["All categories", ...CATALOG_CATEGORIES] as const;

function statusBadgeConfig(status: PositionStatus | undefined): { label: string; tone: BadgeTone } {
  switch (status) {
    case "AT_RISK":
      return { label: "At Risk", tone: "risk" };
    case "OVERSTOCK":
      return { label: "Overstock", tone: "over" };
    case "HEALTHY":
      return { label: "Healthy", tone: "ok" };
    case "NEW":
    default:
      return { label: "New", tone: "fresh" };
  }
}

export function StaffProductStats() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("All categories");
  const [page, setPage] = useState(1);
  const [flagTarget, setFlagTarget] = useState<Product | null>(null);
  const [flagNote, setFlagNote] = useState("");
  const limit = 25;

  const staffBranchId = user?.branchIds?.[0] ?? "Store";

  const queryParams: ProductListQuery = useMemo(
    () => ({
      page,
      limit,
      branch: staffBranchId,
      category: selectedCategory === "All categories" ? undefined : selectedCategory,
      search: search.trim() ? search.trim() : undefined,
    }),
    [page, limit, staffBranchId, selectedCategory, search],
  );

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: queryKeys.catalogProducts(queryParams as unknown as Record<string, unknown>),
    queryFn: () => api.listCatalogProducts(queryParams),
  });

  const alertsQuery = useQuery({
    queryKey: queryKeys.stockAlerts,
    queryFn: () => api.listStockAlerts(),
    enabled: Boolean(user),
  });

  const flagMutation = useMutation({
    mutationFn: api.createStockAlert,
    onSuccess: async (created) => {
      toast.success(`Flagged critical stock for ${created.sku}`);
      setFlagTarget(null);
      setFlagNote("");
      await queryClient.invalidateQueries({ queryKey: queryKeys.stockAlerts });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const alertBySku = useMemo(() => {
    const map = new Map<string, StockAlert>();
    for (const alert of alertsQuery.data?.alerts ?? []) {
      if (alert.branchId !== staffBranchId) continue;
      const existing = map.get(alert.sku);
      if (!existing || alert.status === "PENDING") {
        map.set(alert.sku, alert);
      }
    }
    return map;
  }, [alertsQuery.data?.alerts, staffBranchId]);

  const products = data?.products ?? [];
  const total = data?.total ?? 0;
  const totalPages = data?.totalPages ?? 1;

  const handleSearchChange = (val: string) => {
    setSearch(val);
    setPage(1);
  };

  const handleCategoryChange = (cat: string) => {
    setSelectedCategory(cat);
    setPage(1);
  };

  const handleFlagSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!flagTarget || !flagNote.trim()) return;
    flagMutation.mutate({
      branchId: staffBranchId,
      sku: flagTarget.sku,
      note: flagNote.trim(),
    });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Store Inventory"
        subtitle={`Branch ${staffBranchId} · Live shelf stock & cover days`}
      />

      <TableCard>
        <TableToolbar>
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="relative w-64">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search SKU or name..."
                value={search}
                onChange={(e) => handleSearchChange(e.target.value)}
                className="pl-9"
              />
              {search ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute top-1/2 right-1.5 size-6 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={() => handleSearchChange("")}
                  aria-label="Clear search"
                >
                  <X className="size-3.5" />
                </Button>
              ) : null}
            </div>

            <select
              aria-label="Filter by category"
              className="h-9 rounded-lg border border-border bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
              value={selectedCategory}
              onChange={(e) => handleCategoryChange(e.target.value)}
            >
              {CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>

            {(search || selectedCategory !== "All categories") ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSearch("");
                  setSelectedCategory("All categories");
                  setPage(1);
                }}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Reset filters
              </Button>
            ) : null}
          </div>

          <div className="text-xs text-muted-foreground">
            Showing {products.length > 0 ? (page - 1) * limit + 1 : 0}–
            {Math.min(page * limit, total)} of {formatNumber(total)} products
          </div>
        </TableToolbar>

        {isPending ? (
          <TableSkeleton rows={8} />
        ) : isError ? (
          <div className="p-8">
            <ErrorBlock message={error?.message || "Failed to load store inventory"} onRetry={() => void refetch()} />
          </div>
        ) : products.length === 0 ? (
          <div className="p-8">
            <EmptyBlock
              title="No products found"
              body={
                search || selectedCategory !== "All categories"
                  ? "Try adjusting your search query or category filter."
                  : "No products currently assigned to this branch."
              }
            />
          </div>
        ) : (
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[320px]">Product</TableHead>
                <TableHead className="w-[140px]">Category</TableHead>
                <TableHead className="w-[100px] text-right">On Hand</TableHead>
                <TableHead className="w-[100px] text-right">Velocity</TableHead>
                <TableHead className="w-[110px] text-right">Cover Days</TableHead>
                <TableHead className="w-[110px]">Health</TableHead>
                <TableHead className="w-[180px] text-right">Alert</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((p) => {
                const badge = statusBadgeConfig(p.stats?.status);
                const displayName = formatProductDisplayName(p.name, p.sku);
                const alert = alertBySku.get(p.sku);
                const isAtRisk = p.stats?.status === "AT_RISK";

                return (
                  <TableRow key={p.sku}>
                    <TableCell>
                      <div className="flex items-center gap-2.5">
                        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40 text-muted-foreground">
                          <Package className="size-4" />
                        </div>
                        <div className="min-w-0">
                          <p className="truncate font-medium text-foreground">{displayName}</p>
                          <p className="font-mono text-xs text-muted-foreground">{p.sku}</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{p.category}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums text-foreground">
                      {formatNumber(p.stats?.onHand ?? 0)}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums text-foreground">
                      {formatNumber(p.stats?.velocity ?? 0)}/d
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums text-foreground">
                      {formatCover(p.stats?.coverDays)}
                    </TableCell>
                    <TableCell>
                      <Badge tone={badge.tone}>{badge.label}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {!isAtRisk ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : alert?.status === "PENDING" ? (
                        <Badge tone="pending">Pending review</Badge>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setFlagTarget(p);
                            setFlagNote("");
                          }}
                        >
                          <AlertTriangle className="size-3.5" aria-hidden="true" />
                          Flag critical stock
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}

        <TableCardFooter>
          <div className="flex w-full items-center justify-between">
            <span className="text-xs text-muted-foreground">
              Page {page} of {totalPages}
            </span>
            <div className="flex items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                disabled={page <= 1}
                aria-label="Previous page"
              >
                <ChevronLeft className="size-4" />
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
                disabled={page >= totalPages}
                aria-label="Next page"
              >
                Next
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        </TableCardFooter>
      </TableCard>

      <Dialog
        open={Boolean(flagTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setFlagTarget(null);
            setFlagNote("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Flag critical stock</DialogTitle>
            <DialogDescription>
              Notify your cluster manager about critical shelf shortage for{" "}
              <span className="font-medium text-foreground">
                {flagTarget ? `${flagTarget.sku} · ${formatProductDisplayName(flagTarget.name, flagTarget.sku)}` : ""}
              </span>{" "}
              at {staffBranchId}.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleFlagSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="critical-stock-note" className="text-xs font-medium text-foreground">
                Floor observation note
              </label>
              <Input
                id="critical-stock-note"
                placeholder="e.g., Front display nearly empty before weekend demand"
                value={flagNote}
                onChange={(e) => setFlagNote(e.target.value)}
                maxLength={500}
                required
              />
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setFlagTarget(null);
                  setFlagNote("");
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!flagNote.trim() || flagMutation.isPending}>
                {flagMutation.isPending ? "Submitting..." : "Submit alert"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

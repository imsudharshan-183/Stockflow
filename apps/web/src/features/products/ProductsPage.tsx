import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ChevronLeft,
  ChevronRight,
  Database,
  FileSpreadsheet,
  History,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyBlock, ErrorBlock, TableSkeleton } from "@/components/shared/states";
import { Badge } from "@/components/ui/badge";
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuth } from "@/features/auth/AuthContext";
import { StaffProductStats } from "@/features/products/StaffProductStats";
import { invalidateOperationalQueries, queryKeys } from "@/hooks/queryKeys";
import { api } from "@/lib/api";
import {
  formatDateTime,
  formatMoneyFull,
  formatNumber,
} from "@/lib/format";
import {
  CATALOG_CATEGORIES,
  formatProductDisplayName,
  type CreateProduct,
  type Product,
  type ProductListQuery,
  type ProductStatus,
  type UpdateProduct,
} from "@stockflow/core";

const CATEGORIES = ["All categories", ...CATALOG_CATEGORIES] as const;

export function ProductsPage() {
  const { user } = useAuth();
  if (user?.role === "staff") {
    return <StaffProductStats />;
  }
  return <CatalogProductsPage />;
}

function CatalogProductsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const queryClient = useQueryClient();

  // Filters & Pagination State
  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("All categories");
  const [selectedStatus, setSelectedStatus] = useState<string>("all");
  const [page, setPage] = useState(1);
  const limit = 25;

  // Dialog States
  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Product | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<Product | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<Product | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Product | null>(null);
  const [historyTarget, setHistoryTarget] = useState<string | null>(null);
  const [csvOpen, setCsvOpen] = useState(false);

  // Fetch paginated products list
  const queryParams: ProductListQuery = useMemo(
    () => ({
      page,
      limit,
      ...(search.trim() ? { search: search.trim() } : {}),
      ...(selectedCategory !== "All categories" ? { category: selectedCategory } : {}),
      ...(selectedStatus !== "all" ? { status: selectedStatus as ProductStatus } : {}),
    }),
    [page, limit, search, selectedCategory, selectedStatus],
  );

  const productsQuery = useQuery({
    queryKey: queryKeys.catalogProducts(queryParams),
    queryFn: () => api.listCatalogProducts(queryParams),
  });

  // Fetch change history detail when history modal is opened
  const historyQuery = useQuery({
    queryKey: queryKeys.catalogProduct(historyTarget ?? ""),
    queryFn: () => api.getCatalogProduct(historyTarget ?? ""),
    enabled: Boolean(historyTarget),
  });

  // Fetch delete eligibility when delete modal is opened
  const deleteCheckQuery = useQuery({
    queryKey: queryKeys.catalogProduct(deleteTarget?.sku ?? ""),
    queryFn: () => api.getCatalogProduct(deleteTarget?.sku ?? ""),
    enabled: Boolean(deleteTarget),
  });

  // Mutations
  const createMutation = useMutation({
    mutationFn: api.createCatalogProduct,
    onSuccess: async (created) => {
      toast.success(`Created product ${created.sku} (${created.name})`);
      setAddOpen(false);
      await invalidateOperationalQueries(queryClient);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const updateMutation = useMutation({
    mutationFn: ({ sku, data }: { sku: string; data: UpdateProduct }) =>
      api.updateCatalogProduct(sku, data),
    onSuccess: async (updated) => {
      toast.success(`Updated ${updated.sku}`);
      setEditTarget(null);
      await queryClient.invalidateQueries({ queryKey: ["catalogProduct", updated.sku] });
      await invalidateOperationalQueries(queryClient);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const archiveMutation = useMutation({
    mutationFn: (sku: string) => api.archiveCatalogProduct(sku),
    onSuccess: async (result) => {
      toast.success(
        `Archived ${result.product.sku}. ${result.removedPendingActionsCount} pending actions cleared from queue.`,
      );
      setArchiveTarget(null);
      await invalidateOperationalQueries(queryClient);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const restoreMutation = useMutation({
    mutationFn: (sku: string) => api.restoreCatalogProduct(sku),
    onSuccess: async (restored) => {
      toast.success(`Restored ${restored.sku} (${restored.name}) to ${restored.status}`);
      setRestoreTarget(null);
      await invalidateOperationalQueries(queryClient);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (sku: string) => api.deleteCatalogProduct(sku),
    onSuccess: async () => {
      toast.success("Product permanently deleted");
      setDeleteTarget(null);
      await invalidateOperationalQueries(queryClient);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const sampleHistoryMutation = useMutation({
    mutationFn: (sku: string) => api.generateSampleHistory(sku),
    onSuccess: async (res) => {
      toast.success(
        `Generated ${res.salesEntriesCount} sample sales records. Product activated with updated recommendations!`,
      );
      await invalidateOperationalQueries(queryClient);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const products = productsQuery.data?.products ?? [];
  const total = productsQuery.data?.total ?? 0;
  const totalPages = productsQuery.data?.totalPages ?? 1;

  const handleResetFilters = () => {
    setSearch("");
    setSelectedCategory("All categories");
    setSelectedStatus("all");
    setPage(1);
  };

  return (
    <TooltipProvider delay={120}>
      <div className="space-y-6">
        <PageHeader
          title="Products Catalog"
          description="Manage retail catalog SKUs, categories, pricing, lead times, and replenishment statuses across all branches."
          actions={
            isAdmin ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setCsvOpen(true)}
                  className="gap-1.5"
                >
                  <FileSpreadsheet className="size-4" aria-hidden="true" />
                  Import CSV
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => setAddOpen(true)}
                  className="gap-1.5"
                >
                  <Plus className="size-4" aria-hidden="true" />
                  Add product
                </Button>
              </div>
            ) : null
          }
        />

        <TableCard>
          <TableToolbar>
            <div className="flex flex-1 flex-wrap items-center gap-2">
              <div className="relative min-w-[200px] flex-1 max-w-sm">
                <Search
                  className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                  placeholder="Search by SKU or name…"
                  className="pl-9 pr-8"
                  aria-label="Search products"
                />
                {search ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      setSearch("");
                      setPage(1);
                    }}
                    className="absolute top-1/2 right-1 size-6 -translate-y-1/2 rounded-full text-muted-foreground hover:text-foreground"
                    aria-label="Clear search"
                  >
                    <X className="size-3.5" aria-hidden="true" />
                  </Button>
                ) : null}
              </div>

              {/* Category Filter */}
              <select
                value={selectedCategory}
                onChange={(e) => {
                  setSelectedCategory(e.target.value);
                  setPage(1);
                }}
                className="h-9 rounded-md border border-input bg-background px-3 py-1 text-xs shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                aria-label="Filter by category"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>

              {/* Status Filter */}
              <div className="inline-flex rounded-md border border-border bg-muted/40 p-0.5 text-xs">
                {[
                  { value: "all", label: "All" },
                  { value: "active", label: "Active" },
                  { value: "awaiting_history", label: "Draft" },
                  { value: "archived", label: "Archived" },
                ].map((s) => (
                  <Button
                    key={s.value}
                    variant={selectedStatus === s.value ? "secondary" : "ghost"}
                    size="sm"
                    onClick={() => {
                      setSelectedStatus(s.value);
                      setPage(1);
                    }}
                    className="h-7 px-2.5 text-xs font-medium"
                  >
                    {s.label}
                  </Button>
                ))}
              </div>

              {search || selectedCategory !== "All categories" || selectedStatus !== "all" ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleResetFilters}
                  className="h-9 px-2 text-xs text-muted-foreground hover:text-foreground"
                >
                  Reset filters
                </Button>
              ) : null}
            </div>

            <div className="text-xs text-muted-foreground">
              Total: {formatNumber(total)} products
            </div>
          </TableToolbar>

          {productsQuery.isLoading ? (
            <div className="p-6">
              <TableSkeleton columns={7} rows={8} />
            </div>
          ) : productsQuery.isError ? (
            <div className="p-6">
              <ErrorBlock
                message={productsQuery.error?.message ?? "Could not load catalog products"}
                onRetry={() => {
                  void productsQuery.refetch();
                }}
              />
            </div>
          ) : products.length === 0 ? (
            <div className="p-12">
              <EmptyBlock
                title="No products match your criteria"
                body="Try adjusting your search query, selecting another category, or clearing the status filter."
              />
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table className="min-w-[920px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[120px]">SKU</TableHead>
                      <TableHead className="min-w-[240px]">Product Name</TableHead>
                      <TableHead className="w-[140px]">Category</TableHead>
                      <TableHead className="w-[100px] text-right">Price</TableHead>
                      <TableHead className="w-[100px] text-right">Cost</TableHead>
                      <TableHead className="w-[100px] text-right">Lead Time</TableHead>
                      <TableHead className="w-[130px] text-center">Status</TableHead>
                      <TableHead className="w-[160px] text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {products.map((product) => {
                      const status = product.status ?? "active";
                      const marginPct = Math.round(
                        ((product.price - product.cost) / product.price) * 100,
                      );

                      return (
                        <TableRow key={product.sku}>
                          <TableCell className="font-mono text-xs font-semibold">
                            <Link
                              to={`/products/${product.sku}`}
                              className="text-primary hover:underline"
                            >
                              {product.sku}
                            </Link>
                          </TableCell>
                          <TableCell className="font-medium">
                            <div className="truncate" title={product.name}>
                              {formatProductDisplayName(product.name, product.sku)}
                            </div>
                          </TableCell>
                          <TableCell className="text-muted-foreground text-xs">
                            {product.category}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">
                            {formatMoneyFull(product.price)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs text-muted-foreground">
                            {formatMoneyFull(product.cost)}
                            <span className="ml-1 text-[10px] text-muted-foreground/75">
                              ({marginPct}%)
                            </span>
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">
                            {formatNumber(product.leadTimeDays)}d
                          </TableCell>
                          <TableCell className="text-center">
                            {status === "active" ? (
                              <Badge tone="ok">active</Badge>
                            ) : status === "awaiting_history" ? (
                              <Badge tone="over">awaiting history</Badge>
                            ) : (
                              <Badge tone="staff">archived</Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1">
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      onClick={() => setHistoryTarget(product.sku)}
                                      className="size-7 rounded-md text-muted-foreground hover:text-foreground"
                                      aria-label={`View change history for ${product.sku}`}
                                    />
                                  }
                                >
                                  <History className="size-3.5" aria-hidden="true" />
                                </TooltipTrigger>
                                <TooltipContent side="top">Change history</TooltipContent>
                              </Tooltip>

                              {isAdmin ? (
                                <>
                                  <Tooltip>
                                    <TooltipTrigger
                                      render={
                                        <Button
                                          variant="ghost"
                                          size="icon"
                                          onClick={() => setEditTarget(product)}
                                          className="size-7 rounded-md text-muted-foreground hover:text-foreground"
                                          aria-label={`Edit ${product.sku}`}
                                        />
                                      }
                                    >
                                      <Pencil className="size-3.5" aria-hidden="true" />
                                    </TooltipTrigger>
                                    <TooltipContent side="top">Edit product</TooltipContent>
                                  </Tooltip>

                                  {status === "awaiting_history" ? (
                                    <Tooltip>
                                      <TooltipTrigger
                                        render={
                                          <Button
                                            variant="soft-success"
                                            size="icon"
                                            onClick={() =>
                                              sampleHistoryMutation.mutate(product.sku)
                                            }
                                            loading={sampleHistoryMutation.isPending}
                                            className="size-7 rounded-md"
                                            aria-label={`Generate sample history for ${product.sku}`}
                                          />
                                        }
                                      >
                                        <Database className="size-3.5" aria-hidden="true" />
                                      </TooltipTrigger>
                                      <TooltipContent side="top">
                                        Generate sample history (activate)
                                      </TooltipContent>
                                    </Tooltip>
                                  ) : null}

                                  {status === "active" ? (
                                    <Tooltip>
                                      <TooltipTrigger
                                        render={
                                          <Button
                                            variant="ghost"
                                            size="icon"
                                            onClick={() => setArchiveTarget(product)}
                                            className="size-7 rounded-md text-muted-foreground hover:text-amber-600 dark:hover:text-amber-400"
                                            aria-label={`Archive ${product.sku}`}
                                          />
                                        }
                                      >
                                        <Archive className="size-3.5" aria-hidden="true" />
                                      </TooltipTrigger>
                                      <TooltipContent side="top">Archive product</TooltipContent>
                                    </Tooltip>
                                  ) : status === "archived" ? (
                                    <Tooltip>
                                      <TooltipTrigger
                                        render={
                                          <Button
                                            variant="soft-success"
                                            size="icon"
                                            onClick={() => setRestoreTarget(product)}
                                            className="size-7 rounded-md"
                                            aria-label={`Restore ${product.sku}`}
                                          />
                                        }
                                      >
                                        <RotateCcw className="size-3.5" aria-hidden="true" />
                                      </TooltipTrigger>
                                      <TooltipContent side="top">Restore product</TooltipContent>
                                    </Tooltip>
                                  ) : null}

                                  <Tooltip>
                                    <TooltipTrigger
                                      render={
                                        <Button
                                          variant="ghost"
                                          size="icon"
                                          onClick={() => setDeleteTarget(product)}
                                          className="size-7 rounded-md text-muted-foreground hover:text-destructive"
                                          aria-label={`Delete ${product.sku}`}
                                        />
                                      }
                                    >
                                      <Trash2 className="size-3.5" aria-hidden="true" />
                                    </TooltipTrigger>
                                    <TooltipContent side="top">Delete product</TooltipContent>
                                  </Tooltip>
                                </>
                              ) : null}
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              <TableCardFooter>
                <div className="text-xs text-muted-foreground">
                  Showing {(page - 1) * limit + 1} to {Math.min(page * limit, total)} of{" "}
                  {formatNumber(total)} products
                </div>
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1}
                    className="h-8 gap-1 px-2.5 text-xs"
                  >
                    <ChevronLeft className="size-3.5" aria-hidden="true" />
                    Previous
                  </Button>
                  <span className="px-2 text-xs font-medium text-muted-foreground">
                    Page {page} of {totalPages}
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page >= totalPages}
                    className="h-8 gap-1 px-2.5 text-xs"
                  >
                    Next
                    <ChevronRight className="size-3.5" aria-hidden="true" />
                  </Button>
                </div>
              </TableCardFooter>
            </>
          )}
        </TableCard>

        {/* Add Product Dialog */}
        <AddProductDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          onSubmit={(data) => createMutation.mutate(data)}
          isPending={createMutation.isPending}
        />

        {/* Edit Product Dialog */}
        {editTarget ? (
          <EditProductDialog
            product={editTarget}
            open={Boolean(editTarget)}
            onOpenChange={(open) => !open && setEditTarget(null)}
            onSubmit={(data) => updateMutation.mutate({ sku: editTarget.sku, data })}
            isPending={updateMutation.isPending}
          />
        ) : null}

        {/* Archive Confirmation Dialog */}
        {archiveTarget ? (
          <Dialog open={Boolean(archiveTarget)} onOpenChange={(open) => !open && setArchiveTarget(null)}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Archive Product</DialogTitle>
                <DialogDescription>
                  Are you sure you want to archive <strong>{archiveTarget.name}</strong> (
                  {archiveTarget.sku})?
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2 py-2 text-xs text-muted-foreground">
                <p>
                  Archiving removes all pending replenishment actions for this SKU from the morning
                  queue across all 15 branches.
                </p>
                <p>
                  Historical transaction data and audit logs are safely preserved. You can restore
                  this product at any time.
                </p>
              </div>
              <DialogFooter className="gap-2 sm:gap-0">
                <Button variant="secondary" onClick={() => setArchiveTarget(null)}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  loading={archiveMutation.isPending}
                  onClick={() => archiveMutation.mutate(archiveTarget.sku)}
                >
                  Archive product
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : null}

        {/* Restore Confirmation Dialog */}
        {restoreTarget ? (
          <Dialog open={Boolean(restoreTarget)} onOpenChange={(open) => !open && setRestoreTarget(null)}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Restore Product</DialogTitle>
                <DialogDescription>
                  Restore <strong>{restoreTarget.name}</strong> ({restoreTarget.sku}) to the active
                  catalog?
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2 py-2 text-xs text-muted-foreground">
                <p>
                  Restoring this product recomputes inventory positions and replenishment
                  recommendations across the network.
                </p>
              </div>
              <DialogFooter className="gap-2 sm:gap-0">
                <Button variant="secondary" onClick={() => setRestoreTarget(null)}>
                  Cancel
                </Button>
                <Button
                  variant="soft-success"
                  loading={restoreMutation.isPending}
                  onClick={() => restoreMutation.mutate(restoreTarget.sku)}
                >
                  Restore to active
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : null}

        {/* Permanent Delete Dialog (with safety guarantee) */}
        {deleteTarget ? (
          <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Permanent Product Deletion</DialogTitle>
                <DialogDescription>
                  {deleteCheckQuery.isLoading
                    ? "Checking product deletion eligibility…"
                    : deleteCheckQuery.data?.canDeletePermanently
                      ? `Are you sure you want to permanently delete ${deleteTarget.name} (${deleteTarget.sku})?`
                      : "Permanent deletion is restricted for this product."}
                </DialogDescription>
              </DialogHeader>

              {deleteCheckQuery.isLoading ? (
                <div className="py-4 text-center text-xs text-muted-foreground">
                  Verifying sales history and decision audit trail…
                </div>
              ) : deleteCheckQuery.data?.canDeletePermanently ? (
                <div className="space-y-2 py-2 text-xs text-destructive">
                  <p>
                    This action is permanent and cannot be undone. Because this product has no
                    recorded sales or decision audit history, it will be completely removed from the
                    database.
                  </p>
                </div>
              ) : (
                <div className="space-y-3 py-2 text-xs text-muted-foreground">
                  <div className="rounded-md border border-amber-500/20 bg-amber-500/10 p-3 text-amber-900 dark:text-amber-200">
                    <p className="font-semibold">Deletion Restricted</p>
                    <p className="mt-1">
                      {deleteCheckQuery.data?.cannotDeleteReason ||
                        "Product has existing sales or audit history and cannot be deleted."}
                    </p>
                  </div>
                  <p>
                    To protect financial reporting and audit compliance, products with history must
                    be <strong>archived</strong> rather than permanently deleted.
                  </p>
                </div>
              )}

              <DialogFooter className="gap-2 sm:gap-0">
                <Button variant="secondary" onClick={() => setDeleteTarget(null)}>
                  Cancel
                </Button>
                {deleteCheckQuery.data?.canDeletePermanently ? (
                  <Button
                    variant="destructive"
                    loading={deleteMutation.isPending}
                    onClick={() => deleteMutation.mutate(deleteTarget.sku)}
                  >
                    Delete permanently
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      const target = deleteTarget;
                      setDeleteTarget(null);
                      setArchiveTarget(target);
                    }}
                  >
                    Archive instead
                  </Button>
                )}
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : null}

        {/* Change History Dialog */}
        {historyTarget ? (
          <Dialog open={Boolean(historyTarget)} onOpenChange={(open) => !open && setHistoryTarget(null)}>
            <DialogContent className="sm:max-w-xl">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <History className="size-4" aria-hidden="true" />
                  Change History · {historyTarget}
                </DialogTitle>
                <DialogDescription>
                  Chronological audit log of all catalog adjustments and status transitions.
                </DialogDescription>
              </DialogHeader>

              <div className="max-h-[360px] overflow-y-auto pr-1">
                {historyQuery.isLoading ? (
                  <div className="py-8 text-center text-xs text-muted-foreground">
                    Loading change history…
                  </div>
                ) : (historyQuery.data?.history ?? []).length === 0 ? (
                  <div className="py-8 text-center text-xs text-muted-foreground">
                    No change records logged yet for this product.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {(historyQuery.data?.history ?? []).map((record) => (
                      <div
                        key={record.id}
                        className="rounded-lg border border-border bg-card p-3 text-xs"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <Badge
                              tone={
                                record.action === "CREATE"
                                  ? "ok"
                                  : record.action === "UPDATE"
                                    ? "reorder"
                                    : record.action === "ARCHIVE"
                                      ? "over"
                                      : "ok"
                              }
                            >
                              {record.action}
                            </Badge>
                            <span className="font-semibold text-foreground">
                              {record.actedBy.name}
                            </span>
                            <span className="text-muted-foreground">({record.actedBy.role})</span>
                          </div>
                          <span className="font-mono text-[11px] text-muted-foreground">
                            {formatDateTime(record.at)}
                          </span>
                        </div>

                        <div className="mt-2 space-y-1 text-muted-foreground">
                          {Object.entries(record.changes).map(([field, diff]) => (
                            <div key={field} className="flex items-center gap-1.5 font-mono text-[11px]">
                              <span className="font-medium text-foreground">{field}:</span>
                              <span>{String(diff.before ?? "—")}</span>
                              <span>&rarr;</span>
                              <span className="font-semibold text-primary">
                                {String(diff.after ?? "—")}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <DialogFooter>
                <Button variant="secondary" onClick={() => setHistoryTarget(null)}>
                  Close
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : null}

        {/* CSV Import Modal */}
        <ImportSalesCsvDialog
          open={csvOpen}
          onOpenChange={setCsvOpen}
          onSuccess={async () => {
            await invalidateOperationalQueries(queryClient);
          }}
        />
      </div>
    </TooltipProvider>
  );
}

// ------------------------------------------------------------------------------------------------
// Dialog Subcomponents
// ------------------------------------------------------------------------------------------------

interface AddProductDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: CreateProduct) => void;
  isPending: boolean;
}

function AddProductDialog({ open, onOpenChange, onSubmit, isPending }: AddProductDialogProps) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState<string>("Beverages");
  const [price, setPrice] = useState("");
  const [cost, setCost] = useState("");
  const [leadTimeDays, setLeadTimeDays] = useState("5");

  const numPrice = parseFloat(price);
  const numCost = parseFloat(cost);
  const numLead = parseInt(leadTimeDays, 10);

  const priceInvalid = !isNaN(numPrice) && !isNaN(numCost) && numPrice <= numCost;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || isNaN(numPrice) || isNaN(numCost) || isNaN(numLead)) return;
    if (priceInvalid) {
      toast.error("Selling price must be greater than unit cost");
      return;
    }
    onSubmit({
      name: name.trim(),
      category: category.trim(),
      price: numPrice,
      cost: numCost,
      leadTimeDays: numLead,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={handleSubmit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Add New Product</DialogTitle>
            <DialogDescription>
              Create a new product in draft status (awaiting history). An automated SKU will be
              assigned.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-1">
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground">
                Product Name <span className="text-destructive">*</span>
              </label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value.slice(0, 60))}
                placeholder="e.g. Veritas Organic Matcha Tea, 100 g"
                required
              />
              <p className="text-right text-[11px] text-muted-foreground">{name.length}/60 chars</p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-foreground">Category</label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-xs shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {CATEGORIES.filter((c) => c !== "All categories").map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-foreground">
                  Lead Time (Days, 1–21)
                </label>
                <Input
                  type="number"
                  min="1"
                  max="21"
                  step="1"
                  value={leadTimeDays}
                  onChange={(e) => setLeadTimeDays(e.target.value)}
                  required
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-foreground">
                  Selling Price (BD) <span className="text-destructive">*</span>
                </label>
                <Input
                  type="number"
                  min="0.005"
                  step="0.005"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="3.250"
                  required
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-foreground">
                  Unit Cost (BD) <span className="text-destructive">*</span>
                </label>
                <Input
                  type="number"
                  min="0.005"
                  step="0.005"
                  value={cost}
                  onChange={(e) => setCost(e.target.value)}
                  placeholder="1.950"
                  required
                />
              </div>
            </div>

            {priceInvalid ? (
              <p className="text-xs text-destructive">
                Selling price ({formatMoneyFull(numPrice)}) must be greater than unit cost ({formatMoneyFull(numCost)}).
              </p>
            ) : null}
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="secondary" type="button" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="default"
              loading={isPending}
              disabled={priceInvalid || !name.trim()}
            >
              Create product
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface EditProductDialogProps {
  product: Product;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: UpdateProduct) => void;
  isPending: boolean;
}

function EditProductDialog({
  product,
  open,
  onOpenChange,
  onSubmit,
  isPending,
}: EditProductDialogProps) {
  const [name, setName] = useState(product.name);
  const [category, setCategory] = useState(product.category);
  const [price, setPrice] = useState(String(product.price));
  const [cost, setCost] = useState(String(product.cost));
  const [leadTimeDays, setLeadTimeDays] = useState(String(product.leadTimeDays));

  const numPrice = parseFloat(price);
  const numCost = parseFloat(cost);
  const numLead = parseInt(leadTimeDays, 10);

  const priceInvalid = !isNaN(numPrice) && !isNaN(numCost) && numPrice <= numCost;
  const mathWillChange =
    numPrice !== product.price || numCost !== product.cost || numLead !== product.leadTimeDays;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || isNaN(numPrice) || isNaN(numCost) || isNaN(numLead)) return;
    if (priceInvalid) {
      toast.error("Selling price must be greater than unit cost");
      return;
    }
    onSubmit({
      name: name.trim(),
      category: category.trim(),
      price: numPrice,
      cost: numCost,
      leadTimeDays: numLead,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={handleSubmit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Edit Product · {product.sku}</DialogTitle>
            <DialogDescription>
              Update product parameters. Edits are recorded in the immutable change history.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-1">
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground">Product Name</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value.slice(0, 60))}
                required
              />
              <p className="text-right text-[11px] text-muted-foreground">{name.length}/60 chars</p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-foreground">Category</label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-xs shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {CATEGORIES.filter((c) => c !== "All categories").map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-foreground">
                  Lead Time (Days, 1–21)
                </label>
                <Input
                  type="number"
                  min="1"
                  max="21"
                  step="1"
                  value={leadTimeDays}
                  onChange={(e) => setLeadTimeDays(e.target.value)}
                  required
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-foreground">Selling Price (BD)</label>
                <Input
                  type="number"
                  min="0.005"
                  step="0.005"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  required
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-foreground">Unit Cost (BD)</label>
                <Input
                  type="number"
                  min="0.005"
                  step="0.005"
                  value={cost}
                  onChange={(e) => setCost(e.target.value)}
                  required
                />
              </div>
            </div>

            {priceInvalid ? (
              <p className="text-xs text-destructive">
                Selling price ({formatMoneyFull(numPrice)}) must be greater than unit cost ({formatMoneyFull(numCost)}).
              </p>
            ) : null}

            {mathWillChange && product.status === "active" ? (
              <div className="rounded-md border border-blue-500/20 bg-blue-500/10 p-2.5 text-xs text-blue-900 dark:text-blue-200">
                <p className="font-semibold">Engine Recomputation Notice</p>
                <p className="mt-0.5">
                  Changing price, cost, or lead time on an active product triggers an automatic
                  recomputation of replenishment plans and recommendations across all 15 branches.
                </p>
              </div>
            ) : null}
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="secondary" type="button" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="default"
              loading={isPending}
              disabled={priceInvalid || !name.trim()}
            >
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface ImportSalesCsvDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => Promise<void>;
}

function ImportSalesCsvDialog({ open, onOpenChange, onSuccess }: ImportSalesCsvDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<{
    inserted: number;
    updated: number;
    errors: Array<{ row: number; message: string }>;
  } | null>(null);

  const importMutation = useMutation({
    mutationFn: (f: File) => api.importSalesCsv(f),
    onSuccess: async (data) => {
      setResult(data);
      if (data.errors.length === 0) {
        toast.success(`Imported: ${data.inserted} inserted, ${data.updated} updated.`);
      } else {
        toast.warning(
          `Processed with warnings: ${data.inserted} inserted, ${data.updated} updated, ${data.errors.length} rows skipped.`,
        );
      }
      await onSuccess();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0] ?? null;
    setFile(selected);
    setResult(null);
  };

  const handleUpload = () => {
    if (!file) return;
    importMutation.mutate(file);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          setFile(null);
          setResult(null);
        }
        onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="size-4" aria-hidden="true" />
            Import Sales Entries (CSV)
          </DialogTitle>
          <DialogDescription>
            Upload daily store sales and on-hand inventory to feed replenishment calculations.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
            <p className="font-semibold text-foreground">CSV Format Specifications:</p>
            <p className="mt-1 font-mono text-[11px]">branchId,sku,date,unitsSold,onHand</p>
            <p className="mt-1">
              File must include header row. Maximum file size is 5MB. Rows with valid SKUs will be
              upserted; invalid rows are reported below without failing the entire batch.
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium text-foreground">Select CSV File</label>
            <Input
              type="file"
              accept=".csv,text/csv"
              onChange={handleFileChange}
              className="cursor-pointer"
            />
          </div>

          {result ? (
            <div className="rounded-md border border-border bg-card p-3 text-xs">
              <div className="flex items-center justify-between font-semibold">
                <span>Import Summary:</span>
                <Badge tone={result.errors.length === 0 ? "ok" : "over"}>
                  {result.errors.length === 0 ? "Success" : `${result.errors.length} warnings`}
                </Badge>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-muted-foreground">
                <div>
                  Inserted records: <span className="font-mono font-medium">{result.inserted}</span>
                </div>
                <div>
                  Updated records: <span className="font-mono font-medium">{result.updated}</span>
                </div>
              </div>

              {result.errors.length > 0 ? (
                <div className="mt-3 max-h-36 overflow-y-auto border-t border-border pt-2 text-[11px] text-destructive">
                  <p className="font-semibold">Row errors:</p>
                  <ul className="mt-1 list-inside list-disc space-y-0.5">
                    {result.errors.map((e, i) => (
                      <li key={i}>
                        Row {e.row}: {e.message}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            variant="default"
            disabled={!file}
            loading={importMutation.isPending}
            onClick={handleUpload}
            className="gap-1.5"
          >
            <Upload className="size-3.5" aria-hidden="true" />
            Upload & Process
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

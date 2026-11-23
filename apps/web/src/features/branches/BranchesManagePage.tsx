import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Pencil, Plus, RotateCcw, Search, X } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyBlock, ErrorBlock, TableSkeleton } from "@/components/shared/states";
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
  TableCard,
  TableCardFooter,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableToolbar,
} from "@/components/ui/table";
import { queryKeys } from "@/hooks/queryKeys";
import { api } from "@/lib/api";
import { formatCoordinates, formatNumber } from "@/lib/format";
import type { Branch, BranchStatus, CreateBranch, UpdateBranch } from "@stockflow/core";

export function BranchesManagePage() {
  const queryClient = useQueryClient();

  const [statusFilter, setStatusFilter] = useState<"all" | BranchStatus>("all");
  const [search, setSearch] = useState("");
  const [editTarget, setEditTarget] = useState<Branch | null>(null);

  // Add branch form state (lat/lng required in the create form)
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [region, setRegion] = useState("");
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const queryStatus = statusFilter === "all" ? undefined : statusFilter;

  const branchesQuery = useQuery({
    queryKey: queryKeys.adminBranches(queryStatus),
    queryFn: () => api.listBranches(queryStatus ? { status: queryStatus } : undefined),
  });

  const invalidateBranchQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["adminBranches"] }),
      queryClient.invalidateQueries({ queryKey: queryKeys.locations }),
      queryClient.invalidateQueries({ queryKey: ["kpis"] }),
      queryClient.invalidateQueries({ queryKey: ["recommendations"] }),
    ]);
  };

  const createMutation = useMutation({
    mutationFn: (payload: CreateBranch) => api.createBranch(payload),
    onSuccess: async (created) => {
      toast.success(`Created branch ${created.id} (${created.name})`);
      setName("");
      setCity("");
      setRegion("");
      setLat("");
      setLng("");
      setFormError(null);
      await invalidateBranchQueries();
    },
    onError: (err: Error) => {
      setFormError(err.message);
      toast.error(err.message);
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateBranch }) => api.updateBranch(id, data),
    onSuccess: async (updated, vars) => {
      if (vars.data.status === "archived") {
        toast.success(`Archived ${updated.id} (${updated.name})`);
      } else if (vars.data.status === "active") {
        toast.success(`Unarchived ${updated.id} (${updated.name})`);
      } else {
        toast.success(`Updated ${updated.id} (${updated.name})`);
      }
      setEditTarget(null);
      await invalidateBranchQueries();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const branches = useMemo(() => branchesQuery.data?.branches ?? [], [branchesQuery.data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return branches;
    return branches.filter(
      (b) =>
        b.id.toLowerCase().includes(q) ||
        b.name.toLowerCase().includes(q) ||
        b.city.toLowerCase().includes(q) ||
        b.region.toLowerCase().includes(q),
    );
  }, [branches, search]);

  const handleCreateSubmit = (event: FormEvent) => {
    event.preventDefault();
    const parsedLat = Number(lat);
    const parsedLng = Number(lng);
    if (!name.trim() || !city.trim() || !region.trim()) {
      setFormError("Name, city, and region are required.");
      return;
    }
    if (lat.trim() === "" || !Number.isFinite(parsedLat) || parsedLat < -90 || parsedLat > 90) {
      setFormError("Latitude must be a valid number between -90 and 90.");
      return;
    }
    if (lng.trim() === "" || !Number.isFinite(parsedLng) || parsedLng < -180 || parsedLng > 180) {
      setFormError("Longitude must be a valid number between -180 and 180.");
      return;
    }
    setFormError(null);
    createMutation.mutate({
      name: name.trim(),
      city: city.trim(),
      region: region.trim(),
      coordinates: [parsedLat, parsedLng],
    });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Branch management"
        subtitle="Add new branches and archive or restore existing retail locations across the network."
      />

      {/* Add Branch Card */}
      <Card className="rounded-2xl border border-border bg-card shadow-card">
        <CardHeader>
          <CardTitle className="text-base">Add new branch</CardTitle>
          <CardDescription>
            Assigns the next sequential BR-0xx ID and initializes zero-filled daily history until sales arrive.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreateSubmit} className="space-y-4">
            {formError ? (
              <div className="rounded-xl border border-risk-ring bg-risk-bg px-3 py-2 text-xs text-risk-text">
                {formError}
              </div>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <div className="space-y-1">
                <label htmlFor="branch-name" className="text-xs font-medium text-muted-foreground">
                  Branch name
                </label>
                <Input
                  id="branch-name"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Amwaj Islands"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="branch-city" className="text-xs font-medium text-muted-foreground">
                  City
                </label>
                <Input
                  id="branch-city"
                  required
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  placeholder="e.g. Muharraq"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="branch-region" className="text-xs font-medium text-muted-foreground">
                  Region
                </label>
                <Input
                  id="branch-region"
                  required
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                  placeholder="e.g. Muharraq"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="branch-lat" className="text-xs font-medium text-muted-foreground">
                  Latitude
                </label>
                <Input
                  id="branch-lat"
                  type="number"
                  step="any"
                  required
                  min={-90}
                  max={90}
                  value={lat}
                  onChange={(e) => setLat(e.target.value)}
                  placeholder="26.2845"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="branch-lng" className="text-xs font-medium text-muted-foreground">
                  Longitude
                </label>
                <Input
                  id="branch-lng"
                  type="number"
                  step="any"
                  required
                  min={-180}
                  max={180}
                  value={lng}
                  onChange={(e) => setLng(e.target.value)}
                  placeholder="50.6612"
                />
              </div>
            </div>

            <div className="flex justify-end">
              <Button type="submit" variant="primary" loading={createMutation.isPending}>
                <Plus className="size-4" aria-hidden="true" />
                Add branch
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Branches Table Card */}
      <TableCard>
        <TableToolbar>
          <div className="flex flex-1 flex-wrap items-center gap-2">
            <div className="relative min-w-[200px] flex-1 sm:max-w-[280px]">
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search ID, name, city, or region..."
                aria-label="Search branches"
                className="h-9 rounded-xl border-border bg-card pr-8 pl-8 text-xs shadow-xs"
              />
              {search ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  tooltip="Clear search"
                  aria-label="Clear search"
                  onClick={() => setSearch("")}
                  className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground"
                >
                  <X className="size-3" aria-hidden="true" />
                </Button>
              ) : null}
            </div>

            <select
              aria-label="Filter by branch status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as "all" | BranchStatus)}
              className="h-9 rounded-xl border border-border bg-card px-3 text-xs font-medium text-foreground shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              <option value="all">All statuses</option>
              <option value="active">Active</option>
              <option value="archived">Archived</option>
            </select>
          </div>

          <div className="text-xs text-muted-foreground tabular-nums">
            {branchesQuery.data ? (
              <span>
                Showing <span className="font-medium text-foreground">{formatNumber(filtered.length)}</span>{" "}
                of <span className="font-medium text-foreground">{formatNumber(branches.length)}</span> branches
              </span>
            ) : (
              <span>Loading branches...</span>
            )}
          </div>
        </TableToolbar>

        {branchesQuery.isPending ? (
          <div className="p-4">
            <TableSkeleton rows={6} />
          </div>
        ) : branchesQuery.isError ? (
          <div className="p-4">
            <ErrorBlock
              message={branchesQuery.error.message}
              onRetry={() => void branchesQuery.refetch()}
            />
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-4">
            <EmptyBlock
              title="No matching branches"
              body="Adjust your search or status filter to view branches."
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setSearch("");
                    setStatusFilter("all");
                  }}
                >
                  Reset filters
                </Button>
              }
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table className="min-w-[820px]">
              <TableHeader>
                <tr className="border-b border-border">
                  <TableHead className="w-[100px]">ID</TableHead>
                  <TableHead className="w-[22%]">Name</TableHead>
                  <TableHead className="w-[16%]">City</TableHead>
                  <TableHead className="w-[14%]">Region</TableHead>
                  <TableHead className="w-[170px]">Coordinates</TableHead>
                  <TableHead className="w-[110px]">Status</TableHead>
                  <TableHead className="w-[190px] text-right">Actions</TableHead>
                </tr>
              </TableHeader>
              <TableBody>
                {filtered.map((branch) => {
                  const status = branch.status ?? "active";
                  const isArchived = status === "archived";
                  const isTogglingThis =
                    updateMutation.isPending && updateMutation.variables?.id === branch.id;

                  return (
                    <TableRow key={branch.id}>
                      <TableCell className="font-mono text-xs font-medium text-muted-foreground">
                        {branch.id}
                      </TableCell>
                      <TableCell className="font-semibold text-foreground">
                        <Link
                          to={`/branches/${branch.id}`}
                          className="hover:text-primary hover:underline"
                        >
                          {branch.name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{branch.city}</TableCell>
                      <TableCell className="text-muted-foreground">{branch.region}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground tabular-nums">
                        {formatCoordinates(branch.coordinates)}
                      </TableCell>
                      <TableCell>
                        <Badge tone={isArchived ? "rejected" : "approved"} dot>
                          {isArchived ? "Archived" : "Active"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <Button
                            size="xs"
                            variant="secondary"
                            onClick={() => setEditTarget(branch)}
                          >
                            <Pencil className="size-3" aria-hidden="true" />
                            Edit
                          </Button>
                          {isArchived ? (
                            <Button
                              size="xs"
                              variant="soft-success"
                              loading={isTogglingThis}
                              disabled={updateMutation.isPending}
                              onClick={() =>
                                updateMutation.mutate({
                                  id: branch.id,
                                  data: { status: "active" },
                                })
                              }
                            >
                              <RotateCcw className="size-3" aria-hidden="true" />
                              Unarchive
                            </Button>
                          ) : (
                            <Button
                              size="xs"
                              variant="soft-danger"
                              loading={isTogglingThis}
                              disabled={updateMutation.isPending}
                              onClick={() =>
                                updateMutation.mutate({
                                  id: branch.id,
                                  data: { status: "archived" },
                                })
                              }
                            >
                              <Archive className="size-3" aria-hidden="true" />
                              Archive
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {branchesQuery.data && filtered.length > 0 ? (
          <TableCardFooter>
            <span className="tabular-nums">
              {formatNumber(filtered.length)} {filtered.length === 1 ? "branch" : "branches"}
            </span>
          </TableCardFooter>
        ) : null}
      </TableCard>

      {/* Edit Branch Dialog */}
      <Dialog
        open={editTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditTarget(null);
            updateMutation.reset();
          }
        }}
      >
        <DialogContent className="max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle>Edit branch {editTarget?.id}</DialogTitle>
            <DialogDescription>
              Update location details or coordinates for {editTarget?.name}.
            </DialogDescription>
          </DialogHeader>
          {editTarget ? (
            <EditBranchForm
              key={editTarget.id}
              branch={editTarget}
              isSubmitting={updateMutation.isPending}
              errorMessage={updateMutation.error?.message ?? null}
              onCancel={() => setEditTarget(null)}
              onSubmit={(data) => updateMutation.mutate({ id: editTarget.id, data })}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EditBranchForm({
  branch,
  isSubmitting,
  errorMessage,
  onCancel,
  onSubmit,
}: {
  branch: Branch;
  isSubmitting: boolean;
  errorMessage: string | null;
  onCancel: () => void;
  onSubmit: (data: UpdateBranch) => void;
}) {
  const [name, setName] = useState(branch.name);
  const [city, setCity] = useState(branch.city);
  const [region, setRegion] = useState(branch.region);
  const [lat, setLat] = useState(branch.coordinates ? String(branch.coordinates[0]) : "");
  const [lng, setLng] = useState(branch.coordinates ? String(branch.coordinates[1]) : "");
  const [localError, setLocalError] = useState<string | null>(null);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !city.trim() || !region.trim()) {
      setLocalError("Name, city, and region cannot be empty.");
      return;
    }
    const payload: UpdateBranch = {
      name: name.trim(),
      city: city.trim(),
      region: region.trim(),
    };
    if (lat.trim() !== "" || lng.trim() !== "") {
      const parsedLat = Number(lat);
      const parsedLng = Number(lng);
      if (lat.trim() === "" || !Number.isFinite(parsedLat) || parsedLat < -90 || parsedLat > 90) {
        setLocalError("Latitude must be between -90 and 90.");
        return;
      }
      if (lng.trim() === "" || !Number.isFinite(parsedLng) || parsedLng < -180 || parsedLng > 180) {
        setLocalError("Longitude must be between -180 and 180.");
        return;
      }
      payload.coordinates = [parsedLat, parsedLng];
    }
    setLocalError(null);
    onSubmit(payload);
  };

  const displayError = localError || errorMessage;

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {displayError ? (
        <div className="rounded-xl border border-risk-ring bg-risk-bg px-3 py-2 text-xs text-risk-text">
          {displayError}
        </div>
      ) : null}

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Branch name</label>
        <Input required value={name} onChange={(e) => setName(e.target.value)} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">City</label>
          <Input required value={city} onChange={(e) => setCity(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Region</label>
          <Input required value={region} onChange={(e) => setRegion(e.target.value)} />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Latitude</label>
          <Input
            type="number"
            step="any"
            min={-90}
            max={90}
            value={lat}
            onChange={(e) => setLat(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Longitude</label>
          <Input
            type="number"
            step="any"
            min={-180}
            max={180}
            value={lng}
            onChange={(e) => setLng(e.target.value)}
          />
        </div>
      </div>

      <DialogFooter>
        <Button type="button" variant="secondary" disabled={isSubmitting} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={isSubmitting}>
          Save changes
        </Button>
      </DialogFooter>
    </form>
  );
}

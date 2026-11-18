import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Pencil, Plus, Search, UserX, X } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
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
import { useAuth } from "@/features/auth/AuthContext";
import { queryKeys } from "@/hooks/queryKeys";
import { api } from "@/lib/api";
import { formatDateTime, formatNumber } from "@/lib/format";
import { canManageRole, type Role, type UpdateUser, type User } from "@stockflow/core";

export function UsersPage() {
  const { user: currentUser } = useAuth();
  const actorRole: Role = currentUser?.role ?? "admin";
  const queryClient = useQueryClient();

  const usersQuery = useQuery({ queryKey: ["users"], queryFn: api.listUsers });
  const kpisQuery = useQuery({ queryKey: queryKeys.kpis(), queryFn: () => api.kpis() });

  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<User | null>(null);
  const [resetTarget, setResetTarget] = useState<User | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [deactivateTarget, setDeactivateTarget] = useState<User | null>(null);

  const branches = kpisQuery.data?.branches ?? [];

  const createMutation = useMutation({
    mutationFn: api.createUser,
    onSuccess: async () => {
      toast.success("User created successfully");
      setCreateOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateUser }) => api.updateUser(id, data),
    onSuccess: async () => {
      toast.success("User updated successfully");
      setEditTarget(null);
      await queryClient.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: string) => api.deactivateUser(id),
    onSuccess: async () => {
      toast.success("User deactivated");
      await queryClient.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const resetMutation = useMutation({
    mutationFn: ({ id, pass }: { id: string; pass: string }) => api.resetPassword(id, pass),
    onSuccess: async () => {
      toast.success("Password reset successfully");
      setResetTarget(null);
      setResetPassword("");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const users = useMemo(() => usersQuery.data?.users ?? [], [usersQuery.data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        u.name.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q) ||
        u.role.toLowerCase().includes(q) ||
        u.branchIds.some((b) => b.toLowerCase().includes(q)),
    );
  }, [users, search]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="User management"
        subtitle="Manage roles, assigned branch scopes, and account status."
        actions={
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" aria-hidden="true" />
            Add user
          </Button>
        }
      />

      <TableCard>
        <TableToolbar>
          <div className="relative min-w-[200px] flex-1 sm:max-w-[280px]">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, email, role, or branch..."
              aria-label="Search users"
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

          <div className="text-xs text-muted-foreground tabular-nums">
            {usersQuery.data ? (
              <span>
                Showing <span className="font-medium text-foreground">{formatNumber(filtered.length)}</span>{" "}
                of <span className="font-medium text-foreground">{formatNumber(users.length)}</span> users
              </span>
            ) : (
              <span>Loading users...</span>
            )}
          </div>
        </TableToolbar>

        {usersQuery.isPending ? (
          <div className="p-4">
            <TableSkeleton rows={5} />
          </div>
        ) : usersQuery.isError ? (
          <div className="p-4">
            <ErrorBlock
              message={usersQuery.error.message}
              onRetry={() => void usersQuery.refetch()}
            />
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-4">
            <EmptyBlock
              title={search ? "No matching users" : "No users found"}
              body={
                search
                  ? "No users match your search query."
                  : "Create a manager or staff member to get started."
              }
              action={
                search ? (
                  <Button variant="secondary" size="sm" onClick={() => setSearch("")}>
                    Clear search
                  </Button>
                ) : (
                  <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
                    Add user
                  </Button>
                )
              }
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table className="min-w-[960px]">
              <TableHeader>
                <tr className="border-b border-border">
                  <TableHead className="w-[180px]">Name</TableHead>
                  <TableHead className="w-[200px]">Email</TableHead>
                  <TableHead className="w-[90px]">Role</TableHead>
                  <TableHead className="w-[160px]">Branch scope</TableHead>
                  <TableHead className="w-[90px]">Status</TableHead>
                  <TableHead className="w-[130px]">Created</TableHead>
                  <TableHead className="w-[190px] text-right">Actions</TableHead>
                </tr>
              </TableHeader>
              <TableBody>
                {filtered.map((u) => {
                  const canManageTarget = canManageRole(actorRole, u.role);
                  const isDeactivatingThis =
                    deactivateMutation.isPending && deactivateMutation.variables === u.id;

                  return (
                    <TableRow key={u.id}>
                      <TableCell className="truncate font-semibold text-foreground">
                        {u.name}
                      </TableCell>
                      <TableCell className="truncate text-muted-foreground">
                        {u.email}
                      </TableCell>
                      <TableCell>
                        <Badge tone={u.role}>{u.role}</Badge>
                      </TableCell>
                      <TableCell>
                        {u.role === "admin" ? (
                          <span className="text-xs text-muted-foreground">All 15 branches</span>
                        ) : u.branchIds.length > 0 ? (
                          <span
                            className="block truncate text-xs font-medium text-foreground"
                            title={u.branchIds.join(", ")}
                          >
                            {u.branchIds.join(", ")}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">None</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge tone={u.isActive ? "approved" : "rejected"} dot>
                          {u.isActive ? "Active" : "Inactive"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground tabular-nums">
                        {formatDateTime(u.createdAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        {canManageTarget ? (
                          <div className="flex items-center justify-end gap-1.5">
                            <Button
                              size="xs"
                              variant="secondary"
                              onClick={() => setEditTarget(u)}
                            >
                              <Pencil className="size-3" aria-hidden="true" />
                              Edit
                            </Button>
                            <Button
                              size="xs"
                              variant="ghost"
                              tooltip="Reset password"
                              onClick={() => {
                                setResetTarget(u);
                                setResetPassword("");
                              }}
                            >
                              <KeyRound className="size-3" aria-hidden="true" />
                              Password
                            </Button>
                            {u.isActive ? (
                              <Button
                                size="xs"
                                variant="soft-danger"
                                loading={isDeactivatingThis}
                                disabled={deactivateMutation.isPending}
                                onClick={() => setDeactivateTarget(u)}
                              >
                                <UserX className="size-3" aria-hidden="true" />
                                Deactivate
                              </Button>
                            ) : null}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">Protected</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {usersQuery.data && filtered.length > 0 ? (
          <TableCardFooter>
            <span className="tabular-nums">
              {formatNumber(filtered.length)} {filtered.length === 1 ? "user" : "users"}
            </span>
          </TableCardFooter>
        ) : null}
      </TableCard>

      {/* Create User Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle>Create new user</DialogTitle>
            <DialogDescription>
              Add a manager or staff member and configure their branch visibility.
            </DialogDescription>
          </DialogHeader>
          <CreateUserForm
            actorRole={actorRole}
            branches={branches}
            isSubmitting={createMutation.isPending}
            errorMessage={createMutation.error?.message ?? null}
            onCancel={() => setCreateOpen(false)}
            onSubmit={(data) => createMutation.mutate(data)}
          />
        </DialogContent>
      </Dialog>

      {/* Edit User Dialog */}
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
            <DialogTitle>Edit user</DialogTitle>
            <DialogDescription>
              Update role, assigned branches, or active status for {editTarget?.name}.
            </DialogDescription>
          </DialogHeader>
          {editTarget ? (
            <EditUserForm
              key={editTarget.id}
              actorRole={actorRole}
              targetUser={editTarget}
              branches={branches}
              isSubmitting={updateMutation.isPending}
              errorMessage={updateMutation.error?.message ?? null}
              onCancel={() => setEditTarget(null)}
              onSubmit={(data) => updateMutation.mutate({ id: editTarget.id, data })}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Reset Password Dialog */}
      <Dialog
        open={resetTarget !== null}
        onOpenChange={(open) => {
          if (!open) setResetTarget(null);
        }}
      >
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <DialogTitle>Reset password</DialogTitle>
            <DialogDescription>
              Set a new password for {resetTarget?.name} ({resetTarget?.email}).
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (resetTarget && resetPassword.length >= 6) {
                resetMutation.mutate({ id: resetTarget.id, pass: resetPassword });
              }
            }}
            className="space-y-4"
          >
            <div className="space-y-1.5">
              <label
                htmlFor="reset-password-input"
                className="text-xs font-medium text-muted-foreground"
              >
                New password (min 6 characters)
              </label>
              <Input
                id="reset-password-input"
                type="password"
                required
                minLength={6}
                value={resetPassword}
                onChange={(e) => setResetPassword(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                disabled={resetMutation.isPending}
                onClick={() => setResetTarget(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                loading={resetMutation.isPending}
                disabled={resetPassword.length < 6}
              >
                Confirm reset
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Deactivate User Dialog */}
      <Dialog
        open={deactivateTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeactivateTarget(null);
        }}
      >
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <DialogTitle>Deactivate user</DialogTitle>
            <DialogDescription>
              Are you sure you want to deactivate {deactivateTarget?.name} ({deactivateTarget?.email})? They will immediately lose access to StockFlow.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              disabled={deactivateMutation.isPending}
              onClick={() => setDeactivateTarget(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              loading={deactivateMutation.isPending}
              onClick={() => {
                if (deactivateTarget) {
                  deactivateMutation.mutate(deactivateTarget.id);
                  setDeactivateTarget(null);
                }
              }}
            >
              Confirm deactivate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CreateUserForm({
  actorRole,
  branches,
  isSubmitting,
  errorMessage,
  onCancel,
  onSubmit,
}: {
  actorRole: Role;
  branches: ReadonlyArray<{ id: string; name: string }>;
  isSubmitting: boolean;
  errorMessage: string | null;
  onCancel: () => void;
  onSubmit: (data: {
    name: string;
    email: string;
    password: string;
    role: Role;
    branchIds: string[];
  }) => void;
}) {
  const allowedRoles = (["manager", "staff"] as const).filter((r) =>
    canManageRole(actorRole, r),
  );
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>(allowedRoles[0] ?? "staff");
  const [selectedBranches, setSelectedBranches] = useState<string[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);

  const handleRoleChange = (nextRole: Role) => {
    setRole(nextRole);
  };

  const toggleBranch = (bId: string) => {
    setLocalError(null);
    if (selectedBranches.includes(bId)) {
      setSelectedBranches(selectedBranches.filter((id) => id !== bId));
    } else {
      setSelectedBranches([...selectedBranches, bId]);
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (selectedBranches.length === 0) {
      setLocalError("Select at least one branch.");
      return;
    }
    setLocalError(null);
    onSubmit({
      name: name.trim(),
      email: email.trim().toLowerCase(),
      password,
      role,
      branchIds: selectedBranches,
    });
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
        <label className="text-xs font-medium text-muted-foreground">Full name</label>
        <Input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Jane Doe"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Email</label>
        <Input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="jane@stockflow.dev"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">
          Password (min 6 characters)
        </label>
        <Input
          type="password"
          required
          minLength={6}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Role</label>
        <select
          className="h-9 w-full rounded-xl border border-border bg-card px-3 text-xs font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          value={role}
          onChange={(e) => handleRoleChange(e.target.value as Role)}
        >
          {allowedRoles.map((r) => (
            <option key={r} value={r}>
              {r === "manager"
                ? "Manager (Assigned branches, can approve/reject)"
                : "Staff (Assigned branches, floor view & alerts)"}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">
          Assigned branches ({selectedBranches.length} selected)
        </label>
        <div className="max-h-36 overflow-y-auto rounded-xl border border-border bg-secondary/30 p-2.5 text-xs">
          {branches.map((b) => (
            <label
              key={b.id}
              className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 hover:bg-card"
            >
              <input
                type="checkbox"
                checked={selectedBranches.includes(b.id)}
                onChange={() => toggleBranch(b.id)}
                className="size-3.5 rounded border-input accent-primary"
              />
              <span className="font-mono text-[11px] text-muted-foreground">{b.id}</span>
              <span className="truncate text-foreground">{b.name}</span>
            </label>
          ))}
        </div>
      </div>

      <DialogFooter>
        <Button type="button" variant="secondary" disabled={isSubmitting} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={isSubmitting}>
          Create user
        </Button>
      </DialogFooter>
    </form>
  );
}

function EditUserForm({
  actorRole,
  targetUser,
  branches,
  isSubmitting,
  errorMessage,
  onCancel,
  onSubmit,
}: {
  actorRole: Role;
  targetUser: User;
  branches: ReadonlyArray<{ id: string; name: string }>;
  isSubmitting: boolean;
  errorMessage: string | null;
  onCancel: () => void;
  onSubmit: (data: UpdateUser) => void;
}) {
  const allowedRoles = (["manager", "staff"] as const).filter((r) =>
    canManageRole(actorRole, r),
  );
  const [name, setName] = useState(targetUser.name);
  const [role, setRole] = useState<Role>(targetUser.role);
  const [selectedBranches, setSelectedBranches] = useState<string[]>(targetUser.branchIds);
  const [isActive, setIsActive] = useState<boolean>(targetUser.isActive);
  const [localError, setLocalError] = useState<string | null>(null);

  const handleRoleChange = (nextRole: Role) => {
    setRole(nextRole);
  };

  const toggleBranch = (bId: string) => {
    setLocalError(null);
    if (selectedBranches.includes(bId)) {
      setSelectedBranches(selectedBranches.filter((id) => id !== bId));
    } else {
      setSelectedBranches([...selectedBranches, bId]);
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (selectedBranches.length === 0) {
      setLocalError("Select at least one branch.");
      return;
    }
    setLocalError(null);
    onSubmit({
      name: name.trim(),
      role,
      branchIds: selectedBranches,
      isActive,
    });
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
        <label className="text-xs font-medium text-muted-foreground">Full name</label>
        <Input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Role</label>
        <select
          aria-label="Edit user role"
          className="h-9 w-full rounded-xl border border-border bg-card px-3 text-xs font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          value={role}
          onChange={(e) => handleRoleChange(e.target.value as Role)}
        >
          {allowedRoles.map((r) => (
            <option key={r} value={r}>
              {r === "manager"
                ? "Manager (Assigned branches, can approve/reject)"
                : "Staff (Assigned branches, floor view & alerts)"}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">
          Assigned branches ({selectedBranches.length} selected)
        </label>
        <div className="max-h-36 overflow-y-auto rounded-xl border border-border bg-secondary/30 p-2.5 text-xs">
          {branches.map((b) => (
            <label
              key={b.id}
              className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 hover:bg-card"
            >
              <input
                type="checkbox"
                checked={selectedBranches.includes(b.id)}
                onChange={() => toggleBranch(b.id)}
                className="size-3.5 rounded border-input accent-primary"
              />
              <span className="font-mono text-[11px] text-muted-foreground">{b.id}</span>
              <span className="truncate text-foreground">{b.name}</span>
            </label>
          ))}
        </div>
      </div>

      <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-foreground">
        <input
          type="checkbox"
          checked={isActive}
          onChange={(e) => setIsActive(e.target.checked)}
          className="size-4 rounded border-input accent-primary"
        />
        Account active
      </label>

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

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/shared/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { queryKeys } from "@/hooks/queryKeys";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { Role, User } from "@stockflow/core";

export function UsersPage() {
  const queryClient = useQueryClient();
  const usersQuery = useQuery({ queryKey: ["users"], queryFn: api.listUsers });
  const kpisQuery = useQuery({ queryKey: queryKeys.kpis, queryFn: api.kpis });

  const [createOpen, setCreateOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<User | null>(null);
  const [resetPassword, setResetPassword] = useState("");

  const branches = kpisQuery.data?.branches ?? [];

  // Create User Mutation
  const createMutation = useMutation({
    mutationFn: api.createUser,
    onSuccess: async () => {
      toast.success("User created successfully");
      setCreateOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Deactivate Mutation
  const deactivateMutation = useMutation({
    mutationFn: (id: string) => api.deactivateUser(id),
    onSuccess: async () => {
      toast.success("User deactivated");
      await queryClient.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Reset Password Mutation
  const resetMutation = useMutation({
    mutationFn: ({ id, pass }: { id: string; pass: string }) => api.resetPassword(id, pass),
    onSuccess: async () => {
      toast.success("Password reset successfully");
      setResetTarget(null);
      setResetPassword("");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (usersQuery.isPending) return <LoadingBlock />;
  if (usersQuery.isError) {
    return <ErrorBlock message={usersQuery.error.message} onRetry={() => void usersQuery.refetch()} />;
  }

  const users = usersQuery.data.users;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">User Management</h1>
          <p className="text-sm text-muted-foreground">
            Manage roles and assigned branch scopes (Admin access only).
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>Add User</Button>
      </div>

      {users.length === 0 ? (
        <EmptyBlock title="No users found" body="Create a user to get started." />
      ) : (
        <div className="overflow-x-auto rounded-2xl border bg-card shadow-card">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-[var(--lavender-50)] text-left text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Email</th>
                <th className="px-3 py-2 font-medium">Role</th>
                <th className="px-3 py-2 font-medium">Branch Scope</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Created</th>
                <th className="px-3 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const isDeactivatable = u.role !== "admin" && u.isActive;
                return (
                  <tr key={u.id} className="border-t align-top">
                    <td className="px-3 py-2 font-medium">{u.name}</td>
                    <td className="px-3 py-2 text-muted-foreground">{u.email}</td>
                    <td className="px-3 py-2">
                      <Badge tone={u.role === "admin" ? "high" : u.role === "manager" ? "med" : "low"}>
                        {u.role}
                      </Badge>
                    </td>
                    <td className="px-3 py-2">
                      {u.role === "admin" ? (
                        <span className="text-muted-foreground">All 15 branches</span>
                      ) : u.branchIds.length > 0 ? (
                        <span>{u.branchIds.join(", ")}</span>
                      ) : (
                        <span className="text-muted-foreground">None</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={u.isActive ? "approved" : "rejected"}>
                        {u.isActive ? "Active" : "Inactive"}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{formatDateTime(u.createdAt)}</td>
                    <td className="px-3 py-2 text-right">
                      {u.role !== "admin" ? (
                        <div className="flex justify-end gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setResetTarget(u);
                              setResetPassword("");
                            }}
                          >
                            Reset Password
                          </Button>
                          {isDeactivatable ? (
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={deactivateMutation.isPending}
                              onClick={() => deactivateMutation.mutate(u.id)}
                            >
                              Deactivate
                            </Button>
                          ) : null}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Create User Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Create New User</DialogTitle>
            <DialogDescription>
              Add a manager or staff member and configure their branch visibility.
            </DialogDescription>
          </DialogHeader>
          <CreateUserForm
            branches={branches}
            isSubmitting={createMutation.isPending}
            onSubmit={(data) => createMutation.mutate(data)}
          />
        </DialogContent>
      </Dialog>

      {/* Reset Password Dialog */}
      <Dialog open={resetTarget !== null} onOpenChange={(open) => !open && setResetTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Reset Password</DialogTitle>
            <DialogDescription>Set a new password for {resetTarget?.name}.</DialogDescription>
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
              <label className="text-xs font-medium text-muted-foreground">New Password (min 6 chars)</label>
              <Input
                type="password"
                required
                minLength={6}
                value={resetPassword}
                onChange={(e) => setResetPassword(e.target.value)}
              />
            </div>
            <Button type="submit" className="w-full" disabled={resetMutation.isPending || resetPassword.length < 6}>
              {resetMutation.isPending ? <Spinner data-icon="inline-start" /> : null}
              Confirm Password Reset
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CreateUserForm({
  branches,
  isSubmitting,
  onSubmit,
}: {
  branches: Array<{ id: string; name: string }>;
  isSubmitting: boolean;
  onSubmit: (data: { name: string; email: string; password: string; role: Role; branchIds: string[] }) => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("staff");
  const [selectedBranches, setSelectedBranches] = useState<string[]>([]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit({
      name,
      email,
      password,
      role,
      branchIds: selectedBranches,
    });
  };

  const toggleBranch = (bId: string) => {
    if (selectedBranches.includes(bId)) {
      setSelectedBranches(selectedBranches.filter((id) => id !== bId));
    } else {
      setSelectedBranches([...selectedBranches, bId]);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Full Name</label>
        <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Doe" />
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
        <label className="text-xs font-medium text-muted-foreground">Password (min 6 chars)</label>
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
          className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none"
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
        >
          <option value="manager">Manager (Assigned branches, Can decide)</option>
          <option value="staff">Staff (Single branch, Read-only)</option>
        </select>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">
          Assigned Branches ({selectedBranches.length} selected)
        </label>
        <div className="max-h-36 overflow-y-auto rounded-lg border p-2 text-xs">
          {branches.map((b) => (
            <label key={b.id} className="flex cursor-pointer items-center gap-2 py-0.5 hover:text-foreground">
              <input
                type="checkbox"
                checked={selectedBranches.includes(b.id)}
                onChange={() => toggleBranch(b.id)}
              />
              <span>
                {b.id} — {b.name}
              </span>
            </label>
          ))}
        </div>
      </div>

      <Button type="submit" className="w-full" disabled={isSubmitting}>
        {isSubmitting ? <Spinner data-icon="inline-start" /> : null}
        Create User
      </Button>
    </form>
  );
}

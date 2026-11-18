/**
 * Resolves the active store branch for a staff user across their assigned branches,
 * falling back to the first assigned branch if the requested branch is missing or out of scope.
 */
export function resolveStaffActiveBranch(
  assignedBranchIds: readonly string[],
  requestedBranchId?: string | null,
): string | null {
  if (assignedBranchIds.length === 0) return null;
  if (requestedBranchId && assignedBranchIds.includes(requestedBranchId)) {
    return requestedBranchId;
  }
  return assignedBranchIds[0] ?? null;
}

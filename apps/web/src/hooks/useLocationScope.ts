import { useCallback, useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "@/features/auth/AuthContext";
import { resolveStaffActiveBranch } from "@/hooks/staffBranchScope";

export { resolveStaffActiveBranch };

export function useLocationScope() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const storageKey = `stockflow_location_scope:${user?.id ?? "anon"}`;
  const isStaff = user?.role === "staff";

  const isAllowed = useCallback(
    (branchId: string | null): branchId is string => {
      if (!branchId) return false;
      if (!user || user.role === "admin") return true;
      return user.branchIds.includes(branchId);
    },
    [user],
  );

  const urlLocation = searchParams.get("location");

  const savedLocation = useMemo(() => {
    try {
      return window.localStorage.getItem(storageKey);
    } catch {
      return null;
    }
  }, [storageKey]);

  const selectedLocation = useMemo(() => {
    if (isStaff && user) {
      return resolveStaffActiveBranch(user.branchIds, urlLocation ?? savedLocation);
    }
    if (isAllowed(urlLocation)) return urlLocation;
    if (isAllowed(savedLocation)) return savedLocation;
    return null;
  }, [isStaff, user, urlLocation, savedLocation, isAllowed]);

  // Sync saved location into URL if URL doesn't have one (skipped for single-branch staff whose
  // branch scope is fixed and needs no URL query switcher).
  useEffect(() => {
    if (!urlLocation && selectedLocation && (!isStaff || (user?.branchIds.length ?? 0) > 1)) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("location", selectedLocation);
          return next;
        },
        { replace: true },
      );
    }
  }, [isStaff, user, urlLocation, selectedLocation, setSearchParams]);

  const setSelectedLocation = useCallback(
    (branchId: string | null) => {
      if (isStaff && (!user || user.branchIds.length <= 1)) return;
      const valid =
        isStaff && user
          ? resolveStaffActiveBranch(user.branchIds, branchId)
          : isAllowed(branchId)
            ? branchId
            : null;
      try {
        if (valid) {
          window.localStorage.setItem(storageKey, valid);
        } else {
          window.localStorage.removeItem(storageKey);
        }
      } catch {
        // Ignore storage errors
      }
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (valid) {
            next.set("location", valid);
          } else {
            next.delete("location");
          }
          return next;
        },
        { replace: true },
      );
    },
    [isStaff, user, isAllowed, storageKey, setSearchParams],
  );

  const clearLocation = useCallback(() => {
    if (isStaff) return;
    setSelectedLocation(null);
  }, [isStaff, setSelectedLocation]);

  return {
    selectedLocation,
    setSelectedLocation,
    clearLocation,
    isLocked: isStaff,
  };
}

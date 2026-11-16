import { useCallback, useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "@/features/auth/AuthContext";

export function useLocationScope() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const storageKey = `stockflow_location_scope:${user?.id ?? "anon"}`;
  const isStaff = user?.role === "staff";
  const staffBranch = isStaff ? (user.branchIds[0] ?? null) : null;

  const isAllowed = useCallback(
    (branchId: string | null): branchId is string => {
      if (!branchId) return false;
      if (!user || user.role === "admin") return true;
      return user.branchIds.includes(branchId);
    },
    [user],
  );

  const urlLocation = searchParams.get("location");

  const selectedLocation = useMemo(() => {
    if (isStaff) return staffBranch;
    if (isAllowed(urlLocation)) return urlLocation;
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (isAllowed(saved)) return saved;
    } catch {
      // Ignore storage errors
    }
    return null;
  }, [isStaff, staffBranch, urlLocation, isAllowed, storageKey]);

  // Sync saved location into URL if URL doesn't have one
  useEffect(() => {
    if (isStaff) return;
    if (!urlLocation && selectedLocation) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("location", selectedLocation);
          return next;
        },
        { replace: true },
      );
    }
  }, [isStaff, urlLocation, selectedLocation, setSearchParams]);

  const setSelectedLocation = useCallback(
    (branchId: string | null) => {
      if (isStaff) return;
      const valid = isAllowed(branchId) ? branchId : null;
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
    [isStaff, isAllowed, storageKey, setSearchParams],
  );

  const clearLocation = useCallback(() => {
    setSelectedLocation(null);
  }, [setSelectedLocation]);

  return {
    selectedLocation,
    setSelectedLocation,
    clearLocation,
    isLocked: isStaff,
  };
}

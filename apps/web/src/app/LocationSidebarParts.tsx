import { Check, ChevronDown, ChevronRight, Lock, MapPin, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { LocationSummaryItem } from "@stockflow/core";

function healthDotClass(health: LocationSummaryItem["health"]): string {
  if (health === "red") return "bg-risk";
  if (health === "amber") return "bg-warn";
  return "bg-gain";
}

function healthLabel(health: LocationSummaryItem["health"]): string {
  if (health === "red") return "High risk";
  if (health === "amber") return "Watch";
  return "Healthy";
}

export function LocationSwitcher({
  locations,
  selectedLocation,
  onSelect,
  isLocked,
  isAdmin,
}: {
  locations: LocationSummaryItem[];
  selectedLocation: string | null;
  onSelect: (branchId: string | null) => void;
  isLocked: boolean;
  isAdmin: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const currentItem = useMemo(
    () => locations.find((l) => l.branch.id === selectedLocation) ?? null,
    [locations, selectedLocation],
  );

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? locations.filter(
          (l) =>
            l.branch.name.toLowerCase().includes(q) ||
            l.branch.id.toLowerCase().includes(q) ||
            l.branch.city.toLowerCase().includes(q),
        )
      : locations;

    const map = new Map<string, LocationSummaryItem[]>();
    for (const loc of filtered) {
      const list = map.get(loc.branch.city) ?? [];
      list.push(loc);
      map.set(loc.branch.city, list);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [locations, search]);

  if (isLocked) {
    const label = currentItem ? `${currentItem.branch.name} (${currentItem.branch.id})` : selectedLocation ?? "Assigned store";
    return (
      <div className="px-2.5 pt-3">
        <div className="flex items-center gap-2 rounded-xl border border-border bg-secondary/50 px-2.5 py-2 text-xs">
          <Lock className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="truncate font-medium text-foreground" title={label}>
            {label}
          </span>
        </div>
      </div>
    );
  }

  const triggerLabel = currentItem
    ? `${currentItem.branch.name}`
    : isAdmin
      ? "All locations"
      : "All assigned";

  return (
    <div ref={containerRef} className="relative px-2.5 pt-3">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => {
          setOpen((prev) => !prev);
          setSearch("");
        }}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label="Switch location scope"
        className="h-9 w-full justify-between rounded-xl border border-border bg-background px-2.5 text-xs font-medium text-foreground hover:bg-row-hover"
      >
        <span className="flex min-w-0 items-center gap-2">
          <MapPin className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
          <span className="truncate">{triggerLabel}</span>
        </span>
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      </Button>

      {open ? (
        <div
          role="listbox"
          aria-label="Locations"
          className="absolute right-2.5 left-2.5 z-50 mt-1.5 max-h-80 overflow-hidden rounded-xl border border-border bg-card shadow-pop flex flex-col"
        >
          <div className="border-b border-border p-2">
            <div className="relative">
              <Search
                className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter locations..."
                className="h-8 pl-8 text-xs"
                aria-label="Filter locations"
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-1.5 space-y-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                onSelect(null);
                setOpen(false);
              }}
              className="h-8 w-full justify-between px-2 text-xs font-medium"
            >
              <span>{isAdmin ? "All locations" : "All assigned locations"}</span>
              {!selectedLocation ? <Check className="size-3.5 text-primary" aria-hidden="true" /> : null}
            </Button>

            {grouped.map(([city, items]) => (
              <div key={city}>
                <div className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {city}
                </div>
                <div className="space-y-0.5">
                  {items.map((loc) => (
                    <Button
                      key={loc.branch.id}
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        onSelect(loc.branch.id);
                        setOpen(false);
                      }}
                      className="h-8 w-full justify-between px-2 text-xs font-normal"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span
                          className={cn("size-2 shrink-0 rounded-full", healthDotClass(loc.health))}
                          title={healthLabel(loc.health)}
                        />
                        <span className="truncate">{loc.branch.name}</span>
                      </span>
                      {selectedLocation === loc.branch.id ? (
                        <Check className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                      ) : (
                        <span className="text-[11px] text-muted-foreground tabular-nums">
                          {loc.branch.id}
                        </span>
                      )}
                    </Button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function SidebarLocationsList({
  locations,
  pathname,
}: {
  locations: LocationSummaryItem[];
  pathname: string;
}) {
  const [expanded, setExpanded] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return locations;
    return locations.filter(
      (l) =>
        l.branch.name.toLowerCase().includes(q) ||
        l.branch.id.toLowerCase().includes(q) ||
        l.branch.city.toLowerCase().includes(q),
    );
  }, [locations, search]);

  const visible = showAll || search.trim() ? filtered : filtered.slice(0, 8);
  const hasMore = !search.trim() && filtered.length > 8;

  if (locations.length === 0) return null;

  return (
    <div className="pt-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setExpanded((prev) => !prev)}
        className="mb-1 h-7 w-full justify-between px-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
      >
        <span>Locations ({locations.length})</span>
        {expanded ? (
          <ChevronDown className="size-3.5" aria-hidden="true" />
        ) : (
          <ChevronRight className="size-3.5" aria-hidden="true" />
        )}
      </Button>

      {expanded ? (
        <div className="space-y-1.5">
          {locations.length > 5 ? (
            <div className="px-1">
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Find location..."
                className="h-7 text-xs"
                aria-label="Search sidebar locations"
              />
            </div>
          ) : null}
          <ul className="space-y-0.5">
            {visible.map((loc) => {
              const to = `/branches/${loc.branch.id}`;
              const active = pathname === to;
              return (
                <li key={loc.branch.id}>
                  <NavLink
                    to={to}
                    className={cn(
                      "flex h-8 items-center justify-between gap-2 rounded-lg px-2.5 text-xs transition-colors",
                      active
                        ? "bg-primary-soft font-medium text-primary-text"
                        : "text-muted-foreground hover:bg-row-hover hover:text-foreground",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        className={cn("size-2 shrink-0 rounded-full", healthDotClass(loc.health))}
                        aria-label={healthLabel(loc.health)}
                      />
                      <span className="truncate">{loc.branch.name}</span>
                    </span>
                    {loc.atRiskCount > 0 ? (
                      <Badge tone={loc.health === "red" ? "risk" : "over"} className="px-1.5 py-0 text-[10px]">
                        {formatNumber(loc.atRiskCount)}
                      </Badge>
                    ) : null}
                  </NavLink>
                </li>
              );
            })}
          </ul>
          {hasMore ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setShowAll((prev) => !prev)}
              className="h-7 w-full justify-start px-2.5 text-xs text-primary hover:text-primary"
            >
              {showAll ? "Show fewer" : `Show all (${filtered.length})`}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

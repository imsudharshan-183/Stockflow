import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Clock, MapPin, Package, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
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
import { useAuth } from "@/features/auth/AuthContext";
import { queryKeys } from "@/hooks/queryKeys";
import { api } from "@/lib/api";

interface PaletteItem {
  id: string;
  label: string;
  subtitle: string;
  to: string;
  group: "Page" | "Location" | "Product";
}

const RECENT_STORAGE_KEY = "stockflow_recent_palette";

function readRecent(): PaletteItem[] {
  try {
    const raw = window.localStorage.getItem(RECENT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as PaletteItem[]).slice(0, 5) : [];
  } catch {
    return [];
  }
}

function saveRecent(item: PaletteItem): void {
  try {
    const current = readRecent().filter((r) => r.id !== item.id);
    window.localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify([item, ...current].slice(0, 5)));
  } catch {
    // Ignore storage errors
  }
}

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<PaletteItem[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setRecent(readRecent());
      setActiveIndex(0);
    }
  }, [open]);

  const locationsQuery = useQuery({
    queryKey: queryKeys.locations,
    queryFn: () => api.locations(),
    enabled: open && Boolean(user),
    staleTime: 60_000,
  });

  const productsQuery = useQuery({
    queryKey: queryKeys.catalogProducts({ search: query.trim() || undefined, limit: 15 }),
    queryFn: () => api.listCatalogProducts({ search: query.trim() || undefined, limit: 15, page: 1 }),
    enabled: open && Boolean(user),
    staleTime: 60_000,
  });

  const pageItems = useMemo<PaletteItem[]>(() => {
    const isStaff = user?.role === "staff";
    const items: PaletteItem[] = [
      { id: "page-overview", label: isStaff ? "My Location" : "Overview", subtitle: "Daily summary", to: "/", group: "Page" },
      { id: "page-products", label: "Products", subtitle: "Catalog & stock levels", to: "/products", group: "Page" },
    ];
    if (!isStaff) {
      items.push(
        { id: "page-queue", label: "Action queue", subtitle: "Pending transfers, reorders & markdowns", to: "/queue", group: "Page" },
        { id: "page-data", label: "Daily entries", subtitle: "Record sales & stock counts", to: "/data", group: "Page" },
        { id: "page-audit", label: "Audit log", subtitle: "Decision history", to: "/audit", group: "Page" },
      );
    }
    if (user?.role === "admin") {
      items.push({ id: "page-users", label: "Users", subtitle: "Manage roles & branch access", to: "/users", group: "Page" });
    }
    return items;
  }, [user]);

  const locationItems = useMemo<PaletteItem[]>(() => {
    const locs = locationsQuery.data?.locations ?? [];
    return locs.map((loc) => ({
      id: `loc-${loc.branch.id}`,
      label: `${loc.branch.name} (${loc.branch.id})`,
      subtitle: `${loc.branch.city} · ${loc.atRiskCount} at risk`,
      to: `/branches/${loc.branch.id}`,
      group: "Location",
    }));
  }, [locationsQuery.data]);

  const productItems = useMemo<PaletteItem[]>(() => {
    const prods = productsQuery.data?.products ?? [];
    return prods.map((p) => ({
      id: `sku-${p.sku}`,
      label: `${p.sku} · ${p.name}`,
      subtitle: p.category,
      to: `/products/${p.sku}`,
      group: "Product",
    }));
  }, [productsQuery.data]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = [...pageItems, ...locationItems, ...productItems];
    if (!q) return all.slice(0, 14);
    return all
      .filter(
        (item) =>
          item.label.toLowerCase().includes(q) ||
          item.subtitle.toLowerCase().includes(q),
      )
      .slice(0, 18);
  }, [query, pageItems, locationItems, productItems]);

  const visibleRecent = useMemo(
    () => (!query.trim() ? recent : []),
    [query, recent],
  );

  const navigableItems = useMemo(
    () => [...visibleRecent, ...filtered],
    [visibleRecent, filtered],
  );

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    itemRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const handleSelect = (item: PaletteItem) => {
    saveRecent(item);
    onOpenChange(false);
    navigate(item.to);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (navigableItems.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((prev) => (prev + 1) % navigableItems.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((prev) => (prev - 1 + navigableItems.length) % navigableItems.length);
    } else if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      const selected = navigableItems[activeIndex];
      if (selected) {
        event.preventDefault();
        handleSelect(selected);
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onKeyDown={handleKeyDown}
        className="max-h-[80vh] max-w-xl overflow-hidden flex flex-col p-0"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Command palette</DialogTitle>
          <DialogDescription>Jump to pages, locations, and products</DialogDescription>
        </DialogHeader>
        <div className="relative border-b border-border px-3 py-2.5">
          <Search
            className="pointer-events-none absolute top-1/2 left-5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to a page, location (BR-003), or SKU..."
            className="border-0 pl-8 shadow-none focus-visible:ring-0"
            aria-label="Command palette search"
          />
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-3" role="listbox" aria-label="Command palette results">
          {visibleRecent.length > 0 ? (
            <div>
              <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Recent
              </div>
              <div className="space-y-0.5">
                {visibleRecent.map((item, idx) => {
                  const isActive = idx === activeIndex;
                  return (
                    <Button
                      key={`recent-${item.id}`}
                      ref={(el) => {
                        itemRefs.current[idx] = el;
                      }}
                      role="option"
                      aria-selected={isActive}
                      variant="ghost"
                      onMouseEnter={() => setActiveIndex(idx)}
                      onClick={() => handleSelect(item)}
                      className={`h-auto w-full justify-between px-2.5 py-2 text-left font-normal ${isActive ? "bg-accent" : ""}`}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <Clock className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <span className="truncate font-medium text-foreground">{item.label}</span>
                      </span>
                      <Badge>{item.group}</Badge>
                    </Button>
                  );
                })}
              </div>
            </div>
          ) : null}

          <div>
            <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {query.trim() ? "Results" : "Quick navigation"}
            </div>
            {filtered.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No matching pages, locations, or SKUs.
              </p>
            ) : (
              <div className="space-y-0.5">
                {filtered.map((item, idx) => {
                  const flatIndex = visibleRecent.length + idx;
                  const isActive = flatIndex === activeIndex;
                  return (
                    <Button
                      key={item.id}
                      ref={(el) => {
                        itemRefs.current[flatIndex] = el;
                      }}
                      role="option"
                      aria-selected={isActive}
                      variant="ghost"
                      onMouseEnter={() => setActiveIndex(flatIndex)}
                      onClick={() => handleSelect(item)}
                      className={`h-auto w-full justify-between px-2.5 py-2 text-left font-normal ${isActive ? "bg-accent" : ""}`}
                    >
                      <span className="flex min-w-0 items-center gap-2.5">
                        {item.group === "Location" ? (
                          <MapPin className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                        ) : item.group === "Product" ? (
                          <Package className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                        ) : (
                          <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                        )}
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-foreground">
                            {item.label}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {item.subtitle}
                          </span>
                        </span>
                      </span>
                      <Badge>{item.group}</Badge>
                    </Button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

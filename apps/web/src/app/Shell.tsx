import { useQuery } from "@tanstack/react-query";
import {
  BarChart3,
  ChevronDown,
  ClipboardEdit,
  HelpCircle,
  History,
  ListOrdered,
  LogOut,
  MapPin,
  Menu,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { LocationSwitcher, SidebarLocationsList } from "@/app/LocationSidebarParts";
import { ModeToggle } from "@/components/shared/ModeToggle";
import { CommandPalette } from "@/components/shared/CommandPalette";
import { GlossaryDialog } from "@/components/shared/GlossaryDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuth } from "@/features/auth/AuthContext";
import { queryKeys } from "@/hooks/queryKeys";
import { useLocationScope } from "@/hooks/useLocationScope";
import { api } from "@/lib/api";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { BAHRAIN_BRANCHES, type Role } from "@stockflow/core";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  matchPaths?: string[];
  badgeCount?: number;
}

function readCollapsedPreference(storageKey: string): boolean {
  try {
    return window.localStorage.getItem(storageKey) === "1";
  } catch {
    return false;
  }
}

function writeCollapsedPreference(storageKey: string, collapsed: boolean): void {
  try {
    window.localStorage.setItem(storageKey, collapsed ? "1" : "0");
  } catch {
    // Ignore storage quota or privacy-mode errors
  }
}

function breadcrumbForPath(pathname: string, role?: Role): { section: string; page: string } {
  if (role === "staff" && (pathname === "/" || pathname.startsWith("/overview") || pathname === "/products")) {
    return { section: "Store", page: "Store inventory" };
  }
  if (pathname === "/" || pathname.startsWith("/overview")) {
    return { section: "Daily work", page: "Overview" };
  }
  if (pathname.startsWith("/queue")) {
    return { section: "Daily work", page: "Action queue" };
  }
  if (pathname.startsWith("/data")) {
    return { section: "Inventory", page: "Daily entries" };
  }
  if (pathname.startsWith("/audit")) {
    return { section: "Review", page: "Audit log" };
  }
  if (pathname.startsWith("/users")) {
    return { section: "Admin", page: "Users" };
  }
  if (pathname === "/branches/manage") {
    return { section: "Admin", page: "Branches" };
  }
  if (pathname.startsWith("/branches/")) {
    const id = pathname.split("/")[2] ?? "Location";
    return { section: "Locations", page: id };
  }
  if (pathname === "/products") {
    return role === "staff"
      ? { section: "Store", page: "Store inventory" }
      : { section: "Inventory", page: "Products" };
  }
  if (pathname.startsWith("/products/")) {
    const sku = pathname.split("/")[2] ?? "Product";
    return { section: "Inventory", page: sku };
  }
  return { section: "StockFlow", page: "Page" };
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "SF";
  if (parts.length === 1) return (parts[0]?.slice(0, 2) ?? "SF").toUpperCase();
  return `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`.toUpperCase();
}

function roleBadgeTone(role: Role): "admin" | "manager" | "staff" {
  return role;
}

export function Shell() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const { selectedLocation, setSelectedLocation, clearLocation, isLocked } = useLocationScope();

  const storageKey = `stockflow_sidebar_collapsed:${user?.id ?? "anon"}`;
  const [collapsed, setCollapsed] = useState<boolean>(() => readCollapsedPreference(storageKey));
  const [mobileOpen, setMobileOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const userTriggerRef = useRef<HTMLButtonElement>(null);

  const locationsQuery = useQuery({
    queryKey: queryKeys.locations,
    queryFn: () => api.locations(),
    enabled: Boolean(user) && user?.role !== "staff",
    staleTime: 60_000,
  });

  const pendingQueueQuery = useQuery({
    queryKey: queryKeys.orders({
      queue: "suggested",
      branch: selectedLocation ?? undefined,
    }),
    queryFn: () =>
      api.listOrders({
        queue: "suggested",
        branch: selectedLocation ?? undefined,
      }),
    enabled: Boolean(user) && user?.role !== "staff",
    staleTime: 30_000,
  });

  const locations = useMemo(() => locationsQuery.data?.locations ?? [], [locationsQuery.data]);
  const pendingCount = pendingQueueQuery.data?.total ?? 0;

  useEffect(() => {
    setCollapsed(readCollapsedPreference(storageKey));
  }, [storageKey]);

  useEffect(() => {
    setMobileOpen(false);
    setUserMenuOpen(false);
    const crumb = breadcrumbForPath(location.pathname, user?.role);
    document.title = `${crumb.page} · StockFlow`;
  }, [location.pathname, user?.role]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const onScroll = () => {
      setScrolled(window.scrollY > 4);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!userMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setUserMenuOpen(false);
        userTriggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [userMenuOpen]);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      writeCollapsedPreference(storageKey, next);
      return next;
    });
  };

  const isStaff = user?.role === "staff";
  const isAdmin = user?.role === "admin";
  const canViewAudit = user ? user.role === "admin" || user.role === "manager" : true;
  const canManageUsers = user ? user.role === "admin" : false;

  const dailyWorkNav: NavItem[] = isStaff
    ? [
        {
          to: "/",
          label: "Store inventory",
          icon: Package,
          matchPaths: ["/", "/overview", "/products"],
        },
      ]
    : [
        { to: "/", label: "Overview", icon: BarChart3, matchPaths: ["/", "/overview"] },
        {
          to: "/queue",
          label: "Action queue",
          icon: ListOrdered,
          matchPaths: ["/queue"],
          badgeCount: pendingCount,
        },
      ];

  const inventoryNav: NavItem[] = isStaff
    ? []
    : [
        { to: "/products", label: "Products", icon: Package, matchPaths: ["/products"] },
        { to: "/data", label: "Daily entries", icon: ClipboardEdit, matchPaths: ["/data"] },
      ];

  const reviewNav: NavItem[] = canViewAudit
    ? [{ to: "/audit", label: "Audit log", icon: History, matchPaths: ["/audit"] }]
    : [];

  const adminNav: NavItem[] = canManageUsers
    ? [
        { to: "/users", label: "Users", icon: Users, matchPaths: ["/users"] },
        { to: "/branches/manage", label: "Branches", icon: MapPin, matchPaths: ["/branches/manage"] },
      ]
    : [];

  const scopeSummary =
    user?.role === "admin"
      ? "All 15 branches"
      : user && user.branchIds.length > 0
        ? user.branchIds.join(", ")
        : "No branches";

  const selectedLocationInfo = useMemo(
    () => locations.find((l) => l.branch.id === selectedLocation) ?? null,
    [locations, selectedLocation],
  );
  const lockedBranch = useMemo(
    () => (isStaff && selectedLocation ? BAHRAIN_BRANCHES.find((b) => b.id === selectedLocation) ?? null : null),
    [isStaff, selectedLocation],
  );
  const selectedLocationLabel = selectedLocationInfo
    ? `${selectedLocationInfo.branch.name} (${selectedLocation})`
    : lockedBranch
      ? `${lockedBranch.name} (${lockedBranch.id})`
      : selectedLocation ?? undefined;

  const crumb = breadcrumbForPath(location.pathname, user?.role);

  const renderNavSections = (isRailCollapsed: boolean) => (
    <>
      {!isRailCollapsed ? (
        <LocationSwitcher
          locations={locations}
          selectedLocation={selectedLocation}
          onSelect={setSelectedLocation}
          isLocked={isLocked}
          isAdmin={isAdmin}
          lockedLabel={selectedLocationLabel}
        />
      ) : null}

      <nav className="flex-1 space-y-4 overflow-y-auto px-2.5 py-4" aria-label="Main sections">
        <NavGroup
          title={isStaff ? "Store" : "Daily work"}
          items={dailyWorkNav}
          collapsed={isRailCollapsed}
          pathname={location.pathname}
          search={location.search}
        />

        {inventoryNav.length > 0 ? (
          <NavGroup
            title="Inventory"
            items={inventoryNav}
            collapsed={isRailCollapsed}
            pathname={location.pathname}
            search={location.search}
            divider
          />
        ) : null}

        {reviewNav.length > 0 ? (
          <NavGroup
            title="Review"
            items={reviewNav}
            collapsed={isRailCollapsed}
            pathname={location.pathname}
            search={location.search}
            divider
          />
        ) : null}

        {adminNav.length > 0 ? (
          <NavGroup
            title="Admin"
            items={adminNav}
            collapsed={isRailCollapsed}
            pathname={location.pathname}
            search={location.search}
            divider
          />
        ) : null}

        {!isRailCollapsed && !isStaff ? (
          <SidebarLocationsList locations={locations} pathname={location.pathname} />
        ) : null}
      </nav>

      {/* Sidebar Footer: Help */}
      <div
        className={cn(
          "border-t border-border p-2.5 flex items-center",
          isRailCollapsed ? "justify-center" : "justify-start",
        )}
      >
        <Button
          type="button"
          variant="ghost"
          size={isRailCollapsed ? "icon" : "sm"}
          onClick={() => setGlossaryOpen(true)}
          aria-label="Open glossary and help"
          className={cn(
            "text-muted-foreground hover:text-foreground",
            isRailCollapsed ? "size-8" : "h-8 gap-1.5 px-2.5 text-xs",
          )}
        >
          <HelpCircle className="size-4 shrink-0" aria-hidden="true" />
          {!isRailCollapsed ? <span>Glossary</span> : null}
        </Button>
      </div>
    </>
  );

  return (
    <TooltipProvider delay={120}>
      <div className="flex min-h-screen bg-background text-foreground">
        {/* Desktop Collapsible Sidebar (240px expanded / 64px collapsed rail) */}
        <aside
          aria-label="Primary navigation"
          className={cn(
            "sticky top-0 hidden h-screen shrink-0 flex-col border-r border-border bg-card transition-[width] duration-150 md:flex",
            collapsed ? "w-16" : "w-60",
          )}
        >
          {collapsed ? (
            <>
              <div className="flex h-14 items-center justify-center border-b border-border">
                <NavLink
                  to="/"
                  className="flex items-center justify-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="StockFlow home"
                >
                  <span className="brand-gradient flex size-8 shrink-0 items-center justify-center rounded-lg text-sm font-bold text-primary-foreground shadow-xs">
                    SF
                  </span>
                </NavLink>
              </div>
              <div className="flex justify-center pt-3 pb-1">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={toggleCollapsed}
                        aria-label="Expand sidebar"
                        aria-expanded={false}
                        className="size-8 rounded-lg text-muted-foreground hover:bg-row-hover hover:text-foreground"
                      />
                    }
                  >
                    <PanelLeftOpen className="size-4" aria-hidden="true" />
                  </TooltipTrigger>
                  <TooltipContent side="right">Expand sidebar</TooltipContent>
                </Tooltip>
              </div>
            </>
          ) : (
            <div className="flex h-14 items-center justify-between border-b border-border px-4">
              <NavLink
                to="/"
                className="flex min-w-0 items-center gap-2.5 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="StockFlow home"
              >
                <span className="brand-gradient flex size-8 shrink-0 items-center justify-center rounded-lg text-sm font-bold text-primary-foreground shadow-xs">
                  SF
                </span>
                <span className="truncate text-base font-semibold tracking-tight text-foreground">
                  StockFlow
                </span>
              </NavLink>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={toggleCollapsed}
                      aria-label="Collapse sidebar"
                      aria-expanded={true}
                      className="size-8 shrink-0 rounded-lg text-muted-foreground hover:bg-row-hover hover:text-foreground"
                    />
                  }
                >
                  <PanelLeftClose className="size-4" aria-hidden="true" />
                </TooltipTrigger>
                <TooltipContent side="right">Collapse sidebar</TooltipContent>
              </Tooltip>
            </div>
          )}

          {renderNavSections(collapsed)}
        </aside>

        {/* Mobile Slide-Over Navigation Drawer */}
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent side="left" className="flex flex-col p-0">
            <div className="flex h-14 items-center border-b border-border px-4 pr-12">
              <SheetTitle className="flex items-center gap-2.5">
                <span className="brand-gradient flex size-7 items-center justify-center rounded-lg text-xs font-bold text-primary-foreground shadow-xs">
                  SF
                </span>
                <span className="text-base font-semibold tracking-tight text-foreground">
                  StockFlow
                </span>
              </SheetTitle>
            </div>
            {renderNavSections(false)}
          </SheetContent>
        </Sheet>

        {/* Main Column */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Slim Top Bar */}
          <header
            className={cn(
              "sticky top-0 z-30 flex h-14 items-center justify-between gap-2 border-b border-border bg-card px-4 transition-shadow duration-150 sm:gap-3 sm:px-6",
              scrolled ? "shadow-xs" : "",
            )}
          >
            {/* Left: Mobile menu button + breadcrumb + active location chip */}
            <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-2.5">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 shrink-0 rounded-lg md:hidden"
                      aria-label="Open navigation menu"
                      onClick={() => setMobileOpen(true)}
                    />
                  }
                >
                  <Menu className="size-4" aria-hidden="true" />
                </TooltipTrigger>
                <TooltipContent side="bottom">Open navigation menu</TooltipContent>
              </Tooltip>

              <nav
                aria-label="Breadcrumb"
                className={cn(
                  "min-w-0 items-center gap-1.5 text-xs text-muted-foreground",
                  selectedLocation ? "hidden sm:flex" : "flex",
                )}
              >
                <span className="hidden truncate sm:inline">{crumb.section}</span>
                <span className="hidden text-disabled sm:inline" aria-hidden="true">
                  /
                </span>
                <span className="truncate font-medium text-foreground">{crumb.page}</span>
              </nav>

              {selectedLocation ? (
                <Badge tone="reorder" className="min-w-0 max-w-full shrink gap-1.5 pl-2 pr-1.5">
                  <MapPin className="size-3 shrink-0" aria-hidden="true" />
                  <span className="truncate">
                    {selectedLocationLabel ?? selectedLocation}
                  </span>
                  {!isLocked ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={clearLocation}
                      aria-label="Clear location filter"
                      className="size-4 shrink-0 rounded-full p-0 hover:bg-primary-soft"
                    >
                      <X className="size-3" aria-hidden="true" />
                    </Button>
                  ) : null}
                </Badge>
              ) : null}
            </div>

            {/* Right: Command Palette Hint + Theme Toggle + User Menu */}
            <div className="flex min-w-0 shrink-0 items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setPaletteOpen(true)}
                aria-label="Open command palette"
                className="hidden h-8 gap-2 rounded-lg border border-border bg-background px-2.5 text-xs text-muted-foreground hover:text-foreground sm:inline-flex"
              >
                <Search className="size-3.5" aria-hidden="true" />
                <span>Jump to...</span>
                <kbd className="rounded border border-border bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  Ctrl K
                </kbd>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setPaletteOpen(true)}
                aria-label="Open command palette"
                className="size-8 sm:hidden"
              >
                <Search className="size-4" aria-hidden="true" />
              </Button>

              <ModeToggle />

              {user ? (
                <div ref={userMenuRef} className="relative flex min-w-0 shrink-0 items-center">
                  <Button
                    ref={userTriggerRef}
                    variant="ghost"
                    onClick={() => setUserMenuOpen((prev) => !prev)}
                    aria-haspopup="menu"
                    aria-expanded={userMenuOpen}
                    aria-label={`Account menu for ${user.name}`}
                    className="h-9 max-w-[260px] min-w-0 gap-2 rounded-full border border-border bg-card px-2 py-1 text-foreground shadow-xs hover:bg-row-hover min-[900px]:pr-2.5"
                  >
                    <span
                      className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary-soft text-xs font-semibold text-primary-text"
                      aria-hidden="true"
                    >
                      {initialsOf(user.name)}
                    </span>
                    <span className="hidden min-w-0 items-center gap-1.5 min-[900px]:flex">
                      <span className="max-w-[120px] truncate text-xs font-medium text-foreground">
                        {user.name}
                      </span>
                      <Badge tone={roleBadgeTone(user.role)} className="shrink-0">
                        {user.role}
                      </Badge>
                    </span>
                    <ChevronDown
                      className={cn(
                        "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
                        userMenuOpen ? "rotate-180" : "",
                      )}
                      aria-hidden="true"
                    />
                  </Button>

                  {userMenuOpen ? (
                    <div
                      role="menu"
                      aria-label="User account details"
                      className="absolute top-full right-0 z-50 mt-2 w-64 rounded-2xl border border-border bg-card p-3 shadow-pop"
                    >
                      <div className="space-y-1 border-b border-border pb-3">
                        <div className="flex items-center justify-between gap-2">
                          <p className="truncate text-sm font-semibold text-foreground">{user.name}</p>
                          <Badge tone={roleBadgeTone(user.role)} className="shrink-0">
                            {user.role}
                          </Badge>
                        </div>
                        <p className="truncate text-xs text-muted-foreground">{user.email}</p>
                        <div className="pt-1.5">
                          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                            Branch scope
                          </p>
                          <p className="mt-0.5 text-xs text-foreground" title={scopeSummary}>
                            {scopeSummary}
                          </p>
                        </div>
                      </div>

                      <div className="pt-2">
                        <Button
                          role="menuitem"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setUserMenuOpen(false);
                            void logout();
                          }}
                          className="h-8 w-full justify-start gap-2 rounded-xl px-2.5 text-xs font-medium text-risk-text hover:bg-risk-bg hover:text-risk-text"
                        >
                          <LogOut className="size-3.5" aria-hidden="true" />
                          Sign out
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </header>

          <main className="mx-auto w-full max-w-7xl flex-1 space-y-6 px-4 py-6 sm:px-6">
            <Outlet />
          </main>
        </div>
      </div>

      <GlossaryDialog open={glossaryOpen} onOpenChange={setGlossaryOpen} />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </TooltipProvider>
  );
}

function NavGroup({
  title,
  items,
  collapsed,
  pathname,
  search,
  divider = false,
}: {
  title: string;
  items: NavItem[];
  collapsed: boolean;
  pathname: string;
  search: string;
  divider?: boolean;
}) {
  return (
    <div>
      {!collapsed ? (
        <p className="mb-1.5 px-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </p>
      ) : divider ? (
        <div className="my-2 border-t border-border" />
      ) : null}
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item.to}>
            <SidebarLink item={item} collapsed={collapsed} pathname={pathname} search={search} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function SidebarLink({
  item,
  collapsed,
  pathname,
  search,
}: {
  item: NavItem;
  collapsed: boolean;
  pathname: string;
  search: string;
}) {
  const Icon = item.icon;
  const isActive = item.matchPaths
    ? item.matchPaths.some((p) => (p === "/" ? pathname === "/" : pathname.startsWith(p)))
    : pathname === item.to;

  // Preserve ?location= query parameter when navigating between scoped pages
  const params = new URLSearchParams(search);
  const locationParam = params.get("location");
  const target = locationParam ? `${item.to}?location=${encodeURIComponent(locationParam)}` : item.to;

  const linkElement = (
    <NavLink
      to={target}
      aria-label={collapsed ? item.label : undefined}
      className={cn(
        "relative flex h-9 items-center justify-between gap-2 rounded-xl px-3 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        collapsed ? "justify-center px-0" : "",
        isActive
          ? "bg-primary-soft text-primary-text before:absolute before:top-1.5 before:bottom-1.5 before:left-0 before:w-[3px] before:rounded-r-full before:bg-primary"
          : "text-muted-foreground hover:bg-row-hover hover:text-foreground",
      )}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        {!collapsed ? <span className="truncate">{item.label}</span> : null}
      </span>
      {!collapsed && item.badgeCount && item.badgeCount > 0 ? (
        <Badge tone="reorder" className="px-1.5 py-0 text-[11px]">
          {formatNumber(item.badgeCount)}
        </Badge>
      ) : null}
    </NavLink>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger render={linkElement} />
        <TooltipContent side="right">
          {item.label}
          {item.badgeCount && item.badgeCount > 0 ? ` (${formatNumber(item.badgeCount)})` : ""}
        </TooltipContent>
      </Tooltip>
    );
  }

  return linkElement;
}

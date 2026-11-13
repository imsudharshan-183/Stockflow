import {
  BarChart3,
  ChevronDown,
  History,
  ListOrdered,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuth } from "@/features/auth/AuthContext";
import { cn } from "@/lib/utils";
import type { Role } from "@stockflow/core";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  matchPaths?: string[];
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

function breadcrumbForPath(pathname: string): { section: string; page: string } {
  if (pathname === "/" || pathname.startsWith("/overview")) {
    return { section: "Operations", page: "Overview" };
  }
  if (pathname.startsWith("/queue")) {
    return { section: "Operations", page: "Action queue" };
  }
  if (pathname.startsWith("/audit")) {
    return { section: "Governance", page: "Audit log" };
  }
  if (pathname.startsWith("/users")) {
    return { section: "Governance", page: "Users" };
  }
  if (pathname.startsWith("/branches/")) {
    const id = pathname.split("/")[2] ?? "Branch";
    return { section: "Branches", page: id };
  }
  if (pathname.startsWith("/products/")) {
    const sku = pathname.split("/")[2] ?? "Product";
    return { section: "Products", page: sku };
  }
  return { section: "StockFlow", page: "Page" };
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "SF";
  if (parts.length === 1) return (parts[0]?.slice(0, 2) ?? "SF").toUpperCase();
  return `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`.toUpperCase();
}

function roleBadgeTone(role: Role): "transfer" | "reorder" | "pending" {
  if (role === "admin") return "transfer";
  if (role === "manager") return "reorder";
  return "pending";
}

export function Shell() {
  const { user, logout } = useAuth();
  const location = useLocation();

  const storageKey = `stockflow_sidebar_collapsed:${user?.id ?? "anon"}`;
  const [collapsed, setCollapsed] = useState<boolean>(() => readCollapsedPreference(storageKey));
  const [mobileOpen, setMobileOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const userTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setCollapsed(readCollapsedPreference(storageKey));
  }, [storageKey]);

  useEffect(() => {
    setMobileOpen(false);
    setUserMenuOpen(false);
    const crumb = breadcrumbForPath(location.pathname);
    document.title = `${crumb.page} · StockFlow`;
  }, [location.pathname]);

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

  const canViewAudit = user ? user.role === "admin" || user.role === "manager" : true;
  const canManageUsers = user ? user.role === "admin" : false;

  const operationsNav: NavItem[] = [
    { to: "/", label: "Overview", icon: BarChart3, matchPaths: ["/", "/overview"] },
    { to: "/queue", label: "Action queue", icon: ListOrdered, matchPaths: ["/queue"] },
  ];

  const adminNav: NavItem[] = [
    ...(canViewAudit ? [{ to: "/audit", label: "Audit log", icon: History, matchPaths: ["/audit"] }] : []),
    ...(canManageUsers ? [{ to: "/users", label: "Users", icon: Users, matchPaths: ["/users"] }] : []),
  ];

  const scopeSummary =
    user?.role === "admin"
      ? "All 15 branches"
      : user && user.branchIds.length > 0
        ? user.branchIds.join(", ")
        : "No branches";

  const crumb = breadcrumbForPath(location.pathname);

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

          <nav className="flex-1 space-y-5 overflow-y-auto px-2.5 py-4" aria-label="Main sections">
            <div>
              {!collapsed ? (
                <p className="mb-1.5 px-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Operations
                </p>
              ) : null}
              <ul className="space-y-1">
                {operationsNav.map((item) => (
                  <li key={item.to}>
                    <SidebarLink item={item} collapsed={collapsed} pathname={location.pathname} />
                  </li>
                ))}
              </ul>
            </div>

            {adminNav.length > 0 ? (
              <div>
                {!collapsed ? (
                  <p className="mb-1.5 px-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Governance
                  </p>
                ) : (
                  <div className="my-2 border-t border-border" />
                )}
                <ul className="space-y-1">
                  {adminNav.map((item) => (
                    <li key={item.to}>
                      <SidebarLink item={item} collapsed={collapsed} pathname={location.pathname} />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </nav>
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
            <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4" aria-label="Mobile navigation">
              <div>
                <p className="mb-1.5 px-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Operations
                </p>
                <ul className="space-y-1">
                  {operationsNav.map((item) => (
                    <li key={item.to}>
                      <SidebarLink item={item} collapsed={false} pathname={location.pathname} />
                    </li>
                  ))}
                </ul>
              </div>
              {adminNav.length > 0 ? (
                <div>
                  <p className="mb-1.5 px-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Governance
                  </p>
                  <ul className="space-y-1">
                    {adminNav.map((item) => (
                      <li key={item.to}>
                        <SidebarLink item={item} collapsed={false} pathname={location.pathname} />
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </nav>
            {user ? (
              <div className="border-t border-border bg-secondary/40 p-4 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-semibold text-foreground">{user.name}</span>
                  <Badge tone={roleBadgeTone(user.role)}>{user.role}</Badge>
                </div>
                <p className="mt-0.5 truncate text-muted-foreground">{user.email}</p>
                <p className="mt-1 truncate text-muted-foreground">Scope: {scopeSummary}</p>
              </div>
            ) : null}
          </SheetContent>
        </Sheet>

        {/* Main Column */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Slim Top Bar (white, h-14, bottom border, faint shadow when scrolled) */}
          <header
            className={cn(
              "sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-border bg-card px-4 transition-shadow duration-150 sm:px-6",
              scrolled ? "shadow-xs" : "",
            )}
          >
            {/* Left: Mobile menu button + muted breadcrumb */}
            <div className="flex min-w-0 items-center gap-2.5">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 rounded-lg md:hidden"
                      aria-label="Open navigation menu"
                      onClick={() => setMobileOpen(true)}
                    />
                  }
                >
                  <Menu className="size-4" aria-hidden="true" />
                </TooltipTrigger>
                <TooltipContent side="bottom">Open navigation menu</TooltipContent>
              </Tooltip>

              <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <span className="hidden truncate sm:inline">{crumb.section}</span>
                <span className="hidden text-disabled sm:inline" aria-hidden="true">
                  /
                </span>
                <span className="truncate font-medium text-foreground">{crumb.page}</span>
              </nav>
            </div>

            {/* Right: Single User Menu Button + Dropdown */}
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
          </header>

          <main className="mx-auto w-full max-w-7xl flex-1 space-y-6 px-4 py-6 sm:px-6">
            <Outlet />
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}

function SidebarLink({
  item,
  collapsed,
  pathname,
}: {
  item: NavItem;
  collapsed: boolean;
  pathname: string;
}) {
  const Icon = item.icon;
  const isActive = item.matchPaths
    ? item.matchPaths.some((p) => (p === "/" ? pathname === "/" : pathname.startsWith(p)))
    : pathname === item.to;

  const linkElement = (
    <NavLink
      to={item.to}
      aria-label={collapsed ? item.label : undefined}
      className={cn(
        "relative flex h-9 items-center gap-2.5 rounded-xl px-3 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        collapsed ? "justify-center px-0" : "",
        isActive
          ? "bg-primary-soft text-primary-text before:absolute before:top-1.5 before:bottom-1.5 before:left-0 before:w-[3px] before:rounded-r-full before:bg-primary"
          : "text-muted-foreground hover:bg-row-hover hover:text-foreground",
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      {!collapsed ? <span className="truncate">{item.label}</span> : null}
    </NavLink>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger render={linkElement} />
        <TooltipContent side="right">{item.label}</TooltipContent>
      </Tooltip>
    );
  }

  return linkElement;
}

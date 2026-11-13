import { useQuery } from "@tanstack/react-query";
import {
  BarChart3,
  Building2,
  History,
  ListOrdered,
  Lock,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useSearchParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useAuth } from "@/features/auth/AuthContext";
import { queryKeys } from "@/hooks/queryKeys";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

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

function pageTitleForPath(pathname: string): string {
  if (pathname === "/" || pathname.startsWith("/queue")) return "Action queue";
  if (pathname.startsWith("/overview")) return "Network overview";
  if (pathname.startsWith("/audit")) return "Audit log";
  if (pathname.startsWith("/users")) return "User management";
  if (pathname.startsWith("/branches/")) return "Branch drilldown";
  if (pathname.startsWith("/products/")) return "Product drilldown";
  return "StockFlow";
}

export function Shell() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const kpis = useQuery({ queryKey: queryKeys.kpis, queryFn: api.kpis });

  const storageKey = `stockflow_sidebar_collapsed:${user?.id ?? "anon"}`;
  const [collapsed, setCollapsed] = useState<boolean>(() => readCollapsedPreference(storageKey));
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    setCollapsed(readCollapsedPreference(storageKey));
  }, [storageKey]);

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

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
    { to: "/", label: "Action queue", icon: ListOrdered, matchPaths: ["/", "/queue"] },
    { to: "/overview", label: "Overview", icon: BarChart3, matchPaths: ["/overview"] },
  ];

  const adminNav: NavItem[] = [
    ...(canViewAudit ? [{ to: "/audit", label: "Audit log", icon: History, matchPaths: ["/audit"] }] : []),
    ...(canManageUsers ? [{ to: "/users", label: "Users", icon: Users, matchPaths: ["/users"] }] : []),
  ];

  const isQueueRoute = location.pathname === "/" || location.pathname.startsWith("/queue");
  const branches = kpis.data?.branches ?? [];
  const activeBranchFilter = searchParams.get("branch") ?? "";
  const isSingleBranchStaff = user?.role === "staff" && user.branchIds.length <= 1;
  const singleBranchId = user?.branchIds[0] ?? "";
  const singleBranchName =
    branches.find((b) => b.id === singleBranchId)?.name ?? singleBranchId ?? "Assigned branch";

  function handleQueueBranchChange(nextBranch: string) {
    const next = new URLSearchParams(searchParams);
    if (nextBranch) {
      next.set("branch", nextBranch);
    } else {
      next.delete("branch");
    }
    next.delete("page");
    setSearchParams(next);
  }

  const scopeSummary =
    user?.role === "admin"
      ? "All 15 branches"
      : user && user.branchIds.length > 0
        ? user.branchIds.join(", ")
        : "No branches";

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      {/* Desktop Collapsible Sidebar */}
      <aside
        aria-label="Primary navigation"
        className={cn(
          "sticky top-0 hidden h-screen shrink-0 flex-col border-r bg-card transition-[width] duration-150 md:flex",
          collapsed ? "w-16" : "w-60",
        )}
      >
        <div
          className={cn(
            "flex h-14 items-center border-b px-3",
            collapsed ? "justify-center" : "justify-between px-4",
          )}
        >
          <NavLink
            to="/"
            className="flex items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="StockFlow home"
          >
            <span className="brand-gradient flex size-8 shrink-0 items-center justify-center rounded-lg text-sm font-bold text-white shadow-sm">
              SF
            </span>
            {!collapsed ? (
              <span className="brand-gradient bg-clip-text text-base font-semibold tracking-tight text-transparent">
                StockFlow
              </span>
            ) : null}
          </NavLink>
        </div>

        <nav className="flex-1 space-y-5 overflow-y-auto px-2.5 py-4" aria-label="Main sections">
          <div>
            {!collapsed ? (
              <p className="mb-1.5 px-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
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
                <p className="mb-1.5 px-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Governance
                </p>
              ) : (
                <div className="my-2 border-t" />
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

        <div className="border-t p-2.5">
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={cn(
              "flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-[var(--lavender-50)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              collapsed ? "justify-center px-0" : "",
            )}
          >
            {collapsed ? <PanelLeftOpen className="size-4 shrink-0" /> : <PanelLeftClose className="size-4 shrink-0" />}
            {!collapsed ? <span>Collapse sidebar</span> : null}
          </button>
        </div>
      </aside>

      {/* Mobile Slide-Over Navigation Drawer */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="flex flex-col p-0">
          <div className="flex h-14 items-center border-b px-4">
            <SheetTitle className="flex items-center gap-2.5">
              <span className="brand-gradient flex size-7 items-center justify-center rounded-lg text-xs font-bold text-white">
                SF
              </span>
              <span className="brand-gradient bg-clip-text text-base font-semibold tracking-tight text-transparent">
                StockFlow
              </span>
            </SheetTitle>
          </div>
          <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4" aria-label="Mobile navigation">
            <div>
              <p className="mb-1.5 px-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
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
                <p className="mb-1.5 px-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
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
            <div className="border-t bg-[var(--lavender-50)]/40 p-4 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-foreground">{user.name}</span>
                <Badge tone={user.role === "admin" ? "high" : user.role === "manager" ? "med" : "low"}>
                  {user.role}
                </Badge>
              </div>
              <p className="mt-1 text-muted-foreground">Scope: {scopeSummary}</p>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>

      {/* Main Column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Slim Top Bar */}
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b bg-card/95 px-4 backdrop-blur sm:px-6">
          <div className="flex min-w-0 items-center gap-2.5">
            <Button
              variant="ghost"
              size="icon-sm"
              className="md:hidden"
              aria-label="Open navigation menu"
              onClick={() => setMobileOpen(true)}
            >
              <Menu className="size-4" />
            </Button>
            <h2 className="truncate text-base font-semibold tracking-tight text-foreground">
              {pageTitleForPath(location.pathname)}
            </h2>
          </div>

          <div className="flex items-center gap-2.5 sm:gap-4">
            {/* Queue-only Branch Filter or Locked Staff Pill */}
            {isSingleBranchStaff ? (
              <div
                className="flex items-center gap-1.5 rounded-lg border bg-[var(--lavender-50)] px-2.5 py-1 text-xs font-medium text-foreground"
                title="Staff accounts are scoped to their assigned branch"
              >
                <Lock className="size-3 text-muted-foreground" aria-hidden="true" />
                <span className="hidden text-muted-foreground sm:inline">Filtering queue:</span>
                <span>{singleBranchName}</span>
              </div>
            ) : isQueueRoute ? (
              <label className="flex items-center gap-2 text-xs">
                <span className="hidden items-center gap-1 font-medium text-muted-foreground sm:inline-flex">
                  <Building2 className="size-3.5" aria-hidden="true" />
                  Filtering queue
                </span>
                <select
                  aria-label="Filtering queue by branch"
                  value={activeBranchFilter}
                  onChange={(event) => handleQueueBranchChange(event.target.value)}
                  className="h-8 max-w-[180px] rounded-lg border border-input bg-background px-2.5 text-xs font-medium text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 sm:max-w-[220px]"
                >
                  <option value="">
                    {user?.role === "admin" ? "All 15 branches" : `All assigned (${branches.length})`}
                  </option>
                  {branches.map((branch) => (
                    <option key={branch.id} value={branch.id}>
                      {branch.id} · {branch.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            {/* User Menu */}
            {user ? (
              <div className="flex items-center gap-2.5 border-l pl-2.5 sm:pl-4">
                <div className="hidden flex-col items-end text-xs sm:flex">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-foreground">{user.name}</span>
                    <Badge tone={user.role === "admin" ? "high" : user.role === "manager" ? "med" : "low"}>
                      {user.role}
                    </Badge>
                  </div>
                  <span className="max-w-[180px] truncate text-[11px] text-muted-foreground" title={scopeSummary}>
                    {scopeSummary}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void logout()}
                  aria-label="Sign out"
                  title="Sign out"
                >
                  <LogOut className="size-3.5 sm:mr-1" />
                  <span className="hidden sm:inline">Sign out</span>
                </Button>
              </div>
            ) : null}
          </div>
        </header>

        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-5 sm:px-6">
          <Outlet />
        </main>
      </div>
    </div>
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

  return (
    <NavLink
      to={item.to}
      title={collapsed ? item.label : undefined}
      aria-label={collapsed ? item.label : undefined}
      className={cn(
        "flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        collapsed ? "justify-center px-0" : "",
        isActive
          ? "bg-primary text-primary-foreground shadow-sm"
          : "text-muted-foreground hover:bg-[var(--lavender-50)] hover:text-foreground",
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      {!collapsed ? <span className="truncate">{item.label}</span> : null}
    </NavLink>
  );
}

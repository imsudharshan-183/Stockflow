import { NavLink, Outlet } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/AuthContext";
import { cn } from "@/lib/utils";

export function Shell() {
  const { user, logout } = useAuth();

  const canViewAudit = user ? user.role === "admin" || user.role === "manager" : true;
  const canManageUsers = user ? user.role === "admin" : false;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-6">
            <NavLink to="/" className="brand-gradient bg-clip-text text-lg font-semibold tracking-tight text-transparent">
              StockFlow
            </NavLink>
            <nav className="flex items-center gap-1 rounded-full border bg-card p-1 shadow-card">
              <TopLink to="/">Overview</TopLink>
              <TopLink to="/queue">Action queue</TopLink>
              {canViewAudit ? <TopLink to="/audit">Audit log</TopLink> : null}
              {canManageUsers ? <TopLink to="/users">Users</TopLink> : null}
            </nav>
          </div>

          {user ? (
            <div className="flex items-center gap-3 text-xs">
              <div className="flex flex-col items-end">
                <div className="flex items-center gap-1.5">
                  <span className="font-medium text-foreground">{user.name}</span>
                  <Badge tone={user.role === "admin" ? "high" : user.role === "manager" ? "med" : "low"}>
                    {user.role}
                  </Badge>
                </div>
                <span className="text-muted-foreground">
                  {user.role === "admin"
                    ? "All 15 branches"
                    : user.branchIds.length > 0
                      ? `Branches: ${user.branchIds.join(", ")}`
                      : "No branches"}
                </span>
              </div>
              <Button size="sm" variant="outline" onClick={() => void logout()}>
                Sign Out
              </Button>
            </div>
          ) : null}
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-6">
        <Outlet />
      </main>
    </div>
  );
}

function TopLink({ to, children }: { to: string; children: string }) {
  return (
    <NavLink
      to={to}
      end={to === "/"}
      className={({ isActive }) =>
        cn(
          "rounded-full px-3 py-1.5 text-sm",
          isActive ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-[var(--lavender-50)]",
        )
      }
    >
      {children}
    </NavLink>
  );
}

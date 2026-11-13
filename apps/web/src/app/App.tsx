import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Shell } from "@/app/Shell";
import { LoadingBlock } from "@/components/shared/states";
import { AuditPage } from "@/features/audit/AuditPage";
import { AuthProvider, useAuth } from "@/features/auth/AuthContext";
import { LoginPage } from "@/features/auth/LoginPage";
import { BranchPage } from "@/features/drilldown/BranchPage";
import { ProductPage } from "@/features/drilldown/ProductPage";
import { OverviewPage } from "@/features/overview/OverviewPage";
import { QueuePage } from "@/features/queue/QueuePage";
import { UsersPage } from "@/features/users/UsersPage";
import type { Role } from "@stockflow/core";
import type { ReactNode } from "react";

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) return <LoadingBlock />;
  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  return <>{children}</>;
}

function RequireRole({ role, children }: { role: Role; children: ReactNode }) {
  const { user, isLoading } = useAuth();

  if (isLoading) return <LoadingBlock />;
  if (!user || user.role !== role) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}

function RequireNotStaff({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth();

  if (isLoading) return <LoadingBlock />;
  if (!user || user.role === "staff") {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          element={
            <RequireAuth>
              <Shell />
            </RequireAuth>
          }
        >
          <Route index element={<OverviewPage />} />
          <Route path="queue" element={<QueuePage />} />
          <Route
            path="audit"
            element={
              <RequireNotStaff>
                <AuditPage />
              </RequireNotStaff>
            }
          />
          <Route
            path="users"
            element={
              <RequireRole role="admin">
                <UsersPage />
              </RequireRole>
            }
          />
          <Route path="branches/:id" element={<BranchPage />} />
          <Route path="products/:sku" element={<ProductPage />} />
          <Route path="*" element={<p className="text-sm text-muted-foreground">That page is not in StockFlow.</p>} />
        </Route>
      </Routes>
    </AuthProvider>
  );
}

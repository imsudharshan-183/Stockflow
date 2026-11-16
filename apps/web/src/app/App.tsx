import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Shell } from "@/app/Shell";
import { EmptyBlock, LoadingBlock } from "@/components/shared/states";
import { ThemeProvider } from "@/components/theme-provider";
import { AuthProvider, useAuth } from "@/features/auth/AuthContext";
import type { Role } from "@stockflow/core";

const LoginPage = lazy(() =>
  import("@/features/auth/LoginPage").then((m) => ({ default: m.LoginPage })),
);
const OverviewPage = lazy(() =>
  import("@/features/overview/OverviewPage").then((m) => ({ default: m.OverviewPage })),
);
const QueuePage = lazy(() =>
  import("@/features/queue/QueuePage").then((m) => ({ default: m.QueuePage })),
);
const AuditPage = lazy(() =>
  import("@/features/audit/AuditPage").then((m) => ({ default: m.AuditPage })),
);
const UsersPage = lazy(() =>
  import("@/features/users/UsersPage").then((m) => ({ default: m.UsersPage })),
);
const ProductsPage = lazy(() =>
  import("@/features/products/ProductsPage").then((m) => ({ default: m.ProductsPage })),
);
const DataEntryPage = lazy(() =>
  import("@/features/data/DataEntryPage").then((m) => ({ default: m.DataEntryPage })),
);
const BranchPage = lazy(() =>
  import("@/features/drilldown/BranchPage").then((m) => ({ default: m.BranchPage })),
);
const ProductPage = lazy(() =>
  import("@/features/drilldown/ProductPage").then((m) => ({ default: m.ProductPage })),
);

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
    <ThemeProvider defaultTheme="light" storageKey="stockflow-theme">
      <AuthProvider>
        <Suspense fallback={<LoadingBlock />}>
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
              <Route path="overview" element={<Navigate to="/" replace />} />
              <Route
                path="queue"
                element={
                  <RequireNotStaff>
                    <QueuePage />
                  </RequireNotStaff>
                }
              />
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
              <Route path="products" element={<ProductsPage />} />
              <Route path="products/:sku" element={<ProductPage />} />
              <Route
                path="data"
                element={
                  <RequireNotStaff>
                    <DataEntryPage />
                  </RequireNotStaff>
                }
              />
              <Route
                path="*"
                element={
                  <EmptyBlock
                    title="Page not found"
                    body="That page is not in StockFlow. Use the sidebar to return to the overview or action queue."
                  />
                }
              />
            </Route>
          </Routes>
        </Suspense>
      </AuthProvider>
    </ThemeProvider>
  );
}

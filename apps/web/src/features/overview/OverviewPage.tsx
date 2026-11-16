import { useQuery } from "@tanstack/react-query";
import { ErrorBlock, LoadingBlock } from "@/components/shared/states";
import { useAuth } from "@/features/auth/AuthContext";
import { BranchPage } from "@/features/drilldown/BranchPage";
import { AdminOverview } from "@/features/overview/AdminOverview";
import { ManagerOverview } from "@/features/overview/ManagerOverview";
import { queryKeys } from "@/hooks/queryKeys";
import { useLocationScope } from "@/hooks/useLocationScope";
import { api } from "@/lib/api";

export function OverviewPage() {
  const { user } = useAuth();
  const isStaff = user?.role === "staff";
  const isManager = user?.role === "manager";

  // Staff land on a read-only version of their assigned location dashboard
  if (isStaff) {
    return <BranchPage forcedBranchId={user.branchIds[0]} readOnly />;
  }

  return <OverviewDashboard isManager={isManager} />;
}

function OverviewDashboard({ isManager }: { isManager: boolean }) {
  const { selectedLocation } = useLocationScope();
  const branchParam = selectedLocation ?? undefined;

  const kpis = useQuery({
    queryKey: queryKeys.kpis(branchParam),
    queryFn: () => api.kpis(branchParam),
  });
  const queue = useQuery({
    queryKey: queryKeys.recommendations({ branch: branchParam }),
    queryFn: () => api.recommendations({ branch: branchParam }),
  });

  if (kpis.isPending) return <LoadingBlock />;
  if (kpis.isError) {
    return <ErrorBlock message={kpis.error.message} onRetry={() => void kpis.refetch()} />;
  }

  const report = kpis.data;
  const recommendations = queue.data?.recommendations ?? [];
  const totalActions = queue.data?.total ?? 0;

  if (isManager) {
    return (
      <ManagerOverview
        report={report}
        recommendations={recommendations}
        totalActions={totalActions}
      />
    );
  }

  return (
    <AdminOverview
      report={report}
      recommendations={recommendations}
      totalActions={totalActions}
    />
  );
}

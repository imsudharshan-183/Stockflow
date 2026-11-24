import { useQuery } from "@tanstack/react-query";
import { ErrorBlock, LoadingBlock } from "@/components/shared/states";
import { useAuth } from "@/features/auth/AuthContext";
import { AdminOverview } from "@/features/overview/AdminOverview";
import { ManagerOverview } from "@/features/overview/ManagerOverview";
import { StaffProductStats } from "@/features/products/StaffProductStats";
import { queryKeys } from "@/hooks/queryKeys";
import { useLocationScope } from "@/hooks/useLocationScope";
import { api } from "@/lib/api";

export function OverviewPage() {
  const { user } = useAuth();
  const isStaff = user?.role === "staff";
  const isManager = user?.role === "manager";

  // DECISION: Store staff land directly on non-financial store inventory (`ADR-009`)
  if (isStaff) {
    return <StaffProductStats />;
  }

  return <OverviewDashboard isManager={isManager} />;
}

function OverviewDashboard({ isManager }: { isManager: boolean }) {
  const { selectedLocation } = useLocationScope();
  const branchParam = selectedLocation ?? undefined;

  const liveQuery = useQuery({
    queryKey: queryKeys.kpisLive(branchParam),
    queryFn: () => api.kpisLive(branchParam),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    refetchInterval: 60_000,
  });

  if (liveQuery.isPending) return <LoadingBlock />;
  if (liveQuery.isError) {
    return <ErrorBlock message={liveQuery.error.message} onRetry={() => void liveQuery.refetch()} />;
  }

  const live = liveQuery.data;
  const report = live.report;
  const recommendations = live.pendingRecommendations;
  const totalActions = live.metrics.pendingActionsCount.value;
  const onRefresh = () => {
    void liveQuery.refetch();
  };

  if (isManager) {
    return (
      <ManagerOverview
        report={report}
        recommendations={recommendations}
        selectedLocation={selectedLocation}
        totalActions={totalActions}
        live={live}
        isRefreshing={liveQuery.isFetching}
        onRefresh={onRefresh}
        onRetryRecommendations={onRefresh}
      />
    );
  }

  return (
    <AdminOverview
      report={report}
      recommendations={recommendations}
      selectedLocation={selectedLocation}
      totalActions={totalActions}
      live={live}
      isRefreshing={liveQuery.isFetching}
      onRefresh={onRefresh}
      onRetryRecommendations={onRefresh}
    />
  );
}

import { RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatNumber } from "@/lib/format";

interface FreshnessBannerProps {
  staleDataDays: number;
  isRefreshing?: boolean;
  onRefresh?: () => void;
}

/**
 * Shared overview header action cluster displaying a stale-data warning badge (when latest
 * sales data trails Bahrain today by > 1 calendar day) and a manual Refresh button.
 */
export function FreshnessBanner({
  staleDataDays,
  isRefreshing = false,
  onRefresh,
}: FreshnessBannerProps) {
  if (staleDataDays <= 1 && !onRefresh) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {staleDataDays > 1 ? (
        <Link to="/data?tab=import">
          <Badge tone="risk">
            Data is {formatNumber(staleDataDays)}{" "}
            {staleDataDays === 1 ? "day" : "days"} old - import latest sales
          </Badge>
        </Link>
      ) : null}
      {onRefresh ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          loading={isRefreshing}
          onClick={onRefresh}
          className="gap-1.5"
        >
          <RefreshCw className="size-3.5" aria-hidden="true" />
          Refresh
        </Button>
      ) : null}
    </div>
  );
}

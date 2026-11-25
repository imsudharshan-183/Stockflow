import { ChevronDown, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatDate, formatNumber } from "@/lib/format";

interface FreshnessBannerProps {
  staleDataDays: number;
  today?: string;
  reportingBranches?: Array<{ branchId: string; lastSubmitted: string | null }>;
  branches?: ReadonlyArray<{ id: string; name: string }>;
  isRefreshing?: boolean;
  onRefresh?: () => void;
}

/**
 * Shared overview header action cluster displaying a stale-data warning badge (when latest
 * sales data trails Bahrain today by > 1 calendar day) and a manual Refresh button.
 */
export function FreshnessBanner({
  staleDataDays,
  today,
  reportingBranches,
  branches,
  isRefreshing = false,
  onRefresh,
}: FreshnessBannerProps) {
  if (staleDataDays <= 1 && !onRefresh && !reportingBranches?.length) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {reportingBranches && reportingBranches.length > 0 && (
        <Popover>
          <PopoverTrigger render={<Button variant="secondary" size="sm" />}>
            {formatNumber(reportingBranches.filter((branch) => branch.lastSubmitted === today).length)} of {formatNumber(reportingBranches.length)} stores reported today
            <ChevronDown className="size-3.5" aria-hidden="true" />
          </PopoverTrigger>
          <PopoverContent aria-label="Store reporting dates" className="w-80 max-w-[calc(100vw-2rem)]">
            <p className="mb-2 text-sm font-semibold">Last daily entry by store</p>
            <ul tabIndex={0} aria-label="Latest store entries" className="max-h-64 overflow-y-auto divide-y divide-border text-xs">
              {reportingBranches.map(({ branchId, lastSubmitted }) => (
                <li key={branchId} className="flex items-baseline justify-between gap-2 py-2">
                  <span>{branches?.find((branch) => branch.id === branchId)?.name ?? branchId}</span>
                  <span className="shrink-0 font-medium text-muted-foreground">
                    {lastSubmitted === today ? "Today" : lastSubmitted ? formatDate(lastSubmitted) : "No entries yet"}
                  </span>
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      )}
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

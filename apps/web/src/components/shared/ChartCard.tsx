import { Table2, BarChart2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { ChartDetailStrip, useChartDetail } from "@/components/shared/ChartDetailPopup";
import { InfoPopover } from "@/components/shared/InfoPopover";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/shared/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { LabelKey } from "@/lib/labels";
import { cn } from "@/lib/utils";

export interface ChartTableData {
  headers: string[];
  rows: Array<Array<string | number>>;
}

export function ChartCard({
  detailId,
  title,
  subtitle,
  helpKey,
  isLoading = false,
  isError = false,
  errorMessage,
  onRetry,
  isEmpty = false,
  emptyTitle = "No chart data",
  emptyBody = "There is no data matching the current filters.",
  tableData,
  actions,
  heightClass,
  className,
  children,
}: {
  detailId?: string;
  title: string;
  subtitle?: string;
  helpKey?: LabelKey;
  isLoading?: boolean;
  isError?: boolean;
  errorMessage?: string;
  onRetry?: () => void;
  isEmpty?: boolean;
  emptyTitle?: string;
  emptyBody?: string;
  tableData?: ChartTableData;
  actions?: ReactNode;
  heightClass?: string;
  className?: string;
  children: ReactNode;
}) {
  const [showTable, setShowTable] = useState(false);
  const { detail, clearDetail } = useChartDetail();
  const resolvedId = detailId ?? helpKey ?? title;
  const activeDetail = detail && detail.targetCard === resolvedId ? detail : null;

  return (
    <Card
      role="region"
      aria-label={title}
      className={cn("flex flex-col rounded-2xl border border-border shadow-card", className)}
    >
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 pb-3">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-1.5 text-base">
            <span>{title}</span>
            {helpKey ? <InfoPopover labelKey={helpKey} /> : null}
          </CardTitle>
          {subtitle ? <CardDescription className="mt-0.5">{subtitle}</CardDescription> : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {actions}
          {tableData && tableData.rows.length > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setShowTable((prev) => !prev)}
              aria-pressed={showTable}
              aria-label={showTable ? `View ${title} as chart` : `View ${title} as table`}
              className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
            >
              {showTable ? (
                <>
                  <BarChart2 className="size-3.5" aria-hidden="true" />
                  <span>View as chart</span>
                </>
              ) : (
                <>
                  <Table2 className="size-3.5" aria-hidden="true" />
                  <span>View as table</span>
                </>
              )}
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col">
        {isLoading ? (
          <div className={cn("flex items-center justify-center", heightClass)}>
            <LoadingBlock />
          </div>
        ) : isError ? (
          <ErrorBlock message={errorMessage ?? "Could not load chart data"} onRetry={onRetry ?? (() => undefined)} />
        ) : isEmpty ? (
          <div className={cn("flex items-center justify-center", heightClass)}>
            <EmptyBlock title={emptyTitle} body={emptyBody} />
          </div>
        ) : showTable && tableData ? (
          <div className="max-h-72 overflow-auto rounded-lg border border-border">
            <Table className="table-auto">
              <TableHeader>
                <TableRow>
                  {tableData.headers.map((h) => (
                    <TableHead key={h}>{h}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {tableData.rows.map((row, rIdx) => (
                  <TableRow key={rIdx}>
                    {row.map((cell, cIdx) => (
                      <TableCell key={cIdx} className={cIdx > 0 ? "tabular-nums" : "font-medium"}>
                        {cell}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <>
            <div className={heightClass}>{children}</div>
            {activeDetail ? <ChartDetailStrip detail={activeDetail} onClose={clearDetail} /> : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

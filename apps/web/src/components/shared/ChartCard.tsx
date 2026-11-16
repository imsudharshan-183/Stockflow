import { Table2, BarChart2 } from "lucide-react";
import { useState, type ReactNode } from "react";
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
  className,
  children,
}: {
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
  className?: string;
  children: ReactNode;
}) {
  const [showTable, setShowTable] = useState(false);

  return (
    <Card className={cn("rounded-2xl border border-border shadow-card", className)}>
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
      <CardContent>
        {isLoading ? (
          <LoadingBlock />
        ) : isError ? (
          <ErrorBlock message={errorMessage ?? "Could not load chart data"} onRetry={onRetry ?? (() => undefined)} />
        ) : isEmpty ? (
          <EmptyBlock title={emptyTitle} body={emptyBody} />
        ) : showTable && tableData ? (
          <div className="max-h-72 overflow-auto rounded-lg border border-border">
            <Table>
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
          children
        )}
      </CardContent>
    </Card>
  );
}

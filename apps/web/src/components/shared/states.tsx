import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";

export function LoadingBlock() {
  return (
    <div className="space-y-4" aria-busy="true" aria-live="polite" aria-label="Loading content">
      <Skeleton className="h-12 w-64 rounded-xl" />
      <Skeleton className="h-28 w-full rounded-2xl" />
      <Skeleton className="h-72 w-full rounded-2xl" />
    </div>
  );
}

export function TableSkeleton({ rows = 8 }: { rows?: number; columns?: number }) {
  return (
    <div
      className="overflow-hidden rounded-2xl border border-border bg-card shadow-card"
      aria-busy="true"
      aria-live="polite"
      aria-label="Loading table rows"
    >
      <div className="grid grid-cols-6 gap-4 border-b border-border bg-table-header px-4 py-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} className="h-3.5 w-20" />
        ))}
      </div>
      <div className="divide-y divide-border">
        {Array.from({ length: rows }).map((_, rowIndex) => (
          <div key={rowIndex} className="grid h-[60px] grid-cols-6 items-center gap-4 px-4 py-2.5">
            {Array.from({ length: 6 }).map((__, colIndex) => (
              <Skeleton key={colIndex} className="h-4 w-full max-w-[140px]" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function ErrorBlock({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card className="rounded-2xl border-risk-ring bg-card p-6 shadow-card" role="alert">
      <p className="text-sm font-semibold text-foreground">Unable to load data</p>
      <p className="mt-1 text-sm text-muted-foreground">{message}</p>
      <div className="mt-4">
        <Button size="sm" variant="secondary" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </Card>
  );
}

export function EmptyBlock({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <Empty className="rounded-2xl border border-border bg-card py-12 shadow-card">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{body}</EmptyDescription>
      </EmptyHeader>
      {action ? <div className="mt-3">{action}</div> : null}
    </Empty>
  );
}

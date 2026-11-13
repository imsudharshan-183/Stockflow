import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";

export function LoadingBlock() {
  return (
    <div className="space-y-3" aria-busy="true" aria-live="polite" aria-label="Loading content">
      <Skeleton className="h-12 w-full rounded-xl" />
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}

export function TableSkeleton({ rows = 8, columns = 6 }: { rows?: number; columns?: number }) {
  return (
    <div
      className="overflow-hidden rounded-xl border bg-card shadow-card"
      aria-busy="true"
      aria-live="polite"
      aria-label="Loading table rows"
    >
      <div className="grid gap-3 border-b bg-[var(--lavender-50)]/70 px-3 py-2.5" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {Array.from({ length: columns }).map((_, index) => (
          <Skeleton key={index} className="h-3.5 w-20" />
        ))}
      </div>
      <div className="divide-y">
        {Array.from({ length: rows }).map((_, rowIndex) => (
          <div
            key={rowIndex}
            className="grid items-center gap-3 px-3 py-3"
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
          >
            {Array.from({ length: columns }).map((__, colIndex) => (
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
    <Card className="border-destructive/30 bg-card p-5 shadow-card" role="alert">
      <p className="text-sm font-semibold text-foreground">Unable to load data</p>
      <p className="mt-1 text-sm text-muted-foreground">{message}</p>
      <div className="mt-3">
        <Button size="sm" variant="outline" onClick={onRetry}>
          Try again
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
    <Empty className="rounded-xl border bg-card py-10 shadow-card">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{body}</EmptyDescription>
      </EmptyHeader>
      {action ? <div className="mt-2">{action}</div> : null}
    </Empty>
  );
}

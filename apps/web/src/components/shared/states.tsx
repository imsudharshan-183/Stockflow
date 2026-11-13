import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";

export function LoadingBlock() {
  return (
    <div className="space-y-3" aria-busy="true" aria-live="polite">
      <Skeleton className="h-20" />
      <Skeleton className="h-20" />
      <Skeleton className="h-40" />
    </div>
  );
}

export function ErrorBlock({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card className="p-4">
      <p className="font-medium">Something went wrong</p>
      <p className="mt-1 text-sm text-muted-foreground">{message}</p>
      <Button className="mt-3" variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </Card>
  );
}

export function EmptyBlock({ title, body }: { title: string; body: string }) {
  return (
    <Empty className="border bg-card">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{body}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

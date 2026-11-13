import type { ReactNode } from "react";

export function PageHeader({
  title,
  subtitle,
  description,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  const sub = subtitle ?? description;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
        {sub ? (
          <p className="mt-0.5 truncate text-sm text-muted-foreground tabular-nums">{sub}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

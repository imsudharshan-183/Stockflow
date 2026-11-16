import { ArrowRight, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface BreadcrumbSegment {
  label: string;
  to?: string;
}

export function PageHeader({
  title,
  subtitle,
  description,
  breadcrumbs,
  lastUpdated,
  nextStep,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  description?: ReactNode;
  breadcrumbs?: BreadcrumbSegment[];
  lastUpdated?: string;
  nextStep?: { label: string; to: string };
  actions?: ReactNode;
}) {
  const sub = subtitle ?? description;
  return (
    <div className="space-y-2">
      {breadcrumbs && breadcrumbs.length > 0 ? (
        <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          {breadcrumbs.map((crumb, idx) => (
            <span key={`${crumb.label}-${idx}`} className="inline-flex items-center gap-1">
              {idx > 0 ? <ChevronRight className="size-3 text-muted-foreground/70" aria-hidden="true" /> : null}
              {crumb.to ? (
                <Link to={crumb.to} className="hover:text-foreground hover:underline">
                  {crumb.label}
                </Link>
              ) : (
                <span className="font-medium text-foreground">{crumb.label}</span>
              )}
            </span>
          ))}
        </nav>
      ) : null}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-2.5">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
            {lastUpdated ? (
              <span className="text-xs text-muted-foreground tabular-nums">
                Updated {lastUpdated}
              </span>
            ) : null}
          </div>
          {sub ? (
            <p className="mt-0.5 text-sm text-muted-foreground tabular-nums">{sub}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {nextStep ? (
            <Link
              to={nextStep.to}
              className={cn(buttonVariants({ variant: "secondary", size: "sm" }))}
            >
              <span>{nextStep.label}</span>
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </Link>
          ) : null}
          {actions}
        </div>
      </div>
    </div>
  );
}

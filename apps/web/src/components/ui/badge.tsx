import * as React from "react";
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "group/badge inline-flex w-fit shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap shadow-badge transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-primary/40 [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "border-primary-ring bg-primary-soft text-primary-text",
        secondary: "border-neutral-ring bg-neutral-bg text-neutral-text",
        destructive: "border-risk-ring bg-risk-bg text-risk-text",
        outline: "border-border bg-card text-foreground",
        ghost: "border-transparent bg-transparent text-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

const toneClass = {
  /* Actions */
  transfer: "border-indigo-ring bg-indigo-bg text-indigo-text",
  reorder: "border-info-ring bg-info-bg text-info-text",
  markdown: "border-warn-ring bg-warn-bg text-warn-text",

  /* Statuses */
  pending: "border-neutral-ring bg-neutral-bg text-neutral-text",
  approved: "border-gain-ring bg-gain-bg text-gain-text",
  rejected: "border-risk-ring bg-risk-bg text-risk-text",

  /* Roles */
  admin: "border-primary-ring bg-primary-soft text-primary-text",
  manager: "border-indigo-ring bg-indigo-bg text-indigo-text",
  staff: "border-neutral-ring bg-neutral-bg text-neutral-text",

  /* Confidence */
  confHigh: "border-gain-ring bg-gain-bg text-gain-text",
  confMed: "border-warn-ring bg-warn-bg text-warn-text",
  confLow: "border-risk-ring bg-risk-bg text-risk-text",

  /* Position health */
  risk: "border-risk-ring bg-risk-bg text-risk-text",
  over: "border-warn-ring bg-warn-bg text-warn-text",
  ok: "border-gain-ring bg-gain-bg text-gain-text",
  fresh: "border-neutral-ring bg-neutral-bg text-neutral-text",
} as const;

export type BadgeTone = keyof typeof toneClass;

function Badge({
  className,
  variant = "default",
  tone,
  dot = false,
  children,
  render,
  ...props
}: useRender.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & {
    tone?: BadgeTone;
    dot?: boolean;
  }) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(
          badgeVariants({ variant: tone ? "outline" : variant }),
          tone ? toneClass[tone] : "",
          className,
        ),
        children: (
          <>
            {dot ? (
              <span
                className="size-1.5 shrink-0 rounded-full bg-current opacity-80"
                aria-hidden="true"
              />
            ) : null}
            {children}
          </>
        ),
      },
      props,
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  });
}

export { Badge, badgeVariants };

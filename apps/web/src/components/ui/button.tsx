import * as React from "react";
import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center border font-medium whitespace-nowrap transition-all duration-150 ease-out outline-none select-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none disabled:translate-y-0 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "btn-primary-gradient border-transparent bg-primary text-primary-foreground shadow-primary hover:-translate-y-px hover:shadow-primary-hover active:translate-y-0 active:shadow-xs",
        primary:
          "btn-primary-gradient border-transparent bg-primary text-primary-foreground shadow-primary hover:-translate-y-px hover:shadow-primary-hover active:translate-y-0 active:shadow-xs",
        secondary:
          "border-border bg-card text-foreground shadow-xs hover:border-input hover:bg-row-hover active:bg-secondary",
        outline:
          "border-border bg-card text-foreground shadow-xs hover:border-input hover:bg-row-hover active:bg-secondary",
        "soft-success":
          "border-gain-ring bg-gain-bg text-gain-text shadow-xs hover:bg-gain-hover active:translate-y-0",
        "soft-danger":
          "border-risk-ring bg-risk-bg text-risk-text shadow-xs hover:bg-risk-hover active:translate-y-0",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90 active:translate-y-0",
        ghost:
          "border-transparent bg-transparent text-muted-foreground hover:bg-row-hover hover:text-foreground active:bg-secondary",
        link: "border-transparent bg-transparent text-primary underline-offset-4 hover:underline",
      },
      size: {
        xs: "h-7 gap-1 rounded-full px-2.5 text-xs [&_svg:not([class*='size-'])]:size-3.5",
        sm: "h-8 gap-1.5 rounded-full px-3 text-xs [&_svg:not([class*='size-'])]:size-3.5",
        default: "h-9 gap-2 rounded-full px-4 text-sm",
        lg: "h-10 gap-2 rounded-full px-5 text-sm font-semibold",
        icon: "size-8 rounded-lg p-0",
        "icon-xs": "size-7 rounded-lg p-0 [&_svg:not([class*='size-'])]:size-3.5",
        "icon-sm": "size-8 rounded-lg p-0 [&_svg:not([class*='size-'])]:size-4",
        "icon-lg": "size-9 rounded-lg p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export type ButtonProps = ButtonPrimitive.Props &
  VariantProps<typeof buttonVariants> & {
    loading?: boolean;
    tooltip?: string;
    tooltipSide?: "top" | "right" | "bottom" | "left";
  };

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant = "default",
    size = "default",
    loading = false,
    disabled,
    tooltip,
    tooltipSide = "top",
    children,
    onClick,
    ...props
  },
  ref,
) {
  const isDisabled = Boolean(disabled || loading);
  const isIconSize =
    size === "icon" || size === "icon-xs" || size === "icon-sm" || size === "icon-lg";

  const buttonElement = (
    <ButtonPrimitive
      ref={ref}
      data-slot="button"
      data-loading={loading ? "true" : undefined}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      onClick={isDisabled ? undefined : onClick}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    >
      {loading ? (
        isIconSize ? (
          <Spinner className="size-3.5" />
        ) : (
          <>
            <Spinner data-icon="inline-start" className="size-3.5" />
            {children}
          </>
        )
      ) : (
        children
      )}
    </ButtonPrimitive>
  );

  if (tooltip) {
    return (
      <Tooltip>
        <TooltipTrigger render={buttonElement} />
        <TooltipContent side={tooltipSide}>{tooltip}</TooltipContent>
      </Tooltip>
    );
  }

  return buttonElement;
});

export { Button, buttonVariants };

import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        secondary:
          "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
        destructive:
          "bg-destructive/10 text-destructive focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/20",
        outline:
          "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
        ghost:
          "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

const toneClass = {
  transfer: "border-transparent bg-violet-100 text-violet-800",
  reorder: "border-transparent bg-blue-100 text-blue-800",
  markdown: "border-transparent bg-amber-100 text-amber-800",
  risk: "border-transparent bg-red-100 text-red-700",
  over: "border-transparent bg-amber-100 text-amber-800",
  ok: "border-transparent bg-emerald-100 text-emerald-800",
  fresh: "border-transparent bg-slate-100 text-slate-700",
  approved: "border-transparent bg-emerald-100 text-emerald-800",
  rejected: "border-transparent bg-red-100 text-red-700",
  pending: "border-transparent bg-violet-50 text-violet-700",
  high: "border-transparent bg-violet-600 text-white",
  med: "border-transparent bg-violet-100 text-violet-800",
  low: "border-transparent bg-slate-100 text-slate-600",
} as const

type BadgeTone = keyof typeof toneClass

function Badge({
  className,
  variant = "default",
  tone,
  render,
  ...props
}: useRender.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { tone?: BadgeTone }) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant: tone ? "outline" : variant }), tone ? toneClass[tone] : "", className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

export { Badge, badgeVariants }

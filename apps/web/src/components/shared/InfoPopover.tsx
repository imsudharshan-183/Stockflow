import { Info } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { LABELS, type LabelKey } from "@/lib/labels";
import { cn } from "@/lib/utils";

export function InfoPopover({
  labelKey,
  className,
}: {
  labelKey: LabelKey;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);
  const entry = LABELS[labelKey];

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <span ref={containerRef} className={cn("relative inline-flex items-center", className)}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={`About ${entry.label}`}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((prev) => !prev);
        }}
        className="size-5 rounded-full p-0 text-muted-foreground hover:text-foreground"
      >
        <Info className="size-3.5" aria-hidden="true" />
      </Button>
      {open ? (
        <div
          role="dialog"
          aria-label={entry.label}
          className="absolute top-full left-0 z-50 mt-1.5 w-72 rounded-xl border border-border bg-card p-3.5 text-left shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="text-xs font-semibold text-foreground">{entry.label}</div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{entry.longHelp}</p>
          <div className="mt-2 rounded-lg bg-muted/60 px-2.5 py-1.5">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              How it&apos;s calculated
            </div>
            <div className="mt-0.5 text-[11px] text-foreground">{entry.formula}</div>
          </div>
          <div className="mt-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              What to do
            </div>
            <div className="mt-0.5 text-[11px] text-foreground">{entry.whatToDo}</div>
          </div>
        </div>
      ) : null}
    </span>
  );
}

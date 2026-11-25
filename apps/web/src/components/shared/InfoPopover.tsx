import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { LABELS, type LabelKey } from "@/lib/labels";
import { cn } from "@/lib/utils";

export function InfoPopover({
  labelKey,
  className,
}: {
  labelKey: LabelKey;
  className?: string;
}) {
  const entry = LABELS[labelKey];

  return (
    <span className={cn("inline-flex shrink-0 items-center", className)}>
      <Popover>
        <PopoverTrigger
          aria-label={`About ${entry.label}`}
          onClick={(e) => e.stopPropagation()}
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-5 rounded-full p-0 text-muted-foreground hover:text-foreground"
            />
          }
        >
          <Info className="size-3.5" aria-hidden="true" />
        </PopoverTrigger>
        <PopoverContent
          side="bottom"
          align="start"
          sideOffset={6}
          aria-label={entry.label}
          className="w-72 max-w-[calc(100vw-1rem)] whitespace-normal normal-case tracking-normal font-normal"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="text-xs font-semibold text-foreground">{entry.label}</div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{entry.longHelp}</p>
          <div className="mt-2 rounded-lg bg-muted/60 px-2.5 py-1.5 dark:bg-background/60">
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
        </PopoverContent>
      </Popover>
    </span>
  );
}

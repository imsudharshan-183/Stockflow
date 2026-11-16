import { BookOpen, Search } from "lucide-react";
import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { GLOSSARY_LIST } from "@/lib/labels";

export function GlossaryDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return GLOSSARY_LIST;
    return GLOSSARY_LIST.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        item.shortHelp.toLowerCase().includes(q) ||
        item.longHelp.toLowerCase().includes(q),
    );
  }, [search]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookOpen className="size-4 text-primary" aria-hidden="true" />
            StockFlow Glossary
          </DialogTitle>
          <DialogDescription>
            Plain-language definitions, formulas, and recommended buyer actions for every metric.
          </DialogDescription>
        </DialogHeader>
        <div className="relative mt-2">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search metrics and terms..."
            className="pl-9"
            aria-label="Search glossary"
          />
        </div>
        <div className="mt-3 flex-1 space-y-3 overflow-y-auto pr-1">
          {filtered.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No matching terms found.
            </p>
          ) : (
            filtered.map((item) => (
              <div
                key={item.key}
                className="rounded-xl border border-border bg-surface/50 p-3.5"
              >
                <div className="text-sm font-semibold text-foreground">{item.label}</div>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {item.longHelp}
                </p>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <div className="rounded-lg bg-muted/60 px-2.5 py-1.5">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Formula
                    </div>
                    <div className="mt-0.5 text-[11px] text-foreground">{item.formula}</div>
                  </div>
                  <div className="rounded-lg bg-muted/60 px-2.5 py-1.5">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      What to do
                    </div>
                    <div className="mt-0.5 text-[11px] text-foreground">{item.whatToDo}</div>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function ModeToggle() {
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <Button
        variant="ghost"
        size="icon"
        tooltip="Toggle theme"
        tooltipSide="bottom"
        aria-label="Toggle theme"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <Sun className="size-4 scale-100 rotate-0 transition-transform dark:scale-0 dark:-rotate-90" />
        <Moon className="absolute size-4 scale-0 rotate-90 transition-transform dark:scale-100 dark:rotate-0" />
      </Button>

      {open ? (
        <div
          role="menu"
          aria-label="Theme options"
          className="absolute top-full right-0 z-50 mt-2 w-36 rounded-2xl border border-border bg-popover p-1.5 shadow-pop"
        >
          {(
            [
              { value: "light", label: "Light", icon: Sun },
              { value: "dark", label: "Dark", icon: Moon },
              { value: "system", label: "System", icon: Monitor },
            ] as const
          ).map((item) => {
            const Icon = item.icon;
            const active = theme === item.value;
            return (
              <Button
                key={item.value}
                role="menuitem"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setTheme(item.value);
                  setOpen(false);
                }}
                className={cn(
                  "h-8 w-full justify-start gap-2 rounded-xl px-2.5 text-xs",
                  active ? "bg-primary-soft text-primary-text font-semibold" : "text-foreground",
                )}
              >
                <Icon className="size-3.5" aria-hidden="true" />
                {item.label}
              </Button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

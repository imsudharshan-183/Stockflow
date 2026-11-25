import { Monitor, Moon, Sun } from "lucide-react";
import { useState } from "react";
import { useTheme } from "@/components/shared/ThemeProvider";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function ModeToggle() {
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <PopoverTrigger
          aria-label="Toggle theme"
          aria-haspopup="menu"
          render={<TooltipTrigger render={<Button variant="ghost" size="icon" />} />}
        >
          <Sun className="size-4 scale-100 rotate-0 transition-transform dark:scale-0 dark:-rotate-90" />
          <Moon className="absolute size-4 scale-0 rotate-90 transition-transform dark:scale-100 dark:rotate-0" />
        </PopoverTrigger>
        <TooltipContent side="bottom">Toggle theme</TooltipContent>
      </Tooltip>

      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={8}
        role="menu"
        aria-label="Theme options"
        className="w-36 max-w-[calc(100vw-1rem)] rounded-2xl p-1.5"
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
      </PopoverContent>
    </Popover>
  );
}

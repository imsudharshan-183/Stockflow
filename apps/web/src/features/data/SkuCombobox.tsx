import { Check, ChevronDown, Search, X } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatMoneyPrecise } from "@/lib/format";
import { cn } from "@/lib/utils";
import { matchesProductQuery, type Product } from "@stockflow/core";

export interface SkuComboboxProps {
  id?: string;
  products: readonly Product[];
  value: string;
  onChange: (sku: string) => void;
  placeholder?: string;
  disabled?: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
  onSelectAdvance?: () => void;
  ariaLabel?: string;
}

export function SkuCombobox({
  id,
  products,
  value,
  onChange,
  placeholder = "Search SKU, name, category, or price...",
  disabled = false,
  inputRef,
  onSelectAdvance,
  ariaLabel = "Select SKU",
}: SkuComboboxProps) {
  const listboxId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const internalRef = useRef<HTMLInputElement>(null);
  const resolvedRef = inputRef ?? internalRef;

  const selectedProduct = useMemo(
    () => products.find((p) => p.sku === value) ?? null,
    [products, value],
  );

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [panelStyle, setPanelStyle] = useState<CSSProperties | null>(null);

  useEffect(() => {
    function handleOutsideClick(event: MouseEvent) {
      const target = event.target as Node;
      const inContainer = containerRef.current?.contains(target) ?? false;
      const inListbox = listboxRef.current?.contains(target) ?? false;
      if (!inContainer && !inListbox) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return products.slice(0, 30);
    return products
      .filter(
        (p) =>
          matchesProductQuery(p, q) ||
          p.category.toLowerCase().includes(q) ||
          formatMoneyPrecise(p.price).toLowerCase().includes(q) ||
          String(p.price).includes(q),
      )
      .slice(0, 30);
  }, [products, query]);

  useLayoutEffect(() => {
    if (!open) return;

    const GAP = 6;
    const EDGE_PADDING = 8;
    const MAX_HEIGHT = 256;
    const MIN_WIDTH = 260;

    const updatePosition = () => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      if (rect.width > 0 && rect.height > 0 && (rect.bottom < 0 || rect.top > vh)) {
        setOpen(false);
        setQuery("");
        return;
      }

      const spaceBelow = vh - rect.bottom - GAP - EDGE_PADDING;
      const spaceAbove = rect.top - GAP - EDGE_PADDING;
      const openUp = spaceBelow < 180 && spaceAbove > spaceBelow;
      const maxHeight = Math.max(120, Math.min(MAX_HEIGHT, Math.floor(openUp ? spaceAbove : spaceBelow)));
      const width = rect.width > 0 ? Math.min(Math.max(rect.width, MIN_WIDTH), vw - EDGE_PADDING * 2) : 280;
      const left = Math.max(EDGE_PADDING, Math.min(rect.left, vw - width - EDGE_PADDING));

      setPanelStyle({
        top: openUp ? undefined : rect.bottom + GAP,
        bottom: openUp ? vh - rect.top + GAP : undefined,
        left,
        width,
        maxHeight,
      });
    };

    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [open, filtered.length]);

  useEffect(() => {
    setActiveIndex(0);
  }, [filtered.length, open]);

  function commitSelection(product: Product) {
    onChange(product.sku);
    setQuery("");
    setOpen(false);
    onSelectAdvance?.();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setActiveIndex((prev) => (filtered.length > 0 ? Math.min(prev + 1, filtered.length - 1) : 0));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (open) {
        setActiveIndex((prev) => Math.max(prev - 1, 0));
      }
      return;
    }
    if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
        setQuery("");
      }
      return;
    }
    if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
      if (open && filtered[activeIndex]) {
        e.preventDefault();
        commitSelection(filtered[activeIndex]);
      } else if (selectedProduct && onSelectAdvance) {
        e.preventDefault();
        onSelectAdvance();
      }
    }
  }

  const displayValue = open
    ? query
    : selectedProduct
      ? `${selectedProduct.sku} — ${selectedProduct.name}`
      : value || query;

  return (
    <div ref={containerRef} className="relative">
      <div className="relative flex items-center">
        <Search
          className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          ref={resolvedRef}
          id={id}
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          autoComplete="off"
          disabled={disabled}
          value={displayValue}
          placeholder={placeholder}
          onFocus={() => {
            if (!disabled) {
              setQuery("");
              setOpen(true);
            }
          }}
          onClick={() => {
            if (!disabled && !open) {
              setQuery("");
              setOpen(true);
            }
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!open) setOpen(true);
          }}
          onKeyDown={handleKeyDown}
          className="h-9 pr-14 pl-8 text-sm"
        />
        <div className="absolute right-1 flex items-center gap-0.5">
          {value ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Clear SKU selection"
              disabled={disabled}
              onClick={() => {
                onChange("");
                setQuery("");
                setOpen(true);
                resolvedRef.current?.focus();
              }}
              className="text-muted-foreground"
            >
              <X className="size-3.5" aria-hidden="true" />
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Toggle SKU list"
            disabled={disabled}
            onClick={() => {
              setOpen((prev) => !prev);
              if (!open) {
                resolvedRef.current?.focus();
              }
            }}
            className="text-muted-foreground"
          >
            <ChevronDown className="size-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>

      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={listboxRef}
              id={listboxId}
              role="listbox"
              aria-label="Matching products"
              style={panelStyle ?? undefined}
              className="fixed z-[60] overflow-y-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-pop dark:border-input"
            >
              {filtered.length === 0 ? (
                <div className="px-3 py-2.5 text-xs text-muted-foreground">
                  No matching SKUs found.
                </div>
              ) : (
                filtered.map((product, index) => {
                  const isSelected = product.sku === value;
                  const isHighlighted = index === activeIndex;
                  return (
                    <Button
                      key={product.sku}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      variant="ghost"
                      size="sm"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        commitSelection(product);
                      }}
                      className={cn(
                        "h-auto w-full justify-between rounded-lg px-2.5 py-2 text-left font-normal",
                        isHighlighted && "bg-secondary/80",
                        isSelected && "border border-primary/30 bg-primary/5",
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs font-semibold text-foreground">
                            {product.sku}
                          </span>
                          <span className="truncate text-xs font-medium text-foreground">
                            {product.name}
                          </span>
                        </div>
                        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                          <span>{product.category}</span>
                          <span>·</span>
                          <span className="tabular-nums">{formatMoneyPrecise(product.price)}</span>
                        </div>
                      </div>
                      {isSelected ? (
                        <Check className="ml-2 size-3.5 shrink-0 text-primary" aria-hidden="true" />
                      ) : null}
                    </Button>
                  );
                })
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

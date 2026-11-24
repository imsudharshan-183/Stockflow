import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Pencil,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/shared/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCard,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableToolbar,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useOptionalAuth } from "@/features/auth/AuthContext";
import { DailyEntryContextPanel } from "@/features/data/DailyEntryContextPanel";
import { DailySheetEditor } from "@/features/data/DailySheetEditor";
import { SkuCombobox } from "@/features/data/SkuCombobox";
import { invalidateOperationalQueries, queryKeys } from "@/hooks/queryKeys";
import { useLocationScope } from "@/hooks/useLocationScope";
import { api } from "@/lib/api";
import { parseNonNegativeInt } from "@/lib/dailySheetCsv";
import {
  formatBahrainDateTime,
  formatDate,
  formatNumber,
  getBahrainTodayIso,
} from "@/lib/format";

const LAST_BRANCH_STORAGE_KEY = "stockflow_last_entry_branch";

function readStoredBranch(): string {
  try {
    return window.localStorage.getItem(LAST_BRANCH_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeStoredBranch(branchId: string): void {
  try {
    if (branchId) {
      window.localStorage.setItem(LAST_BRANCH_STORAGE_KEY, branchId);
    }
  } catch {
    // Ignore storage quota / privacy mode errors
  }
}

interface SalesEntryRow {
  id: string;
  branchId: string;
  sku: string;
  date: string;
  unitsSold: number;
  onHand: number;
  updatedAt: string;
}

function extractCsvPreviewMeta(csvText: string): {
  headerLine: string;
  dataLines: string[];
  minDate: string | null;
  maxDate: string | null;
} {
  const cleaned = csvText.replace(/^\uFEFF/, "");
  const nonEmptyLines = cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (nonEmptyLines.length === 0) {
    return { headerLine: "", dataLines: [], minDate: null, maxDate: null };
  }
  const headerLine = nonEmptyLines[0] ?? "";
  const dataLines = nonEmptyLines.slice(1);
  const headers = headerLine.split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  const dateColIdx = headers.indexOf("date");
  let minDate: string | null = null;
  let maxDate: string | null = null;
  const isoRe = /^\d{4}-\d{2}-\d{2}$/;

  for (const line of dataLines) {
    const cells = line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    const candidate =
      dateColIdx >= 0 ? (cells[dateColIdx] ?? "") : (cells.find((c) => isoRe.test(c)) ?? "");
    if (!isoRe.test(candidate)) continue;
    if (!minDate || candidate < minDate) minDate = candidate;
    if (!maxDate || candidate > maxDate) maxDate = candidate;
  }

  return { headerLine, dataLines, minDate, maxDate };
}

export function DataEntryPage() {
  const queryClient = useQueryClient();
  const auth = useOptionalAuth();
  const { selectedLocation } = useLocationScope();
  const [searchParams, setSearchParams] = useSearchParams();

  const tab = (searchParams.get("tab") as "add" | "recent" | "import" | null) ?? "add";
  const setTab = (nextTab: string) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("tab", nextTab);
        return next;
      },
      { replace: true },
    );
  };

  const locationsQuery = useQuery({
    queryKey: queryKeys.locations,
    queryFn: () => api.locations(),
  });

  const allLocations = useMemo(() => locationsQuery.data?.locations ?? [], [locationsQuery.data]);
  const scopedLocations = useMemo(() => {
    const active = allLocations.filter((l) => l.branch.status !== "archived");
    if (auth?.user && auth.user.role !== "admin") {
      const allowed = new Set(auth.user.branchIds);
      return active.filter((l) => allowed.has(l.branch.id));
    }
    return active;
  }, [allLocations, auth?.user]);
  const locations = scopedLocations;

  const todayIso = getBahrainTodayIso();

  // Add entry form state
  const [entryMode, setEntryMode] = useState<"single" | "sheet">("single");
  const [branchId, setBranchId] = useState(() => selectedLocation || readStoredBranch());
  const [selectedSku, setSelectedSku] = useState("");
  const [date, setDate] = useState(todayIso);
  const [unitsSold, setUnitsSold] = useState("0");
  const [onHand, setOnHand] = useState("0");
  const [warningsConfirmed, setWarningsConfirmed] = useState(false);

  const skuInputRef = useRef<HTMLInputElement>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);
  const unitsSoldInputRef = useRef<HTMLInputElement>(null);
  const onHandInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (scopedLocations.length === 0) return;
    const isValid = scopedLocations.some((l) => l.branch.id === branchId);
    if (isValid) return;

    const fromScope =
      selectedLocation && scopedLocations.some((l) => l.branch.id === selectedLocation)
        ? selectedLocation
        : "";
    const fromStorage = readStoredBranch();
    const validStorage =
      fromStorage && scopedLocations.some((l) => l.branch.id === fromStorage) ? fromStorage : "";
    const nextBranch = fromScope || validStorage || scopedLocations[0]!.branch.id;
    setBranchId(nextBranch);
    writeStoredBranch(nextBranch);
  }, [branchId, selectedLocation, scopedLocations]);

  function handleSelectBranch(nextBranch: string) {
    setBranchId(nextBranch);
    writeStoredBranch(nextBranch);
    setWarningsConfirmed(false);
  }

  const branchNameById = useMemo(
    () => new Map(allLocations.map((l) => [l.branch.id, l.branch.name])),
    [allLocations],
  );

  const skuListQuery = useQuery({
    queryKey: queryKeys.catalogProducts({ limit: 200, page: 1 }),
    queryFn: () =>
      api.listCatalogProducts({
        limit: 200,
        page: 1,
      }),
  });

  const activeProducts = useMemo(
    () => (skuListQuery.data?.products ?? []).filter((p) => p.status !== "archived"),
    [skuListQuery.data],
  );

  const selectedProduct = useMemo(
    () => activeProducts.find((p) => p.sku === selectedSku),
    [activeProducts, selectedSku],
  );

  const hasSingleKey = tab === "add" && entryMode === "single" && Boolean(branchId && selectedSku && date);
  const existingEntryQuery = useQuery({
    queryKey: queryKeys.salesEntries({
      lookup: "single",
      branch: branchId,
      sku: selectedSku,
      from: date,
      to: date,
    }),
    queryFn: () =>
      api.listSalesEntries({
        branch: branchId,
        sku: selectedSku,
        from: date,
        to: date,
        page: 1,
        limit: 1,
      }),
    enabled: hasSingleKey,
  });

  const existingEntry = existingEntryQuery.data?.entries[0] ?? null;

  const contextHistoryQuery = useQuery({
    queryKey: queryKeys.salesEntries({
      context: "panel",
      branch: branchId,
      sku: selectedSku,
      limit: 7,
    }),
    queryFn: () =>
      api.listSalesEntries({
        branch: branchId,
        sku: selectedSku,
        page: 1,
        limit: 7,
      }),
    enabled: tab === "add" && entryMode === "single" && Boolean(branchId && selectedSku),
  });

  const parsedUnitsSold = parseNonNegativeInt(unitsSold);
  const parsedOnHand = parseNonNegativeInt(onHand);
  const isDateFuture = Boolean(date && date > todayIso);

  const anomalyWarnings = useMemo(() => {
    if (!hasSingleKey || parsedUnitsSold === null || parsedOnHand === null) return [];
    const warnings: string[] = [];
    const history = [...(contextHistoryQuery.data?.entries ?? [])].sort((a, b) =>
      b.date.localeCompare(a.date),
    );
    if (history.length > 0) {
      const avgSold = history.reduce((sum, e) => sum + e.unitsSold, 0) / history.length;
      if (avgSold > 0 && parsedUnitsSold >= Math.max(10, Math.ceil(avgSold * 3))) {
        warnings.push(
          `Units sold (${formatNumber(parsedUnitsSold)}) is well above the recent ${formatNumber(history.length)}-day average (${formatNumber(Math.round(avgSold))}/day).`,
        );
      }
      const prevEntry = history.find((e) => e.date !== date) ?? history[0];
      if (
        prevEntry &&
        Math.abs(parsedOnHand - prevEntry.onHand) >=
          Math.max(25, Math.ceil(prevEntry.onHand * 1.5))
      ) {
        warnings.push(
          `End-of-day stock jumped from ${formatNumber(prevEntry.onHand)} to ${formatNumber(parsedOnHand)} units compared to ${formatDate(prevEntry.date)}.`,
        );
      }
    }
    return warnings;
  }, [hasSingleKey, parsedUnitsSold, parsedOnHand, contextHistoryQuery.data, date]);

  // Recent entries state
  const filterBranch = searchParams.get("branch") ?? selectedLocation ?? "";
  const filterSku = searchParams.get("sku") ?? "";
  const filterFrom = searchParams.get("from") ?? "";
  const filterTo = searchParams.get("to") ?? "";
  const page = Math.max(1, Number(searchParams.get("page") ?? "1") || 1);

  const entriesQuery = useQuery({
    queryKey: queryKeys.salesEntries({
      branch: filterBranch || undefined,
      sku: filterSku || undefined,
      from: filterFrom || undefined,
      to: filterTo || undefined,
      page,
      limit: 20,
    }),
    queryFn: () =>
      api.listSalesEntries({
        branch: filterBranch || undefined,
        sku: filterSku || undefined,
        from: filterFrom || undefined,
        to: filterTo || undefined,
        page,
        limit: 20,
      }),
  });

  const addRecentEntriesQuery = useQuery({
    queryKey: queryKeys.salesEntries({
      addRecent: true,
      branch: branchId || undefined,
      limit: 10,
    }),
    queryFn: () =>
      api.listSalesEntries({
        branch: branchId || undefined,
        page: 1,
        limit: 10,
      }),
    enabled: tab === "add",
  });

  // Edit Sheet & Delete Dialog state
  const [editingEntry, setEditingEntry] = useState<SalesEntryRow | null>(null);
  const [editUnitsSold, setEditUnitsSold] = useState("");
  const [editOnHand, setEditOnHand] = useState("");
  const [deletingEntry, setDeletingEntry] = useState<SalesEntryRow | null>(null);

  // Import CSV state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [importResult, setImportResult] = useState<{
    inserted: number;
    updated: number;
    errors: Array<{ row: number; message: string }>;
    fileName: string;
    importedAt: string;
    minDate: string | null;
    maxDate: string | null;
    headerLine: string;
    dataLines: string[];
  } | null>(null);

  const importsQuery = useQuery({
    queryKey: queryKeys.salesImports,
    queryFn: () => api.listSalesImports(10),
  });

  const invalidateAll = () => {
    void invalidateOperationalQueries(queryClient);
  };

  const [saveMode, setSaveMode] = useState<"default" | "another">("default");
  const [saveError, setSaveError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: (mode: "default" | "another") => {
      setSaveMode(mode);
      setSaveError(null);
      return api.createSalesEntry({
        branchId,
        sku: selectedSku,
        date,
        unitsSold: parsedUnitsSold ?? 0,
        onHand: parsedOnHand ?? 0,
      });
    },
    onSuccess: (_data, mode) => {
      invalidateAll();
      toast.success(existingEntry ? "Daily entry updated" : "Daily entry saved", {
        action: {
          label: "View in Recent entries",
          onClick: () => setTab("recent"),
        },
      });
      setUnitsSold("0");
      setOnHand("0");
      setWarningsConfirmed(false);
      if (mode === "another") {
        setSelectedSku("");
        window.requestAnimationFrame(() => {
          skuInputRef.current?.focus();
        });
      }
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : "Could not save entry";
      setSaveError(msg);
      toast.error(msg);
    },
  });

  const canSaveSingle =
    Boolean(branchId && selectedSku && date) &&
    !isDateFuture &&
    parsedUnitsSold !== null &&
    parsedOnHand !== null &&
    (anomalyWarnings.length === 0 || warningsConfirmed) &&
    !createMutation.isPending;

  function triggerSave(mode: "default" | "another") {
    if (!canSaveSingle) return;
    createMutation.mutate(mode);
  }

  function handleFieldKeyDown(
    e: KeyboardEvent<HTMLInputElement | HTMLSelectElement>,
    nextRef?: React.RefObject<HTMLInputElement | null>,
  ) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      triggerSave("default");
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (nextRef?.current) {
        nextRef.current.focus();
      } else {
        triggerSave("default");
      }
    }
  }

  const updateMutation = useMutation({
    mutationFn: (input: { id: string; unitsSold: number; onHand: number }) =>
      api.updateSalesEntry(input.id, { unitsSold: input.unitsSold, onHand: input.onHand }),
    onSuccess: () => {
      invalidateAll();
      setEditingEntry(null);
      toast.success("Entry updated");
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Could not update entry");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteSalesEntry(id),
    onSuccess: () => {
      invalidateAll();
      setDeletingEntry(null);
      toast.success("Entry deleted");
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Could not delete entry");
    },
  });

  const importMutation = useMutation({
    mutationFn: async (file: File) => {
      const text = typeof file.text === "function" ? await file.text().catch(() => "") : "";
      const meta = extractCsvPreviewMeta(text);
      const res = await api.importSalesCsv(file);
      return { res, file, meta };
    },
    onSuccess: ({ res, file, meta }) => {
      invalidateAll();
      setImportResult({
        ...res,
        fileName: file.name,
        importedAt: new Date().toISOString(),
        minDate: meta.minDate,
        maxDate: meta.maxDate,
        headerLine: meta.headerLine,
        dataLines: meta.dataLines,
      });
      if (res.errors.length === 0) {
        setCsvFile(null);
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
        toast.success(
          `Import complete: ${formatNumber(res.inserted)} inserted, ${formatNumber(res.updated)} updated, 0 errors`,
        );
      } else {
        toast.error(
          `Import finished with ${formatNumber(res.errors.length)} error(s); review offending rows below`,
        );
      }
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "CSV import failed");
    },
  });

  const updateFilterParam = (updates: Record<string, string | undefined>) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(updates)) {
          if (!v) next.delete(k);
          else next.set(k, v);
        }
        return next;
      },
      { replace: true },
    );
  };

  const downloadTemplate = () => {
    const csv = `branchId,sku,date,unitsSold,onHand\n${branchId || "BR-001"},SKU-00001,${todayIso},5,20\n`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "sales-entries-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadErrorsCsv = () => {
    if (!importResult || importResult.errors.length === 0) return;
    const hasSourceLines =
      importResult.headerLine.length > 0 && importResult.dataLines.length > 0;
    const header = hasSourceLines ? `${importResult.headerLine},error` : "row,message";
    const rows = importResult.errors.map((e) => {
      const escapedMsg = `"${e.message.replace(/"/g, '""')}"`;
      if (hasSourceLines) {
        const original = importResult.dataLines[e.row - 1];
        if (original !== undefined) {
          return `${original},${escapedMsg}`;
        }
      }
      return `${e.row},${escapedMsg}`;
    });
    const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "sales-import-errors.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Daily entries"
        subtitle="Record end-of-day sales and on-hand stock counts or import a CSV batch."
        breadcrumbs={[{ label: "Inventory", to: "/products" }, { label: "Daily entries" }]}
        nextStep={{ label: "Open action queue", to: "/queue" }}
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-auto w-full flex-wrap justify-start gap-1 rounded-xl border border-border bg-secondary/70 p-1 sm:w-fit">
          <TabsTrigger
            value="add"
            className="px-3.5 py-1.5 data-active:border-border data-active:bg-card data-active:font-semibold data-active:text-primary data-active:shadow-sm"
          >
            Add entry
          </TabsTrigger>
          <TabsTrigger
            value="recent"
            className="px-3.5 py-1.5 data-active:border-border data-active:bg-card data-active:font-semibold data-active:text-primary data-active:shadow-sm"
          >
            Recent entries
          </TabsTrigger>
          <TabsTrigger
            value="import"
            className="px-3.5 py-1.5 data-active:border-border data-active:bg-card data-active:font-semibold data-active:text-primary data-active:shadow-sm"
          >
            Import CSV
          </TabsTrigger>
        </TabsList>

        {/* Tab 1: Add entry */}
        <TabsContent value="add" className="mt-4 space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex rounded-xl border border-border bg-secondary/50 p-1" role="group" aria-label="Entry mode">
              <Button
                type="button"
                size="sm"
                variant={entryMode === "single" ? "primary" : "ghost"}
                aria-pressed={entryMode === "single"}
                onClick={() => setEntryMode("single")}
              >
                Single entry
              </Button>
              <Button
                type="button"
                size="sm"
                variant={entryMode === "sheet" ? "primary" : "ghost"}
                aria-pressed={entryMode === "sheet"}
                onClick={() => setEntryMode("sheet")}
              >
                Daily sheet
              </Button>
            </div>
            <span className="text-xs text-muted-foreground">
              Press Enter to move to the next field · Ctrl+Enter to save
            </span>
          </div>

          {entryMode === "sheet" ? (
            <div className="space-y-4">
              <Card className="rounded-2xl border border-border shadow-card">
                <CardContent className="grid gap-4 pt-5 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <label htmlFor="sheet-branch" className="text-xs font-medium text-foreground">
                      Location
                    </label>
                    <select
                      id="sheet-branch"
                      aria-label="Location"
                      value={branchId}
                      onChange={(e) => handleSelectBranch(e.target.value)}
                      className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground"
                    >
                      {locations.map((loc) => (
                        <option key={loc.branch.id} value={loc.branch.id}>
                          {loc.branch.name} ({loc.branch.id})
                        </option>
                      ))}
                    </select>
                    <p className="text-[11px] text-muted-foreground">
                      Branch for all rows in this daily sheet.
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="sheet-date" className="text-xs font-medium text-foreground">
                      Date
                    </label>
                    <Input
                      id="sheet-date"
                      type="date"
                      max={todayIso}
                      value={date}
                      onChange={(e) => setDate(e.target.value)}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Business date in Asia/Bahrain (max {todayIso}).
                    </p>
                  </div>
                </CardContent>
              </Card>

              <DailySheetEditor
                branchId={branchId}
                branchName={branchNameById.get(branchId)}
                date={date}
                products={activeProducts}
                onImported={({ branchId: impBranch, date: impDate }) => {
                  updateFilterParam({ branch: impBranch, from: impDate, to: impDate, page: "1" });
                }}
              />
            </div>
          ) : (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.9fr)] lg:items-start">
              <Card className="rounded-2xl border border-border shadow-card">
                <CardHeader className="pb-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <CardTitle className="text-base">Record daily sales &amp; stock</CardTitle>
                      <CardDescription>
                        Upserts on location, SKU, and date and refreshes that SKU&apos;s recommendations.
                      </CardDescription>
                    </div>
                  </div>
                  {branchId && selectedSku && date ? (
                    <div
                      role="status"
                      className={
                        existingEntry
                          ? "mt-2 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-over-text/30 bg-over-bg px-3 py-2 text-xs text-over-text"
                          : "mt-2 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-ok-text/30 bg-ok-bg px-3 py-2 text-xs text-ok-text"
                      }
                    >
                      <span className="font-medium">
                        {existingEntry
                          ? `Updating existing entry (${formatDate(date)}) — currently ${formatNumber(existingEntry.unitsSold)} sold, ${formatNumber(existingEntry.onHand)} on hand`
                          : "New entry"}
                      </span>
                      {existingEntry ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={() => {
                            setUnitsSold(String(existingEntry.unitsSold));
                            setOnHand(String(existingEntry.onHand));
                            setWarningsConfirmed(false);
                          }}
                        >
                          Load saved values
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </CardHeader>

                <CardContent className="space-y-4">
                  <div className="space-y-1.5">
                    <label htmlFor="entry-branch" className="text-xs font-medium text-foreground">
                      Location
                    </label>
                    <select
                      id="entry-branch"
                      value={branchId}
                      onChange={(e) => handleSelectBranch(e.target.value)}
                      onKeyDown={(e) => handleFieldKeyDown(e, skuInputRef)}
                      className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground"
                    >
                      {locations.map((loc) => (
                        <option key={loc.branch.id} value={loc.branch.id}>
                          {loc.branch.name} ({loc.branch.id})
                        </option>
                      ))}
                    </select>
                    <p className="text-[11px] text-muted-foreground">
                      {auth?.user && auth.user.role !== "admin"
                        ? "Scoped to your assigned store locations."
                        : "Select the branch whose closing count you are recording."}
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="entry-sku" className="text-xs font-medium text-foreground">
                      Product SKU
                    </label>
                    <SkuCombobox
                      id="entry-sku"
                      inputRef={skuInputRef}
                      products={activeProducts}
                      value={selectedSku}
                      onChange={(nextSku) => {
                        setSelectedSku(nextSku);
                        setWarningsConfirmed(false);
                        setSaveError(null);
                      }}
                      onSelectAdvance={() => {
                        window.requestAnimationFrame(() => dateInputRef.current?.focus());
                      }}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Search by SKU code, product name, category, or unit price in BHD.
                    </p>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-3">
                    <div className="space-y-1.5">
                      <label htmlFor="entry-date" className="text-xs font-medium text-foreground">
                        Date
                      </label>
                      <Input
                        ref={dateInputRef}
                        id="entry-date"
                        type="date"
                        max={todayIso}
                        value={date}
                        onChange={(e) => {
                          setDate(e.target.value);
                          setWarningsConfirmed(false);
                        }}
                        onKeyDown={(e) => handleFieldKeyDown(e, unitsSoldInputRef)}
                      />
                      <p className="text-[11px] text-muted-foreground">
                        Bahrain business date (up to {todayIso}).
                      </p>
                      {isDateFuture ? (
                        <p role="alert" className="text-xs font-medium text-risk-text">
                          Date cannot be after today in Bahrain ({todayIso}).
                        </p>
                      ) : null}
                    </div>

                    <div className="space-y-1.5">
                      <label htmlFor="entry-sold" className="text-xs font-medium text-foreground">
                        Units sold
                      </label>
                      <Input
                        ref={unitsSoldInputRef}
                        id="entry-sold"
                        type="number"
                        min={0}
                        step={1}
                        value={unitsSold}
                        onChange={(e) => {
                          setUnitsSold(e.target.value);
                          setWarningsConfirmed(false);
                        }}
                        onKeyDown={(e) => handleFieldKeyDown(e, onHandInputRef)}
                        className="tabular-nums"
                      />
                      <p className="text-[11px] text-muted-foreground">
                        Whole units sold today (0 or more).
                      </p>
                      {parsedUnitsSold === null ? (
                        <p role="alert" className="text-xs font-medium text-risk-text">
                          Enter a whole number ≥ 0.
                        </p>
                      ) : null}
                    </div>

                    <div className="space-y-1.5">
                      <label htmlFor="entry-onhand" className="text-xs font-medium text-foreground">
                        End-of-day stock (on hand)
                      </label>
                      <Input
                        ref={onHandInputRef}
                        id="entry-onhand"
                        type="number"
                        min={0}
                        step={1}
                        value={onHand}
                        onChange={(e) => {
                          setOnHand(e.target.value);
                          setWarningsConfirmed(false);
                        }}
                        onKeyDown={(e) => handleFieldKeyDown(e)}
                        className="tabular-nums"
                      />
                      <p className="text-[11px] text-muted-foreground">
                        Closing physical count at end of day (0 or more).
                      </p>
                      {parsedOnHand === null ? (
                        <p role="alert" className="text-xs font-medium text-risk-text">
                          Enter a whole number ≥ 0.
                        </p>
                      ) : null}
                    </div>
                  </div>

                  {anomalyWarnings.length > 0 ? (
                    <div
                      role="status"
                      className="space-y-2 rounded-xl border border-over-text/30 bg-over-bg p-3 text-xs text-over-text"
                    >
                      <div className="flex items-start gap-2 font-medium">
                        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                        <div className="space-y-1">
                          <p>Review unusual figures before saving</p>
                          <ul className="list-disc space-y-0.5 pl-4 font-normal">
                            {anomalyWarnings.map((warning) => (
                              <li key={warning}>{warning}</li>
                            ))}
                          </ul>
                        </div>
                      </div>
                      <label className="flex items-center gap-2 pt-1 font-medium text-foreground">
                        <input
                          type="checkbox"
                          checked={warningsConfirmed}
                          onChange={(e) => setWarningsConfirmed(e.target.checked)}
                        />
                        <span>Confirm these figures are accurate</span>
                      </label>
                    </div>
                  ) : null}

                  {saveError ? (
                    <p role="alert" className="text-xs font-medium text-risk-text">
                      {saveError}
                    </p>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-2 pt-2">
                    <Button
                      type="button"
                      variant="primary"
                      loading={createMutation.isPending && saveMode === "default"}
                      disabled={!canSaveSingle}
                      onClick={() => triggerSave("default")}
                      className="gap-1.5"
                    >
                      <Plus className="size-4" aria-hidden="true" />
                      Save daily entry
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      loading={createMutation.isPending && saveMode === "another"}
                      disabled={!canSaveSingle}
                      onClick={() => triggerSave("another")}
                    >
                      Save &amp; add another
                    </Button>
                  </div>
                </CardContent>
              </Card>

              <DailyEntryContextPanel
                branchId={branchId}
                branchName={branchNameById.get(branchId)}
                sku={selectedSku}
                product={selectedProduct}
              />
            </div>
          )}

          {/* Last 10 Recent entries right on the Add entry tab */}
          <TableCard>
            <TableToolbar className="flex-wrap justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-foreground">
                  Recent entries (last 10)
                </h2>
                <p className="text-xs text-muted-foreground">
                  Latest recorded sales and end-of-day counts
                  {branchId ? ` for ${branchNameById.get(branchId) ?? branchId}` : ""}.
                </p>
              </div>
              <Button type="button" variant="ghost" size="xs" onClick={() => setTab("recent")}>
                View all recent entries
              </Button>
            </TableToolbar>

            {addRecentEntriesQuery.isPending ? (
              <div className="p-4">
                <LoadingBlock />
              </div>
            ) : !addRecentEntriesQuery.data || addRecentEntriesQuery.data.entries.length === 0 ? (
              <div className="p-4">
                <EmptyBlock
                  title="No recent entries yet"
                  body="Save an entry above or import a CSV batch to populate recent history."
                />
              </div>
            ) : (
              <Table className="min-w-[640px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Location</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead className="text-right">Units sold</TableHead>
                    <TableHead className="text-right">End-of-day stock (on hand)</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {addRecentEntriesQuery.data.entries.slice(0, 10).map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="tabular-nums">{formatDate(entry.date)}</TableCell>
                      <TableCell className="font-mono text-xs">{entry.branchId}</TableCell>
                      <TableCell className="font-mono text-xs font-medium">{entry.sku}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(entry.unitsSold)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(entry.onHand)}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="inline-flex items-center gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`Edit entry ${entry.sku} on ${entry.date}`}
                            onClick={() => {
                              setEditingEntry(entry);
                              setEditUnitsSold(String(entry.unitsSold));
                              setEditOnHand(String(entry.onHand));
                            }}
                          >
                            <Pencil className="size-3.5" aria-hidden="true" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`Delete entry ${entry.sku} on ${entry.date}`}
                            onClick={() => setDeletingEntry(entry)}
                            className="text-risk-text hover:bg-risk-bg"
                          >
                            <Trash2 className="size-3.5" aria-hidden="true" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TableCard>
        </TabsContent>

        {/* Tab 2: Recent entries */}
        <TabsContent value="recent" className="mt-4">
          <TableCard>
            <TableToolbar className="flex-wrap gap-2">
              <select
                value={filterBranch}
                onChange={(e) => updateFilterParam({ branch: e.target.value || undefined, page: "1" })}
                aria-label="Filter by location"
                className="h-8 rounded-lg border border-border bg-background px-2.5 text-xs text-foreground"
              >
                <option value="">All scoped locations</option>
                {locations.map((loc) => (
                  <option key={loc.branch.id} value={loc.branch.id}>
                    {loc.branch.name} ({loc.branch.id})
                  </option>
                ))}
              </select>
              <Input
                value={filterSku}
                onChange={(e) => updateFilterParam({ sku: e.target.value || undefined, page: "1" })}
                placeholder="Filter SKU (e.g. SKU-00001)"
                className="h-8 w-44 text-xs"
                aria-label="Filter by SKU"
              />
              <Input
                type="date"
                value={filterFrom}
                onChange={(e) => updateFilterParam({ from: e.target.value || undefined, page: "1" })}
                className="h-8 w-36 text-xs"
                aria-label="From date"
              />
              <Input
                type="date"
                value={filterTo}
                onChange={(e) => updateFilterParam({ to: e.target.value || undefined, page: "1" })}
                className="h-8 w-36 text-xs"
                aria-label="To date"
              />
            </TableToolbar>

            {entriesQuery.isPending ? (
              <div className="p-6">
                <LoadingBlock />
              </div>
            ) : entriesQuery.isError ? (
              <div className="p-6">
                <ErrorBlock
                  message={entriesQuery.error.message}
                  onRetry={() => void entriesQuery.refetch()}
                />
              </div>
            ) : entriesQuery.data.entries.length === 0 ? (
              <div className="p-6">
                <EmptyBlock
                  title="No recorded entries yet"
                  body="Use the Add entry or Import CSV tab to record daily sales and stock counts."
                />
              </div>
            ) : (
              <>
                <Table className="min-w-[680px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Location</TableHead>
                      <TableHead>SKU</TableHead>
                      <TableHead className="text-right">Units sold</TableHead>
                      <TableHead className="text-right">End-of-day stock (on hand)</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {entriesQuery.data.entries.map((entry) => (
                      <TableRow key={entry.id}>
                        <TableCell className="tabular-nums">{formatDate(entry.date)}</TableCell>
                        <TableCell className="font-mono text-xs">{entry.branchId}</TableCell>
                        <TableCell className="font-mono text-xs font-medium">{entry.sku}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatNumber(entry.unitsSold)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatNumber(entry.onHand)}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="inline-flex items-center gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              aria-label={`Edit entry ${entry.sku} on ${entry.date}`}
                              onClick={() => {
                                setEditingEntry(entry);
                                setEditUnitsSold(String(entry.unitsSold));
                                setEditOnHand(String(entry.onHand));
                              }}
                            >
                              <Pencil className="size-3.5" aria-hidden="true" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              aria-label={`Delete entry ${entry.sku} on ${entry.date}`}
                              onClick={() => setDeletingEntry(entry)}
                              className="text-risk-text hover:bg-risk-bg"
                            >
                              <Trash2 className="size-3.5" aria-hidden="true" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>

                <div className="flex items-center justify-between border-t border-border px-4 py-3 text-xs text-muted-foreground">
                  <span>
                    Page {formatNumber(entriesQuery.data.page)} of{" "}
                    {formatNumber(entriesQuery.data.totalPages)} ({formatNumber(entriesQuery.data.total)}{" "}
                    entries)
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={entriesQuery.data.page <= 1}
                      onClick={() =>
                        updateFilterParam({ page: String(entriesQuery.data.page - 1) })
                      }
                    >
                      Previous
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={entriesQuery.data.page >= entriesQuery.data.totalPages}
                      onClick={() =>
                        updateFilterParam({ page: String(entriesQuery.data.page + 1) })
                      }
                    >
                      Next
                    </Button>
                  </div>
                </div>
              </>
            )}
          </TableCard>
        </TabsContent>

        {/* Tab 3: Import CSV */}
        <TabsContent value="import" className="mt-4">
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:items-start">
            <Card className="rounded-2xl border border-border shadow-card">
              <CardHeader>
                <CardTitle className="text-base">Import daily entries CSV</CardTitle>
                <CardDescription>
                  Upload a CSV (max 5MB) with header: branchId,sku,date,unitsSold,onHand.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={downloadTemplate}
                    className="gap-1.5"
                  >
                    <Download className="size-3.5" aria-hidden="true" />
                    Download template.csv
                  </Button>
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="csv-upload" className="text-xs font-medium text-foreground">
                    CSV file
                  </label>
                  <Input
                    ref={fileInputRef}
                    id="csv-upload"
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(e) => {
                      const f = e.target.files?.[0] ?? null;
                      setCsvFile(f);
                      setImportResult(null);
                    }}
                  />
                  {csvFile ? (
                    <p className="text-xs text-muted-foreground">
                      Selected: <span className="font-mono text-foreground">{csvFile.name}</span>
                    </p>
                  ) : null}
                </div>

                <Button
                  type="button"
                  variant="primary"
                  disabled={!csvFile}
                  loading={importMutation.isPending}
                  onClick={() => {
                    if (csvFile) importMutation.mutate(csvFile);
                  }}
                  className="gap-1.5"
                >
                  <Upload className="size-4" aria-hidden="true" />
                  Upload &amp; import
                </Button>

                {importResult ? (
                  <div className="space-y-3 rounded-xl border border-border bg-secondary/40 p-4 text-xs">
                    {importResult.errors.length === 0 ? (
                      <div
                        role="status"
                        className="rounded-lg border border-gain-ring bg-gain-bg/70 px-3 py-2.5 text-gain-text"
                      >
                        <div className="flex items-start gap-2">
                          <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                          <div className="space-y-0.5">
                            <p className="font-semibold">
                              Import complete: {formatNumber(importResult.inserted)} inserted,{" "}
                              {formatNumber(importResult.updated)} updated, 0 errors
                            </p>
                            <p className="text-[11px] opacity-90">
                              <span className="font-mono">{importResult.fileName}</span> ·{" "}
                              {formatBahrainDateTime(importResult.importedAt)} (Bahrain)
                            </p>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-lg border border-risk-ring bg-risk-bg/70 px-3 py-2 text-risk-text">
                        <p className="font-semibold">
                          Import finished with {formatNumber(importResult.errors.length)} error(s)
                        </p>
                        <p className="text-[11px] opacity-90">
                          <span className="font-mono">{importResult.fileName}</span> ·{" "}
                          {formatBahrainDateTime(importResult.importedAt)} (Bahrain)
                        </p>
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="ok">Inserted: {formatNumber(importResult.inserted)}</Badge>
                      <Badge tone="reorder">Updated: {formatNumber(importResult.updated)}</Badge>
                      <Badge tone={importResult.errors.length > 0 ? "risk" : "ok"}>
                        Errors: {formatNumber(importResult.errors.length)}
                      </Badge>
                    </div>

                    {importResult.errors.length === 0 ? (
                      <div>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() =>
                            updateFilterParam({
                              tab: "recent",
                              from: importResult.minDate ?? undefined,
                              to: importResult.maxDate ?? undefined,
                              page: "1",
                            })
                          }
                        >
                          View in Recent entries
                        </Button>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <ul className="max-h-36 space-y-1 overflow-y-auto text-risk-text">
                          {importResult.errors.slice(0, 20).map((err) => (
                            <li key={`${err.row}-${err.message}`}>
                              Row {err.row}: {err.message}
                            </li>
                          ))}
                        </ul>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={downloadErrorsCsv}
                          className="gap-1.5"
                        >
                          <Download className="size-3.5" aria-hidden="true" />
                          Download error rows as CSV
                        </Button>
                      </div>
                    )}
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <Card className="rounded-2xl border border-border shadow-card">
              <CardHeader>
                <CardTitle className="text-base">Recent imports</CardTitle>
                <CardDescription>
                  Last 10 CSV uploads in your permission scope (timestamps in Asia/Bahrain).
                </CardDescription>
              </CardHeader>
              <CardContent>
                {importsQuery.isPending ? (
                  <LoadingBlock />
                ) : importsQuery.isError ? (
                  <ErrorBlock
                    message={importsQuery.error.message}
                    onRetry={() => void importsQuery.refetch()}
                  />
                ) : importsQuery.data.imports.length === 0 ? (
                  <EmptyBlock
                    title="No CSV imports recorded yet"
                    body="Uploaded CSV batches will appear here with row counts and uploader identity."
                  />
                ) : (
                  <div className="overflow-x-auto">
                    <Table className="min-w-[520px]">
                      <TableHeader>
                        <TableRow>
                          <TableHead>Time</TableHead>
                          <TableHead>File</TableHead>
                          <TableHead>User</TableHead>
                          <TableHead className="text-right">Ins</TableHead>
                          <TableHead className="text-right">Upd</TableHead>
                          <TableHead className="text-right">Err</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {importsQuery.data.imports.map((imp) => (
                          <TableRow key={imp.id}>
                            <TableCell className="text-xs whitespace-nowrap tabular-nums">
                              {formatBahrainDateTime(imp.importedAt)}
                            </TableCell>
                            <TableCell className="max-w-[160px] truncate font-mono text-xs">
                              {imp.fileName}
                            </TableCell>
                            <TableCell className="text-xs">{imp.user.name}</TableCell>
                            <TableCell className="text-right text-xs tabular-nums">
                              {formatNumber(imp.inserted)}
                            </TableCell>
                            <TableCell className="text-right text-xs tabular-nums">
                              {formatNumber(imp.updated)}
                            </TableCell>
                            <TableCell className="text-right text-xs tabular-nums">
                              <Badge tone={imp.errorCount > 0 ? "risk" : "ok"}>
                                {formatNumber(imp.errorCount)}
                              </Badge>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>

      {/* Edit Sheet */}
      <Sheet
        open={Boolean(editingEntry)}
        onOpenChange={(open) => {
          if (!open) setEditingEntry(null);
        }}
      >
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Edit daily entry</SheetTitle>
            <SheetDescription>
              {editingEntry
                ? `${editingEntry.branchId} · ${editingEntry.sku} · ${formatDate(editingEntry.date)}`
                : ""}
            </SheetDescription>
          </SheetHeader>
          <div className="mt-6 space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="edit-sold" className="text-xs font-medium text-foreground">
                Units sold
              </label>
              <Input
                id="edit-sold"
                type="number"
                min={0}
                value={editUnitsSold}
                onChange={(e) => setEditUnitsSold(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="edit-onhand" className="text-xs font-medium text-foreground">
                End-of-day stock (on hand)
              </label>
              <Input
                id="edit-onhand"
                type="number"
                min={0}
                value={editOnHand}
                onChange={(e) => setEditOnHand(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="secondary" onClick={() => setEditingEntry(null)}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="primary"
                loading={updateMutation.isPending}
                onClick={() => {
                  if (!editingEntry) return;
                  updateMutation.mutate({
                    id: editingEntry.id,
                    unitsSold: Number(editUnitsSold),
                    onHand: Number(editOnHand),
                  });
                }}
              >
                Save changes
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={Boolean(deletingEntry)}
        onOpenChange={(open) => {
          if (!open) setDeletingEntry(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete daily entry?</DialogTitle>
            <DialogDescription>
              {deletingEntry
                ? `Remove the entry for ${deletingEntry.sku} at ${deletingEntry.branchId} on ${formatDate(deletingEntry.date)}?`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setDeletingEntry(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              loading={deleteMutation.isPending}
              onClick={() => {
                if (deletingEntry) deleteMutation.mutate(deletingEntry.id);
              }}
            >
              Delete entry
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ClipboardPaste, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SkuCombobox } from "@/features/data/SkuCombobox";
import { invalidateOperationalQueries } from "@/hooks/queryKeys";
import { api } from "@/lib/api";
import {
  buildDailySheetCsvFile,
  parseSpreadsheetPaste,
  validateDailySheetRows,
  type DailySheetRowDraft,
} from "@/lib/dailySheetCsv";
import { formatNumber } from "@/lib/format";
import type { Product } from "@stockflow/core";

export interface DailySheetEditorProps {
  branchId: string;
  branchName?: string;
  date: string;
  products: readonly Product[];
  onImported: (result: { inserted: number; updated: number; branchId: string; date: string }) => void;
}

function nextRowId(seq: number): string {
  return `sheet_row_${seq}`;
}

export function DailySheetEditor({
  branchId,
  branchName,
  date,
  products,
  onImported,
}: DailySheetEditorProps) {
  const queryClient = useQueryClient();
  const [seq, setSeq] = useState(2);
  const [rows, setRows] = useState<DailySheetRowDraft[]>([
    { id: "sheet_row_1", sku: "", unitsSold: "0", onHand: "0" },
  ]);
  const [addSkuValue, setAddSkuValue] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [sheetError, setSheetError] = useState<string | null>(null);

  const productMap = useMemo(() => new Map(products.map((p) => [p.sku, p])), [products]);
  const validSkuSet = useMemo(() => new Set(products.map((p) => p.sku)), [products]);
  const validationErrors = useMemo(
    () => validateDailySheetRows(rows, validSkuSet),
    [rows, validSkuSet],
  );

  const submitMutation = useMutation({
    mutationFn: async () => {
      const { file, rowIndexToId } = buildDailySheetCsvFile(rows, branchId, date);
      const res = await api.importSalesCsv(file);
      return { res, rowIndexToId };
    },
    onSuccess: async ({ res, rowIndexToId }) => {
      if (res.errors.length > 0) {
        const errorByRowId = new Map<string, string>();
        for (const err of res.errors) {
          const id = rowIndexToId.get(err.row);
          if (id) errorByRowId.set(id, err.message);
        }
        setRows((prev) =>
          prev.map((row) => ({
            ...row,
            serverError: errorByRowId.get(row.id),
          })),
        );
        setSheetError(`Daily sheet finished with ${formatNumber(res.errors.length)} row error(s).`);
        toast.error("Some daily sheet rows failed validation");
        return;
      }

      setSheetError(null);
      toast.success(
        `Saved daily sheet: ${formatNumber(res.inserted)} inserted, ${formatNumber(res.updated)} updated`,
      );
      setRows([{ id: nextRowId(seq), sku: "", unitsSold: "0", onHand: "0" }]);
      setSeq((s) => s + 1);
      await invalidateOperationalQueries(queryClient);
      onImported({
        inserted: res.inserted,
        updated: res.updated,
        branchId,
        date,
      });
    },
    onError: (err: Error) => {
      setSheetError(err.message || "Daily sheet submission failed");
      toast.error(err.message || "Unable to submit daily sheet");
    },
  });

  function addRowForSku(sku: string) {
    if (!sku) return;
    setRows((prev) => {
      if (prev.length === 1 && !prev[0]!.sku) {
        return [{ ...prev[0]!, sku, serverError: undefined }];
      }
      const next = [...prev, { id: nextRowId(seq), sku, unitsSold: "0", onHand: "0" }];
      return next;
    });
    setSeq((s) => s + 1);
    setAddSkuValue("");
    setSheetError(null);
  }

  function handleApplyPaste() {
    const parsed = parseSpreadsheetPaste(pasteText);
    if (parsed.length === 0) {
      setSheetError("No valid rows detected in pasted text. Expected columns: SKU, unitsSold, onHand.");
      return;
    }
    let counter = seq;
    const importedRows: DailySheetRowDraft[] = parsed.map((item) => {
      const id = nextRowId(counter);
      counter += 1;
      return { id, sku: item.sku, unitsSold: item.unitsSold, onHand: item.onHand };
    });
    setRows((prev) => {
      const nonEmpty = prev.filter((r) => r.sku.trim().length > 0);
      return [...nonEmpty, ...importedRows];
    });
    setSeq(counter);
    setPasteText("");
    setPasteOpen(false);
    setSheetError(null);
  }

  const canSubmit =
    Boolean(branchId && date) &&
    rows.length > 0 &&
    validationErrors.size === 0 &&
    !submitMutation.isPending;

  return (
    <Card className="rounded-2xl border border-border shadow-card">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">Daily sheet</CardTitle>
            <CardDescription>
              Batch grid for {branchName ?? branchId} on {date}. Add rows by SKU search or paste columns from Excel (SKU, units sold, end-of-day stock).
            </CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setPasteOpen((prev) => !prev)}
            className="gap-1.5"
          >
            <ClipboardPaste className="size-3.5" aria-hidden="true" />
            Paste from Excel
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {pasteOpen ? (
          <div className="space-y-2 rounded-xl border border-border bg-secondary/40 p-3.5">
            <label htmlFor="daily-sheet-paste" className="text-xs font-medium text-foreground">
              Paste spreadsheet rows (tab- or comma-separated: SKU, unitsSold, onHand)
            </label>
            <textarea
              id="daily-sheet-paste"
              rows={4}
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder={"SKU-00001\t6\t22\nSKU-00002\t3\t14"}
              className="w-full rounded-lg border border-input bg-card px-3 py-2 font-mono text-xs text-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none"
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" size="xs" onClick={() => setPasteOpen(false)}>
                Cancel
              </Button>
              <Button type="button" variant="primary" size="xs" onClick={handleApplyPaste}>
                Add pasted rows
              </Button>
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[260px] flex-1 space-y-1">
            <label htmlFor="daily-sheet-add-sku" className="text-xs font-medium text-foreground">
              Quick add SKU row
            </label>
            <SkuCombobox
              id="daily-sheet-add-sku"
              ariaLabel="Quick add SKU to daily sheet"
              products={products}
              value={addSkuValue}
              onChange={(sku) => addRowForSku(sku)}
            />
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              setRows((prev) => [...prev, { id: nextRowId(seq), sku: "", unitsSold: "0", onHand: "0" }]);
              setSeq((s) => s + 1);
            }}
            className="gap-1"
          >
            <Plus className="size-3.5" aria-hidden="true" />
            Blank row
          </Button>
        </div>

        <div className="overflow-x-auto rounded-xl border border-border">
          <Table className="min-w-[680px]">
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[240px]">SKU</TableHead>
                <TableHead className="w-[140px]">Units sold</TableHead>
                <TableHead className="w-[170px]">End-of-day stock (on hand)</TableHead>
                <TableHead className="w-[64px] text-right">Remove</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, idx) => {
                const err = row.serverError ?? validationErrors.get(row.id);
                const prod = productMap.get(row.sku);
                return (
                  <TableRow key={row.id}>
                    <TableCell className="align-top">
                      <SkuCombobox
                        ariaLabel={`Row ${idx + 1} SKU`}
                        products={products}
                        value={row.sku}
                        onChange={(sku) =>
                          setRows((prev) =>
                            prev.map((r) =>
                              r.id === row.id ? { ...r, sku, serverError: undefined } : r,
                            ),
                          )
                        }
                      />
                      {prod ? (
                        <p className="mt-1 truncate text-[11px] text-muted-foreground">
                          {prod.category}
                        </p>
                      ) : null}
                      {err ? (
                        <p role="alert" className="mt-1 text-xs font-medium text-risk-text">
                          {err}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="align-top">
                      <Input
                        type="number"
                        step={1}
                        min={0}
                        aria-label={`Row ${idx + 1} units sold`}
                        value={row.unitsSold}
                        onChange={(e) =>
                          setRows((prev) =>
                            prev.map((r) =>
                              r.id === row.id
                                ? { ...r, unitsSold: e.target.value, serverError: undefined }
                                : r,
                            ),
                          )
                        }
                        className="h-9 tabular-nums"
                      />
                    </TableCell>
                    <TableCell className="align-top">
                      <Input
                        type="number"
                        step={1}
                        min={0}
                        aria-label={`Row ${idx + 1} end-of-day stock`}
                        value={row.onHand}
                        onChange={(e) =>
                          setRows((prev) =>
                            prev.map((r) =>
                              r.id === row.id
                                ? { ...r, onHand: e.target.value, serverError: undefined }
                                : r,
                            ),
                          )
                        }
                        className="h-9 tabular-nums"
                      />
                    </TableCell>
                    <TableCell className="align-top text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        disabled={rows.length === 1 && !row.sku}
                        aria-label={`Remove row ${idx + 1}`}
                        onClick={() =>
                          setRows((prev) =>
                            prev.length <= 1
                              ? [{ id: nextRowId(seq), sku: "", unitsSold: "0", onHand: "0" }]
                              : prev.filter((r) => r.id !== row.id),
                          )
                        }
                        className="text-risk-text hover:bg-risk-bg"
                      >
                        <Trash2 className="size-3.5" aria-hidden="true" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        {sheetError ? (
          <p role="alert" className="text-xs font-medium text-risk-text">
            {sheetError}
          </p>
        ) : null}

        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatNumber(rows.length)} {rows.length === 1 ? "row" : "rows"} ready
          </span>
          <Button
            type="button"
            variant="primary"
            loading={submitMutation.isPending}
            disabled={!canSubmit}
            onClick={() => submitMutation.mutate()}
          >
            Submit daily sheet
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

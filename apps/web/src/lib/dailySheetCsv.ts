export interface DailySheetRowDraft {
  id: string;
  sku: string;
  unitsSold: string;
  onHand: string;
  serverError?: string;
}

export interface ParsedPasteRow {
  sku: string;
  unitsSold: string;
  onHand: string;
}

export function parseNonNegativeInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/**
 * Parses tab-separated (Excel paste) or comma/semicolon-separated rows of:
 * sku, unitsSold, onHand
 */
export function parseSpreadsheetPaste(text: string): ParsedPasteRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const parsed: ParsedPasteRow[] = [];

  for (const line of lines) {
    const cells = line.includes("\t")
      ? line.split("\t")
      : line.includes(",")
        ? line.split(",")
        : line.includes(";")
          ? line.split(";")
          : line.split(/\s+/);
    const cleaned = cells.map((c) => c.trim());
    if (cleaned.length === 0) continue;
    if (/^sku$/i.test(cleaned[0] ?? "")) continue;

    const sku = (cleaned[0] ?? "").toUpperCase();
    if (!sku) continue;
    parsed.push({
      sku,
      unitsSold: cleaned[1] ?? "0",
      onHand: cleaned[2] ?? "0",
    });
  }

  return parsed;
}

export function validateDailySheetRows(
  rows: readonly DailySheetRowDraft[],
  validSkus?: ReadonlySet<string>,
): Map<string, string> {
  const errors = new Map<string, string>();
  const seenSkus = new Set<string>();

  for (const row of rows) {
    const sku = row.sku.trim();
    if (!sku) {
      errors.set(row.id, "Select a valid SKU");
      continue;
    }
    if (validSkus && validSkus.size > 0 && !validSkus.has(sku)) {
      errors.set(row.id, `Unknown SKU ${sku}`);
      continue;
    }
    if (seenSkus.has(sku)) {
      errors.set(row.id, `Duplicate SKU ${sku} in daily sheet`);
      continue;
    }
    seenSkus.add(sku);

    if (parseNonNegativeInt(row.unitsSold) === null) {
      errors.set(row.id, "Units sold must be a whole number (>= 0)");
      continue;
    }
    if (parseNonNegativeInt(row.onHand) === null) {
      errors.set(row.id, "End-of-day stock (on hand) must be a whole number (>= 0)");
    }
  }

  return errors;
}

export function buildDailySheetCsvFile(
  rows: readonly DailySheetRowDraft[],
  branchId: string,
  date: string,
): { file: File; rowIndexToId: Map<number, string> } {
  const lines = ["branchId,sku,date,unitsSold,onHand"];
  const rowIndexToId = new Map<number, string>();

  rows.forEach((row, index) => {
    const units = parseNonNegativeInt(row.unitsSold) ?? 0;
    const stock = parseNonNegativeInt(row.onHand) ?? 0;
    lines.push(`${branchId},${row.sku.trim()},${date},${units},${stock}`);
    rowIndexToId.set(index + 2, row.id);
  });

  const csvContent = lines.join("\n");
  const file = new File([csvContent], `daily-sheet-${branchId}-${date}.csv`, {
    type: "text/csv",
  });
  return { file, rowIndexToId };
}

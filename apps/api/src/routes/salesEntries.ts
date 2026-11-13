import type { FastifyInstance } from "fastify";
import { recomputeForSku, upsertSalesEntry } from "../db.js";

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface ValidatedSalesEntryInput {
  branchId: string;
  sku: string;
  date: string;
  unitsSold: number;
  onHand: number;
}

function isValidCalendarDate(dateStr: string): boolean {
  if (!ISO_DATE_RE.test(dateStr)) return false;
  const parsed = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === dateStr;
}

function parseNumericField(raw: unknown, allowNumericString: boolean): number | null {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw : null;
  }
  if (allowNumericString && typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    const num = Number(trimmed);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

/**
 * Validates a manual or CSV sales entry row.
 * Returns a specific error message for the first missing/invalid field, or the normalized input.
 */
export function validateSalesEntryInput(
  raw: unknown,
  options: { coerceNumericStrings?: boolean } = {},
): { ok: true; data: ValidatedSalesEntryInput } | { ok: false; message: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, message: "Request body must be a JSON object" };
  }

  const record = raw as Record<string, unknown>;
  const coerce = Boolean(options.coerceNumericStrings);

  // 1. branchId
  if (record.branchId === undefined || record.branchId === null || record.branchId === "") {
    return { ok: false, message: "Field 'branchId' is required" };
  }
  if (typeof record.branchId !== "string" || record.branchId.trim().length === 0) {
    return { ok: false, message: "Field 'branchId' must be a non-empty string" };
  }

  // 2. sku
  if (record.sku === undefined || record.sku === null || record.sku === "") {
    return { ok: false, message: "Field 'sku' is required" };
  }
  if (typeof record.sku !== "string" || record.sku.trim().length === 0) {
    return { ok: false, message: "Field 'sku' must be a non-empty string" };
  }

  // 3. date
  if (record.date === undefined || record.date === null || record.date === "") {
    return { ok: false, message: "Field 'date' is required" };
  }
  if (typeof record.date !== "string" || !isValidCalendarDate(record.date.trim())) {
    return {
      ok: false,
      message: "Field 'date' must be a valid date string in YYYY-MM-DD format",
    };
  }

  // 4. unitsSold
  if (record.unitsSold === undefined || record.unitsSold === null || record.unitsSold === "") {
    return { ok: false, message: "Field 'unitsSold' is required" };
  }
  const unitsSold = parseNumericField(record.unitsSold, coerce);
  if (unitsSold === null || unitsSold < 0) {
    return {
      ok: false,
      message: "Field 'unitsSold' must be a non-negative number (>= 0)",
    };
  }

  // 5. onHand
  if (record.onHand === undefined || record.onHand === null || record.onHand === "") {
    return { ok: false, message: "Field 'onHand' is required" };
  }
  const onHand = parseNumericField(record.onHand, coerce);
  if (onHand === null || onHand < 0) {
    return {
      ok: false,
      message: "Field 'onHand' must be a non-negative number (>= 0)",
    };
  }

  return {
    ok: true,
    data: {
      branchId: record.branchId.trim(),
      sku: record.sku.trim(),
      date: record.date.trim(),
      unitsSold,
      onHand,
    },
  };
}

interface MultipartFileExtraction {
  ok: true;
  fileBuffer: Buffer;
  filename: string;
}

interface MultipartError {
  ok: false;
  statusCode: number;
  message: string;
}

function extractMultipartFile(
  rawBody: Buffer,
  contentTypeHeader: string | undefined,
): MultipartFileExtraction | MultipartError {
  if (!contentTypeHeader || !contentTypeHeader.toLowerCase().includes("multipart/form-data")) {
    return {
      ok: false,
      statusCode: 400,
      message: "Content-Type must be multipart/form-data with a 'file' field",
    };
  }

  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;,\s]+))/i.exec(contentTypeHeader);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary) {
    return {
      ok: false,
      statusCode: 400,
      message: "Missing multipart/form-data boundary",
    };
  }

  const delimiter = Buffer.from(`--${boundary}`);
  const headerEndMarker = Buffer.from("\r\n\r\n");
  const headerEndMarkerLf = Buffer.from("\n\n");

  let offset = rawBody.indexOf(delimiter);
  if (offset === -1) {
    return { ok: false, statusCode: 400, message: "Malformed multipart payload" };
  }

  while (offset !== -1) {
    const partStart = offset + delimiter.length;
    // Check for closing "--"
    if (
      rawBody[partStart] === 0x2d &&
      rawBody[partStart + 1] === 0x2d
    ) {
      break;
    }

    // Advance past leading CRLF or LF after boundary
    let cursor = partStart;
    if (rawBody[cursor] === 0x0d && rawBody[cursor + 1] === 0x0a) {
      cursor += 2;
    } else if (rawBody[cursor] === 0x0a) {
      cursor += 1;
    }

    const nextBoundary = rawBody.indexOf(delimiter, cursor);
    const partEnd = nextBoundary === -1 ? rawBody.length : nextBoundary;
    const partSlice = rawBody.subarray(cursor, partEnd);

    let headerEnd = partSlice.indexOf(headerEndMarker);
    let bodyStartOffset = headerEnd + 4;
    if (headerEnd === -1) {
      headerEnd = partSlice.indexOf(headerEndMarkerLf);
      bodyStartOffset = headerEnd + 2;
    }

    if (headerEnd !== -1) {
      const headersText = partSlice.subarray(0, headerEnd).toString("utf8");
      const nameMatch = /name="([^"]+)"/i.exec(headersText);
      const fieldName = nameMatch?.[1];

      if (fieldName === "file") {
        let contentEnd = partSlice.length;
        if (
          contentEnd >= 2 &&
          partSlice[contentEnd - 2] === 0x0d &&
          partSlice[contentEnd - 1] === 0x0a
        ) {
          contentEnd -= 2;
        } else if (contentEnd >= 1 && partSlice[contentEnd - 1] === 0x0a) {
          contentEnd -= 1;
        }
        const fileBuffer = partSlice.subarray(bodyStartOffset, contentEnd);
        if (fileBuffer.byteLength > MAX_FILE_BYTES) {
          return {
            ok: false,
            statusCode: 413,
            message: "Uploaded file exceeds the 5MB limit",
          };
        }
        const filenameMatch = /filename="([^"]*)"/i.exec(headersText);
        return {
          ok: true,
          fileBuffer,
          filename: filenameMatch?.[1] ?? "upload.csv",
        };
      }
    }

    offset = nextBoundary;
  }

  return {
    ok: false,
    statusCode: 400,
    message: "Missing required file field named 'file'",
  };
}

/**
 * RFC 4180 CSV parser with header mapping (columns: true).
 * Returns an array of { rowNumber, record } objects where rowNumber is 1-based data row index.
 */
export function parseCsvWithHeaders(
  csvText: string,
): Array<{ rowNumber: number; record: Record<string, string> }> {
  const cleaned = csvText.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = "";
  let inQuotes = false;

  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (inQuotes) {
      if (ch === '"') {
        if (cleaned[i + 1] === '"') {
          currentField += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        currentField += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      currentRow.push(currentField);
      currentField = "";
    } else if (ch === "\r") {
      if (cleaned[i + 1] === "\n") {
        i += 1;
      }
      currentRow.push(currentField);
      rows.push(currentRow);
      currentRow = [];
      currentField = "";
    } else if (ch === "\n") {
      currentRow.push(currentField);
      rows.push(currentRow);
      currentRow = [];
      currentField = "";
    } else {
      currentField += ch;
    }
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  if (rows.length === 0) return [];

  const headerRow = rows[0] ?? [];
  const headers = headerRow.map((h) => h.trim());
  const results: Array<{ rowNumber: number; record: Record<string, string> }> = [];

  for (let r = 1; r < rows.length; r += 1) {
    const cells = rows[r] ?? [];
    // Skip trailing completely blank lines
    if (cells.length === 1 && (cells[0] ?? "").trim() === "") {
      continue;
    }
    const record: Record<string, string> = {};
    for (let c = 0; c < headers.length; c += 1) {
      const key = headers[c];
      if (key) {
        record[key] = (cells[c] ?? "").trim();
      }
    }
    results.push({ rowNumber: results.length + 1, record });
  }

  return results;
}

export function registerSalesEntriesRoutes(app: FastifyInstance): void {
  // Accept multipart/form-data as raw Buffer within this route scope
  app.addContentTypeParser(
    "multipart/form-data",
    { parseAs: "buffer", bodyLimit: MAX_FILE_BYTES + 256 * 1024 },
    (_req, body, done) => {
      done(null, body);
    },
  );

  /**
   * POST /api/sales-entries
   * Manual single-entry upsert on (branchId, sku, date).
   */
  app.post("/sales-entries", async (request, reply) => {
    const validation = validateSalesEntryInput(request.body, { coerceNumericStrings: false });
    if (!validation.ok) {
      return reply.code(400).send({ error: validation.message });
    }

    const { entry } = await upsertSalesEntry(validation.data);
    await recomputeForSku(entry.branchId, entry.sku);

    return reply.code(201).send(entry);
  });

  /**
   * POST /api/sales-entries/import
   * Bulk CSV upload via multipart/form-data field "file" (max 5MB).
   */
  app.post("/sales-entries/import", async (request, reply) => {
    const rawBuffer = Buffer.isBuffer(request.body) ? request.body : null;
    if (!rawBuffer) {
      return reply
        .code(400)
        .send({ error: "Expected multipart/form-data with a 'file' field" });
    }

    const extracted = extractMultipartFile(rawBuffer, request.headers["content-type"]);
    if (!extracted.ok) {
      return reply.code(extracted.statusCode).send({ error: extracted.message });
    }

    const csvText = extracted.fileBuffer.toString("utf8");
    const parsedRows = parseCsvWithHeaders(csvText);

    let inserted = 0;
    let updated = 0;
    const errors: Array<{ row: number; message: string }> = [];
    const touchedPairs = new Map<string, { branchId: string; sku: string }>();

    for (const item of parsedRows) {
      const validation = validateSalesEntryInput(item.record, {
        coerceNumericStrings: true,
      });
      if (!validation.ok) {
        errors.push({ row: item.rowNumber, message: validation.message });
        continue;
      }

      const result = await upsertSalesEntry(validation.data);
      if (result.created) {
        inserted += 1;
      } else {
        updated += 1;
      }

      const pairKey = `${result.entry.branchId}::${result.entry.sku}`;
      touchedPairs.set(pairKey, {
        branchId: result.entry.branchId,
        sku: result.entry.sku,
      });
    }

    // Trigger recomputeForSku once per distinct (branchId, sku) touched
    for (const pair of touchedPairs.values()) {
      await recomputeForSku(pair.branchId, pair.sku);
    }

    return reply.code(200).send({
      inserted,
      updated,
      errors,
    });
  });
}

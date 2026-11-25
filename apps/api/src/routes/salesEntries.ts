import { randomUUID } from "node:crypto";
import { isBranchInScope, scopeBranches } from "@stockflow/core";
import type { FastifyInstance } from "fastify";
import {
  deleteSalesEntryById,
  getSalesEntryById,
  listImportLogs,
  listSalesEntries,
  recomputeForSku,
  recordImportLog,
  previewSalesImport,
  persistMongoSalesImport,
  recordSalesEntryAudit,
  updateSalesEntryById,
  upsertSalesEntry,
} from "../db.js";
import type { AuthContext } from "../plugins/auth.js";
import type { StockServices } from "../services/index.js";
import { getBahrainToday } from "../utils/bahrainDate.js";

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface ValidatedSalesEntryInput {
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
function validateSalesEntryInput(
  raw: unknown,
  options: { coerceNumericStrings?: boolean; nowMs?: number } = {},
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
  const todayIso = getBahrainToday(options.nowMs).isoDate;
  if (record.date.trim() > todayIso) {
    return {
      ok: false,
      message: "Field 'date' cannot be in the future",
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
function parseCsvWithHeaders(
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

export function registerSalesEntriesRoutes(
  app: FastifyInstance,
  services: StockServices,
  authGuards: AuthContext,
): void {
  // Accept multipart/form-data as raw Buffer within this route scope
  app.addContentTypeParser(
    "multipart/form-data",
    { parseAs: "buffer", bodyLimit: MAX_FILE_BYTES + 256 * 1024 },
    (_req, body, done) => {
      done(null, body);
    },
  );

  const mongo = services.repositoryKind() === "mongo";
  const validateDomainRefs = (data: ValidatedSalesEntryInput): string | null => {
    if (!services.catalog.hasBranch(data.branchId)) {
      return `Field 'branchId' references unknown branch '${data.branchId}'`;
    }
    const status = services.catalog.getProductStatus(data.sku);
    if (status === "unknown") {
      return `Field 'sku' references unknown SKU '${data.sku}'`;
    }
    if (status === "archived") {
      return `SKU '${data.sku}' is archived and cannot accept sales entries`;
    }
    return null;
  };

  /**
   * GET /api/sales-entries/template.csv
   */
  // RBAC: Admin, manager, staff (sales:enter; downloads blank sample CSV template).
  app.get(
    "/sales-entries/template.csv",
    { preHandler: [authGuards.requirePermission("sales:enter")] },
    async (_request, reply) => {
      const today = getBahrainToday(services.runtime.now()).isoDate;
      const csv = `branchId,sku,date,unitsSold,onHand\nBR-001,SKU-00001,${today},5,20\n`;
      return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", 'attachment; filename="sales-entries-template.csv"')
        .send(csv);
    },
  );

  /**
   * GET /api/sales/imports
   * Recent CSV import history (admin sees all, manager/staff see only their own).
   */
  // RBAC: Authenticated (any role; admin sees all imports, manager/staff see only their own uploads).
  app.get(
    "/sales/imports",
    { preHandler: [authGuards.authenticate] },
    async (request) => {
      await services.ensureInitialized();
      const q = (request.query ?? {}) as Record<string, unknown>;
      const limit = Math.min(50, Math.max(1, Number(q.limit ?? 10) || 10));
      const userId =
        request.currentUser.role === "admin" ? undefined : request.currentUser.id;
      const imports = await listImportLogs({ userId, limit }, mongo);
      return { imports };
    },
  );

  /**
   * GET /api/sales-entries
   * Paginated, filtered, branch-scoped list of recorded sales entries.
   */
  // RBAC: Admin, manager, staff (sales:enter; non-admin restricted to assigned branches, 403 otherwise).
  app.get(
    "/sales-entries",
    { preHandler: [authGuards.requirePermission("sales:enter")] },
    async (request, reply) => {
      await services.ensureInitialized();
      const q = (request.query ?? {}) as Record<string, unknown>;
      const branch = typeof q.branch === "string" && q.branch.trim() ? q.branch.trim() : undefined;
      const sku = typeof q.sku === "string" && q.sku.trim() ? q.sku.trim() : undefined;
      const from = typeof q.from === "string" && q.from.trim() ? q.from.trim() : undefined;
      const to = typeof q.to === "string" && q.to.trim() ? q.to.trim() : undefined;
      const page = Math.max(1, Number(q.page ?? 1) || 1);
      const limit = Math.min(100, Math.max(1, Number(q.limit ?? 25) || 25));

      if (branch && !isBranchInScope(request.currentUser, branch)) {
        return reply.code(403).send({ error: "Access to branch forbidden" });
      }

      const allowedBranchIds =
        request.currentUser.role === "admin"
          ? null
          : scopeBranches(request.currentUser, services.catalog.allBranchIds());

      return listSalesEntries({
        allowedBranchIds,
        branchId: branch,
        sku,
        from,
        to,
        page,
        limit,
      }, mongo);
    },
  );

  /**
   * POST /api/sales-entries
   * Manual single-entry upsert on (branchId, sku, date).
   */
  // RBAC: Admin, manager, staff (sales:enter; enforces isBranchInScope on target branchId).
  app.post(
    "/sales-entries",
    { preHandler: [authGuards.requirePermission("sales:enter")] },
    async (request, reply) => {
      await services.ensureInitialized();
      const validation = validateSalesEntryInput(request.body, {
        coerceNumericStrings: false,
        nowMs: services.runtime.now(),
      });
      if (!validation.ok) {
        return reply.code(400).send({ error: validation.message });
      }

      const refError = validateDomainRefs(validation.data);
      if (refError) {
        return reply.code(400).send({ error: refError });
      }

      if (!isBranchInScope(request.currentUser, validation.data.branchId)) {
        return reply.code(403).send({ error: "Access to branch forbidden" });
      }

      const { entry, created } = await upsertSalesEntry(validation.data, mongo);
      const { dateAdded } = services.catalog.applySalesEntryToDataset(
        entry.branchId,
        entry.sku,
        entry.date,
        entry.unitsSold,
        entry.onHand,
      );
      await recomputeForSku(entry.branchId, entry.sku);
      await services.catalog.recomputeSingleSku(entry.sku, { fullPlanRecompute: dateAdded });

      await recordSalesEntryAudit({
        id: `sea_${randomUUID()}`,
        entryId: entry.id,
        branchId: entry.branchId,
        sku: entry.sku,
        date: entry.date,
        action: created ? "CREATE" : "UPDATE",
        at: new Date().toISOString(),
        actedBy: {
          userId: request.currentUser.id,
          name: request.currentUser.name,
          role: request.currentUser.role,
        },
        before: null,
        after: { unitsSold: entry.unitsSold, onHand: entry.onHand },
      }, mongo);

      return reply.code(201).send(entry);
    },
  );

  /**
   * PATCH /api/sales-entries/:id
   * Edits unitsSold and/or onHand only; branchId, sku, and date are immutable.
   */
  // RBAC: Admin, manager, staff (sales:enter; enforces isBranchInScope on existing entry branchId).
  app.patch(
    "/sales-entries/:id",
    { preHandler: [authGuards.requirePermission("sales:enter")] },
    async (request, reply) => {
      await services.ensureInitialized();
      const { id } = request.params as { id: string };
      const existing = await getSalesEntryById(decodeURIComponent(id), mongo);
      if (!existing) {
        return reply.code(404).send({ error: "Sales entry not found" });
      }
      if (!isBranchInScope(request.currentUser, existing.branchId)) {
        return reply.code(403).send({ error: "Access to branch forbidden" });
      }

      const body = request.body as Record<string, unknown> | null;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return reply.code(400).send({ error: "Request body must be a JSON object" });
      }
      if ("branchId" in body || "sku" in body || "date" in body) {
        return reply.code(400).send({ error: "Key fields (branchId, sku, date) are immutable" });
      }

      const unitsSold = body.unitsSold !== undefined ? parseNumericField(body.unitsSold, false) : existing.unitsSold;
      if (unitsSold === null || unitsSold < 0) {
        return reply.code(400).send({ error: "Field 'unitsSold' must be a non-negative number (>= 0)" });
      }
      const onHand = body.onHand !== undefined ? parseNumericField(body.onHand, false) : existing.onHand;
      if (onHand === null || onHand < 0) {
        return reply.code(400).send({ error: "Field 'onHand' must be a non-negative number (>= 0)" });
      }

      const updated = await updateSalesEntryById(existing.id, { unitsSold, onHand }, mongo);
      if (!updated) {
        return reply.code(404).send({ error: "Sales entry not found" });
      }

      services.catalog.applySalesEntryToDataset(
        updated.branchId,
        updated.sku,
        updated.date,
        updated.unitsSold,
        updated.onHand,
      );
      await recomputeForSku(updated.branchId, updated.sku);
      await services.catalog.recomputeSingleSku(updated.sku);

      await recordSalesEntryAudit({
        id: `sea_${randomUUID()}`,
        entryId: updated.id,
        branchId: updated.branchId,
        sku: updated.sku,
        date: updated.date,
        action: "UPDATE",
        at: new Date().toISOString(),
        actedBy: {
          userId: request.currentUser.id,
          name: request.currentUser.name,
          role: request.currentUser.role,
        },
        before: { unitsSold: existing.unitsSold, onHand: existing.onHand },
        after: { unitsSold: updated.unitsSold, onHand: updated.onHand },
      }, mongo);

      return updated;
    },
  );

  /**
   * DELETE /api/sales-entries/:id
   */
  // RBAC: Admin, manager, staff (sales:enter; enforces isBranchInScope on target entry branchId).
  app.delete(
    "/sales-entries/:id",
    { preHandler: [authGuards.requirePermission("sales:enter")] },
    async (request, reply) => {
      await services.ensureInitialized();
      const { id } = request.params as { id: string };
      const existing = await getSalesEntryById(decodeURIComponent(id), mongo);
      if (!existing) {
        return reply.code(404).send({ error: "Sales entry not found" });
      }
      if (!isBranchInScope(request.currentUser, existing.branchId)) {
        return reply.code(403).send({ error: "Access to branch forbidden" });
      }

      const deleted = await deleteSalesEntryById(existing.id, mongo);
      if (!deleted) {
        return reply.code(404).send({ error: "Sales entry not found" });
      }

      await recomputeForSku(deleted.branchId, deleted.sku);
      await services.catalog.recomputeSingleSku(deleted.sku);

      await recordSalesEntryAudit({
        id: `sea_${randomUUID()}`,
        entryId: deleted.id,
        branchId: deleted.branchId,
        sku: deleted.sku,
        date: deleted.date,
        action: "DELETE",
        at: new Date().toISOString(),
        actedBy: {
          userId: request.currentUser.id,
          name: request.currentUser.name,
          role: request.currentUser.role,
        },
        before: { unitsSold: deleted.unitsSold, onHand: deleted.onHand },
        after: null,
      }, mongo);

      return { ok: true };
    },
  );

  /**
   * POST /api/sales-entries/import
   * Bulk CSV upload via multipart/form-data field "file" (max 5MB).
   */
  // RBAC: Admin, manager, staff (sales:enter; per-row branch scope enforced inside validation loop).
  app.post(
    "/sales-entries/import",
    { preHandler: [authGuards.requirePermission("sales:enter")] },
    async (request, reply) => {
      await services.ensureInitialized();
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

      const validatedRows: Array<
        | { ok: true; rowNumber: number; data: ValidatedSalesEntryInput }
        | { ok: false; rowNumber: number; message: string }
      > = [];

      for (const item of parsedRows) {
        const validation = validateSalesEntryInput(item.record, {
          coerceNumericStrings: true,
          nowMs: services.runtime.now(),
        });
        if (!validation.ok) {
          validatedRows.push({ ok: false, rowNumber: item.rowNumber, message: validation.message });
          continue;
        }
        const refError = validateDomainRefs(validation.data);
        if (refError) {
          validatedRows.push({ ok: false, rowNumber: item.rowNumber, message: refError });
          continue;
        }
        if (!isBranchInScope(request.currentUser, validation.data.branchId)) {
          validatedRows.push({
            ok: false,
            rowNumber: item.rowNumber,
            message: `Branch '${validation.data.branchId}' is outside your assigned scope`,
          });
          continue;
        }
        validatedRows.push({ ok: true, rowNumber: item.rowNumber, data: validation.data });
      }

      const rows = validatedRows.flatMap((item) => item.ok ? [item.data] : []);
      const errors = validatedRows.flatMap((item) => item.ok ? [] : [{ row: item.rowNumber, message: item.message }]);
      if ((request.query as { preview?: string }).preview === "1") {
        return { ...await previewSalesImport(rows, mongo), errors };
      }
      if (mongo) {
        const dates = rows.map((row) => row.date).sort();
        const saved = await persistMongoSalesImport(rows, {
          id: `imp_${randomUUID()}`, importedAt: new Date(services.runtime.now()).toISOString(),
          fileName: extracted.filename || "upload.csv",
          user: { userId: request.currentUser.id, name: request.currentUser.name, role: request.currentUser.role },
          inserted: 0, updated: 0, errorCount: errors.length, minDate: dates[0] ?? null,
          maxDate: dates.at(-1) ?? null, branchIds: [...new Set(rows.map((row) => row.branchId))],
        });
        try {
          await services.ensureFreshPlan();
        } catch {
          return reply.code(202).send({ ...saved, errors, planRefreshPending: true });
        }
        return { ...saved, errors };
      }
      let inserted = 0;
      let updated = 0;
      const touchedPairs = new Map<string, { branchId: string; sku: string }>();
      const touchedSkus = new Set<string>();
      const touchedBranches = new Set<string>();
      let minDate: string | null = null;
      let maxDate: string | null = null;
      let anyDateAdded = false;

      for (const item of validatedRows) {
        if (!item.ok) {
          continue;
        }

        const result = await upsertSalesEntry(item.data, false);
        if (result.created) {
          inserted += 1;
        } else {
          updated += 1;
        }

        const applied = services.catalog.applySalesEntryToDataset(
          result.entry.branchId,
          result.entry.sku,
          result.entry.date,
          result.entry.unitsSold,
          result.entry.onHand,
        );
        if (applied.dateAdded) anyDateAdded = true;

        touchedBranches.add(result.entry.branchId);
        if (!minDate || result.entry.date < minDate) minDate = result.entry.date;
        if (!maxDate || result.entry.date > maxDate) maxDate = result.entry.date;

        const pairKey = `${result.entry.branchId}::${result.entry.sku}`;
        touchedPairs.set(pairKey, {
          branchId: result.entry.branchId,
          sku: result.entry.sku,
        });
        touchedSkus.add(result.entry.sku);
      }

      // Trigger recomputeForSku once per distinct (branchId, sku) touched
      for (const pair of touchedPairs.values()) {
        await recomputeForSku(pair.branchId, pair.sku);
      }
      if (anyDateAdded && touchedSkus.size > 0) {
        const firstSku = touchedSkus.values().next().value;
        if (firstSku) {
          await services.catalog.recomputeSingleSku(firstSku, {
            bumpVersion: false,
            fullPlanRecompute: true,
          });
        }
      } else {
        for (const sku of touchedSkus) {
          await services.catalog.recomputeSingleSku(sku, { bumpVersion: false });
        }
      }
      if (touchedSkus.size > 0) {
        await services.commitPlanVersion();
      }

      await recordImportLog({
        id: `imp_${randomUUID()}`,
        importedAt: new Date(services.runtime.now()).toISOString(),
        fileName: extracted.filename || "upload.csv",
        user: {
          userId: request.currentUser.id,
          name: request.currentUser.name,
          role: request.currentUser.role,
        },
        inserted,
        updated,
        errorCount: errors.length,
        minDate,
        maxDate,
        branchIds: Array.from(touchedBranches),
      }, false);

      return reply.code(200).send({
        inserted,
        updated,
        errors,
      });
    },
  );
}

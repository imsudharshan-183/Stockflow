import mongoose from "mongoose";
import { DataVersionModel, ImportLogModel, SalesEntryModel } from "./repositories/models.js";

export interface SalesEntryRecord {
  id: string;
  branchId: string;
  sku: string;
  date: string;
  unitsSold: number;
  onHand: number;
  updatedAt: Date;
  source?: "sample" | "reported";
}

export interface UpsertSalesEntryResult {
  entry: SalesEntryRecord;
  created: boolean;
}

export interface SalesEntryAuditRecord {
  id: string;
  entryId: string;
  branchId: string;
  sku: string;
  date: string;
  action: "CREATE" | "UPDATE" | "DELETE";
  at: string;
  actedBy: { userId: string; name: string; role: string };
  before: { unitsSold: number; onHand: number } | null;
  after: { unitsSold: number; onHand: number } | null;
}

export interface ImportLogEntry {
  id: string;
  importedAt: string;
  fileName: string;
  user: {
    userId: string;
    name: string;
    role: "admin" | "manager" | "staff";
  };
  inserted: number;
  updated: number;
  errorCount: number;
  minDate: string | null;
  maxDate: string | null;
  branchIds: string[];
}

const memorySalesEntries = new Map<string, SalesEntryRecord>();
const memorySalesEntryAudits: SalesEntryAuditRecord[] = [];
const memoryImportLogs: ImportLogEntry[] = [];

function mapSalesEntryDoc(
  doc: {
    _id?: unknown;
    branchId?: unknown;
    sku?: unknown;
    date?: unknown;
    unitsSold?: unknown;
    onHand?: unknown;
    updatedAt?: unknown;
  },
  fallbackDate?: Date,
): SalesEntryRecord {
  return {
    id: String(doc._id),
    branchId: String(doc.branchId),
    sku: String(doc.sku),
    date: String(doc.date),
    unitsSold: Number(doc.unitsSold),
    onHand: Number(doc.onHand),
    updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt : (fallbackDate ?? new Date()),
  };
}

export function clearMemorySalesEntries(): void {
  memorySalesEntries.clear();
  memorySalesEntryAudits.length = 0;
  memoryImportLogs.length = 0;
}

function makeEntryKey(branchId: string, sku: string, date: string): string {
  return `${branchId}::${sku}::${date}`;
}

type DailyObservation = Pick<SalesEntryRecord, "branchId" | "sku" | "date" | "unitsSold" | "onHand">;

export async function previewSalesImport(rows: DailyObservation[], mongo: boolean) {
  const keys = new Set(rows.map((r) => makeEntryKey(r.branchId, r.sku, r.date)));
  let existing = 0;
  if (mongo) {
    const unique = [...new Map(rows.map((r) => [makeEntryKey(r.branchId, r.sku, r.date), r])).values()];
    for (let i = 0; i < unique.length; i += 500) {
      const filters = unique.slice(i, i + 500).map(({ branchId, sku, date }) => ({ branchId, sku, date }));
      existing += await SalesEntryModel.countDocuments({ $or: filters });
    }
  } else {
    existing = [...keys].filter((key) => memorySalesEntries.has(key)).length;
  }
  const inserted = keys.size - existing;
  return { inserted, updated: rows.length - inserted };
}

export async function persistMongoSalesImport(rows: DailyObservation[], log: ImportLogEntry) {
  const session = await mongoose.startSession();
  const save = async (session?: mongoose.ClientSession) => {
    const updatedAt = new Date(log.importedAt);
    const ops = rows.map(({ branchId, sku, date, unitsSold, onHand }) => ({
      updateOne: {
        filter: { branchId, sku, date },
        update: { $set: { unitsSold, onHand, updatedAt, source: "reported" as const } },
        upsert: true,
      },
    }));
    const saved = ops.length ? await SalesEntryModel.bulkWrite(ops, { ordered: true, session }) : null;
    const inserted = saved?.upsertedCount ?? 0;
    const updated = saved?.matchedCount ?? 0;
    if (rows.length) {
      await DataVersionModel.updateOne({ _id: "current" }, { $inc: { version: 1 }, $set: { changedAt: log.importedAt } }, { session, upsert: true });
    }
    await ImportLogModel.create([{ ...log, inserted, updated }], { session });
    return { inserted, updated };
  };
  try {
    return await session.withTransaction(() => save(session));
  } catch (err) {
    if ((err as { code?: number }).code !== 20) throw err;
    return await save();
  } finally {
    await session.endSession();
  }
}

export async function upsertSalesEntry(input: {
  branchId: string;
  sku: string;
  date: string;
  unitsSold: number;
  onHand: number;
}, mongo: boolean, source: "sample" | "reported" = "reported"): Promise<UpsertSalesEntryResult> {
  const now = new Date();

  if (mongo) {
    const rawResult = await SalesEntryModel.collection.findOneAndUpdate(
      { branchId: input.branchId, sku: input.sku, date: input.date },
      {
        $set: {
          branchId: input.branchId,
          sku: input.sku,
          date: input.date,
          unitsSold: input.unitsSold,
          onHand: input.onHand,
          updatedAt: now,
          source,
        },
      },
      { upsert: true, returnDocument: "after", includeResultMetadata: true },
    );

    const updatedExisting = Boolean(rawResult.lastErrorObject?.updatedExisting);
    const doc = rawResult.value;
    const id = doc?._id ? String(doc._id) : makeEntryKey(input.branchId, input.sku, input.date);
    return {
      created: !updatedExisting,
      entry: {
        id,
        branchId: typeof doc?.branchId === "string" ? doc.branchId : input.branchId,
        sku: typeof doc?.sku === "string" ? doc.sku : input.sku,
        date: typeof doc?.date === "string" ? doc.date : input.date,
        unitsSold: typeof doc?.unitsSold === "number" ? doc.unitsSold : input.unitsSold,
        onHand: typeof doc?.onHand === "number" ? doc.onHand : input.onHand,
        updatedAt: doc?.updatedAt instanceof Date ? doc.updatedAt : now,
      },
    };
  }

  const key = makeEntryKey(input.branchId, input.sku, input.date);
  const existed = memorySalesEntries.has(key);
  const record: SalesEntryRecord = {
    id: key,
    source,
    branchId: input.branchId,
    sku: input.sku,
    date: input.date,
    unitsSold: input.unitsSold,
    onHand: input.onHand,
    updatedAt: now,
  };
  memorySalesEntries.set(key, record);
  return { entry: record, created: !existed };
}

export async function latestStockCounts(pairs: { sku: string; branchId: string }[], mongo: boolean) {
  const requested = new Map(pairs.map((pair) => [`${pair.sku}::${pair.branchId}`, pair]));
  const result = new Map<string, { date: string; updatedAt: Date; unitsSold: number }>();
  if (mongo) {
    const unique = [...requested.values()];
    for (let i = 0; i < unique.length; i += 250) {
      const rows = await SalesEntryModel.aggregate<{ _id: { sku: string; branchId: string }; date: string; updatedAt: Date; unitsSold: number }>([
        { $match: { source: { $ne: "sample" }, $or: unique.slice(i, i + 250) } },
        { $sort: { date: -1 } },
        { $group: { _id: { sku: "$sku", branchId: "$branchId" }, date: { $first: "$date" }, updatedAt: { $first: "$updatedAt" }, unitsSold: { $first: "$unitsSold" } } },
      ]);
      for (const row of rows) result.set(`${row._id.sku}::${row._id.branchId}`, row);
    }
  } else {
    for (const entry of memorySalesEntries.values()) {
      const key = `${entry.sku}::${entry.branchId}`;
      if (entry.source !== "sample" && requested.has(key) && entry.date > (result.get(key)?.date ?? "")) result.set(key, entry);
    }
  }
  return result;
}

export async function latestSubmissionDates(branchIds: readonly string[], mongo: boolean): Promise<Map<string, string>> {
  if (mongo) {
    const rows = await SalesEntryModel.aggregate<{ _id: string; date: string }>([
      { $match: { branchId: { $in: branchIds }, source: { $ne: "sample" } } },
      { $sort: { branchId: 1, date: -1 } },
      { $group: { _id: "$branchId", date: { $first: "$date" } } },
    ]);
    return new Map(rows.map((row) => [row._id, row.date]));
  }
  const allowed = new Set(branchIds);
  const latest = new Map<string, string>();
  for (const entry of memorySalesEntries.values()) {
    if (entry.source !== "sample" && allowed.has(entry.branchId) && entry.date > (latest.get(entry.branchId) ?? "")) {
      latest.set(entry.branchId, entry.date);
    }
  }
  return latest;
}

export async function reportedDailySales(branchIds: string[], date: string, mongo: boolean) {
  if (mongo) {
    return SalesEntryModel.aggregate<{ _id: string; units: number; entries: number }>([
      { $match: { branchId: { $in: branchIds }, date, source: { $ne: "sample" } } },
      { $group: { _id: "$branchId", units: { $sum: "$unitsSold" }, entries: { $sum: 1 } } },
    ]);
  }
  const allowed = new Set(branchIds);
  const rows = new Map<string, { _id: string; units: number; entries: number }>();
  for (const entry of memorySalesEntries.values()) {
    if (entry.date !== date || entry.source === "sample" || !allowed.has(entry.branchId)) continue;
    const row = rows.get(entry.branchId) ?? { _id: entry.branchId, units: 0, entries: 0 };
    row.units += entry.unitsSold;
    row.entries++;
    rows.set(entry.branchId, row);
  }
  return [...rows.values()];
}

export async function listSalesEntries(filter: {
  allowedBranchIds?: readonly string[] | null;
  branchId?: string;
  sku?: string;
  from?: string;
  to?: string;
  page: number;
  limit: number;
}, mongo: boolean): Promise<{
  entries: SalesEntryRecord[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}> {
  if (mongo) {
    const query: Record<string, unknown> = {};
    if (filter.branchId) {
      query.branchId = filter.branchId;
    } else if (filter.allowedBranchIds) {
      query.branchId = { $in: [...filter.allowedBranchIds] };
    }
    if (filter.sku) query.sku = filter.sku;
    if (filter.from || filter.to) {
      const dateFilter: Record<string, string> = {};
      if (filter.from) dateFilter.$gte = filter.from;
      if (filter.to) dateFilter.$lte = filter.to;
      query.date = dateFilter;
    }

    const total = await SalesEntryModel.collection.countDocuments(query);
    const totalPages = Math.max(1, Math.ceil(total / filter.limit));
    const page = Math.min(filter.page, totalPages);
    const skip = (page - 1) * filter.limit;
    const docs = await SalesEntryModel.collection
      .find(query)
      .sort({ date: -1, updatedAt: -1 })
      .skip(skip)
      .limit(filter.limit)
      .toArray();

    return {
      entries: docs.map((doc) => mapSalesEntryDoc(doc)),
      total,
      page,
      limit: filter.limit,
      totalPages,
    };
  }

  const allowedSet = filter.allowedBranchIds ? new Set(filter.allowedBranchIds) : null;
  const all = Array.from(memorySalesEntries.values())
    .filter((e) => {
      if (allowedSet && !allowedSet.has(e.branchId)) return false;
      if (filter.branchId && e.branchId !== filter.branchId) return false;
      if (filter.sku && e.sku !== filter.sku) return false;
      if (filter.from && e.date < filter.from) return false;
      if (filter.to && e.date > filter.to) return false;
      return true;
    })
    .sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.getTime() - a.updatedAt.getTime());

  const total = all.length;
  const totalPages = Math.max(1, Math.ceil(total / filter.limit));
  const page = Math.min(filter.page, totalPages);
  const start = (page - 1) * filter.limit;

  return {
    entries: all.slice(start, start + filter.limit),
    total,
    page,
    limit: filter.limit,
    totalPages,
  };
}

export async function getSalesEntryById(id: string, mongo: boolean): Promise<SalesEntryRecord | null> {
  if (mongo) {
    if (!mongoose.Types.ObjectId.isValid(id)) return null;
    const doc = await SalesEntryModel.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });
    if (!doc) return null;
    return mapSalesEntryDoc(doc);
  }
  return memorySalesEntries.get(id) ?? null;
}

export async function updateSalesEntryById(
  id: string,
  patch: { unitsSold?: number; onHand?: number },
  mongo: boolean,
): Promise<SalesEntryRecord | null> {
  const now = new Date();
  if (mongo) {
    if (!mongoose.Types.ObjectId.isValid(id)) return null;
    const $set: Record<string, unknown> = { updatedAt: now, source: "reported" };
    if (patch.unitsSold !== undefined) $set.unitsSold = patch.unitsSold;
    if (patch.onHand !== undefined) $set.onHand = patch.onHand;
    const doc = await SalesEntryModel.collection.findOneAndUpdate(
      { _id: new mongoose.Types.ObjectId(id) },
      { $set },
      { returnDocument: "after" },
    );
    if (!doc) return null;
    return mapSalesEntryDoc(doc, now);
  }

  const existing = memorySalesEntries.get(id);
  if (!existing) return null;
  const updated: SalesEntryRecord = {
    ...existing,
    source: "reported",
    unitsSold: patch.unitsSold ?? existing.unitsSold,
    onHand: patch.onHand ?? existing.onHand,
    updatedAt: now,
  };
  memorySalesEntries.set(id, updated);
  return updated;
}

export async function deleteSalesEntryById(id: string, mongo: boolean): Promise<SalesEntryRecord | null> {
  if (mongo) {
    if (!mongoose.Types.ObjectId.isValid(id)) return null;
    const doc = await SalesEntryModel.collection.findOneAndDelete({
      _id: new mongoose.Types.ObjectId(id),
    });
    if (!doc) return null;
    return mapSalesEntryDoc(doc);
  }

  const existing = memorySalesEntries.get(id);
  if (!existing) return null;
  memorySalesEntries.delete(id);
  return existing;
}

export async function recordSalesEntryAudit(record: SalesEntryAuditRecord, mongo: boolean): Promise<void> {
  if (mongo) {
    await mongoose.connection.collection<SalesEntryAuditRecord>("sales_entry_audits").insertOne(record);
    return;
  }
  memorySalesEntryAudits.push(record);
}

const recomputeCallLog: Array<{ branchId: string; sku: string; at: string }> = [];

export async function recomputeForSku(branchId: string, sku: string): Promise<void> {
  if (process.env.NODE_ENV !== "test") return;
  recomputeCallLog.push({ branchId, sku, at: new Date().toISOString() });
}

export function getRecomputeCallLog(): ReadonlyArray<{ branchId: string; sku: string; at: string }> {
  return recomputeCallLog;
}

export function clearRecomputeCallLog(): void {
  recomputeCallLog.length = 0;
}

export async function recordImportLog(entry: ImportLogEntry, mongo: boolean): Promise<ImportLogEntry> {
  const normalized: ImportLogEntry = {
    id: entry.id,
    importedAt: entry.importedAt,
    fileName: entry.fileName,
    user: { ...entry.user },
    inserted: entry.inserted,
    updated: entry.updated,
    errorCount: entry.errorCount,
    minDate: entry.minDate,
    maxDate: entry.maxDate,
    branchIds: [...new Set(entry.branchIds)].sort(),
  };

  if (mongo) {
    await ImportLogModel.create(normalized);
    return normalized;
  }

  memoryImportLogs.push(normalized);
  return normalized;
}

export async function listImportLogs(filter: {
  userId?: string;
  limit?: number;
}, mongo: boolean): Promise<ImportLogEntry[]> {
  const limit = Math.min(50, Math.max(1, filter.limit ?? 10));

  if (mongo) {
    const query = filter.userId ? { "user.userId": filter.userId } : {};
    const rows = await ImportLogModel.find(query)
      .sort({ importedAt: -1 })
      .limit(limit)
      .lean();
    return rows.map((row) => ({
      id: String(row.id),
      importedAt: String(row.importedAt),
      fileName: String(row.fileName),
      user: {
        userId: String(row.user?.userId ?? ""),
        name: String(row.user?.name ?? ""),
        role: (row.user?.role ?? "staff") as "admin" | "manager" | "staff",
      },
      inserted: Number(row.inserted ?? 0),
      updated: Number(row.updated ?? 0),
      errorCount: Number(row.errorCount ?? 0),
      minDate: row.minDate ? String(row.minDate) : null,
      maxDate: row.maxDate ? String(row.maxDate) : null,
      branchIds: Array.isArray(row.branchIds) ? row.branchIds.map(String) : [],
    }));
  }

  return [...memoryImportLogs]
    .filter((item) => (!filter.userId ? true : item.user.userId === filter.userId))
    .sort((a, b) => b.importedAt.localeCompare(a.importedAt))
    .slice(0, limit);
}

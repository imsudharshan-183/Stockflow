import mongoose from "mongoose";
import { SalesEntryModel } from "./repositories/models.js";

const DEFAULT_MONGO_URI = "mongodb://localhost:27017/stockflow";

export interface SalesEntryRecord {
  branchId: string;
  sku: string;
  date: string;
  unitsSold: number;
  onHand: number;
  updatedAt: Date;
}

export interface UpsertSalesEntryResult {
  entry: SalesEntryRecord;
  created: boolean;
}

let sharedConnectionPromise: Promise<typeof mongoose> | null = null;

/**
 * Connects to the `stockflow` MongoDB database using MONGODB_URI
 * (defaulting to mongodb://localhost:27017/stockflow for local dev)
 * and ensures the unique compound index on sales_entries (branchId, sku, date).
 * Reuses a single shared connection across requests.
 */
export async function connectDb(uri?: string): Promise<mongoose.mongo.Db> {
  if (mongoose.connection.readyState === 1 && mongoose.connection.db) {
    return mongoose.connection.db;
  }
  const targetUri = (uri ?? process.env.MONGODB_URI)?.trim() || DEFAULT_MONGO_URI;
  if (!sharedConnectionPromise) {
    sharedConnectionPromise = mongoose
      .connect(targetUri, { dbName: "stockflow", serverSelectionTimeoutMS: 15000 })
      .then(async (m) => {
        await SalesEntryModel.createIndexes();
        return m;
      })
      .catch((err: unknown) => {
        sharedConnectionPromise = null;
        throw err;
      });
  }
  await sharedConnectionPromise;
  if (!mongoose.connection.db) {
    throw new Error("MongoDB connection established without db handle");
  }
  return mongoose.connection.db;
}

/**
 * Returns the active MongoDB Db instance if connected, or null when running in memory mode.
 */
export function getDb(): mongoose.mongo.Db | null {
  return mongoose.connection.readyState === 1 && mongoose.connection.db
    ? mongoose.connection.db
    : null;
}

// In-memory store fallback used when running in memory repository mode (dev/test without Mongo daemon)
const memorySalesEntries = new Map<string, SalesEntryRecord>();

export function clearMemorySalesEntries(): void {
  memorySalesEntries.clear();
}

/**
 * Upserts a sales entry on (branchId, sku, date) into MongoDB `sales_entries`
 * (when connected) or the in-memory store fallback.
 */
export async function upsertSalesEntry(input: {
  branchId: string;
  sku: string;
  date: string;
  unitsSold: number;
  onHand: number;
}): Promise<UpsertSalesEntryResult> {
  const now = new Date();

  if (mongoose.connection.readyState === 1 && mongoose.connection.db) {
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
        },
      },
      { upsert: true, returnDocument: "after", includeResultMetadata: true },
    );

    const updatedExisting = Boolean(rawResult.lastErrorObject?.updatedExisting);
    const doc = rawResult.value;
    return {
      created: !updatedExisting,
      entry: {
        branchId: typeof doc?.branchId === "string" ? doc.branchId : input.branchId,
        sku: typeof doc?.sku === "string" ? doc.sku : input.sku,
        date: typeof doc?.date === "string" ? doc.date : input.date,
        unitsSold: typeof doc?.unitsSold === "number" ? doc.unitsSold : input.unitsSold,
        onHand: typeof doc?.onHand === "number" ? doc.onHand : input.onHand,
        updatedAt: doc?.updatedAt instanceof Date ? doc.updatedAt : now,
      },
    };
  }

  const key = `${input.branchId}::${input.sku}::${input.date}`;
  const existed = memorySalesEntries.has(key);
  const record: SalesEntryRecord = {
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

const recomputeCallLog: Array<{ branchId: string; sku: string; at: string }> = [];

/**
 * Stub hook called after sales entry writes to recompute recommendations for a touched (branchId, sku).
 * Ready to be wired to the incremental engine recomputation.
 */
export function recomputeForSku(branchId: string, sku: string): Promise<void> {
  recomputeCallLog.push({ branchId, sku, at: new Date().toISOString() });
  return Promise.resolve();
}

export function getRecomputeCallLog(): ReadonlyArray<{ branchId: string; sku: string; at: string }> {
  return recomputeCallLog;
}

export function clearRecomputeCallLog(): void {
  recomputeCallLog.length = 0;
}

export { SalesEntryModel };

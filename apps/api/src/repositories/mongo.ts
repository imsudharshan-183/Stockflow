import {
  ActionRecordSchema,
  AuditEntrySchema,
  DEFAULT_POLICY,
  KpiSummarySchema,
  PositionStatusSchema,
  RecommendationSchema,
  StockAlertSchema,
  analyze,
  generateDataset,
  ProductChangeRecordSchema,
  type ActedBy,
  type ActionRecord,
  type Analysis,
  type AuditEntry,
  type Branch,
  type Dataset,
  type Product,
  type ProductChangeRecord,
  type StockAlert,
} from "@stockflow/core";
import { gunzipSync, gzipSync } from "node:zlib";
import mongoose from "mongoose";
import { z } from "zod";
import { clearMemorySalesEntries } from "../db.js";
import {
  ActionModel,
  AuditModel,
  DataVersionModel,
  FactModel,
  MetaModel,
  MetaShape,
  PlanCacheModel,
  PlanModel,
  ProductChangeModel,
  RefreshTokenModel,
  SalesEntryModel,
  SeriesModel,
  SeriesShape,
  StockAlertModel,
  UserModel,
} from "./models.js";
import type { CachedPlanRecord, SaveDecisionBatchResult, StockRepository } from "./types.js";
import { MongoUserRepository } from "./mongoUser.js";
import { getInitialSeedUsers } from "./seedData.js";

const SERIES_BATCH = 400;
const FACT_BATCH = 5000;

type MongoCache = { uri: string; pending: Promise<void> };
const globalCache = globalThis as typeof globalThis & { __stockflowMongo?: MongoCache };

const PositionShape = z.object({
  skuIndex: z.number(),
  branchIndex: z.number(),
  onHand: z.number(),
  velocity: z.number(),
  sigma: z.number(),
  inStockDays: z.number(),
  safetyStock: z.number(),
  reorderPoint: z.number(),
  coverDays: z.number().nullable(),
  status: PositionStatusSchema,
  surplus: z.number(),
  need: z.number(),
  lostUnits: z.number(),
  leadTimeDays: z.number(),
});

const PlanShape = z.object({
  recommendations: z.array(RecommendationSchema),
  kpis: KpiSummarySchema,
  positions: z.array(z.array(PositionShape)),
});

export class MongoRepository implements StockRepository {
  readonly kind = "mongo" as const;
  readonly users: MongoUserRepository;

  constructor(
    private readonly uri?: string,
    private readonly dbName = "stockflow",
  ) {
    this.users = new MongoUserRepository(() => this.ensureConnected());
  }

  static createLazy(uri: string, dbName = "stockflow"): MongoRepository {
    return new MongoRepository(uri, dbName);
  }

  static async connect(uri: string, dbName = "stockflow"): Promise<MongoRepository> {
    const repo = new MongoRepository(uri, dbName);
    await repo.ensureConnected();
    return repo;
  }

  async ensureConnected(): Promise<void> {
    if (mongoose.connection.readyState === 1) return;
    if (!this.uri) return;
    const uri = this.uri;
    const dbName = this.dbName;
    const current = globalCache.__stockflowMongo;
    if (!current || current.uri !== uri) {
      const pending = mongoose
        .connect(uri, { dbName, serverSelectionTimeoutMS: 8000 })
        .then(async () => {
          await FactModel.createIndexes();
          await SeriesModel.createIndexes();
          await SalesEntryModel.createIndexes();
          await PlanCacheModel.createIndexes();
          await StockAlertModel.createIndexes();
        });
      pending.catch(() => {
        if (globalCache.__stockflowMongo?.pending === pending) delete globalCache.__stockflowMongo;
      });
      globalCache.__stockflowMongo = { uri, pending };
    }
    const pending = globalCache.__stockflowMongo?.pending;
    if (!pending) throw new Error("MongoDB connection was not started");
    await pending;
  }

  async ping(): Promise<void> {
    await this.ensureConnected();
    const db = mongoose.connection.db;
    if (!db) {
      throw new Error("MongoDB connection has no active database handle");
    }
    await db.admin().ping();
  }

  // IMPORTANT: Seeding is a full destructive reset and will wipe any branch (or product) added through the admin UI.
  async seed(customDataset?: Dataset, cleanAll = true): Promise<void> {
    await this.ensureConnected();
    clearMemorySalesEntries();
    await dropIfExists(MetaModel);
    await dropIfExists(SeriesModel);
    await dropIfExists(FactModel);
    if (cleanAll) {
      await Promise.all([
        dropIfExists(ActionModel),
        dropIfExists(AuditModel),
        dropIfExists(DataVersionModel),
        dropIfExists(PlanModel),
        dropIfExists(PlanCacheModel),
        dropIfExists(ProductChangeModel),
        dropIfExists(RefreshTokenModel),
        dropIfExists(SalesEntryModel),
        dropIfExists(StockAlertModel),
        dropIfExists(UserModel),
        dropCollectionByName("products"),
        dropCollectionByName("sales_entries"),
        dropCollectionByName("stock_alerts"),
        dropCollectionByName("branches"),
        dropCollectionByName("audits"),
        dropCollectionByName("product_changes"),
        dropCollectionByName("plan_cache"),
        dropCollectionByName("data_version"),
      ]);
    }
    await UserModel.createIndexes();
    await RefreshTokenModel.createIndexes();
    await FactModel.createIndexes();
    await SeriesModel.createIndexes();
    await SalesEntryModel.createIndexes();
    await PlanCacheModel.createIndexes();
    await ActionModel.createIndexes();
    await ProductChangeModel.createIndexes();
    await StockAlertModel.createIndexes();
    const data = customDataset ?? generateDataset();
    await this.persist(data);
    const initialAnalysis = analyze(data, DEFAULT_POLICY);
    await this.saveAnalysis(initialAnalysis);
    await DataVersionModel.replaceOne({ _id: "current" }, { _id: "current", version: 1 }, { upsert: true });
    await PlanCacheModel.deleteMany({});
    await this.saveCachedPlan(1, initialAnalysis);
    const adminPassword = process.env.ADMIN_PASSWORD?.trim() || "Admin@12345";
    for (const u of getInitialSeedUsers(adminPassword)) {
      await UserModel.findOneAndUpdate({ id: u.id }, { $set: u }, { upsert: true });
    }
  }

  async loadDataset(): Promise<Dataset> {
    await this.ensureConnected();
    const existing: unknown = await MetaModel.findById("dataset").lean();
    if (existing === null) throw new Error("MongoDB has no seeded dataset. Run pnpm seed:mongo.");
    return this.read(MetaShape.parse(existing));
  }

  async loadAnalysis(): Promise<Analysis | null> {
    await this.ensureConnected();
    const existing: unknown = await PlanModel.findById("morning").lean();
    if (existing === null) return null;
    return PlanShape.parse(existing);
  }

  async saveAnalysis(analysis: Analysis): Promise<void> {
    await this.ensureConnected();
    await PlanModel.replaceOne({ _id: "morning" }, { _id: "morning", ...analysis }, { upsert: true });
  }

  async getDataVersion(): Promise<number> {
    await this.ensureConnected();
    const doc = await DataVersionModel.findById("current").lean();
    return typeof doc?.version === "number" ? doc.version : 1;
  }

  async bumpDataVersion(): Promise<number> {
    await this.ensureConnected();
    const doc = await DataVersionModel.findOneAndUpdate(
      { _id: "current" },
      { $inc: { version: 1 } },
      { upsert: true, new: true },
    ).lean();
    return typeof doc?.version === "number" ? doc.version : 1;
  }

  async loadCachedPlan(dataVersion: number): Promise<CachedPlanRecord | null> {
    await this.ensureConnected();
    const doc = await PlanCacheModel.findOne({ dataVersion }).lean();
    if (!doc) return null;
    let rawPlan: unknown = doc.plan;
    if (doc.planCompressed) {
      const buf = Buffer.isBuffer(doc.planCompressed)
        ? doc.planCompressed
        : Buffer.from((doc.planCompressed as { buffer: Uint8Array }).buffer);
      rawPlan = JSON.parse(gunzipSync(buf).toString("utf8"));
    }
    return {
      dataVersion: doc.dataVersion,
      computedAt: doc.computedAt,
      plan: PlanShape.parse(rawPlan),
    };
  }

  async saveCachedPlan(dataVersion: number, plan: Analysis): Promise<void> {
    await this.ensureConnected();
    const compressed = gzipSync(Buffer.from(JSON.stringify(plan), "utf8"));
    // Keep well under MongoDB's 16 MiB BSON document limit.
    if (compressed.byteLength > 15_000_000) {
      throw new Error(`Compressed plan (${compressed.byteLength} bytes) exceeds 15 MB safety limit`);
    }
    await PlanCacheModel.replaceOne(
      { dataVersion },
      {
        dataVersion,
        computedAt: new Date().toISOString(),
        planCompressed: compressed,
      },
      { upsert: true },
    );
  }

  async listActions(): Promise<ActionRecord[]> {
    await this.ensureConnected();
    const rows: unknown = await ActionModel.find().lean();
    if (!Array.isArray(rows)) throw new Error("action query failed");
    return rows.map((row) => ActionRecordSchema.parse(row));
  }

  async saveAction(record: ActionRecord): Promise<void> {
    await this.ensureConnected();
    await ActionModel.create(ActionRecordSchema.parse(record));
  }

  async saveActions(records: ActionRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.ensureConnected();
    await ActionModel.insertMany(records.map((record) => ActionRecordSchema.parse(record)));
  }

  async listAudit(): Promise<AuditEntry[]> {
    await this.ensureConnected();
    const rows: unknown = await AuditModel.find().lean();
    if (!Array.isArray(rows)) throw new Error("audit query failed");
    return rows.map((row) => AuditEntrySchema.parse(row));
  }

  async saveAudit(entry: AuditEntry): Promise<void> {
    await this.ensureConnected();
    await AuditModel.create(AuditEntrySchema.parse(entry));
  }

  async saveAudits(entries: AuditEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.ensureConnected();
    await AuditModel.insertMany(entries.map((entry) => AuditEntrySchema.parse(entry)));
  }

  private async extractDuplicateRecIds(error: unknown, pendingRecords: ActionRecord[]): Promise<Set<string> | null> {
    const dupIds = new Set<string>();
    const err = error as {
      code?: number;
      message?: string;
      keyValue?: { recommendationId?: string };
      writeErrors?: Array<{ code?: number; index?: number; err?: { code?: number; index?: number } }>;
    };
    if (Array.isArray(err.writeErrors) && err.writeErrors.length > 0) {
      let allDup = true;
      for (const we of err.writeErrors) {
        const code = we.code ?? we.err?.code;
        const idx = we.index ?? we.err?.index;
        if (code === 11000 && typeof idx === "number" && pendingRecords[idx]) {
          dupIds.add(pendingRecords[idx]!.recommendationId);
        } else {
          allDup = false;
        }
      }
      if (allDup && dupIds.size > 0) return dupIds;
    }
    const isDup = err.code === 11000 || (typeof err.message === "string" && err.message.includes("E11000"));
    if (isDup) {
      if (typeof err.keyValue?.recommendationId === "string") {
        dupIds.add(err.keyValue.recommendationId);
        return dupIds;
      }
      const existing = await ActionModel.find(
        { recommendationId: { $in: pendingRecords.map((r) => r.recommendationId) } },
        { recommendationId: 1 },
      ).lean();
      for (const row of existing) {
        if (typeof row.recommendationId === "string") dupIds.add(row.recommendationId);
      }
      if (dupIds.size > 0) return dupIds;
    }
    return null;
  }

  private isTransactionUnsupported(error: unknown): boolean {
    const err = error as { code?: number; message?: string };
    return (
      err.code === 20 ||
      (typeof err.message === "string" && err.message.includes("Transaction numbers are only allowed"))
    );
  }

  async saveDecisionBatch(records: ActionRecord[], entries: AuditEntry[]): Promise<SaveDecisionBatchResult> {
    const persistedIds = new Set<string>();
    const duplicateIds = new Set<string>();
    if (records.length === 0) return { persistedIds, duplicateIds };
    await this.ensureConnected();

    const entryByRecId = new Map(entries.map((e) => [e.recommendationId, AuditEntrySchema.parse(e)]));
    let pendingRecords: ActionRecord[] = [];
    const seen = new Set<string>();
    for (const raw of records) {
      const parsed = ActionRecordSchema.parse(raw);
      if (seen.has(parsed.recommendationId)) {
        duplicateIds.add(parsed.recommendationId);
        continue;
      }
      seen.add(parsed.recommendationId);
      pendingRecords.push(parsed);
    }

    const session = await mongoose.startSession();
    let useTransaction = true;
    try {
      while (pendingRecords.length > 0 && useTransaction) {
        const pendingEntries = pendingRecords.map((r) => {
          const e = entryByRecId.get(r.recommendationId);
          if (!e) throw new Error(`Missing audit entry for ${r.recommendationId}`);
          return e;
        });
        try {
          await session.withTransaction(async () => {
            await ActionModel.insertMany(pendingRecords, { ordered: false, session });
            await AuditModel.insertMany(pendingEntries, { session });
          });
          for (const r of pendingRecords) persistedIds.add(r.recommendationId);
          pendingRecords = [];
        } catch (err) {
          if (this.isTransactionUnsupported(err)) {
            useTransaction = false;
            break;
          }
          const dup = await this.extractDuplicateRecIds(err, pendingRecords);
          if (!dup) throw err;
          for (const id of dup) duplicateIds.add(id);
          pendingRecords = pendingRecords.filter((r) => !dup.has(r.recommendationId));
        }
      }
    } finally {
      await session.endSession();
    }

    // Fallback for standalone MongoDB without replica-set transactions:
    // Write audit entries first, then actions; clean up audit rows for duplicate actions.
    if (!useTransaction && pendingRecords.length > 0) {
      const pendingEntries = pendingRecords.map((r) => {
        const e = entryByRecId.get(r.recommendationId);
        if (!e) throw new Error(`Missing audit entry for ${r.recommendationId}`);
        return e;
      });
      await AuditModel.insertMany(pendingEntries, { ordered: false });
      try {
        await ActionModel.insertMany(pendingRecords, { ordered: false });
        for (const r of pendingRecords) persistedIds.add(r.recommendationId);
      } catch (err) {
        const dup = await this.extractDuplicateRecIds(err, pendingRecords);
        if (!dup) throw err;
        for (const id of dup) duplicateIds.add(id);
        const dupAuditIds: string[] = [];
        for (const r of pendingRecords) {
          if (dup.has(r.recommendationId)) {
            dupAuditIds.push(r.id);
          } else {
            persistedIds.add(r.recommendationId);
          }
        }
        if (dupAuditIds.length > 0) {
          await AuditModel.deleteMany({ id: { $in: dupAuditIds } });
        }
      }
    }

    return { persistedIds, duplicateIds };
  }

  async saveProduct(product: Product): Promise<void> {
    await this.ensureConnected();
    const updated = await MetaModel.updateOne(
      { _id: "dataset", "products.sku": product.sku },
      { $set: { "products.$": product } },
    );
    if (updated.matchedCount === 0) {
      await MetaModel.updateOne(
        { _id: "dataset" },
        { $push: { products: product } },
      );
    }
  }

  async saveBranch(branch: Branch): Promise<void> {
    await this.ensureConnected();
    const updated = await MetaModel.updateOne(
      { _id: "dataset", "branches.id": branch.id },
      { $set: { "branches.$": branch } },
    );
    if (updated.matchedCount === 0) {
      await MetaModel.updateOne(
        { _id: "dataset" },
        { $push: { branches: branch } },
      );
    }
  }

  async removeProduct(sku: string): Promise<void> {
    await this.ensureConnected();
    await MetaModel.updateOne(
      { _id: "dataset" },
      { $pull: { products: { sku } } },
    );
    await SeriesModel.deleteMany({ sku });
    await FactModel.deleteMany({ sku });
  }

  async listProductChanges(sku: string): Promise<ProductChangeRecord[]> {
    await this.ensureConnected();
    const rows = await ProductChangeModel.find({ sku }).sort({ at: -1 }).lean();
    return rows.map((r) => ProductChangeRecordSchema.parse(r));
  }

  async saveProductChange(change: ProductChangeRecord): Promise<void> {
    await this.ensureConnected();
    await ProductChangeModel.create(ProductChangeRecordSchema.parse(change));
  }

  async hasHistoryOrAudits(sku: string): Promise<{ hasSales: boolean; hasAudits: boolean }> {
    await this.ensureConnected();
    const [auditCount, salesEntryCount, factCount] = await Promise.all([
      AuditModel.countDocuments({ sku }),
      SalesEntryModel.countDocuments({ sku, unitsSold: { $gt: 0 } }),
      FactModel.countDocuments({ sku, units: { $gt: 0 } }),
    ]);
    return {
      hasAudits: auditCount > 0,
      hasSales: salesEntryCount > 0 || factCount > 0,
    };
  }

  databaseName(): string {
    return mongoose.connection.db?.databaseName ?? mongoose.connection.name ?? this.dbName;
  }

  async clearDecisions(): Promise<{ actionsRemoved: number; auditsRemoved: number }> {
    await this.ensureConnected();
    const [actionsRes, auditsRes] = await Promise.all([
      ActionModel.deleteMany({}),
      AuditModel.deleteMany({}),
    ]);
    return {
      actionsRemoved: actionsRes.deletedCount ?? 0,
      auditsRemoved: auditsRes.deletedCount ?? 0,
    };
  }

  async listStockAlerts(): Promise<StockAlert[]> {
    await this.ensureConnected();
    const rows = await StockAlertModel.find().sort({ flaggedAt: -1 }).lean();
    return rows.map((row) => StockAlertSchema.parse(row));
  }

  async getStockAlert(id: string): Promise<StockAlert | null> {
    await this.ensureConnected();
    const row = await StockAlertModel.findOne({ id }).lean();
    return row ? StockAlertSchema.parse(row) : null;
  }

  async createStockAlert(alert: StockAlert): Promise<StockAlert> {
    await this.ensureConnected();
    const parsed = StockAlertSchema.parse(alert);
    await StockAlertModel.create(parsed);
    return parsed;
  }

  async decideStockAlert(
    id: string,
    decision: "APPROVED" | "REJECTED",
    decidedBy: ActedBy,
    decidedAt: string,
  ): Promise<
    | { status: "decided"; alert: StockAlert }
    | { status: "not_found" }
    | { status: "already_decided"; alert: StockAlert }
  > {
    await this.ensureConnected();
    // DECISION: Conditional atomic findOneAndUpdate({ id, status: "PENDING" }) prevents TOCTOU races
    // under concurrent manager reviews without needing a multi-document transaction; a null match lets us
    // cleanly separate "not_found" from "already_decided" (409) via a follow-up lookup.
    const updated = await StockAlertModel.findOneAndUpdate(
      { id, status: "PENDING" },
      { $set: { status: decision, decidedBy, decidedAt } },
      { new: true },
    ).lean();
    if (updated) {
      return { status: "decided", alert: StockAlertSchema.parse(updated) };
    }
    const existing = await StockAlertModel.findOne({ id }).lean();
    if (!existing) {
      return { status: "not_found" };
    }
    return { status: "already_decided", alert: StockAlertSchema.parse(existing) };
  }

  async close(): Promise<void> {
    delete globalCache.__stockflowMongo;
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  }

  private async persist(data: Dataset): Promise<void> {
    const docs = [];
    for (let sku = 0; sku < data.products.length; sku += 1) {
      const product = data.products[sku];
      const sales = data.sales[sku];
      const onHand = data.onHand[sku];
      const demand = data.demand[sku];
      if (!product || !sales || !onHand || !demand) throw new Error(`missing series for sku ${sku}`);
      for (let branch = 0; branch < data.branches.length; branch += 1) {
        const branchRow = data.branches[branch];
        if (!branchRow || !sales[branch] || !onHand[branch] || !demand[branch]) {
          throw new Error(`missing series for ${product.sku}`);
        }
        docs.push({
          sku: product.sku,
          branchId: branchRow.id,
          sales: sales[branch],
          onHand: onHand[branch],
          demand: demand[branch],
        });
      }
    }
    for (let offset = 0; offset < docs.length; offset += SERIES_BATCH) {
      await SeriesModel.insertMany(docs.slice(offset, offset + SERIES_BATCH));
    }
    await insertFacts(data);
    await MetaModel.create({
      _id: "dataset",
      seed: data.seed,
      asOf: data.asOf,
      dates: data.dates,
      branches: data.branches,
      products: data.products,
    });
  }

  private async read(meta: z.infer<typeof MetaShape>): Promise<Dataset> {
    const rows: unknown = await SeriesModel.find().lean();
    if (!Array.isArray(rows)) throw new Error("series query failed");
    const byKey = new Map<string, z.infer<typeof SeriesShape>>();
    for (const row of rows) {
      const series = SeriesShape.parse(row);
      byKey.set(`${series.sku}|${series.branchId}`, series);
    }
    const sales: number[][][] = [];
    const onHand: number[][][] = [];
    const demand: number[][][] = [];
    for (const product of meta.products) {
      const skuSales: number[][] = [];
      const skuStock: number[][] = [];
      const skuDemand: number[][] = [];
      for (const branch of meta.branches) {
        const series = byKey.get(`${product.sku}|${branch.id}`);
        if (!series) {
          // Cold-start fallback for awaiting_history SKUs and newly created admin branches without pre-seeded series.
          const zeros = new Array(meta.dates.length).fill(0);
          skuSales.push(zeros);
          skuStock.push([...zeros]);
          skuDemand.push([...zeros]);
          continue;
        }
        if (series.sales.length !== meta.dates.length) {
          throw new Error(`series length mismatch for ${product.sku} at ${branch.id}`);
        }
        skuSales.push(series.sales);
        skuStock.push(series.onHand);
        skuDemand.push(series.demand);
      }
      sales.push(skuSales);
      onHand.push(skuStock);
      demand.push(skuDemand);
    }
    const dataset: Dataset = {
      seed: meta.seed,
      asOf: meta.asOf,
      dates: meta.dates,
      branches: meta.branches,
      products: meta.products,
      sales,
      onHand,
      demand,
    };

    const entries = await SalesEntryModel.find().lean();
    if (entries.length > 0) {
      const skuIndexBySku = new Map(dataset.products.map((p, i) => [p.sku, i]));
      const branchIndexById = new Map(dataset.branches.map((b, i) => [b.id, i]));
      const dateIndexByDate = new Map(dataset.dates.map((d, i) => [d, i]));
      const lastDateIdx = dataset.dates.length - 1;
      for (const entry of entries) {
        const sIdx = skuIndexBySku.get(entry.sku);
        const bIdx = branchIndexById.get(entry.branchId);
        if (sIdx === undefined || bIdx === undefined) continue;
        const dIdx = dateIndexByDate.get(entry.date) ?? lastDateIdx;
        if (dIdx < 0) continue;
        const salesRow = dataset.sales[sIdx]?.[bIdx];
        const onHandRow = dataset.onHand[sIdx]?.[bIdx];
        const demandRow = dataset.demand[sIdx]?.[bIdx];
        if (salesRow && onHandRow && demandRow) {
          salesRow[dIdx] = entry.unitsSold;
          onHandRow[dIdx] = entry.onHand;
          demandRow[dIdx] = entry.unitsSold;
        }
      }
    }

    return dataset;
  }
}

async function dropIfExists(model: { collection: mongoose.Collection }): Promise<void> {
  await dropCollectionByName(model.collection.name);
}

async function dropCollectionByName(name: string): Promise<void> {
  const listed = await mongoose.connection.db?.listCollections({ name }).toArray();
  if (listed && listed.length > 0) {
    await mongoose.connection.db?.dropCollection(name);
  }
}

function money(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

async function insertFacts(data: Dataset): Promise<void> {
  type FactDoc = { branchId: string; sku: string; date: string; units: number; revenue: number; onHand: number };
  let batch: FactDoc[] = [];
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    await FactModel.insertMany(batch, { ordered: false });
    batch = [];
  };

  for (let sku = 0; sku < data.products.length; sku += 1) {
    const product = data.products[sku];
    const sales = data.sales[sku];
    const stock = data.onHand[sku];
    if (!product || !sales || !stock) throw new Error(`missing facts for sku ${sku}`);
    for (let branch = 0; branch < data.branches.length; branch += 1) {
      const branchRow = data.branches[branch];
      const unitsRow = sales[branch];
      const stockRow = stock[branch];
      if (!branchRow || !unitsRow || !stockRow) throw new Error(`missing facts for ${product.sku}`);
      for (let day = 0; day < data.dates.length; day += 1) {
        const date = data.dates[day];
        const units = unitsRow[day];
        const onHand = stockRow[day];
        if (date === undefined || units === undefined || onHand === undefined) {
          throw new Error(`missing day for ${product.sku}`);
        }
        batch.push({
          branchId: branchRow.id,
          sku: product.sku,
          date,
          units,
          revenue: money(units * product.price),
          onHand,
        });
        if (batch.length >= FACT_BATCH) await flush();
      }
    }
  }
  await flush();
}

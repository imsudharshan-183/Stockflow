import {
  ActionMetaRecordSchema,
  ApiAuditEntrySchema,
  BranchSchema,
  DEFAULT_POLICY,
  KpiSummarySchema,
  OrderEventSchema,
  PositionStatusSchema,
  RecommendationSchema,
  ReplenishmentOrderSchema,
  StoreOrderSchema,
  StockAlertResolutionSchema,
  StockAlertSchema,
  analyze,
  generateDataset,
  ProductChangeRecordSchema,
  type ActedBy,
  type Analysis,
  type Branch,
  type Dataset,
  type OrderEvent,
  type OrderListQuery,
  type OrderStatus,
  type Product,
  type ProductChangeRecord,
  type ReplenishmentOrder,
  type StockAlert,
  type StockAlertResolution,
} from "@stockflow/core";
import { gunzip, gzip } from "node:zlib";
import { promisify } from "node:util";
import mongoose from "mongoose";
import { z } from "zod";
import { clearMemorySalesEntries } from "../db.js";
import {
  ActionModel,
  AuditModel,
  BranchModel,
  DataVersionModel,
  FactModel,
  ImportLogModel,
  MetaModel,
  MetaShape,
  OrderEventModel,
  PlanCacheModel,
  PlanModel,
  ProductChangeModel,
  RefreshTokenModel,
  ReplenishmentOrderModel,
  SalesEntryModel,
  SeriesModel,
  SeriesShape,
  StockAlertModel,
  UserModel,
} from "./models.js";
import type {
  ActionMetaRecord,
  ApiAuditEntry,
  CachedPlanRecord,
  AllocationGuard,
  OrderLifecycleMeta,
  ResolveStockAlertOrderPayload,
  ResolveStockAlertResult,
  SaveDecisionBatchResult,
  SaveOrderWithEventResult,
  StockRepository,
} from "./types.js";
import { MongoUserRepository } from "./mongoUser.js";
import { getInitialSeedUsers } from "./seedData.js";

const SERIES_BATCH = 400;
const compressPlan = promisify(gzip);
const decompressPlan = promisify(gunzip);

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
          await ImportLogModel.createIndexes();
          await BranchModel.createIndexes();
          await PlanCacheModel.createIndexes();
          await StockAlertModel.createIndexes();
          await ReplenishmentOrderModel.createIndexes();
          await OrderEventModel.createIndexes();
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
        dropIfExists(ReplenishmentOrderModel),
        dropIfExists(OrderEventModel),
        dropIfExists(ImportLogModel),
        dropIfExists(BranchModel),
        dropIfExists(UserModel),
        dropCollectionByName("products"),
        dropCollectionByName("sales_entries"),
        dropCollectionByName("import_log"),
        dropCollectionByName("stock_alerts"),
        dropCollectionByName("replenishment_orders"),
        dropCollectionByName("order_events"),
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
    await ImportLogModel.createIndexes();
    await BranchModel.createIndexes();
    await PlanCacheModel.createIndexes();
    await ActionModel.createIndexes();
    await ProductChangeModel.createIndexes();
    await StockAlertModel.createIndexes();
    await ReplenishmentOrderModel.createIndexes();
    await OrderEventModel.createIndexes();
    const data = customDataset ?? generateDataset();
    if (data.branches.length > 0) {
      for (const b of data.branches) {
        const parsed = BranchSchema.parse(b);
        await BranchModel.findOneAndUpdate({ id: parsed.id }, { $set: parsed }, { upsert: true });
      }
    }
    await this.persist(data);
    const initialAnalysis = analyze(data, DEFAULT_POLICY);
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
    const [existing, branchDocs] = await Promise.all([
      MetaModel.findById("dataset").lean(),
      BranchModel.find().lean(),
    ]);
    if (existing === null) throw new Error("MongoDB has no seeded dataset. Run pnpm seed:mongo.");
    const meta = MetaShape.parse(existing);
    if (branchDocs.length > 0) {
      const byId = new Map<string, z.infer<typeof BranchSchema>>();
      for (const doc of branchDocs) {
        const parsed = BranchSchema.parse(doc);
        byId.set(parsed.id, parsed);
      }
      const merged: z.infer<typeof BranchSchema>[] = meta.branches.map((b) => byId.get(b.id) ?? b);
      const seenIds = new Set(merged.map((b) => b.id));
      for (const b of byId.values()) {
        if (!seenIds.has(b.id)) {
          merged.push(b);
          seenIds.add(b.id);
        }
      }
      meta.branches = merged;
    }
    return this.read(meta);
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

  async getPhysicalChangeTime(version: number) {
    const doc = await DataVersionModel.findOne({ _id: "current", version }).select("changedAt").lean();
    return doc?.changedAt ?? undefined;
  }

  async bumpDataVersion(): Promise<number> {
    await this.ensureConnected();
    const doc = await DataVersionModel.findOneAndUpdate(
      { _id: "current" },
      { $inc: { version: 1 }, $set: { changedAt: new Date().toISOString() } },
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
      rawPlan = JSON.parse((await decompressPlan(buf)).toString("utf8"));
    }
    return {
      dataVersion: doc.dataVersion,
      computedAt: doc.computedAt,
      plan: PlanShape.parse(rawPlan),
    };
  }

  async saveCachedPlan(dataVersion: number, plan: Analysis): Promise<void> {
    await this.ensureConnected();
    const compressed = await compressPlan(Buffer.from(JSON.stringify(plan), "utf8"));
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
    await PlanCacheModel.deleteMany({ dataVersion: { $lt: dataVersion - 1 } });
  }

  async listActions(): Promise<ActionMetaRecord[]> {
    await this.ensureConnected();
    const rows: unknown = await ActionModel.find().lean();
    if (!Array.isArray(rows)) throw new Error("action query failed");
    return rows.map((row) => normalizeActionRow(row as Record<string, unknown>));
  }

  async saveAction(record: ActionMetaRecord): Promise<void> {
    await this.ensureConnected();
    const parsed = stripUndefinedKeys(ActionMetaRecordSchema.parse(record));
    await ActionModel.create(parsed);
  }

  async saveActions(records: ActionMetaRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.ensureConnected();
    await ActionModel.insertMany(
      records.map((record) => stripUndefinedKeys(ActionMetaRecordSchema.parse(record))),
    );
  }

  async listAudit(): Promise<ApiAuditEntry[]> {
    await this.ensureConnected();
    const rows: unknown = await AuditModel.find().lean();
    if (!Array.isArray(rows)) throw new Error("audit query failed");
    return rows.map((row) => normalizeAuditRow(row as Record<string, unknown>));
  }

  async saveAudit(entry: ApiAuditEntry): Promise<void> {
    await this.ensureConnected();
    await AuditModel.create(stripUndefinedKeys(ApiAuditEntrySchema.parse(entry)));
  }

  async saveAudits(entries: ApiAuditEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.ensureConnected();
    await AuditModel.insertMany(
      entries.map((entry) => stripUndefinedKeys(ApiAuditEntrySchema.parse(entry))),
    );
  }

  private async extractDuplicateRecIds(error: unknown, pendingRecords: ActionMetaRecord[]): Promise<Set<string> | null> {
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

  async saveDecisionBatch(
    records: ActionMetaRecord[],
    entries: ApiAuditEntry[],
    options?: { allowOverwriteIds?: ReadonlySet<string>; allocationGuard?: AllocationGuard },
  ): Promise<SaveDecisionBatchResult> {
    const persistedIds = new Set<string>();
    const duplicateIds = new Set<string>();
    if (records.length === 0) return { persistedIds, duplicateIds };
    await this.ensureConnected();

    const allowOverwrite = options?.allowOverwriteIds;
    const entryByRecId = new Map(
      entries.map((e) => [e.recommendationId, stripUndefinedKeys(ApiAuditEntrySchema.parse(e))]),
    );
    const overwriteRecords: ActionMetaRecord[] = [];
    let pendingRecords: ActionMetaRecord[] = [];
    const seen = new Set<string>();
    for (const raw of records) {
      const parsed = stripUndefinedKeys(ActionMetaRecordSchema.parse(raw));
      if (seen.has(parsed.recommendationId)) {
        duplicateIds.add(parsed.recommendationId);
        continue;
      }
      seen.add(parsed.recommendationId);
      if (allowOverwrite?.has(parsed.recommendationId)) {
        overwriteRecords.push(parsed);
      } else {
        pendingRecords.push(parsed);
      }
    }

    const session = await mongoose.startSession();
    let useTransaction = true;
    try {
      while ((pendingRecords.length > 0 || overwriteRecords.length > 0) && useTransaction) {
        const allThisRound = [...pendingRecords, ...overwriteRecords];
        const pendingEntries = allThisRound.map((r) => {
          const e = entryByRecId.get(r.recommendationId);
          if (!e) throw new Error(`Missing audit entry for ${r.recommendationId}`);
          return e;
        });
        try {
          await session.withTransaction(async () => {
            if (options?.allocationGuard) await guardAllocation(options.allocationGuard, session);
            if (pendingRecords.length > 0) {
              await ActionModel.insertMany(pendingRecords, { ordered: false, session });
            }
            for (const rec of overwriteRecords) {
              await ActionModel.findOneAndUpdate(
                { recommendationId: rec.recommendationId },
                {
                  $set: {
                    id: rec.id,
                    status: rec.status,
                    decidedAt: rec.decidedAt,
                    reasonCode: rec.reasonCode ?? null,
                    comment: rec.comment ?? null,
                    snapshot: rec.snapshot ?? null,
                    rejectedUntil: rec.rejectedUntil ?? null,
                    reopenedAt: rec.reopenedAt ?? null,
                  },
                },
                { upsert: true, session },
              );
            }
            await AuditModel.insertMany(pendingEntries, { session });
          });
          for (const r of allThisRound) persistedIds.add(r.recommendationId);
          pendingRecords = [];
          overwriteRecords.length = 0;
        } catch (err) {
          if (this.isTransactionUnsupported(err)) {
            useTransaction = false;
            break;
          }
          const dup =
            pendingRecords.length > 0
              ? await this.extractDuplicateRecIds(err, pendingRecords)
              : null;
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
    if (!useTransaction && (pendingRecords.length > 0 || overwriteRecords.length > 0)) {
      const allThisRound = [...pendingRecords, ...overwriteRecords];
      const pendingEntries = allThisRound.map((r) => {
        const e = entryByRecId.get(r.recommendationId);
        if (!e) throw new Error(`Missing audit entry for ${r.recommendationId}`);
        return e;
      });
      await AuditModel.insertMany(pendingEntries, { ordered: false });
      for (const rec of overwriteRecords) {
        await ActionModel.findOneAndUpdate(
          { recommendationId: rec.recommendationId },
          {
            $set: {
              id: rec.id,
              status: rec.status,
              decidedAt: rec.decidedAt,
              reasonCode: rec.reasonCode ?? null,
              comment: rec.comment ?? null,
              snapshot: rec.snapshot ?? null,
              rejectedUntil: rec.rejectedUntil ?? null,
              reopenedAt: rec.reopenedAt ?? null,
            },
          },
          { upsert: true },
        );
        persistedIds.add(rec.recommendationId);
      }
      if (pendingRecords.length > 0) {
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
    }

    return { persistedIds, duplicateIds };
  }

  async reopenAction(
    recommendationId: string,
    reopenedAt: string,
    auditEntry: ApiAuditEntry,
  ): Promise<boolean> {
    await this.ensureConnected();
    const parsedEntry = stripUndefinedKeys(ApiAuditEntrySchema.parse(auditEntry));
    const existing = await ActionModel.findOne({ recommendationId }).lean();
    if (!existing) return false;

    const session = await mongoose.startSession();
    let useTransaction = true;
    let updatedFlag = false;
    try {
      await session.withTransaction(async () => {
        const res = await ActionModel.findOneAndUpdate(
          { recommendationId },
          { $set: { reopenedAt } },
          { new: true, session },
        ).lean();
        if (!res) return;
        updatedFlag = true;
        await AuditModel.create([parsedEntry], { session });
      });
    } catch (err) {
      if (this.isTransactionUnsupported(err)) {
        useTransaction = false;
      } else {
        throw err;
      }
    } finally {
      await session.endSession();
    }

    if (useTransaction) return updatedFlag;

    const prevReopenedAt = existing.reopenedAt ?? null;
    await ActionModel.updateOne({ recommendationId }, { $set: { reopenedAt } });
    try {
      await AuditModel.create(parsedEntry);
    } catch (err) {
      await ActionModel.updateOne({ recommendationId }, { $set: { reopenedAt: prevReopenedAt } });
      throw err;
    }
    return true;
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
    const parsed = BranchSchema.parse(branch);
    await BranchModel.findOneAndUpdate(
      { id: parsed.id },
      { $set: parsed },
      { upsert: true },
    );
    const updated = await MetaModel.updateOne(
      { _id: "dataset", "branches.id": parsed.id },
      { $set: { "branches.$": parsed } },
    );
    if (updated.matchedCount === 0) {
      await MetaModel.updateOne(
        { _id: "dataset" },
        { $push: { branches: parsed } },
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
    const [auditCount, salesEntryCount, seedSales] = await Promise.all([
      AuditModel.countDocuments({ sku }),
      SalesEntryModel.countDocuments({ sku, unitsSold: { $gt: 0 } }),
      SeriesModel.exists({ sku, sales: { $elemMatch: { $gt: 0 } } }),
    ]);
    return {
      hasAudits: auditCount > 0,
      hasSales: salesEntryCount > 0 || Boolean(seedSales),
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
      ReplenishmentOrderModel.deleteMany({}),
      OrderEventModel.deleteMany({}),
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

  async resolveStockAlert(
    id: string,
    resolution: StockAlertResolution,
    linkedOrder?: ResolveStockAlertOrderPayload,
  ): Promise<ResolveStockAlertResult> {
    await this.ensureConnected();
    // Strip undefined own properties so Schema.Types.Mixed never persists them as BSON null.
    const parsedResolution = stripUndefinedKeys(StockAlertResolutionSchema.parse(resolution));

    let preparedOrder: { orderDoc: Omit<ReplenishmentOrder, "events">; parsedEvent: OrderEvent } | null =
      null;
    if (linkedOrder) {
      const parsedOrder = ReplenishmentOrderSchema.parse({ ...linkedOrder.order, events: [] });
      const parsedEvent = OrderEventSchema.parse(linkedOrder.event);
      const { events: _events, ...orderDoc } = parsedOrder;
      preparedOrder = { orderDoc, parsedEvent };
    }

    const session = await mongoose.startSession();
    let useTransaction = true;
    let txResult: ResolveStockAlertResult | null = null;
    let updatedAlertDoc: unknown = null;

    try {
      await session.withTransaction(async () => {
        const updated = await StockAlertModel.findOneAndUpdate(
          { id, status: "PENDING" },
          {
            $set: {
              status: "RESOLVED",
              decidedBy: parsedResolution.decidedBy,
              decidedAt: parsedResolution.decidedAt,
              resolution: parsedResolution,
            },
          },
          { new: true, session },
        ).lean();
        if (!updated) {
          throw new AlertNotPendingConflict();
        }
        updatedAlertDoc = updated;
        if (preparedOrder) {
          await ReplenishmentOrderModel.create([preparedOrder.orderDoc], { session });
          await OrderEventModel.create([preparedOrder.parsedEvent], { session });
        }
      });

      const alert = StockAlertSchema.parse(updatedAlertDoc);
      const order = preparedOrder ? await this.getOrder(preparedOrder.orderDoc.id) : null;
      txResult = { status: "resolved", alert, order };
    } catch (err) {
      if (err instanceof AlertNotPendingConflict) {
        const existing = await StockAlertModel.findOne({ id }).lean();
        txResult = existing
          ? { status: "already_decided", alert: StockAlertSchema.parse(existing) }
          : { status: "not_found" };
      } else if (this.isTransactionUnsupported(err)) {
        useTransaction = false;
      } else {
        throw err;
      }
    } finally {
      await session.endSession();
    }

    if (useTransaction && txResult) {
      return txResult;
    }

    // Fallback for standalone MongoDB without replica-set transactions:
    // Compensate alert status + order doc manually if creating the linked order or event fails.
    const updated = await StockAlertModel.findOneAndUpdate(
      { id, status: "PENDING" },
      {
        $set: {
          status: "RESOLVED",
          decidedBy: parsedResolution.decidedBy,
          decidedAt: parsedResolution.decidedAt,
          resolution: parsedResolution,
        },
      },
      { new: true },
    ).lean();
    if (!updated) {
      const existing = await StockAlertModel.findOne({ id }).lean();
      if (!existing) {
        return { status: "not_found" };
      }
      return { status: "already_decided", alert: StockAlertSchema.parse(existing) };
    }

    if (preparedOrder) {
      let orderInserted = false;
      try {
        await ReplenishmentOrderModel.create(preparedOrder.orderDoc);
        orderInserted = true;
        await OrderEventModel.create(preparedOrder.parsedEvent);
      } catch (err) {
        if (orderInserted) {
          await ReplenishmentOrderModel.deleteOne({ id: preparedOrder.orderDoc.id });
        }
        await StockAlertModel.updateOne(
          { id },
          {
            $set: {
              status: "PENDING",
              decidedBy: null,
              decidedAt: null,
              resolution: null,
            },
          },
        );
        throw err;
      }
    }

    const alert = StockAlertSchema.parse(updated);
    const order = preparedOrder ? await this.getOrder(preparedOrder.orderDoc.id) : null;
    return { status: "resolved", alert, order };
  }

  private isDuplicateKeyError(error: unknown): boolean {
    const err = error as { code?: number; message?: string };
    return err.code === 11000 || (typeof err.message === "string" && err.message.includes("E11000"));
  }

  async listOrderHistory(query: OrderListQuery, branches: readonly string[] | null) {
    await this.ensureConnected();
    const scopeFilter = (ids: readonly string[]) => ({ $or: [
      { targetBranchId: { $in: ids } }, { type: "TRANSFER", sourceBranchId: { $in: ids } },
    ] });
    const pipeline: mongoose.PipelineStage[] = [];
    if (branches) pipeline.push({ $match: scopeFilter(branches) });
    if (query.branch) pipeline.push({ $match: scopeFilter([query.branch]) });
    if (query.status) pipeline.push({ $match: { status: query.status } });
    if (query.type) pipeline.push({ $match: { type: query.type } });
    const events = { $lookup: { from: OrderEventModel.collection.name, localField: "id", foreignField: "orderId",
      pipeline: [{ $sort: { at: 1 as const, _id: 1 as const } }], as: "events" } };
    if (query.search) {
      const pattern = new RegExp(query.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      pipeline.push(events, { $match: { $or: ["sku", "productName", "id", "sourceBranchId", "sourceBranchName",
        "targetBranchId", "targetBranchName", "events.actor.name", "events.comment"].map((key) => ({ [key]: pattern })) } });
    }
    pipeline.push({ $sort: { updatedAt: -1, id: 1 } }, { $facet: {
      count: [{ $count: "total" }],
      orders: [{ $skip: ((query.historyPage ?? 1) - 1) * 25 }, { $limit: 25 }, ...(query.search ? [] : [events])],
    } });
    const [page] = await ReplenishmentOrderModel.aggregate(pipeline);
    return { orders: ReplenishmentOrderSchema.array().parse(page?.orders ?? []), total: Number(page?.count[0]?.total ?? 0) };
  }

  async listStoreDeliveries(branchId: string) {
    await this.ensureConnected();
    const rows = await ReplenishmentOrderModel.find({
      targetBranchId: branchId, status: "COMMITTED", type: { $in: ["TRANSFER", "REORDER"] },
    }).select(Object.keys(StoreOrderSchema.shape).join(" ")).sort({ updatedAt: -1 }).lean();
    return rows.map((row) => StoreOrderSchema.parse(row));
  }

  async getOrderEventCount(): Promise<number> {
    await this.ensureConnected();
    return OrderEventModel.countDocuments({}).hint("_id_");
  }

  async getAllocationRevision(): Promise<number> {
    await this.ensureConnected();
    const current = await DataVersionModel.findById("current").select("allocationRevision").lean();
    return current?.allocationRevision ?? 0;
  }

  async listOrders(): Promise<ReplenishmentOrder[]> {
    await this.ensureConnected();
    const [orderRows, eventRows] = await Promise.all([
      ReplenishmentOrderModel.find().lean(),
      OrderEventModel.find().sort({ at: 1 }).lean(),
    ]);
    const eventsByOrder = new Map<string, OrderEvent[]>();
    for (const row of eventRows) {
      const parsed = OrderEventSchema.parse(row);
      const list = eventsByOrder.get(parsed.orderId) ?? [];
      list.push(parsed);
      eventsByOrder.set(parsed.orderId, list);
    }
    return orderRows.map((row) =>
      ReplenishmentOrderSchema.parse({
        ...row,
        events: eventsByOrder.get(String(row.id)) ?? [],
      }),
    );
  }

  async getOrder(id: string): Promise<ReplenishmentOrder | null> {
    await this.ensureConnected();
    const [row, eventRows] = await Promise.all([
      ReplenishmentOrderModel.findOne({ id }).lean(),
      OrderEventModel.find({ orderId: id }).sort({ at: 1 }).lean(),
    ]);
    if (!row) return null;
    const events = eventRows.map((e) => OrderEventSchema.parse(e));
    return ReplenishmentOrderSchema.parse({ ...row, events });
  }

  async listOrderEvents(orderId?: string): Promise<OrderEvent[]> {
    await this.ensureConnected();
    const filter = orderId ? { orderId } : {};
    const rows = await OrderEventModel.find(filter).sort({ at: 1 }).lean();
    return rows.map((row) => OrderEventSchema.parse(row));
  }

  async listOrderLifecycleMeta(): Promise<Map<string, OrderLifecycleMeta>> {
    await this.ensureConnected();
    const rows = await ReplenishmentOrderModel.find(
      {},
      { id: 1, rejectionSnapshot: 1, rejectedUntil: 1, reopenedAt: 1 },
    ).lean();
    const map = new Map<string, OrderLifecycleMeta>();
    for (const row of rows) {
      const id = String(row.id);
      const snapshotRaw = row.rejectionSnapshot as
        | { netBenefit?: number; targetCoverDays?: number | null }
        | null
        | undefined;
      map.set(id, {
        rejectionSnapshot:
          snapshotRaw && typeof snapshotRaw.netBenefit === "number"
            ? {
                netBenefit: snapshotRaw.netBenefit,
                targetCoverDays: snapshotRaw.targetCoverDays ?? null,
              }
            : null,
        rejectedUntil: row.rejectedUntil ? String(row.rejectedUntil) : null,
        reopenedAt: row.reopenedAt ? String(row.reopenedAt) : null,
      });
    }
    return map;
  }

  async saveOrderWithEvent(
    order: ReplenishmentOrder,
    event: OrderEvent,
    expectedStatus: OrderStatus | null,
    lifecycleMeta?: OrderLifecycleMeta,
    allocationGuard?: AllocationGuard,
  ): Promise<SaveOrderWithEventResult> {
    await this.ensureConnected();
    const parsedOrder = ReplenishmentOrderSchema.parse({ ...order, events: [] });
    const parsedEvent = OrderEventSchema.parse(event);
    const { events: _events, ...baseOrderDoc } = parsedOrder;
    const orderDoc = lifecycleMeta
      ? {
          ...baseOrderDoc,
          ...(lifecycleMeta.rejectionSnapshot !== undefined
            ? { rejectionSnapshot: lifecycleMeta.rejectionSnapshot }
            : {}),
          ...(lifecycleMeta.rejectedUntil !== undefined
            ? { rejectedUntil: lifecycleMeta.rejectedUntil }
            : {}),
          ...(lifecycleMeta.reopenedAt !== undefined
            ? { reopenedAt: lifecycleMeta.reopenedAt }
            : {}),
        }
      : baseOrderDoc;

    const session = await mongoose.startSession();
    let useTransaction = true;
    let txResult: SaveOrderWithEventResult | null = null;
    try {
      await session.withTransaction(async () => {
        if (allocationGuard) {
          await guardAllocation(allocationGuard, session);
        }
        if (expectedStatus === null) {
          await ReplenishmentOrderModel.create([orderDoc], { session });
          await OrderEventModel.create([parsedEvent], { session });
        } else {
          const updated = await ReplenishmentOrderModel.findOneAndUpdate(
            { id: parsedOrder.id, status: expectedStatus },
            { $set: orderDoc },
            { new: true, session },
          ).lean();
          if (!updated) {
            throw new OrderOptimisticConflict();
          }
          await OrderEventModel.create([parsedEvent], { session });
        }
      });
      const hydrated = await this.getOrder(parsedOrder.id);
      if (!hydrated) {
        throw new Error(`Persisted order ${parsedOrder.id} missing after transaction`);
      }
      txResult = { status: "saved", order: hydrated };
    } catch (err) {
      if (err instanceof OrderOptimisticConflict || this.isDuplicateKeyError(err)) {
        txResult = { status: "conflict" };
      } else if (this.isTransactionUnsupported(err)) {
        useTransaction = false;
      } else {
        throw err;
      }
    } finally {
      await session.endSession();
    }

    if (useTransaction && txResult) {
      return txResult;
    }

    // Fallback for standalone MongoDB without replica-set transactions:
    // Compensate manually if writing the immutable OrderEvent fails.
    if (expectedStatus === null) {
      try {
        await ReplenishmentOrderModel.create(orderDoc);
      } catch (err) {
        if (this.isDuplicateKeyError(err)) return { status: "conflict" };
        throw err;
      }
      try {
        await OrderEventModel.create(parsedEvent);
      } catch (err) {
        await ReplenishmentOrderModel.deleteOne({ id: parsedOrder.id });
        throw err;
      }
    } else {
      const previous = await ReplenishmentOrderModel.findOne({ id: parsedOrder.id }).lean();
      if (!previous || previous.status !== expectedStatus) {
        return { status: "conflict" };
      }
      const updated = await ReplenishmentOrderModel.findOneAndUpdate(
        { id: parsedOrder.id, status: expectedStatus },
        { $set: orderDoc },
        { new: true },
      ).lean();
      if (!updated) {
        return { status: "conflict" };
      }
      try {
        await OrderEventModel.create(parsedEvent);
      } catch (err) {
        const { _id, __v, ...prevDoc } = previous as Record<string, unknown>;
        await ReplenishmentOrderModel.replaceOne({ id: parsedOrder.id }, prevDoc);
        throw err;
      }
    }

    const hydrated = await this.getOrder(parsedOrder.id);
    if (!hydrated) {
      throw new Error(`Persisted order ${parsedOrder.id} missing after save`);
    }
    return { status: "saved", order: hydrated };
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
    const byKey = new Map<string, z.infer<typeof SeriesShape>>();
    for await (const row of SeriesModel.find().lean().cursor()) {
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
      baselineThrough: meta.asOf,
      seed: meta.seed,
      asOf: meta.asOf,
      dates: meta.dates,
      branches: meta.branches,
      products: meta.products,
      sales,
      onHand,
      demand,
    };

    const skuIndex = new Map(dataset.products.map((p, i) => [p.sku, i]));
    const branchIndex = new Map(dataset.branches.map((branch, i) => [branch.id, i]));
    let dateIndex = new Map(dataset.dates.map((date, i) => [date, i]));
    // Apply each day's observations before using that closing stock for the next missing count.
    for await (const entry of SalesEntryModel.find().sort({ date: 1 }).lean().cursor()) {
      const sku = skuIndex.get(entry.sku);
      const branch = branchIndex.get(entry.branchId);
      if (sku === undefined || branch === undefined) continue;
      let day = dateIndex.get(entry.date);
      if (day === undefined) {
        const later = dataset.dates.findIndex((date) => date > entry.date);
        day = later < 0 ? dataset.dates.length : later;
        (dataset.submissions ??= {})[entry.date] = new Set();
        dataset.dates.splice(day, 0, entry.date);
        for (let p = 0; p < dataset.products.length; p++) {
          for (let b = 0; b < dataset.branches.length; b++) {
            const stock = dataset.onHand[p]![b]!;
            stock.splice(day, 0, stock[Math.max(0, day - 1)] ?? 0);
            dataset.sales[p]![b]!.splice(day, 0, 0);
            dataset.demand[p]![b]!.splice(day, 0, 0);
          }
        }
        dateIndex = new Map(dataset.dates.map((date, i) => [date, i]));
      }
      dataset.submissions?.[entry.date]?.add(`${entry.sku}::${entry.branchId}`);
      dataset.sales[sku]![branch]![day] = entry.unitsSold;
      dataset.onHand[sku]![branch]![day] = entry.onHand;
      dataset.demand[sku]![branch]![day] = entry.unitsSold;
    }
    dataset.asOf = dataset.dates.at(-1) ?? meta.asOf;
    return dataset;
  }
}

function stripUndefinedKeys<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined),
  ) as T;
}

function normalizeActionRow(row: Record<string, unknown>): ActionMetaRecord {
  const cleaned: Record<string, unknown> = {
    id: row.id,
    recommendationId: row.recommendationId,
    status: row.status,
    decidedAt: row.decidedAt,
    reopenedAt: row.reopenedAt ?? null,
  };
  if (typeof row.reasonCode === "string") cleaned.reasonCode = row.reasonCode;
  if (typeof row.comment === "string") cleaned.comment = row.comment;
  if (row.snapshot && typeof row.snapshot === "object") cleaned.snapshot = row.snapshot;
  if (typeof row.rejectedUntil === "string") cleaned.rejectedUntil = row.rejectedUntil;
  return ActionMetaRecordSchema.parse(cleaned);
}

function normalizeAuditRow(row: Record<string, unknown>): ApiAuditEntry {
  const cleaned: Record<string, unknown> = {
    id: row.id,
    at: row.at,
    user: row.user,
    recommendationId: row.recommendationId,
    decision: row.decision,
    action: row.action,
    sku: row.sku,
    productName: row.productName,
    branchId: row.branchId,
    branchName: row.branchName,
    donorBranchId: row.donorBranchId ?? null,
    netBenefit: row.netBenefit,
    reasonCodes: row.reasonCodes,
  };
  if (typeof row.reasonCode === "string") cleaned.reasonCode = row.reasonCode;
  if (typeof row.comment === "string") cleaned.comment = row.comment;
  if (row.actedBy && typeof row.actedBy === "object") cleaned.actedBy = row.actedBy;
  return ApiAuditEntrySchema.parse(cleaned);
}

class OrderOptimisticConflict extends Error {
  readonly statusCode = 409;
  constructor() {
    super("Order status conflict");
  }
}

class AlertNotPendingConflict extends Error {
  constructor() {
    super("Stock alert is missing or no longer PENDING");
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

async function guardAllocation(guard: AllocationGuard, session: mongoose.ClientSession) {
  // Serialize competing allocations against the plan and reservations used to validate quantity.
  const guarded = await DataVersionModel.updateOne({
    _id: "current",
    version: guard.dataVersion,
    $expr: { $eq: [{ $ifNull: ["$allocationRevision", 0] }, guard.revision] },
  }, { $inc: { allocationRevision: 1 } }, { session });
  if (!guarded.matchedCount) throw new OrderOptimisticConflict();
}

import {
  ActionRecordSchema,
  AuditEntrySchema,
  DEFAULT_POLICY,
  KpiSummarySchema,
  PositionStatusSchema,
  RecommendationSchema,
  analyze,
  generateDataset,
  type ActionRecord,
  type Analysis,
  type AuditEntry,
  type Dataset,
} from "@stockflow/core";
import mongoose from "mongoose";
import { z } from "zod";
import { ActionModel, AuditModel, FactModel, MetaModel, MetaShape, PlanModel, SeriesModel, SeriesShape, UserModel, RefreshTokenModel } from "./models.js";
import type { StockRepository } from "./types.js";
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
  readonly users = new MongoUserRepository();

  static async connect(uri: string): Promise<MongoRepository> {
    if (mongoose.connection.readyState === 1) return new MongoRepository();
    const current = globalCache.__stockflowMongo;
    if (!current || current.uri !== uri) {
      const pending = mongoose
        .connect(uri, { dbName: "stockflow", serverSelectionTimeoutMS: 15000 })
        .then(async () => {
          await FactModel.createIndexes();
          await SeriesModel.createIndexes();
        });
      pending.catch(() => {
        if (globalCache.__stockflowMongo?.pending === pending) delete globalCache.__stockflowMongo;
      });
      globalCache.__stockflowMongo = { uri, pending };
    }
    const pending = globalCache.__stockflowMongo?.pending;
    if (!pending) throw new Error("MongoDB connection was not started");
    await pending;
    return new MongoRepository();
  }

  async seed(): Promise<void> {
    await dropIfExists(MetaModel);
    await dropIfExists(SeriesModel);
    await dropIfExists(FactModel);
    await UserModel.createIndexes();
    await RefreshTokenModel.createIndexes();
    await FactModel.createIndexes();
    await SeriesModel.createIndexes();
    const data = generateDataset();
    await this.persist(data);
    await this.saveAnalysis(analyze(data, DEFAULT_POLICY));
    for (const u of getInitialSeedUsers()) {
      await UserModel.findOneAndUpdate({ id: u.id }, { $set: u }, { upsert: true });
    }
  }

  async loadDataset(): Promise<Dataset> {
    const existing: unknown = await MetaModel.findById("dataset").lean();
    if (existing === null) throw new Error("MongoDB has no seeded dataset. Run pnpm seed:mongo.");
    return this.read(MetaShape.parse(existing));
  }

  async loadAnalysis(): Promise<Analysis | null> {
    const existing: unknown = await PlanModel.findById("morning").lean();
    if (existing === null) return null;
    return PlanShape.parse(existing);
  }

  async saveAnalysis(analysis: Analysis): Promise<void> {
    await PlanModel.replaceOne({ _id: "morning" }, { _id: "morning", ...analysis }, { upsert: true });
  }

  async listActions(): Promise<ActionRecord[]> {
    const rows: unknown = await ActionModel.find().lean();
    if (!Array.isArray(rows)) throw new Error("action query failed");
    return rows.map((row) => ActionRecordSchema.parse(row));
  }

  async saveAction(record: ActionRecord): Promise<void> {
    await ActionModel.create(ActionRecordSchema.parse(record));
  }

  async listAudit(): Promise<AuditEntry[]> {
    const rows: unknown = await AuditModel.find().lean();
    if (!Array.isArray(rows)) throw new Error("audit query failed");
    return rows.map((row) => AuditEntrySchema.parse(row));
  }

  async saveAudit(entry: AuditEntry): Promise<void> {
    await AuditModel.create(AuditEntrySchema.parse(entry));
  }

  async close(): Promise<void> {
    delete globalCache.__stockflowMongo;
    await mongoose.disconnect();
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
        if (!series) throw new Error(`missing series for ${product.sku} at ${branch.id}`);
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
    return {
      seed: meta.seed,
      asOf: meta.asOf,
      dates: meta.dates,
      branches: meta.branches,
      products: meta.products,
      sales,
      onHand,
      demand,
    };
  }
}

async function dropIfExists(model: { collection: mongoose.Collection }): Promise<void> {
  const listed = await mongoose.connection.db?.listCollections({ name: model.collection.name }).toArray();
  if (listed && listed.length > 0) await model.collection.drop();
}

function money(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
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

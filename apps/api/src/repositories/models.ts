import { BranchSchema, IsoDateSchema, ProductSchema } from "@stockflow/core";
import mongoose, { Schema } from "mongoose";
import { z } from "zod";

const branchSchema = new Schema(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
    city: { type: String, required: true },
    region: { type: String, required: true },
  },
  { _id: false },
);

const productSchema = new Schema(
  {
    sku: { type: String, required: true },
    name: { type: String, required: true },
    category: { type: String, required: true },
    price: { type: Number, required: true },
    cost: { type: Number, required: true },
    leadTimeDays: { type: Number, required: true },
    status: { type: String, enum: ["active", "awaiting_history", "archived"], default: "active" },
  },
  { _id: false },
);

const metaSchema = new Schema({
  _id: { type: String, required: true },
  seed: { type: Number, required: true },
  asOf: { type: String, required: true },
  dates: { type: [String], required: true },
  branches: { type: [branchSchema], required: true },
  products: { type: [productSchema], required: true },
});

const seriesSchema = new Schema({
  sku: { type: String, required: true },
  branchId: { type: String, required: true },
  sales: { type: [Number], required: true },
  onHand: { type: [Number], required: true },
  demand: { type: [Number], required: true },
});
seriesSchema.index({ sku: 1, branchId: 1 }, { unique: true });

const factSchema = new Schema({
  branchId: { type: String, required: true },
  sku: { type: String, required: true },
  date: { type: String, required: true },
  units: { type: Number, required: true },
  revenue: { type: Number, required: true },
  onHand: { type: Number, required: true },
});
factSchema.index({ branchId: 1, sku: 1, date: 1 }, { unique: true });

const actionSchema = new Schema({
  id: { type: String, required: true, unique: true },
  recommendationId: { type: String, required: true, index: true },
  status: { type: String, required: true },
  decidedAt: { type: String, required: true },
});

const actedBySchema = new Schema(
  {
    userId: { type: String, required: true },
    name: { type: String, required: true },
    role: { type: String, required: true, enum: ["admin", "manager", "staff"] },
  },
  { _id: false },
);

const auditSchema = new Schema({
  id: { type: String, required: true, unique: true },
  at: { type: String, required: true },
  user: { type: String, required: true },
  recommendationId: { type: String, required: true },
  decision: { type: String, required: true },
  action: { type: String, required: true },
  sku: { type: String, required: true },
  productName: { type: String, required: true },
  branchId: { type: String, required: true },
  branchName: { type: String, required: true },
  donorBranchId: { type: String, default: null },
  netBenefit: { type: Number, required: true },
  reasonCodes: { type: [String], required: true },
  actedBy: { type: actedBySchema, required: false },
});

export const MetaShape = z.object({
  seed: z.number(),
  asOf: IsoDateSchema,
  dates: z.array(IsoDateSchema),
  branches: z.array(BranchSchema),
  products: z.array(ProductSchema),
});

export const SeriesShape = z.object({
  sku: z.string().min(1),
  branchId: z.string().min(1),
  sales: z.array(z.number()),
  onHand: z.array(z.number()),
  demand: z.array(z.number()),
});

const planSchema = new Schema({
  _id: { type: String, required: true },
  recommendations: { type: Schema.Types.Mixed, required: true },
  kpis: { type: Schema.Types.Mixed, required: true },
  positions: { type: Schema.Types.Mixed, required: true },
});

const productChangeSchema = new Schema(
  {
    id: { type: String, required: true, unique: true },
    sku: { type: String, required: true, index: true },
    at: { type: String, required: true },
    actedBy: {
      userId: { type: String, required: true },
      name: { type: String, required: true },
      role: { type: String, required: true, enum: ["admin", "manager", "staff"] },
    },
    action: { type: String, required: true, enum: ["CREATE", "UPDATE", "ARCHIVE", "RESTORE"] },
    changes: { type: Schema.Types.Mixed, required: true },
  },
  { collection: "product_changes" },
);
productChangeSchema.index({ sku: 1, at: -1 });

export const MetaModel = mongoose.model("StockflowMeta", metaSchema);
export const PlanModel = mongoose.model("StockflowPlan", planSchema);
export const SeriesModel = mongoose.model("StockflowSeries", seriesSchema);
export const FactModel = mongoose.model("StockflowFact", factSchema);
export const ActionModel = mongoose.model("StockflowAction", actionSchema);
export const AuditModel = mongoose.model("StockflowAudit", auditSchema);
export const ProductChangeModel = mongoose.model("StockflowProductChange", productChangeSchema);

const userSchema = new Schema({
  id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, required: true, enum: ["admin", "manager", "staff"] },
  branchIds: { type: [String], required: true },
  isActive: { type: Boolean, required: true, default: true },
  createdAt: { type: String, required: true },
  lastLoginAt: { type: String, default: null },
});

const refreshTokenSchema = new Schema({
  token: { type: String, required: true, unique: true },
  userId: { type: String, required: true, index: true },
  expiresAt: { type: Date, required: true, expires: 0 },
});

export const UserModel = mongoose.model("StockflowUser", userSchema);
export const RefreshTokenModel = mongoose.model("StockflowRefreshToken", refreshTokenSchema);

const salesEntrySchema = new Schema(
  {
    branchId: { type: String, required: true, trim: true },
    sku: { type: String, required: true, trim: true },
    date: { type: String, required: true, trim: true },
    unitsSold: { type: Number, required: true, min: 0 },
    onHand: { type: Number, required: true, min: 0 },
    updatedAt: { type: Date, required: true, default: () => new Date() },
  },
  { collection: "sales_entries" },
);
salesEntrySchema.index({ branchId: 1, sku: 1, date: 1 }, { unique: true });

export const SalesEntryModel = mongoose.model("SalesEntry", salesEntrySchema);

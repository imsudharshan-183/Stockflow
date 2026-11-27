import { BranchSchema, IsoDateSchema, ProductSchema } from "@stockflow/core";
import mongoose, { Schema } from "mongoose";
import { z } from "zod";

const branchSchema = new Schema(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
    city: { type: String, required: true },
    region: { type: String, required: true },
    coordinates: { type: [Number], default: undefined },
    status: { type: String, enum: ["active", "archived"], default: "active" },
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

const branchCollectionSchema = new Schema(
  {
    id: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    city: { type: String, required: true },
    region: { type: String, required: true },
    coordinates: { type: [Number], default: undefined },
    status: { type: String, enum: ["active", "archived"], default: "active" },
  },
  { collection: "branches" },
);

export const BranchModel = mongoose.model("StockflowBranch", branchCollectionSchema);

const actionSchema = new Schema({
  id: { type: String, required: true, unique: true },
  recommendationId: { type: String, required: true, unique: true },
  status: { type: String, required: true },
  decidedAt: { type: String, required: true },
  reasonCode: { type: String, required: false },
  comment: { type: String, required: false },
  snapshot: { type: Schema.Types.Mixed, required: false },
  rejectedUntil: { type: String, required: false },
  reopenedAt: { type: String, default: null },
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
  reasonCode: { type: String, required: false },
  comment: { type: String, required: false },
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

const dataVersionSchema = new Schema(
  {
    _id: { type: String, required: true },
    version: { type: Number, required: true, default: 1 },
    changedAt: { type: String },
    allocationRevision: { type: Number, default: 0 },
  },
  { collection: "data_version" },
);

const planCacheSchema = new Schema(
  {
    dataVersion: { type: Number, required: true, unique: true },
    computedAt: { type: String, required: true },
    planCompressed: { type: Buffer, required: false },
    plan: { type: Schema.Types.Mixed, required: false },
  },
  { collection: "plan_cache" },
);

export const DataVersionModel = mongoose.model("StockflowDataVersion", dataVersionSchema);
export const PlanCacheModel = mongoose.model("StockflowPlanCache", planCacheSchema);
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
  familyId: { type: String, required: false, index: true },
  revokedAt: { type: Date, default: null },
  expiresAt: { type: Date, required: true, expires: 0 },
});

export const UserModel = mongoose.model("StockflowUser", userSchema);
export const RefreshTokenModel = mongoose.model("StockflowRefreshToken", refreshTokenSchema);

const salesEntrySchema = new Schema(
  {
    branchId: { type: String, required: true, trim: true },
    sku: { type: String, required: true, trim: true },
    date: { type: String, required: true, trim: true },
    source: { type: String, enum: ["sample", "reported"] },
    simulationDay: String,
    simulationAnchor: Boolean,
    unitsSold: { type: Number, required: true, min: 0 },
    onHand: { type: Number, required: true, min: 0 },
    updatedAt: { type: Date, required: true, default: () => new Date() },
  },
  { collection: "sales_entries" },
);
salesEntrySchema.index({ date: 1 });
salesEntrySchema.index({ branchId: 1, date: -1 });
salesEntrySchema.index({ branchId: 1, sku: 1, date: 1 }, { unique: true });

export const SalesEntryModel = mongoose.model("SalesEntry", salesEntrySchema);

const stockAlertSchema = new Schema(
  {
    id: { type: String, required: true, unique: true },
    branchId: { type: String, required: true, index: true },
    branchName: { type: String, required: false },
    sku: { type: String, required: true, index: true },
    productName: { type: String, required: false },
    category: {
      type: String,
      required: true,
      enum: ["CRITICAL_LOW", "DAMAGED_SHRINKAGE", "COUNT_MISMATCH", "OTHER"],
      default: "CRITICAL_LOW",
    },
    reportedQty: { type: Number, required: false },
    flaggedBy: { type: actedBySchema, required: true },
    flaggedAt: { type: String, required: true },
    note: { type: String, required: true },
    status: {
      type: String,
      required: true,
      enum: ["PENDING", "APPROVED", "REJECTED", "RESOLVED"],
      default: "PENDING",
    },
    decidedBy: { type: actedBySchema, default: null },
    decidedAt: { type: String, default: null },
    resolution: { type: Schema.Types.Mixed, default: null },
  },
  { collection: "stock_alerts" },
);
stockAlertSchema.index({ branchId: 1, status: 1, flaggedAt: -1 });

export const StockAlertModel = mongoose.model("StockflowStockAlert", stockAlertSchema);

const replenishmentOrderSchema = new Schema(
  {
    id: { type: String, required: true, unique: true },
    origin: {
      type: String,
      required: true,
      enum: ["ENGINE", "MANAGER_REQUEST", "ALERT_ESCALATION"],
    },
    type: { type: String, required: true, enum: ["TRANSFER", "REORDER", "MARKDOWN"] },
    status: {
      type: String,
      required: true,
      enum: [
        "SUGGESTED",
        "OPEN_REQUEST",
        "AWAITING_DONOR",
        "COMMITTED",
        "RECEIVED",
        "REJECTED",
        "CANCELLED",
      ],
      index: true,
    },
    sku: { type: String, required: true },
    productName: { type: String, required: true },
    category: { type: String, required: true },
    targetBranchId: { type: String, required: true },
    targetBranchName: { type: String, required: true },
    sourceBranchId: { type: String, default: null },
    sourceBranchName: { type: String, default: null },
    quantity: { type: Number, required: true },
    qty: { type: Number, required: false },
    approvedNetBenefitBhd: { type: Number, required: false },
    approvedFreightCostBhd: { type: Number, required: false },
    requestedBy: { type: actedBySchema, default: null },
    linkedAlertId: { type: String, default: null, index: true },
    engineSnapshot: { type: Schema.Types.Mixed, required: true },
    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
    awaitingDonorSince: { type: String, default: null },
    escalatedAt: { type: String, default: null },
    committedAt: { type: String, default: null },
    receivedAt: { type: String, default: null },
    rejectionSnapshot: { type: Schema.Types.Mixed, default: null },
    rejectedUntil: { type: String, default: null },
    reopenedAt: { type: String, default: null },
  },
  { collection: "replenishment_orders" },
);
replenishmentOrderSchema.index({ targetBranchId: 1, status: 1 });
replenishmentOrderSchema.index({ sourceBranchId: 1, status: 1 });

export const ReplenishmentOrderModel = mongoose.model(
  "StockflowReplenishmentOrder",
  replenishmentOrderSchema,
);

const importLogSchema = new Schema(
  {
    id: { type: String, required: true, unique: true },
    importedAt: { type: String, required: true, index: true },
    fileName: { type: String, required: true },
    user: { type: actedBySchema, required: true },
    inserted: { type: Number, required: true, min: 0 },
    updated: { type: Number, required: true, min: 0 },
    errorCount: { type: Number, required: true, min: 0 },
    minDate: { type: String, default: null },
    maxDate: { type: String, default: null },
    branchIds: { type: [String], default: [] },
  },
  { collection: "import_log" },
);
importLogSchema.index({ importedAt: -1 });
importLogSchema.index({ "user.userId": 1, importedAt: -1 });

export const ImportLogModel = mongoose.model("StockflowImportLog", importLogSchema);

const orderEventSchema = new Schema(
  {
    id: { type: String, required: true, unique: true },
    orderId: { type: String, required: true },
    at: { type: String, required: true },
    actor: { type: actedBySchema, required: true },
    action: {
      type: String,
      required: true,
      enum: [
        "CREATED",
        "REQUEST_TRANSFER",
        "COMMIT",
        "DECLINE",
        "REROUTE",
        "CANCEL",
        "RECEIVE",
        "ESCALATE",
        "MIGRATED",
      ],
    },
    fromStatus: { type: String, default: null },
    toStatus: {
      type: String,
      required: true,
      enum: [
        "SUGGESTED",
        "OPEN_REQUEST",
        "AWAITING_DONOR",
        "COMMITTED",
        "RECEIVED",
        "REJECTED",
        "CANCELLED",
      ],
    },
    dispositionCode: { type: String, required: false },
    comment: { type: String, required: false },
    sourceBranchId: { type: String, default: null },
    quantity: { type: Number, required: false },
    engineQty: { type: Number, required: false },
    approvedQty: { type: Number, required: false },
    isAdminOverride: { type: Boolean, required: false },
  },
  { collection: "order_events" },
);
orderEventSchema.index({ orderId: 1, at: 1 });

export const OrderEventModel = mongoose.model("StockflowOrderEvent", orderEventSchema);

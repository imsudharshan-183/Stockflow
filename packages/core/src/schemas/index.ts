import { z } from "zod";
import { ActedBySchema } from "./auth.js";
export * from "./auth.js";

export const BranchSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  city: z.string().min(1),
  region: z.string().min(1),
});

export const ProductSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  category: z.string().min(1),
  price: z.number().positive(),
  cost: z.number().positive(),
  leadTimeDays: z.number().int().positive(),
});

export const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const SalesDailySchema = z.object({
  branchId: z.string().min(1),
  sku: z.string().min(1),
  date: IsoDateSchema,
  units: z.number().nonnegative(),
  revenue: z.number().nonnegative(),
});

export const InventorySnapshotSchema = z.object({
  branchId: z.string().min(1),
  sku: z.string().min(1),
  date: IsoDateSchema,
  onHand: z.number().nonnegative(),
});

export const ActionSchema = z.enum(["TRANSFER", "REORDER", "MARKDOWN"]);
export const StatusSchema = z.enum(["PENDING", "APPROVED", "REJECTED"]);
export const PositionStatusSchema = z.enum(["AT_RISK", "OVERSTOCK", "HEALTHY", "NEW"]);

export const ReasonCodeSchema = z.enum([
  "BELOW_REORDER_POINT",
  "OVERSTOCK_COVER",
  "RECEIVER_BELOW_TARGET",
  "DONOR_SURPLUS",
  "NO_DONOR",
  "NO_RECEIVER",
  "LOST_SALES_AT_RISK",
  "CARRYING_COST",
  "FREIGHT_LIMITS_QTY",
  "ZERO_VELOCITY",
  "REORDER_TO_TARGET",
  "MARKDOWN_CLEARANCE",
  "MIN_TRANSFER_MET",
]);

export const PolicySchema = z.object({
  ewmaSpanDays: z.number().positive(),
  serviceZ: z.number().positive(),
  overstockCoverDays: z.number().positive(),
  receiverCoverDays: z.number().positive(),
  donorCoverDays: z.number().positive(),
  minTransferQty: z.number().int().positive(),
  transferCostPerUnit: z.number().nonnegative(),
  annualHoldingRate: z.number().nonnegative(),
  markdownDiscount: z.number().min(0).max(1),
  deadStockHoldDays: z.number().positive(),
  backtestDays: z.number().int().positive(),
});

export const RecommendationMetricsSchema = z.object({
  onHand: z.number(),
  velocity: z.number(),
  sigmaDemand: z.number(),
  coverDays: z.number().nullable(),
  safetyStock: z.number(),
  reorderPoint: z.number(),
  lostMarginAvoided: z.number(),
  carryingCostSaved: z.number(),
  transferCost: z.number(),
  markdownCost: z.number(),
  donorOnHand: z.number().nullable(),
  donorCoverDays: z.number().nullable(),
  lostUnits: z.number(),
});

export const RecommendationSchema = z.object({
  id: z.string().min(1),
  rank: z.number().int().positive(),
  sku: z.string().min(1),
  productName: z.string().min(1),
  category: z.string().min(1),
  branchId: z.string().min(1),
  branchName: z.string().min(1),
  donorBranchId: z.string().nullable(),
  donorBranchName: z.string().nullable(),
  action: ActionSchema,
  quantity: z.number().int().positive(),
  netBenefit: z.number(),
  reasonCodes: z.array(ReasonCodeSchema).min(1),
  reason: z.string().min(1),
  status: StatusSchema,
  metrics: RecommendationMetricsSchema,
});

export const RecommendationQuerySchema = z.object({
  branch: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  action: ActionSchema.optional(),
  status: StatusSchema.optional(),
});

export const BacktestSchema = z.object({
  windowDays: z.number().int().nonnegative(),
  baselineStockoutDays: z.number().int().nonnegative(),
  engineStockoutDays: z.number().int().nonnegative(),
  stockoutDaysAvoided: z.number().int(),
  cashReleased: z.number(),
});

export const TrendPointSchema = z.object({
  date: IsoDateSchema,
  stockoutRate: z.number(),
  salesValue: z.number(),
  inventoryValue: z.number(),
});

export const BranchRiskSchema = z.object({
  branchId: z.string(),
  branchName: z.string(),
  stockoutRate: z.number(),
  revenueAtRisk: z.number(),
});

export const CoverCellSchema = z.object({
  branchId: z.string(),
  branchName: z.string(),
  category: z.string(),
  coverDays: z.number().nullable(),
});

export const KpiSchema = z.object({
  asOf: IsoDateSchema,
  stockoutRate: z.number(),
  deadStockValue: z.number(),
  lostSalesAtRisk: z.number(),
  cashReleasable: z.number(),
  backtest: BacktestSchema,
  trend: z.array(TrendPointSchema),
  branches: z.array(BranchSchema),
  categories: z.array(z.string()),
  policy: PolicySchema,
  branchRisk: z.array(BranchRiskSchema),
  coverGrid: z.array(CoverCellSchema),
});

export const KpiSummarySchema = KpiSchema;

export const BranchTrendPointSchema = z.object({
  date: IsoDateSchema,
  salesUnits: z.number(),
  salesValue: z.number(),
  onHandUnits: z.number(),
  stockoutRate: z.number(),
});

export const BranchDetailSchema = z.object({
  branch: BranchSchema,
  stockoutRate: z.number(),
  deadStockValue: z.number(),
  cashReleasable: z.number(),
  lostSalesAtRisk: z.number(),
  inventoryValue: z.number(),
  recommendations: z.array(RecommendationSchema),
  trend: z.array(BranchTrendPointSchema),
});

export const PositionViewSchema = z.object({
  branch: BranchSchema,
  onHand: z.number(),
  velocity: z.number(),
  sigmaDemand: z.number(),
  coverDays: z.number().nullable(),
  safetyStock: z.number(),
  reorderPoint: z.number(),
  leadTimeDays: z.number().int().positive(),
  inStockDays: z.number().int().nonnegative(),
  status: PositionStatusSchema,
  lostUnits: z.number(),
  recommendation: RecommendationSchema.nullable(),
});

export const SeriesPointSchema = z.object({
  date: IsoDateSchema,
  salesUnits: z.number(),
  onHand: z.number(),
  demandUnits: z.number(),
});

export const ProductDetailSchema = z.object({
  product: ProductSchema,
  policy: PolicySchema,
  positions: z.array(PositionViewSchema),
  series: z.array(
    z.object({
      branchId: z.string(),
      points: z.array(SeriesPointSchema),
    }),
  ),
});

export const HealthSchema = z.object({
  status: z.literal("ok"),
  repository: z.enum(["memory", "mongo"]),
});

export const RecommendationListSchema = z.object({
  recommendations: z.array(RecommendationSchema),
  total: z.number().int().nonnegative(),
});

export const ActionRecordSchema = z.object({
  id: z.string().min(1),
  recommendationId: z.string().min(1),
  status: z.enum(["APPROVED", "REJECTED"]),
  decidedAt: z.string().min(1),
});

export const AuditEntrySchema = z.object({
  id: z.string().min(1),
  at: z.string().min(1),
  user: z.string().min(1),
  recommendationId: z.string().min(1),
  decision: z.enum(["APPROVED", "REJECTED"]),
  action: ActionSchema,
  sku: z.string().min(1),
  productName: z.string().min(1),
  branchId: z.string().min(1),
  branchName: z.string().min(1),
  netBenefit: z.number(),
  reasonCodes: z.array(ReasonCodeSchema),
  actedBy: ActedBySchema.optional(),
});

export const AuditListSchema = z.object({
  entries: z.array(AuditEntrySchema),
});

export const ErrorBodySchema = z.object({
  error: z.string().min(1),
});

export type Branch = z.infer<typeof BranchSchema>;
export type Product = z.infer<typeof ProductSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type RecommendationStatus = z.infer<typeof StatusSchema>;
export type PositionStatus = z.infer<typeof PositionStatusSchema>;
export type ReasonCode = z.infer<typeof ReasonCodeSchema>;
export type Policy = z.infer<typeof PolicySchema>;
export type Recommendation = z.infer<typeof RecommendationSchema>;
export type RecommendationQuery = z.infer<typeof RecommendationQuerySchema>;
export type BacktestResult = z.infer<typeof BacktestSchema>;
export type TrendPoint = z.infer<typeof TrendPointSchema>;
export type BranchTrendPoint = z.infer<typeof BranchTrendPointSchema>;
export type KpiReport = z.infer<typeof KpiSchema>;
export type KpiSummary = KpiReport;
export type BranchDetail = z.infer<typeof BranchDetailSchema>;
export type ProductDetail = z.infer<typeof ProductDetailSchema>;
export type PositionView = z.infer<typeof PositionViewSchema>;
export type SalesDaily = z.infer<typeof SalesDailySchema>;
export type InventorySnapshot = z.infer<typeof InventorySnapshotSchema>;
export type ActionRecord = z.infer<typeof ActionRecordSchema>;
export type AuditEntry = z.infer<typeof AuditEntrySchema>;
export type AuditList = z.infer<typeof AuditListSchema>;
export type RecommendationList = z.infer<typeof RecommendationListSchema>;
export type ErrorBody = z.infer<typeof ErrorBodySchema>;
export type Health = z.infer<typeof HealthSchema>;
export type SeriesPoint = z.infer<typeof SeriesPointSchema>;

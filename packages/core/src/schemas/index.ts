import { z } from "zod";
import { ActedBySchema } from "./auth.js";
export * from "./auth.js";

export const BranchSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  city: z.string().min(1),
  region: z.string().min(1),
  coordinates: z.tuple([z.number(), z.number()]).optional(),
});

export const ProductStatusSchema = z.enum(["active", "awaiting_history", "archived"]);
export type ProductStatus = z.infer<typeof ProductStatusSchema>;

export const PositionStatusSchema = z.enum(["AT_RISK", "OVERSTOCK", "HEALTHY", "NEW"]);
export type PositionStatus = z.infer<typeof PositionStatusSchema>;

export const ProductStatsSchema = z.object({
  onHand: z.number(),
  velocity: z.number(),
  coverDays: z.number().nullable(),
  status: PositionStatusSchema,
  surplus: z.number().optional(),
  reserved: z.number().optional(),
  inTransit: z.number().optional(),
});
export type ProductStats = z.infer<typeof ProductStatsSchema>;

export const ProductSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  category: z.string().min(1),
  price: z.number().positive(),
  cost: z.number().positive(),
  leadTimeDays: z.number().int().positive(),
  status: ProductStatusSchema.optional(),
  stats: ProductStatsSchema.optional(),
});

export const CreateProductSchema = z
  .object({
    name: z.string().min(1, "Name is required").max(60, "Name must be 60 characters or less"),
    category: z.string().min(1, "Category is required"),
    price: z.number().positive("Price must be greater than 0"),
    cost: z.number().positive("Unit cost must be greater than 0"),
    leadTimeDays: z.number().int("Lead time must be an integer").min(1, "Lead time must be at least 1 day").max(21, "Lead time cannot exceed 21 days"),
  })
  .refine((data) => data.price > data.cost, {
    message: "Selling price must be greater than unit cost",
    path: ["price"],
  });

export const UpdateProductSchema = z
  .object({
    name: z.string().min(1, "Name cannot be empty").max(60, "Name must be 60 characters or less").optional(),
    category: z.string().min(1, "Category cannot be empty").optional(),
    price: z.number().positive("Price must be greater than 0").optional(),
    cost: z.number().positive("Unit cost must be greater than 0").optional(),
    leadTimeDays: z.number().int("Lead time must be an integer").min(1, "Lead time must be at least 1 day").max(21, "Lead time cannot exceed 21 days").optional(),
  })
  .refine(
    (data) => {
      if (data.price !== undefined && data.cost !== undefined) {
        return data.price > data.cost;
      }
      return true;
    },
    {
      message: "Selling price must be greater than unit cost",
      path: ["price"],
    },
  );

export const ProductChangeFieldSchema = z.object({
  before: z.unknown(),
  after: z.unknown(),
});

export const ProductChangeRecordSchema = z.object({
  id: z.string().min(1),
  sku: z.string().min(1),
  at: z.string().min(1),
  actedBy: z.object({
    userId: z.string().min(1),
    name: z.string().min(1),
    role: z.enum(["admin", "manager", "staff"]),
  }),
  action: z.enum(["CREATE", "UPDATE", "ARCHIVE", "RESTORE"]),
  changes: z.record(z.string(), ProductChangeFieldSchema),
});

export const ProductListQuerySchema = z.object({
  status: ProductStatusSchema.optional(),
  category: z.string().min(1).optional(),
  search: z.string().optional(),
  branch: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

export const ProductBranchSummarySchema = z.object({
  branch: BranchSchema,
  totalSkus: z.number().int().nonnegative(),
  statusCounts: z.object({
    AT_RISK: z.number().int().nonnegative(),
    HEALTHY: z.number().int().nonnegative(),
    OVERSTOCK: z.number().int().nonnegative(),
    NEW: z.number().int().nonnegative(),
  }),
});
export type ProductBranchSummary = z.infer<typeof ProductBranchSummarySchema>;

export const ProductListResponseSchema = z.object({
  products: z.array(ProductSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  totalPages: z.number().int().positive(),
  branchSummary: ProductBranchSummarySchema.optional(),
});

export const ProductDetailWithHistorySchema = z.object({
  product: ProductSchema,
  history: z.array(ProductChangeRecordSchema),
  canDeletePermanently: z.boolean(),
  cannotDeleteReason: z.string().nullable(),
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
  transferFixedCost: z.number().nonnegative(),
  transferCostPerKm: z.number().nonnegative(),
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

export const KpiOperationalRollupSchema = z.object({
  pendingApprovalsCount: z.number().int().nonnegative(),
  backlogValue: z.number(),
  atRiskBranchCount: z.number().int().nonnegative(),
});
export type KpiOperationalRollup = z.infer<typeof KpiOperationalRollupSchema>;

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
  operational: KpiOperationalRollupSchema.optional(),
  scope: z.array(z.string()).optional(),
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
  surplus: z.number().optional(),
  reserved: z.number().optional(),
  inTransit: z.number().optional(),
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
  donorBranchId: z.string().min(1).nullable().optional(),
  netBenefit: z.number(),
  reasonCodes: z.array(ReasonCodeSchema),
  reasonCode: z.string().min(1).optional(),
  actedBy: ActedBySchema.optional(),
});

export const BatchDecideRequestSchema = z
  .object({
    ids: z.array(z.string().min(1)).min(1).max(200),
    decision: z.enum(["approve", "reject"]),
    reasonCode: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.decision === "reject") {
      if (!data.reasonCode || data.reasonCode.trim().length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["reasonCode"],
          message: "reasonCode is required when decision is reject",
        });
      }
    }
  });

export const BatchDecideItemStatusSchema = z.enum(["ok", "forbidden", "not_found", "already_decided"]);

export const BatchDecideItemResultSchema = z.object({
  id: z.string().min(1),
  status: BatchDecideItemStatusSchema,
});

export const BatchDecideResponseSchema = z.object({
  results: z.array(BatchDecideItemResultSchema),
});

export const AuditListSchema = z.object({
  entries: z.array(AuditEntrySchema),
});

export const ErrorBodySchema = z.object({
  error: z.string().min(1),
});

export const LocationHealthStatusSchema = z.enum(["red", "amber", "green"]);
export type LocationHealthStatus = z.infer<typeof LocationHealthStatusSchema>;

export const LocationSummaryItemSchema = z.object({
  branch: BranchSchema,
  health: LocationHealthStatusSchema,
  atRiskCount: z.number().int().nonnegative(),
  overstockCount: z.number().int().nonnegative(),
  totalSkus: z.number().int().nonnegative(),
  pendingCount: z.number().int().nonnegative(),
  stockoutRate: z.number(),
  lostSalesAtRisk: z.number(),
  cashReleasable: z.number(),
});
export type LocationSummaryItem = z.infer<typeof LocationSummaryItemSchema>;

export const LocationListResponseSchema = z.object({
  locations: z.array(LocationSummaryItemSchema),
});
export type LocationListResponse = z.infer<typeof LocationListResponseSchema>;

export const LocationCoverBandSchema = z.object({
  band: PositionStatusSchema,
  count: z.number().int().nonnegative(),
  share: z.number(),
});
export type LocationCoverBand = z.infer<typeof LocationCoverBandSchema>;

export const LocationCategoryHeatmapCellSchema = z.object({
  category: z.string(),
  status: PositionStatusSchema,
  count: z.number().int().nonnegative(),
  value: z.number(),
});
export type LocationCategoryHeatmapCell = z.infer<typeof LocationCategoryHeatmapCellSchema>;

export const LocationTopRiskSkuSchema = z.object({
  sku: z.string(),
  name: z.string(),
  category: z.string(),
  onHand: z.number(),
  coverDays: z.number().nullable(),
  reorderPoint: z.number(),
  lostSalesAtRisk: z.number(),
  status: PositionStatusSchema,
});
export type LocationTopRiskSku = z.infer<typeof LocationTopRiskSkuSchema>;

export const LocationSummaryResponseSchema = z.object({
  branch: BranchSchema,
  asOf: IsoDateSchema,
  kpis: z.object({
    stockoutRate: z.number(),
    skusAtRisk: z.number().int().nonnegative(),
    overstockValue: z.number(),
    lostSalesAtRisk: z.number(),
    cashReleasable: z.number(),
    pendingDecisions: z.number().int().nonnegative(),
  }),
  needsStock: z.array(RecommendationSchema),
  canGive: z.array(RecommendationSchema),
  shouldMarkdown: z.array(RecommendationSchema),
  totals: z.object({
    needsStockCount: z.number().int().nonnegative(),
    needsStockValue: z.number(),
    canGiveCount: z.number().int().nonnegative(),
    canGiveValue: z.number(),
    shouldMarkdownCount: z.number().int().nonnegative(),
    shouldMarkdownValue: z.number(),
  }),
  coverBands: z.array(LocationCoverBandSchema),
  categoryHeatmap: z.array(LocationCategoryHeatmapCellSchema),
  topAtRiskSkus: z.array(LocationTopRiskSkuSchema),
  leadTimeDaysBySku: z.record(z.string(), z.number().int().positive()).optional(),
});
export type LocationSummaryResponse = z.infer<typeof LocationSummaryResponseSchema>;

export const LocationInventoryQuerySchema = z.object({
  search: z.string().optional(),
  category: z.string().optional(),
  status: PositionStatusSchema.optional(),
  sortBy: z.enum(["sku", "name", "category", "onHand", "coverDays", "reorderPoint", "status"]).default("coverDays"),
  sortDir: z.enum(["asc", "desc"]).default("asc"),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(500).default(25),
});
export type LocationInventoryQuery = z.infer<typeof LocationInventoryQuerySchema>;

export const LocationInventoryItemSchema = z.object({
  sku: z.string(),
  name: z.string(),
  category: z.string(),
  onHand: z.number(),
  velocity: z.number(),
  coverDays: z.number().nullable(),
  reorderPoint: z.number(),
  status: PositionStatusSchema,
  surplus: z.number().optional(),
  reserved: z.number().optional(),
  inTransit: z.number().optional(),
  recommendedAction: ActionSchema.nullable(),
  recommendationId: z.string().nullable(),
  netBenefit: z.number().nullable(),
});
export type LocationInventoryItem = z.infer<typeof LocationInventoryItemSchema>;

export const LocationInventoryResponseSchema = z.object({
  branch: BranchSchema,
  items: z.array(LocationInventoryItemSchema),
  categories: z.array(z.string()),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  totalPages: z.number().int().positive(),
});
export type LocationInventoryResponse = z.infer<typeof LocationInventoryResponseSchema>;

export const LocationTrendQuerySchema = z.object({
  sku: z.string().optional(),
  category: z.string().optional(),
  range: z.enum(["7", "30", "90"]).default("30"),
});
export type LocationTrendQuery = z.infer<typeof LocationTrendQuerySchema>;

export const LocationTrendPointSchema = z.object({
  date: IsoDateSchema,
  salesUnits: z.number(),
  onHandUnits: z.number(),
});
export type LocationTrendPoint = z.infer<typeof LocationTrendPointSchema>;

export const LocationTrendResponseSchema = z.object({
  branch: BranchSchema,
  sku: z.string().nullable(),
  category: z.string().nullable(),
  range: z.enum(["7", "30", "90"]),
  points: z.array(LocationTrendPointSchema),
});
export type LocationTrendResponse = z.infer<typeof LocationTrendResponseSchema>;

export const StockAlertStatusSchema = z.enum(["PENDING", "APPROVED", "REJECTED"]);
export type StockAlertStatus = z.infer<typeof StockAlertStatusSchema>;

export const StockAlertCategorySchema = z.enum([
  "CRITICAL_LOW",
  "DAMAGED_SHRINKAGE",
  "COUNT_MISMATCH",
]);
export type StockAlertCategory = z.infer<typeof StockAlertCategorySchema>;

export const StockAlertSchema = z.object({
  id: z.string().min(1),
  branchId: z.string().min(1),
  branchName: z.string().min(1).optional(),
  sku: z.string().min(1),
  productName: z.string().min(1).optional(),
  category: StockAlertCategorySchema.default("CRITICAL_LOW"),
  flaggedBy: ActedBySchema,
  flaggedAt: z.string().min(1),
  note: z.string().min(1).max(500),
  status: StockAlertStatusSchema,
  decidedBy: ActedBySchema.nullable(),
  decidedAt: z.string().nullable(),
});
export type StockAlert = z.infer<typeof StockAlertSchema>;

export const CreateStockAlertSchema = z.object({
  branchId: z.string().min(1),
  sku: z.string().min(1),
  category: StockAlertCategorySchema.default("CRITICAL_LOW"),
  note: z.string().trim().min(1, "Note is required").max(500),
});
export type CreateStockAlert = z.input<typeof CreateStockAlertSchema>;

export const StockAlertQuerySchema = z.object({
  branchId: z.string().trim().min(1).optional(),
});
export type StockAlertQuery = z.infer<typeof StockAlertQuerySchema>;

export const StockAlertListSchema = z.object({
  alerts: z.array(StockAlertSchema),
});
export type StockAlertList = z.infer<typeof StockAlertListSchema>;

export type Branch = z.infer<typeof BranchSchema>;
export type Product = z.infer<typeof ProductSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type RecommendationStatus = z.infer<typeof StatusSchema>;
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
export type CreateProduct = z.infer<typeof CreateProductSchema>;
export type UpdateProduct = z.infer<typeof UpdateProductSchema>;
export type ProductChangeField = z.infer<typeof ProductChangeFieldSchema>;
export type ProductChangeRecord = z.infer<typeof ProductChangeRecordSchema>;
export type ProductListQuery = z.infer<typeof ProductListQuerySchema>;
export type ProductListResponse = z.infer<typeof ProductListResponseSchema>;
export type ProductDetailWithHistory = z.infer<typeof ProductDetailWithHistorySchema>;
export type BatchDecideRequest = z.infer<typeof BatchDecideRequestSchema>;
export type BatchDecideItemStatus = z.infer<typeof BatchDecideItemStatusSchema>;
export type BatchDecideItemResult = z.infer<typeof BatchDecideItemResultSchema>;
export type BatchDecideResponse = z.infer<typeof BatchDecideResponseSchema>;

/**
 * Shared Zod contracts for queue lifecycle views, API audit rows, and live overview freshness.
 */
import { z } from "zod";
import { ReplenishmentOrderSchema } from "../orders.js";
import { ActedBySchema } from "./auth.js";
import {
  ActionSchema,
  KpiSummarySchema,
  ReasonCodeSchema,
  RecommendationSchema,
} from "./index.js";

export const QueueLifecycleViewSchema = z.enum(["pending", "in_progress", "decided"]);
export type QueueLifecycleView = z.infer<typeof QueueLifecycleViewSchema>;

export const DecisionSnapshotSchema = z.object({
  netBenefit: z.number(),
  targetCoverDays: z.number().nullable(),
});
export type DecisionSnapshot = z.infer<typeof DecisionSnapshotSchema>;

export const ActionMetaRecordSchema = z.object({
  id: z.string().min(1),
  recommendationId: z.string().min(1),
  status: z.enum(["APPROVED", "REJECTED"]),
  decidedAt: z.string().min(1),
  reasonCode: z.string().optional(),
  comment: z.string().optional(),
  snapshot: DecisionSnapshotSchema.optional(),
  rejectedUntil: z.string().optional(),
  reopenedAt: z.string().nullable().optional(),
});
export type ActionMetaRecord = z.infer<typeof ActionMetaRecordSchema>;

export const ReopenBadgeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("snooze_expired"),
    daysAgo: z.number().int().positive(),
    reason: z.string(),
    label: z.string(),
  }),
  z.object({
    kind: z.literal("worsened"),
    label: z.string(),
  }),
]);
export type ReopenBadge = z.infer<typeof ReopenBadgeSchema>;

export const LifecycleFieldsSchema = z.object({
  lifecycleState: QueueLifecycleViewSchema.optional(),
  reopenBadge: ReopenBadgeSchema.nullable().optional(),
  canReopen: z.boolean().optional(),
  decidedAt: z.string().nullable().optional(),
  rejectedUntil: z.string().nullable().optional(),
});

export const LifecycleRecommendationSchema = RecommendationSchema.merge(LifecycleFieldsSchema);
export type LifecycleRecommendation = z.infer<typeof LifecycleRecommendationSchema>;

export const LifecycleRecommendationListSchema = z.object({
  recommendations: z.array(LifecycleRecommendationSchema),
  total: z.number().int().nonnegative(),
  totalNetBenefit: z.number().optional(),
  view: QueueLifecycleViewSchema.optional(),
});
export type LifecycleRecommendationList = z.infer<typeof LifecycleRecommendationListSchema>;

export const LifecycleOrderSchema = ReplenishmentOrderSchema.merge(LifecycleFieldsSchema);
export type LifecycleOrder = z.infer<typeof LifecycleOrderSchema>;

export const LifecycleOrderListResponseSchema = z.object({
  orders: z.array(LifecycleOrderSchema),
  total: z.number().int().nonnegative(),
  totalNetBenefit: z.number().optional(),
  view: QueueLifecycleViewSchema.optional(),
});
export type LifecycleOrderListResponse = z.infer<typeof LifecycleOrderListResponseSchema>;

export const ApiAuditEntrySchema = z.object({
  id: z.string().min(1),
  at: z.string().min(1),
  user: z.string().min(1),
  recommendationId: z.string().min(1),
  decision: z.enum(["APPROVED", "REJECTED", "REOPENED"]),
  action: ActionSchema,
  sku: z.string().min(1),
  productName: z.string().min(1),
  branchId: z.string().min(1),
  branchName: z.string().min(1),
  donorBranchId: z.string().nullable(),
  netBenefit: z.number(),
  reasonCodes: z.array(ReasonCodeSchema).min(1),
  reasonCode: z.string().optional(),
  comment: z.string().optional(),
  actedBy: ActedBySchema.optional(),
});
export type ApiAuditEntry = z.infer<typeof ApiAuditEntrySchema>;

export const ApiAuditListSchema = z.object({
  entries: z.array(ApiAuditEntrySchema),
});
export type ApiAuditList = z.infer<typeof ApiAuditListSchema>;

export const LiveKpiMetricSchema = z.object({
  value: z.number(),
  computedAt: z.string().min(1),
  dataVersion: z.number().int().nonnegative(),
  decisionVersion: z.number().int().nonnegative(),
});
export type LiveKpiMetric = z.infer<typeof LiveKpiMetricSchema>;

export const OverviewFreshnessMetaSchema = z.object({
  computedAt: z.string().min(1),
  dataVersion: z.number().int().nonnegative(),
  decisionVersion: z.number().int().nonnegative(),
  todayBahrain: z.string().min(1),
  reportingBranches: z.array(z.object({ branchId: z.string(), lastSubmitted: z.string().nullable() })).optional(),
  asOfDataDate: z.string().min(1),
  staleDataDays: z.number().int().nonnegative(),
});
export type OverviewFreshnessMeta = z.infer<typeof OverviewFreshnessMetaSchema>;

export const LiveOverviewMetricsSchema = z.object({
  stockoutRate: LiveKpiMetricSchema,
  stockoutRateDelta28d: LiveKpiMetricSchema,
  overstockValue: LiveKpiMetricSchema,
  deadStockValue: LiveKpiMetricSchema,
  salesAtRisk: LiveKpiMetricSchema,
  pendingActionsCount: LiveKpiMetricSchema,
  pendingEstimatedGain: LiveKpiMetricSchema,
});
export type LiveOverviewMetrics = z.infer<typeof LiveOverviewMetricsSchema>;

export const LiveOverviewResponseSchema = z.object({
  report: KpiSummarySchema,
  meta: OverviewFreshnessMetaSchema,
  metrics: LiveOverviewMetricsSchema,
  stockoutSparkline: z.array(z.number()),
  handoffs: z.array(z.object({
    id: z.string(), sku: z.string(), productName: z.string(), units: z.number(),
    source: z.string(), destination: z.string(), needsRelease: z.boolean(), overdue: z.boolean(),
  })).optional(),
  shortages: z.array(z.object({
    branchId: z.string(), branchName: z.string(), sku: z.string(), name: z.string(), coverDays: z.number(),
  })).optional(),
  pendingRecommendations: z.array(LifecycleRecommendationSchema),
});
export type LiveOverviewResponse = z.infer<typeof LiveOverviewResponseSchema>;

export const KpisWithMetaResponseSchema = KpiSummarySchema.extend({
  meta: OverviewFreshnessMetaSchema,
  metrics: LiveOverviewMetricsSchema,
  stockoutSparkline: z.array(z.number()),
});
export type KpisWithMetaResponse = z.infer<typeof KpisWithMetaResponseSchema>;

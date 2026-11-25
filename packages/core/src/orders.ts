import { z } from "zod";
import { ActedBySchema, type Role } from "./schemas/auth.js";
import {
  DonorCandidateSchema,
  OrderStatusSchema,
  OrderTypeSchema,
  ReasonCodeSchema,
  RecommendationMetricsSchema,
  StockAlertSchema,
  type OrderStatus,
  type OrderType,
} from "./schemas/index.js";

export { OrderStatusSchema, OrderTypeSchema, type OrderStatus, type OrderType };

export const DEFAULT_DONOR_ESCALATION_HOURS = 24;

export const OrderOriginSchema = z.enum(["ENGINE", "MANAGER_REQUEST", "ALERT_ESCALATION"]);
export type OrderOrigin = z.infer<typeof OrderOriginSchema>;

export const OrderTransitionActionSchema = z.enum([
  "REQUEST_TRANSFER",
  "COMMIT",
  "DECLINE",
  "REROUTE",
  "CANCEL",
  "RECEIVE",
]);
export type OrderTransitionAction = z.infer<typeof OrderTransitionActionSchema>;

export const OrderEventActionSchema = z.enum([
  "CREATED",
  "REQUEST_TRANSFER",
  "COMMIT",
  "DECLINE",
  "REROUTE",
  "CANCEL",
  "RECEIVE",
  "ESCALATE",
  "MIGRATED",
]);
export type OrderEventAction = z.infer<typeof OrderEventActionSchema>;

export const ActorRefSchema = ActedBySchema;
export type ActorRef = z.infer<typeof ActorRefSchema>;

export const QuantityChangeReasonSchema = z.enum([
  "CASE_PACK",
  "TRUCK_CAPACITY",
  "PROMO_HOLD",
  "OTHER",
]);
export type QuantityChangeReason = z.infer<typeof QuantityChangeReasonSchema>;

export const OrderEngineSnapshotSchema = z.object({
  recommendationId: z.string().min(1).nullable().optional(),
  qty: z.number().int().positive().optional(),
  netBenefitBhd: z.number(),
  reasonCodes: z.array(ReasonCodeSchema),
  reason: z.string(),
  distanceKm: z.number().nullable().optional(),
  freightCostBhd: z.number().optional(),
  unitPrice: z.number().nonnegative().optional(),
  unitCost: z.number().nonnegative().optional(),
  donorVelocity: z.number().nonnegative().optional(),
  metrics: RecommendationMetricsSchema.optional(),
});
export type OrderEngineSnapshot = z.infer<typeof OrderEngineSnapshotSchema>;

export const OrderEventSchema = z.object({
  id: z.string().min(1),
  orderId: z.string().min(1),
  at: z.string().min(1),
  actor: ActorRefSchema,
  action: OrderEventActionSchema,
  fromStatus: OrderStatusSchema.nullable(),
  toStatus: OrderStatusSchema,
  dispositionCode: z.string().trim().min(1).max(80).optional(),
  comment: z.string().trim().max(500).optional(),
  sourceBranchId: z.string().nullable().optional(),
  quantity: z.number().int().positive().optional(),
  engineQty: z.number().int().positive().optional(),
  approvedQty: z.number().int().positive().optional(),
  isAdminOverride: z.boolean().optional(),
});
export type OrderEvent = z.infer<typeof OrderEventSchema>;

export const ReplenishmentOrderSchema = z.object({
  id: z.string().min(1),
  origin: OrderOriginSchema,
  type: OrderTypeSchema,
  status: OrderStatusSchema,
  sku: z.string().min(1),
  productName: z.string().min(1),
  category: z.string().min(1),
  targetBranchId: z.string().min(1),
  targetBranchName: z.string().min(1),
  sourceBranchId: z.string().nullable(),
  sourceBranchName: z.string().nullable(),
  quantity: z.number().int().positive(),
  qty: z.number().int().positive().optional(),
  approvedNetBenefitBhd: z.number().optional(),
  approvedFreightCostBhd: z.number().optional(),
  requestedBy: ActorRefSchema.nullable(),
  linkedAlertId: z.string().nullable().default(null),
  engineSnapshot: OrderEngineSnapshotSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  awaitingDonorSince: z.string().nullable().default(null),
  escalatedAt: z.string().nullable().default(null),
  committedAt: z.string().nullable().default(null),
  receivedAt: z.string().nullable().default(null),
  events: z.array(OrderEventSchema).default([]),
  isVirtual: z.boolean().optional(),
  isEscalated: z.boolean().optional(),
  donorAvailableSurplus: z.number().int().nonnegative().optional(),
  donorCoverDaysAfter: z.number().nullable().optional(),
});
export const StoreOrderSchema = ReplenishmentOrderSchema.pick({
  id: true, sku: true, productName: true, type: true, status: true, quantity: true,
  sourceBranchName: true, sourceBranchId: true, targetBranchId: true, targetBranchName: true,
  updatedAt: true, receivedAt: true,
});
export type StoreOrder = z.infer<typeof StoreOrderSchema>;
export type ReplenishmentOrder = z.infer<typeof ReplenishmentOrderSchema>;

export const OrderQueueTabSchema = z.enum(["suggested", "incoming", "outgoing"]);
export type OrderQueueTab = z.infer<typeof OrderQueueTabSchema>;

export const OrderListQuerySchema = z.object({
  historyPage: z.coerce.number().int().min(1).max(100000).optional(),
  search: z.string().trim().max(160).optional(),
  queue: OrderQueueTabSchema.optional(),
  status: OrderStatusSchema.optional(),
  type: OrderTypeSchema.optional(),
  branch: z.string().min(1).optional(),
  sku: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
});
export type OrderListQuery = z.infer<typeof OrderListQuerySchema>;

export const CreateOrderRequestSchema = z.object({
  type: OrderTypeSchema.default("TRANSFER"),
  sku: z.string().min(1),
  targetBranchId: z.string().min(1),
  sourceBranchId: z.string().min(1).nullable().optional(),
  quantity: z.coerce.number().int().positive(),
  linkedAlertId: z.string().min(1).nullable().optional(),
  dispositionCode: z.string().trim().min(1).max(80).optional(),
  comment: z.string().trim().max(500).optional(),
});
export type CreateOrderRequest = Omit<z.infer<typeof CreateOrderRequestSchema>, "type"> & {
  type?: OrderType;
};

export const OrderRequestTransferBodySchema = z.object({
  sourceBranchId: z.string().min(1).optional(),
  quantity: z.coerce.number().int().positive().optional(),
  dispositionCode: z.string().trim().min(1).max(80).optional(),
  comment: z.string().trim().max(500).optional(),
});
export type OrderRequestTransferBody = z.infer<typeof OrderRequestTransferBodySchema>;

export const OrderCommitBodySchema = z.object({
  approvedQty: z.number().optional(),
  dispositionCode: z.string().trim().min(1).max(80).optional(),
  comment: z.string().trim().max(500).optional(),
  force: z.boolean().optional(),
});
export type OrderCommitBody = z.infer<typeof OrderCommitBodySchema>;

export const OrderDeclineBodySchema = z.object({
  dispositionCode: z.string().trim().min(1).max(80).optional(),
  comment: z.string().trim().min(1, "Comment is required when declining").max(500),
});
export type OrderDeclineBody = z.infer<typeof OrderDeclineBodySchema>;

export const OrderRerouteBodySchema = z.object({
  sourceBranchId: z.string().min(1, "Replacement donor branch is required"),
  quantity: z.coerce.number().int().positive().optional(),
  dispositionCode: z.string().trim().min(1).max(80).optional(),
  comment: z.string().trim().max(500).optional(),
});
export type OrderRerouteBody = z.infer<typeof OrderRerouteBodySchema>;

export const OrderCancelBodySchema = z.object({
  dispositionCode: z.string().trim().min(1).max(80).optional(),
  comment: z.string().trim().max(500).optional(),
});
export type OrderCancelBody = z.infer<typeof OrderCancelBodySchema>;

export const OrderReceiveBodySchema = z.object({
  dispositionCode: z.string().trim().min(1).max(80).optional(),
  comment: z.string().trim().max(500).optional(),
});
export type OrderReceiveBody = z.infer<typeof OrderReceiveBodySchema>;

export const DonorCandidatesQuerySchema = z.object({
  sku: z.string().min(1),
  target: z.string().min(1),
  qty: z.coerce.number().int().positive(),
  includeIneligible: z
    .preprocess((val) => val === true || val === "true" || val === "1", z.boolean())
    .optional(),
  limit: z.coerce.number().int().positive().max(50).optional(),
});
export type DonorCandidatesQuery = z.infer<typeof DonorCandidatesQuerySchema>;

export const OrderListResponseSchema = z.object({
  orders: z.array(ReplenishmentOrderSchema),
  total: z.number().int().nonnegative(),
});
export type OrderListResponse = z.infer<typeof OrderListResponseSchema>;

export const DonorCandidatesResponseSchema = z.object({
  candidates: z.array(DonorCandidateSchema),
});
export type DonorCandidatesResponse = z.infer<typeof DonorCandidatesResponseSchema>;

export const ResolveStockAlertResponseSchema = z.object({
  alert: StockAlertSchema,
  order: ReplenishmentOrderSchema.nullable().default(null),
});
export type ResolveStockAlertResponse = z.infer<typeof ResolveStockAlertResponseSchema>;

export const TERMINAL_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set([
  "RECEIVED",
  "REJECTED",
  "CANCELLED",
]);

export const ORDER_TRANSITION_TABLE: Record<
  OrderTransitionAction,
  { from: readonly OrderStatus[]; to: OrderStatus }
> = {
  REQUEST_TRANSFER: { from: ["SUGGESTED", "OPEN_REQUEST"], to: "AWAITING_DONOR" },
  COMMIT: { from: ["SUGGESTED", "OPEN_REQUEST", "AWAITING_DONOR"], to: "COMMITTED" },
  DECLINE: { from: ["SUGGESTED", "OPEN_REQUEST", "AWAITING_DONOR"], to: "REJECTED" },
  REROUTE: { from: ["SUGGESTED", "OPEN_REQUEST", "AWAITING_DONOR", "REJECTED"], to: "AWAITING_DONOR" },
  CANCEL: { from: ["SUGGESTED", "OPEN_REQUEST", "AWAITING_DONOR"], to: "CANCELLED" },
  RECEIVE: { from: ["COMMITTED"], to: "RECEIVED" },
};

export interface OrderOwnership {
  ownsTarget: boolean;
  ownsSource: boolean;
  intraCluster: boolean;
  isRequester: boolean;
  hasComment?: boolean;
  force?: boolean;
  targetDonorBranchId?: string | null;
}

export type TransitionDecision =
  | { allowed: true; nextStatus: OrderStatus; isAdminOverride: boolean }
  | {
      allowed: false;
      code: "FORBIDDEN" | "INVALID_STATE" | "VALIDATION_ERROR";
      reason: string;
    };

export function canTransition(
  order: Pick<ReplenishmentOrder, "status" | "type" | "targetBranchId" | "sourceBranchId">,
  actor: { role: Role },
  action: OrderTransitionAction,
  ownership: OrderOwnership,
): TransitionDecision {
  const rule = ORDER_TRANSITION_TABLE[action];
  if (!rule.from.includes(order.status)) {
    return {
      allowed: false,
      code: "INVALID_STATE",
      reason: `Cannot ${action} an order in ${order.status} status`,
    };
  }

  switch (action) {
    case "REQUEST_TRANSFER": {
      if (order.type !== "TRANSFER") {
        return {
          allowed: false,
          code: "VALIDATION_ERROR",
          reason: "Transfer requests are only valid for TRANSFER orders",
        };
      }
      if (actor.role !== "admin" && !(actor.role === "manager" && ownership.ownsTarget)) {
        return {
          allowed: false,
          code: "FORBIDDEN",
          reason: "Only target branch manager or admin can request a donor transfer",
        };
      }
      const donorId = (ownership.targetDonorBranchId ?? order.sourceBranchId)?.trim();
      if (!donorId || donorId === order.targetBranchId) {
        return {
          allowed: false,
          code: "VALIDATION_ERROR",
          reason: "A valid donor branch distinct from targetBranchId is required",
        };
      }
      return { allowed: true, nextStatus: rule.to, isAdminOverride: false };
    }

    case "COMMIT": {
      if (actor.role === "staff") {
        return {
          allowed: false,
          code: "FORBIDDEN",
          reason: "Store staff cannot commit replenishment orders",
        };
      }
      if (actor.role === "admin") {
        const isForce =
          Boolean(ownership.force) ||
          (order.type === "TRANSFER" &&
            (order.status === "AWAITING_DONOR" || order.status === "OPEN_REQUEST"));
        if (isForce && !ownership.hasComment) {
          return {
            allowed: false,
            code: "VALIDATION_ERROR",
            reason: "Comment is required when admin force-commits an order",
          };
        }
        return { allowed: true, nextStatus: rule.to, isAdminOverride: isForce };
      }
      if (order.type !== "TRANSFER") {
        if (!ownership.ownsTarget) {
          return {
            allowed: false,
            code: "FORBIDDEN",
            reason: "Manager does not own target branch",
          };
        }
        return { allowed: true, nextStatus: rule.to, isAdminOverride: false };
      }
      if (ownership.intraCluster) {
        return { allowed: true, nextStatus: rule.to, isAdminOverride: false };
      }
      if (order.status === "AWAITING_DONOR" && ownership.ownsSource) {
        return { allowed: true, nextStatus: rule.to, isAdminOverride: false };
      }
      return {
        allowed: false,
        code: "FORBIDDEN",
        reason: "Cross-cluster transfers require donor branch approval",
      };
    }

    case "DECLINE": {
      if (actor.role === "staff") {
        return {
          allowed: false,
          code: "FORBIDDEN",
          reason: "Store staff cannot decline replenishment orders",
        };
      }
      if (actor.role === "manager") {
        if (order.status === "AWAITING_DONOR" && !ownership.ownsSource) {
          return {
            allowed: false,
            code: "FORBIDDEN",
            reason: "Only donor branch manager or admin can decline an awaiting-donor transfer",
          };
        }
        if (order.status === "OPEN_REQUEST") {
          return {
            allowed: false,
            code: "FORBIDDEN",
            reason: "Open requests must be cancelled by requester or declined by admin",
          };
        }
        if (order.status === "SUGGESTED") {
          const allowedSuggester =
            order.type === "TRANSFER" ? ownership.ownsSource : ownership.ownsTarget;
          if (!allowedSuggester) {
            return {
              allowed: false,
              code: "FORBIDDEN",
              reason: "Only donor branch manager or admin can decline this suggestion",
            };
          }
        }
      }
      if (!ownership.hasComment) {
        return {
          allowed: false,
          code: "VALIDATION_ERROR",
          reason: "Comment is required when declining",
        };
      }
      return { allowed: true, nextStatus: rule.to, isAdminOverride: false };
    }

    case "REROUTE": {
      if (order.type !== "TRANSFER") {
        return {
          allowed: false,
          code: "VALIDATION_ERROR",
          reason: "Only TRANSFER orders can be rerouted to another donor",
        };
      }
      if (actor.role !== "admin" && !(actor.role === "manager" && ownership.ownsTarget)) {
        return {
          allowed: false,
          code: "FORBIDDEN",
          reason: "Only target branch manager or admin can reroute a transfer",
        };
      }
      const nextDonor = ownership.targetDonorBranchId?.trim();
      if (!nextDonor || nextDonor === order.targetBranchId || nextDonor === order.sourceBranchId) {
        return {
          allowed: false,
          code: "VALIDATION_ERROR",
          reason: "Replacement donor branch must be distinct from target and current donor",
        };
      }
      return { allowed: true, nextStatus: rule.to, isAdminOverride: false };
    }

    case "CANCEL": {
      if (!ownership.isRequester) {
        return {
          allowed: false,
          code: "FORBIDDEN",
          reason: "Only the requester can cancel an order before commit",
        };
      }
      return { allowed: true, nextStatus: rule.to, isAdminOverride: false };
    }

    case "RECEIVE": {
      if (
        actor.role !== "admin" &&
        !((actor.role === "manager" || actor.role === "staff") && ownership.ownsTarget)
      ) {
        return {
          allowed: false,
          code: "FORBIDDEN",
          reason: "Only target branch staff/manager or admin can confirm receipt",
        };
      }
      return { allowed: true, nextStatus: rule.to, isAdminOverride: false };
    }
  }
}

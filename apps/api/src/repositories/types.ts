import type {
  ActedBy,
  ActionMetaRecord,
  Analysis,
  ApiAuditEntry,
  Branch,
  Dataset,
  DecisionSnapshot,
  OrderEvent,
  OrderListQuery,
  OrderStatus,
  Product,
  ProductChangeRecord,
  QueueLifecycleView,
  ReplenishmentOrder,
  StockAlert,
  StockAlertResolution,
  StoreOrder,
} from "@stockflow/core";
import type { UserRepository } from "./userTypes.js";

// IMPORTANT: both stores must return the same dataset shape and the same audit rows. The engine does not know which one it is reading.
// SCALE: daily facts are one document per branch, SKU, and date. At 100x, load the series cache for the engine and keep facts for range queries.

export interface CachedPlanRecord {
  dataVersion: number;
  computedAt: string;
  plan: Analysis;
}

export type { ActionMetaRecord, ApiAuditEntry, QueueLifecycleView };

export interface OrderLifecycleMeta {
  rejectionSnapshot?: DecisionSnapshot | null;
  rejectedUntil?: string | null;
  reopenedAt?: string | null;
}

export interface SaveDecisionBatchResult {
  persistedIds: Set<string>;
  duplicateIds: Set<string>;
}

export type SaveOrderWithEventResult =
  | { status: "saved"; order: ReplenishmentOrder }
  | { status: "conflict" };

export interface ResolveStockAlertOrderPayload {
  order: ReplenishmentOrder;
  event: OrderEvent;
}

export type ResolveStockAlertResult =
  | { status: "resolved"; alert: StockAlert; order: ReplenishmentOrder | null }
  | { status: "not_found" }
  | { status: "already_decided"; alert: StockAlert };

export interface AllocationGuard { revision: number; dataVersion: number }

export interface StockRepository {
  readonly kind: "memory" | "mongo";
  readonly users: UserRepository;
  loadDataset(): Promise<Dataset>;
  loadAnalysis(): Promise<Analysis | null>;
  saveAnalysis(analysis: Analysis): Promise<void>;
  getPhysicalChangeTime?(version: number): Promise<string | undefined>;
  getDataVersion(): Promise<number>;
  bumpDataVersion(): Promise<number>;
  loadCachedPlan(dataVersion: number): Promise<CachedPlanRecord | null>;
  saveCachedPlan(dataVersion: number, plan: Analysis): Promise<void>;
  listActions(): Promise<ActionMetaRecord[]>;
  saveAction(record: ActionMetaRecord): Promise<void>;
  saveActions(records: ActionMetaRecord[]): Promise<void>;
  listAudit(): Promise<ApiAuditEntry[]>;
  saveAudit(entry: ApiAuditEntry): Promise<void>;
  saveAudits(entries: ApiAuditEntry[]): Promise<void>;
  saveDecisionBatch(
    records: ActionMetaRecord[],
    entries: ApiAuditEntry[],
    options?: { allowOverwriteIds?: ReadonlySet<string>; allocationGuard?: AllocationGuard },
  ): Promise<SaveDecisionBatchResult>;
  reopenAction(
    recommendationId: string,
    reopenedAt: string,
    auditEntry: ApiAuditEntry,
  ): Promise<boolean>;
  clearDecisions(): Promise<{ actionsRemoved: number; auditsRemoved: number }>;
  saveProduct(product: Product): Promise<void>;
  saveBranch(branch: Branch): Promise<void>;
  removeProduct(sku: string): Promise<void>;
  listProductChanges(sku: string): Promise<ProductChangeRecord[]>;
  saveProductChange(change: ProductChangeRecord): Promise<void>;
  hasHistoryOrAudits(sku: string): Promise<{ hasSales: boolean; hasAudits: boolean }>;
  listStockAlerts(): Promise<StockAlert[]>;
  getStockAlert(id: string): Promise<StockAlert | null>;
  createStockAlert(alert: StockAlert): Promise<StockAlert>;
  decideStockAlert(
    id: string,
    decision: "APPROVED" | "REJECTED",
    decidedBy: ActedBy,
    decidedAt: string,
  ): Promise<
    | { status: "decided"; alert: StockAlert }
    | { status: "not_found" }
    | { status: "already_decided"; alert: StockAlert }
  >;
  resolveStockAlert(
    id: string,
    resolution: StockAlertResolution,
    linkedOrder?: ResolveStockAlertOrderPayload,
  ): Promise<ResolveStockAlertResult>;
  listOrderHistory?(query: OrderListQuery, branches: readonly string[] | null): Promise<{ orders: ReplenishmentOrder[]; total: number }>;
  listStoreDeliveries?(branchId: string): Promise<StoreOrder[]>;
  getOrderEventCount?(): Promise<number>;
  getAllocationRevision?(): Promise<number>;
  listOrders(): Promise<ReplenishmentOrder[]>;
  getOrder(id: string): Promise<ReplenishmentOrder | null>;
  listOrderEvents(orderId?: string): Promise<OrderEvent[]>;
  listOrderLifecycleMeta?(): Promise<Map<string, OrderLifecycleMeta>>;
  saveOrderWithEvent(
    order: ReplenishmentOrder,
    event: OrderEvent,
    expectedStatus: OrderStatus | null,
    lifecycleMeta?: OrderLifecycleMeta,
    allocationGuard?: AllocationGuard,
  ): Promise<SaveOrderWithEventResult>;
  ping?(): Promise<void>;
  close(): Promise<void>;
}

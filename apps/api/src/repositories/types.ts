import type {
  ActedBy,
  ActionRecord,
  Analysis,
  AuditEntry,
  Branch,
  Dataset,
  Product,
  ProductChangeRecord,
  StockAlert,
} from "@stockflow/core";
import type { UserRepository } from "./userTypes.js";

// IMPORTANT: both stores must return the same dataset shape and the same audit rows. The engine does not know which one it is reading.
// SCALE: daily facts are one document per branch, SKU, and date. At 100x, load the series cache for the engine and keep facts for range queries.

export interface CachedPlanRecord {
  dataVersion: number;
  computedAt: string;
  plan: Analysis;
}

export interface SaveDecisionBatchResult {
  persistedIds: Set<string>;
  duplicateIds: Set<string>;
}

export interface StockRepository {
  readonly kind: "memory" | "mongo";
  readonly users: UserRepository;
  loadDataset(): Promise<Dataset>;
  loadAnalysis(): Promise<Analysis | null>;
  saveAnalysis(analysis: Analysis): Promise<void>;
  getDataVersion(): Promise<number>;
  bumpDataVersion(): Promise<number>;
  loadCachedPlan(dataVersion: number): Promise<CachedPlanRecord | null>;
  saveCachedPlan(dataVersion: number, plan: Analysis): Promise<void>;
  listActions(): Promise<ActionRecord[]>;
  saveAction(record: ActionRecord): Promise<void>;
  saveActions(records: ActionRecord[]): Promise<void>;
  listAudit(): Promise<AuditEntry[]>;
  saveAudit(entry: AuditEntry): Promise<void>;
  saveAudits(entries: AuditEntry[]): Promise<void>;
  saveDecisionBatch(records: ActionRecord[], entries: AuditEntry[]): Promise<SaveDecisionBatchResult>;
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
  ping?(): Promise<void>;
  close(): Promise<void>;
}

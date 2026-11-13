import type { ActionRecord, Analysis, AuditEntry, Dataset } from "@stockflow/core";
import type { UserRepository } from "./userTypes.js";

// IMPORTANT: both stores must return the same dataset shape and the same audit rows. The engine does not know which one it is reading.
// SCALE: daily facts are one document per branch, SKU, and date. At 100x, load the series cache for the engine and keep facts for range queries.

export interface StockRepository {
  readonly kind: "memory" | "mongo";
  readonly users: UserRepository;
  loadDataset(): Promise<Dataset>;
  loadAnalysis(): Promise<Analysis | null>;
  saveAnalysis(analysis: Analysis): Promise<void>;
  listActions(): Promise<ActionRecord[]>;
  saveAction(record: ActionRecord): Promise<void>;
  listAudit(): Promise<AuditEntry[]>;
  saveAudit(entry: AuditEntry): Promise<void>;
  close(): Promise<void>;
}

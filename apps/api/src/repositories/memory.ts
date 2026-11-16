import {
  ActionRecordSchema,
  AuditEntrySchema,
  generateDataset,
  type ActedBy,
  type ActionRecord,
  type Analysis,
  type AuditEntry,
  type Dataset,
  type Product,
  type ProductChangeRecord,
  type StockAlert,
} from "@stockflow/core";
import { MemoryStockAlertStore } from "./memoryAlerts.js";
import type { CachedPlanRecord, SaveDecisionBatchResult, StockRepository } from "./types.js";
import type { UserRepository } from "./userTypes.js";
import { InMemoryUserRepository } from "./memoryUser.js";

export class InMemoryRepository implements StockRepository {
  readonly kind = "memory" as const;
  readonly users: UserRepository;
  private readonly actions: ActionRecord[] = [];
  private readonly audit: AuditEntry[] = [];
  private readonly productChanges: ProductChangeRecord[] = [];
  private readonly alertStore = new MemoryStockAlertStore();
  private dataVersion = 1;
  private cachedPlan: CachedPlanRecord | null = null;

  private constructor(private data: Dataset | null, users?: UserRepository) {
    this.users = users ?? new InMemoryUserRepository();
  }

  static create(users?: UserRepository): InMemoryRepository {
    // DECISION: Defer synthetic dataset generation (500 SKUs x 15 branches x 120 days)
    // until loadDataset() is called so creating the repository never blocks port binding.
    return new InMemoryRepository(null, users);
  }

  static createFromDataset(data: Dataset, users?: UserRepository): InMemoryRepository {
    return new InMemoryRepository(structuredClone(data), users);
  }

  private getDataset(): Dataset {
    if (!this.data) {
      this.data = generateDataset();
    }
    return this.data;
  }

  peekDatasetSync(): Dataset {
    return this.getDataset();
  }

  peekDataVersionSync(): number {
    return this.dataVersion;
  }

  peekCachedPlanSync(dataVersion: number): CachedPlanRecord | null {
    if (this.cachedPlan && this.cachedPlan.dataVersion === dataVersion) {
      return this.cachedPlan;
    }
    return null;
  }

  saveCachedPlanSync(dataVersion: number, plan: Analysis): void {
    this.cachedPlan = {
      dataVersion,
      computedAt: new Date().toISOString(),
      plan,
    };
  }

  peekActionsSync(): ActionRecord[] {
    return this.actions.map((action) => ActionRecordSchema.parse(action));
  }

  peekAuditSync(): AuditEntry[] {
    return this.audit.map((entry) => AuditEntrySchema.parse(entry));
  }

  loadDataset(): Promise<Dataset> {
    return Promise.resolve(this.getDataset());
  }

  loadAnalysis(): Promise<Analysis | null> {
    return Promise.resolve(null);
  }

  saveAnalysis(): Promise<void> {
    return Promise.resolve();
  }

  getDataVersion(): Promise<number> {
    return Promise.resolve(this.dataVersion);
  }

  bumpDataVersion(): Promise<number> {
    this.dataVersion += 1;
    return Promise.resolve(this.dataVersion);
  }

  loadCachedPlan(dataVersion: number): Promise<CachedPlanRecord | null> {
    if (this.cachedPlan && this.cachedPlan.dataVersion === dataVersion) {
      return Promise.resolve(this.cachedPlan);
    }
    return Promise.resolve(null);
  }

  saveCachedPlan(dataVersion: number, plan: Analysis): Promise<void> {
    this.cachedPlan = {
      dataVersion,
      computedAt: new Date().toISOString(),
      plan,
    };
    return Promise.resolve();
  }

  listActions(): Promise<ActionRecord[]> {
    return Promise.resolve(this.actions.map((action) => ActionRecordSchema.parse(action)));
  }

  saveAction(record: ActionRecord): Promise<void> {
    this.actions.push(ActionRecordSchema.parse(record));
    return Promise.resolve();
  }

  saveActions(records: ActionRecord[]): Promise<void> {
    if (records.length === 0) return Promise.resolve();
    for (const record of records) {
      this.actions.push(ActionRecordSchema.parse(record));
    }
    return Promise.resolve();
  }

  listAudit(): Promise<AuditEntry[]> {
    return Promise.resolve(this.audit.map((entry) => AuditEntrySchema.parse(entry)));
  }

  saveAudit(entry: AuditEntry): Promise<void> {
    this.audit.push(AuditEntrySchema.parse(entry));
    return Promise.resolve();
  }

  saveAudits(entries: AuditEntry[]): Promise<void> {
    if (entries.length === 0) return Promise.resolve();
    for (const entry of entries) {
      this.audit.push(AuditEntrySchema.parse(entry));
    }
    return Promise.resolve();
  }

  async saveDecisionBatch(records: ActionRecord[], entries: AuditEntry[]): Promise<SaveDecisionBatchResult> {
    const persistedIds = new Set<string>();
    const duplicateIds = new Set<string>();
    if (records.length === 0) return { persistedIds, duplicateIds };

    const existingRecIds = new Set(this.actions.map((a) => a.recommendationId));
    const entryByRecId = new Map(entries.map((e) => [e.recommendationId, e]));
    const recordsToSave: ActionRecord[] = [];
    const entriesToSave: AuditEntry[] = [];

    for (const rawRecord of records) {
      const record = ActionRecordSchema.parse(rawRecord);
      if (existingRecIds.has(record.recommendationId) || persistedIds.has(record.recommendationId)) {
        duplicateIds.add(record.recommendationId);
        continue;
      }
      const rawEntry = entryByRecId.get(record.recommendationId);
      if (!rawEntry) throw new Error(`Missing audit entry for ${record.recommendationId}`);
      recordsToSave.push(record);
      entriesToSave.push(AuditEntrySchema.parse(rawEntry));
      persistedIds.add(record.recommendationId);
    }

    if (recordsToSave.length > 0) {
      // Write audit entries first so a simulated audit failure leaves zero orphan actions.
      await this.commitAuditEntries(entriesToSave);
      for (const r of recordsToSave) this.actions.push(r);
    }

    return { persistedIds, duplicateIds };
  }

  // Exposed for unit testing simulated audit-write failures without double-counting DB ops.
  async commitAuditEntries(entries: AuditEntry[]): Promise<void> {
    for (const entry of entries) {
      this.audit.push(AuditEntrySchema.parse(entry));
    }
  }

  clearDecisions(): Promise<{ actionsRemoved: number; auditsRemoved: number }> {
    const actionsRemoved = this.actions.length;
    const auditsRemoved = this.audit.length;
    this.actions.length = 0;
    this.audit.length = 0;
    return Promise.resolve({ actionsRemoved, auditsRemoved });
  }

  saveProduct(product: Product): Promise<void> {
    const data = this.getDataset();
    const idx = data.products.findIndex((p) => p.sku === product.sku);
    if (idx >= 0) {
      data.products[idx] = product;
    } else {
      data.products.push(product);
      data.sales.push(data.branches.map(() => data.dates.map(() => 0)));
      data.onHand.push(data.branches.map(() => data.dates.map(() => 0)));
      data.demand.push(data.branches.map(() => data.dates.map(() => 0)));
    }
    return Promise.resolve();
  }

  removeProduct(sku: string): Promise<void> {
    const data = this.getDataset();
    const idx = data.products.findIndex((p) => p.sku === sku);
    if (idx >= 0) {
      data.products.splice(idx, 1);
      data.sales.splice(idx, 1);
      data.onHand.splice(idx, 1);
      data.demand.splice(idx, 1);
    }
    return Promise.resolve();
  }

  listProductChanges(sku: string): Promise<ProductChangeRecord[]> {
    return Promise.resolve(
      this.productChanges
        .filter((c) => c.sku === sku)
        .sort((a, b) => b.at.localeCompare(a.at)),
    );
  }

  saveProductChange(change: ProductChangeRecord): Promise<void> {
    this.productChanges.push(change);
    return Promise.resolve();
  }

  hasHistoryOrAudits(sku: string): Promise<{ hasSales: boolean; hasAudits: boolean }> {
    const data = this.getDataset();
    const hasAudits = this.audit.some((a) => a.sku === sku);
    const idx = data.products.findIndex((p) => p.sku === sku);
    let hasSales = false;
    if (idx >= 0 && data.sales[idx]) {
      hasSales = data.sales[idx].some((byBranch) => byBranch.some((units) => units > 0));
    }
    return Promise.resolve({ hasSales, hasAudits });
  }

  listStockAlerts(): Promise<StockAlert[]> {
    return Promise.resolve(this.alertStore.list());
  }

  getStockAlert(id: string): Promise<StockAlert | null> {
    return Promise.resolve(this.alertStore.get(id));
  }

  createStockAlert(alert: StockAlert): Promise<StockAlert> {
    return Promise.resolve(this.alertStore.create(alert));
  }

  decideStockAlert(
    id: string,
    decision: "APPROVED" | "REJECTED",
    decidedBy: ActedBy,
    decidedAt: string,
  ): Promise<
    | { status: "decided"; alert: StockAlert }
    | { status: "not_found" }
    | { status: "already_decided"; alert: StockAlert }
  > {
    return Promise.resolve(this.alertStore.decide(id, decision, decidedBy, decidedAt));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

import {
  OrderEventSchema,
  ReplenishmentOrderSchema,
  generateDataset,
  type ActedBy,
  type Analysis,
  type Branch,
  type Dataset,
  type OrderEvent,
  type OrderStatus,
  type Product,
  type ProductChangeRecord,
  type ReplenishmentOrder,
  type StockAlert,
  type StockAlertResolution,
} from "@stockflow/core";
import { MemoryStockAlertStore } from "./memoryAlerts.js";
import type {
  ActionMetaRecord,
  ApiAuditEntry,
  CachedPlanRecord,
  OrderLifecycleMeta,
  ResolveStockAlertOrderPayload,
  ResolveStockAlertResult,
  SaveDecisionBatchResult,
  SaveOrderWithEventResult,
  StockRepository,
} from "./types.js";
import type { UserRepository } from "./userTypes.js";
import { InMemoryUserRepository } from "./memoryUser.js";
import { ActionMetaRecordSchema, ApiAuditEntrySchema } from "../services/queueLifecycle.js";

export class InMemoryRepository implements StockRepository {
  readonly kind = "memory" as const;
  readonly users: UserRepository;
  private readonly actions: ActionMetaRecord[] = [];
  private readonly audit: ApiAuditEntry[] = [];
  private readonly orders = new Map<string, ReplenishmentOrder>();
  private readonly orderEvents: OrderEvent[] = [];
  private readonly orderLifecycleMeta = new Map<string, OrderLifecycleMeta>();
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

  peekActionsSync(): ActionMetaRecord[] {
    return this.actions.map((action) => ActionMetaRecordSchema.parse(action));
  }

  peekAuditSync(): ApiAuditEntry[] {
    return this.audit.map((entry) => ApiAuditEntrySchema.parse(entry));
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

  listActions(): Promise<ActionMetaRecord[]> {
    return Promise.resolve(this.actions.map((action) => ActionMetaRecordSchema.parse(action)));
  }

  saveAction(record: ActionMetaRecord): Promise<void> {
    this.actions.push(ActionMetaRecordSchema.parse(record));
    return Promise.resolve();
  }

  saveActions(records: ActionMetaRecord[]): Promise<void> {
    if (records.length === 0) return Promise.resolve();
    for (const record of records) {
      this.actions.push(ActionMetaRecordSchema.parse(record));
    }
    return Promise.resolve();
  }

  listAudit(): Promise<ApiAuditEntry[]> {
    return Promise.resolve(this.audit.map((entry) => ApiAuditEntrySchema.parse(entry)));
  }

  saveAudit(entry: ApiAuditEntry): Promise<void> {
    this.audit.push(ApiAuditEntrySchema.parse(entry));
    return Promise.resolve();
  }

  saveAudits(entries: ApiAuditEntry[]): Promise<void> {
    if (entries.length === 0) return Promise.resolve();
    for (const entry of entries) {
      this.audit.push(ApiAuditEntrySchema.parse(entry));
    }
    return Promise.resolve();
  }

  async saveDecisionBatch(
    records: ActionMetaRecord[],
    entries: ApiAuditEntry[],
    options?: { allowOverwriteIds?: ReadonlySet<string> },
  ): Promise<SaveDecisionBatchResult> {
    const persistedIds = new Set<string>();
    const duplicateIds = new Set<string>();
    if (records.length === 0) return { persistedIds, duplicateIds };

    const allowOverwrite = options?.allowOverwriteIds;
    const existingIdxByRec = new Map(this.actions.map((a, idx) => [a.recommendationId, idx]));
    const entryByRecId = new Map(entries.map((e) => [e.recommendationId, e]));
    const recordsToSave: ActionMetaRecord[] = [];
    const entriesToSave: ApiAuditEntry[] = [];

    for (const rawRecord of records) {
      const record = ActionMetaRecordSchema.parse(rawRecord);
      const existsAlready = existingIdxByRec.has(record.recommendationId);
      if (
        (existsAlready && !allowOverwrite?.has(record.recommendationId)) ||
        persistedIds.has(record.recommendationId)
      ) {
        duplicateIds.add(record.recommendationId);
        continue;
      }
      const rawEntry = entryByRecId.get(record.recommendationId);
      if (!rawEntry) throw new Error(`Missing audit entry for ${record.recommendationId}`);
      recordsToSave.push(record);
      entriesToSave.push(ApiAuditEntrySchema.parse(rawEntry));
      persistedIds.add(record.recommendationId);
    }

    if (recordsToSave.length > 0) {
      // Write audit entries first so a simulated audit failure leaves zero orphan actions.
      await this.commitAuditEntries(entriesToSave);
      for (const r of recordsToSave) {
        const idx = existingIdxByRec.get(r.recommendationId);
        if (idx !== undefined) {
          this.actions[idx] = r;
        } else {
          this.actions.push(r);
        }
      }
    }

    return { persistedIds, duplicateIds };
  }

  async reopenAction(
    recommendationId: string,
    reopenedAt: string,
    auditEntry: ApiAuditEntry,
  ): Promise<boolean> {
    const target = this.actions.find((a) => a.recommendationId === recommendationId);
    if (!target) return false;
    const prevReopenedAt = target.reopenedAt;
    target.reopenedAt = reopenedAt;
    try {
      await this.commitAuditEntries([ApiAuditEntrySchema.parse(auditEntry)]);
    } catch (err) {
      target.reopenedAt = prevReopenedAt;
      throw err;
    }
    return true;
  }

  // Exposed for unit testing simulated audit-write failures without double-counting DB ops.
  async commitAuditEntries(entries: ApiAuditEntry[]): Promise<void> {
    for (const entry of entries) {
      this.audit.push(ApiAuditEntrySchema.parse(entry));
    }
  }

  clearDecisions(): Promise<{ actionsRemoved: number; auditsRemoved: number }> {
    const actionsRemoved = this.actions.length;
    const auditsRemoved = this.audit.length;
    this.actions.length = 0;
    this.audit.length = 0;
    this.orders.clear();
    this.orderEvents.length = 0;
    this.orderLifecycleMeta.clear();
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

  saveBranch(branch: Branch): Promise<void> {
    const data = this.getDataset();
    const idx = data.branches.findIndex((b) => b.id === branch.id);
    if (idx >= 0) {
      data.branches[idx] = branch;
    } else {
      data.branches.push(branch);
      const numDays = data.dates.length;
      for (let sIdx = 0; sIdx < data.products.length; sIdx += 1) {
        data.sales[sIdx]?.push(new Array(numDays).fill(0));
        data.onHand[sIdx]?.push(new Array(numDays).fill(0));
        data.demand[sIdx]?.push(new Array(numDays).fill(0));
      }
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

  async resolveStockAlert(
    id: string,
    resolution: StockAlertResolution,
    linkedOrder?: ResolveStockAlertOrderPayload,
  ): Promise<ResolveStockAlertResult> {
    const previous = this.alertStore.get(id);
    if (!previous) return { status: "not_found" };
    if (previous.status !== "PENDING") {
      return { status: "already_decided", alert: previous };
    }

    let parsedOrder: ReplenishmentOrder | null = null;
    let parsedEvent: OrderEvent | null = null;
    if (linkedOrder) {
      parsedOrder = ReplenishmentOrderSchema.parse({ ...linkedOrder.order, events: [] });
      parsedEvent = OrderEventSchema.parse(linkedOrder.event);
      if (this.orders.has(parsedOrder.id)) {
        throw new Error(`Order ${parsedOrder.id} already exists`);
      }
    }

    const res = this.alertStore.resolve(id, resolution);
    if (res.status !== "resolved") {
      return res;
    }

    if (parsedOrder && parsedEvent) {
      this.orders.set(parsedOrder.id, parsedOrder);
      try {
        await this.commitOrderEvent(parsedEvent);
      } catch (err) {
        this.orders.delete(parsedOrder.id);
        this.alertStore.restore(previous);
        throw err;
      }
      return {
        status: "resolved",
        alert: res.alert,
        order: this.hydrateMemoryOrder(parsedOrder),
      };
    }

    return { status: "resolved", alert: res.alert, order: null };
  }

  private hydrateMemoryOrder(order: ReplenishmentOrder): ReplenishmentOrder {
    const events = this.orderEvents
      .filter((e) => e.orderId === order.id)
      .sort((a, b) => a.at.localeCompare(b.at))
      .map((e) => OrderEventSchema.parse(e));
    return ReplenishmentOrderSchema.parse({ ...order, events });
  }

  peekOrdersSync(): ReplenishmentOrder[] {
    return Array.from(this.orders.values(), (o) => this.hydrateMemoryOrder(o));
  }

  listOrders(): Promise<ReplenishmentOrder[]> {
    return Promise.resolve(this.peekOrdersSync());
  }

  getOrder(id: string): Promise<ReplenishmentOrder | null> {
    const found = this.orders.get(id);
    return Promise.resolve(found ? this.hydrateMemoryOrder(found) : null);
  }

  listOrderEvents(orderId?: string): Promise<OrderEvent[]> {
    const filtered = orderId
      ? this.orderEvents.filter((e) => e.orderId === orderId)
      : this.orderEvents;
    return Promise.resolve(
      [...filtered]
        .sort((a, b) => a.at.localeCompare(b.at))
        .map((e) => OrderEventSchema.parse(e)),
    );
  }

  // Exposed for unit testing simulated event-write failures cleanly.
  async commitOrderEvent(event: OrderEvent): Promise<void> {
    this.orderEvents.push(OrderEventSchema.parse(event));
  }

  listOrderLifecycleMeta(): Promise<Map<string, OrderLifecycleMeta>> {
    return Promise.resolve(new Map(this.orderLifecycleMeta));
  }

  async saveOrderWithEvent(
    order: ReplenishmentOrder,
    event: OrderEvent,
    expectedStatus: OrderStatus | null,
    lifecycleMeta?: OrderLifecycleMeta,
  ): Promise<SaveOrderWithEventResult> {
    const parsedOrder = ReplenishmentOrderSchema.parse({ ...order, events: [] });
    const parsedEvent = OrderEventSchema.parse(event);
    const existing = this.orders.get(parsedOrder.id);
    if (expectedStatus === null) {
      if (existing) return { status: "conflict" };
    } else if (!existing || existing.status !== expectedStatus) {
      return { status: "conflict" };
    }

    const previous = existing ? { ...existing } : undefined;
    const prevMeta = this.orderLifecycleMeta.get(parsedOrder.id);
    this.orders.set(parsedOrder.id, parsedOrder);
    if (lifecycleMeta) {
      this.orderLifecycleMeta.set(parsedOrder.id, { ...prevMeta, ...lifecycleMeta });
    }
    try {
      await this.commitOrderEvent(parsedEvent);
    } catch (err) {
      if (previous) {
        this.orders.set(parsedOrder.id, previous);
      } else {
        this.orders.delete(parsedOrder.id);
      }
      if (prevMeta) {
        this.orderLifecycleMeta.set(parsedOrder.id, prevMeta);
      } else {
        this.orderLifecycleMeta.delete(parsedOrder.id);
      }
      throw err;
    }

    return { status: "saved", order: this.hydrateMemoryOrder(parsedOrder) };
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

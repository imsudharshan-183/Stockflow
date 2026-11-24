import type { FastifyInstance } from "fastify";
import {
  BAHRAIN_BRANCHES,
  OrderEventSchema,
  ReplenishmentOrderSchema,
  type ActedBy,
  type Analysis,
  type Branch,
  type Dataset,
  type OrderEvent,
  type OrderStatus,
  type Product,
  type ProductChangeRecord,
  type ReplenishmentOrder,
  type Role,
  type StockAlert,
  type StockAlertResolution,
} from "@stockflow/core";
import { buildApp } from "../plugins/app.js";
import { InMemoryRepository } from "../repositories/memory.js";
import { MemoryStockAlertStore } from "../repositories/memoryAlerts.js";
import { InMemoryUserRepository } from "../repositories/memoryUser.js";
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
} from "../repositories/types.js";
import type { UserRepository } from "../repositories/userTypes.js";
import { createStockServices, type StockServices } from "../services/index.js";
import { ActionMetaRecordSchema, ApiAuditEntrySchema } from "../services/queueLifecycle.js";

export const TEST_JWT_SECRET = "test-secret-at-least-32-characters-long-key";

/** Seeded users (see repositories/seedData.ts). */
export const SEED_USERS = {
  admin: { id: "usr_admin_01", email: "admin@stockflow.dev", role: "admin", password: "Admin@12345" },
  managerManama: {
    id: "usr_mgr_01",
    email: "manager.manama@stockflow.dev",
    role: "manager",
    password: "Manager@12345",
    branchIds: ["BR-001", "BR-002"],
  },
  managerRegional: {
    id: "usr_mgr_02",
    email: "manager.regional@stockflow.dev",
    role: "manager",
    password: "Manager@12345",
    branchIds: ["BR-005", "BR-006", "BR-008", "BR-011"],
  },
  staffManama: {
    id: "usr_stf_01",
    email: "staff.manama@stockflow.dev",
    role: "staff",
    password: "Staff@12345",
    branchIds: ["BR-001"],
  },
  staffJuffair: {
    id: "usr_stf_02",
    email: "staff.juffair@stockflow.dev",
    role: "staff",
    password: "Staff@12345",
    branchIds: ["BR-002"],
  },
} as const satisfies Record<
  string,
  { id: string; email: string; role: Role; password: string; branchIds?: readonly string[] }
>;

export interface TestContext {
  app: FastifyInstance;
  services: StockServices;
  repo: StockRepository;
}

export async function setupApp(
  options: { authEnabled?: boolean; repo?: StockRepository } = {},
): Promise<TestContext> {
  const repo = options.repo ?? InMemoryRepository.create();
  const services = createStockServices(repo);
  const app = await buildApp(services, {
    AUTH_ENABLED: options.authEnabled ?? true,
    JWT_SECRET: TEST_JWT_SECRET,
  });
  await app.ready();
  return { app, services, repo };
}

/**
 * Mints an access token exactly like /api/auth/login does, without going through the
 * rate-limited login route (max 5 per minute per app instance).
 */
export function tokenFor(
  app: FastifyInstance,
  user: { id: string; email: string; role: Role },
  extra: Record<string, unknown> = {},
): string {
  return app.jwt.sign({ sub: user.id, email: user.email, role: user.role, ...extra });
}

export function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

export function json<T = unknown>(payload: string): T {
  return JSON.parse(payload) as T;
}

export function buildMultipartPayload(
  fieldName: string,
  filename: string,
  content: string | Buffer,
): { payload: Buffer; contentType: string } {
  const boundary = "----StockFlowTestBoundary7MA4YWxkTrZu0gW";
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n`,
    "utf8",
  );
  const bodyBuf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return {
    payload: Buffer.concat([prefix, bodyBuf, suffix]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/**
 * Minimal repository over a hand-built dataset. Used where the seeded catalog does not
 * produce the shape a test needs (the seeded data yields no TRANSFER actions).
 */
export class FixedDatasetRepository implements StockRepository {
  readonly kind = "memory" as const;
  readonly users: UserRepository = new InMemoryUserRepository();
  private readonly actions: ActionMetaRecord[] = [];
  private readonly audit: ApiAuditEntry[] = [];
  private readonly orders = new Map<string, ReplenishmentOrder>();
  private readonly orderEvents: OrderEvent[] = [];
  private readonly orderLifecycleMeta = new Map<string, OrderLifecycleMeta>();
  private readonly alertStore = new MemoryStockAlertStore();
  private dataVersion = 1;
  private cachedPlan: CachedPlanRecord | null = null;

  constructor(private readonly data: Dataset) {}

  peekDatasetSync(): Dataset {
    return this.data;
  }
  peekDataVersionSync(): number {
    return this.dataVersion;
  }
  peekCachedPlanSync(dataVersion: number): CachedPlanRecord | null {
    return this.cachedPlan?.dataVersion === dataVersion ? this.cachedPlan : null;
  }
  saveCachedPlanSync(dataVersion: number, plan: Analysis): void {
    this.cachedPlan = { dataVersion, computedAt: new Date().toISOString(), plan };
  }
  peekActionsSync(): ActionMetaRecord[] {
    return [...this.actions];
  }
  peekAuditSync(): ApiAuditEntry[] {
    return [...this.audit];
  }

  loadDataset(): Promise<Dataset> {
    return Promise.resolve(this.data);
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
    return Promise.resolve(this.cachedPlan?.dataVersion === dataVersion ? this.cachedPlan : null);
  }
  saveCachedPlan(dataVersion: number, plan: Analysis): Promise<void> {
    this.cachedPlan = { dataVersion, computedAt: new Date().toISOString(), plan };
    return Promise.resolve();
  }
  listActions(): Promise<ActionMetaRecord[]> {
    return Promise.resolve(this.actions.map((a) => ActionMetaRecordSchema.parse(a)));
  }
  saveAction(record: ActionMetaRecord): Promise<void> {
    this.actions.push(ActionMetaRecordSchema.parse(record));
    return Promise.resolve();
  }
  saveActions(records: ActionMetaRecord[]): Promise<void> {
    for (const r of records) this.actions.push(ActionMetaRecordSchema.parse(r));
    return Promise.resolve();
  }
  listAudit(): Promise<ApiAuditEntry[]> {
    return Promise.resolve(this.audit.map((e) => ApiAuditEntrySchema.parse(e)));
  }
  saveAudit(entry: ApiAuditEntry): Promise<void> {
    this.audit.push(ApiAuditEntrySchema.parse(entry));
    return Promise.resolve();
  }
  saveAudits(entries: ApiAuditEntry[]): Promise<void> {
    for (const e of entries) this.audit.push(ApiAuditEntrySchema.parse(e));
    return Promise.resolve();
  }
  async saveDecisionBatch(
    records: ActionMetaRecord[],
    entries: ApiAuditEntry[],
    options?: { allowOverwriteIds?: ReadonlySet<string> },
  ): Promise<SaveDecisionBatchResult> {
    const persistedIds = new Set<string>();
    const duplicateIds = new Set<string>();
    const allowOverwrite = options?.allowOverwriteIds;
    const existingByRec = new Map(this.actions.map((a, idx) => [a.recommendationId, idx]));
    const entryByRecId = new Map(entries.map((e) => [e.recommendationId, e]));
    const toActions: ActionMetaRecord[] = [];
    const toAudits: ApiAuditEntry[] = [];
    for (const raw of records) {
      const r = ActionMetaRecordSchema.parse(raw);
      const existsAlready = existingByRec.has(r.recommendationId);
      if ((existsAlready && !allowOverwrite?.has(r.recommendationId)) || persistedIds.has(r.recommendationId)) {
        duplicateIds.add(r.recommendationId);
        continue;
      }
      const entry = entryByRecId.get(r.recommendationId);
      if (!entry) throw new Error(`Missing audit entry for ${r.recommendationId}`);
      toActions.push(r);
      toAudits.push(ApiAuditEntrySchema.parse(entry));
      persistedIds.add(r.recommendationId);
    }
    if (toActions.length > 0) {
      await this.saveAudits(toAudits);
      for (const r of toActions) {
        const idx = existingByRec.get(r.recommendationId);
        if (idx !== undefined) {
          this.actions[idx] = r;
        } else {
          this.actions.push(r);
        }
      }
    }
    return { persistedIds, duplicateIds };
  }
  reopenAction(
    recommendationId: string,
    reopenedAt: string,
    auditEntry: ApiAuditEntry,
  ): Promise<boolean> {
    const target = this.actions.find((a) => a.recommendationId === recommendationId);
    if (!target) return Promise.resolve(false);
    target.reopenedAt = reopenedAt;
    this.audit.push(ApiAuditEntrySchema.parse(auditEntry));
    return Promise.resolve(true);
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
    const idx = this.data.products.findIndex((p) => p.sku === product.sku);
    if (idx >= 0) this.data.products[idx] = product;
    else this.data.products.push(product);
    return Promise.resolve();
  }
  saveBranch(branch: Branch): Promise<void> {
    const idx = this.data.branches.findIndex((b) => b.id === branch.id);
    if (idx >= 0) this.data.branches[idx] = branch;
    else {
      this.data.branches.push(branch);
      const numDays = this.data.dates.length;
      for (let sIdx = 0; sIdx < this.data.products.length; sIdx += 1) {
        this.data.sales[sIdx]?.push(new Array(numDays).fill(0));
        this.data.onHand[sIdx]?.push(new Array(numDays).fill(0));
        this.data.demand[sIdx]?.push(new Array(numDays).fill(0));
      }
    }
    return Promise.resolve();
  }
  removeProduct(sku: string): Promise<void> {
    const idx = this.data.products.findIndex((p) => p.sku === sku);
    if (idx >= 0) this.data.products.splice(idx, 1);
    return Promise.resolve();
  }
  listProductChanges(): Promise<ProductChangeRecord[]> {
    return Promise.resolve([]);
  }
  saveProductChange(): Promise<void> {
    return Promise.resolve();
  }
  hasHistoryOrAudits(sku: string): Promise<{ hasSales: boolean; hasAudits: boolean }> {
    return Promise.resolve({
      hasAudits: this.audit.some((a) => a.sku === sku),
      hasSales: false,
    });
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
  resolveStockAlert(
    id: string,
    resolution: StockAlertResolution,
    linkedOrder?: ResolveStockAlertOrderPayload,
  ): Promise<ResolveStockAlertResult> {
    const previous = this.alertStore.get(id);
    if (!previous) return Promise.resolve({ status: "not_found" });
    if (previous.status !== "PENDING") {
      return Promise.resolve({ status: "already_decided", alert: previous });
    }
    const res = this.alertStore.resolve(id, resolution);
    if (res.status !== "resolved") return Promise.resolve(res);
    if (linkedOrder) {
      const parsedOrder = ReplenishmentOrderSchema.parse({ ...linkedOrder.order, events: [] });
      const parsedEvent = OrderEventSchema.parse(linkedOrder.event);
      this.orders.set(parsedOrder.id, parsedOrder);
      this.orderEvents.push(parsedEvent);
      return Promise.resolve({
        status: "resolved",
        alert: res.alert,
        order: ReplenishmentOrderSchema.parse({
          ...parsedOrder,
          events: this.orderEvents.filter((e) => e.orderId === parsedOrder.id),
        }),
      });
    }
    return Promise.resolve({ status: "resolved", alert: res.alert, order: null });
  }
  listOrders(): Promise<ReplenishmentOrder[]> {
    return Promise.resolve(
      Array.from(this.orders.values(), (o) =>
        ReplenishmentOrderSchema.parse({
          ...o,
          events: this.orderEvents.filter((e) => e.orderId === o.id),
        }),
      ),
    );
  }
  getOrder(id: string): Promise<ReplenishmentOrder | null> {
    const found = this.orders.get(id);
    if (!found) return Promise.resolve(null);
    return Promise.resolve(
      ReplenishmentOrderSchema.parse({
        ...found,
        events: this.orderEvents.filter((e) => e.orderId === id),
      }),
    );
  }
  listOrderEvents(orderId?: string): Promise<OrderEvent[]> {
    const rows = orderId ? this.orderEvents.filter((e) => e.orderId === orderId) : this.orderEvents;
    return Promise.resolve([...rows].sort((a, b) => a.at.localeCompare(b.at)));
  }
  listOrderLifecycleMeta(): Promise<Map<string, OrderLifecycleMeta>> {
    return Promise.resolve(new Map(this.orderLifecycleMeta));
  }
  saveOrderWithEvent(
    order: ReplenishmentOrder,
    event: OrderEvent,
    expectedStatus: OrderStatus | null,
    lifecycleMeta?: OrderLifecycleMeta,
  ): Promise<SaveOrderWithEventResult> {
    const parsedOrder = ReplenishmentOrderSchema.parse({ ...order, events: [] });
    const parsedEvent = OrderEventSchema.parse(event);
    const existing = this.orders.get(parsedOrder.id);
    if (expectedStatus === null) {
      if (existing) return Promise.resolve({ status: "conflict" });
    } else if (!existing || existing.status !== expectedStatus) {
      return Promise.resolve({ status: "conflict" });
    }
    this.orders.set(parsedOrder.id, parsedOrder);
    if (lifecycleMeta) {
      this.orderLifecycleMeta.set(parsedOrder.id, {
        ...this.orderLifecycleMeta.get(parsedOrder.id),
        ...lifecycleMeta,
      });
    }
    this.orderEvents.push(parsedEvent);
    return Promise.resolve({
      status: "saved",
      order: ReplenishmentOrderSchema.parse({
        ...parsedOrder,
        events: this.orderEvents.filter((e) => e.orderId === parsedOrder.id),
      }),
    });
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

const TINY_DAYS = 60;

/**
 * One SKU, three branches:
 *  - BR-001 (Manama) is overstocked: sells 2/day, holds 300 -> donor
 *  - BR-005 (Hidd) is short: sells 5/day, holds 10          -> transfer receiver
 *  - BR-009 (Tubli) is in nobody's seeded scope and steady
 * Mirrors the engine's worked example (60 units from B to A).
 */
export function transferDataset(): Dataset {
  const branches: Branch[] = ["BR-001", "BR-005", "BR-009"].map((id) => {
    const found = BAHRAIN_BRANCHES.find((b) => b.id === id);
    if (!found) throw new Error(`Missing branch ${id} in BAHRAIN_BRANCHES`);
    return { ...found };
  });
  const product: Product = {
    sku: "SKU-90001",
    name: "Test Product",
    category: "Household",
    price: 140,
    cost: 80,
    leadTimeDays: 7,
  };
  const start = Date.UTC(2026, 8, 13);
  const dates = Array.from({ length: TINY_DAYS }, (_, i) =>
    new Date(start + i * 86_400_000).toISOString().slice(0, 10),
  );
  const fill = (v: number) => Array.from({ length: TINY_DAYS }, () => v);
  const sales = [[fill(2), fill(5), fill(3)]];
  const onHand = [[fill(300), fill(10), fill(60)]];
  return {
    seed: 1,
    asOf: dates[dates.length - 1] ?? "2026-11-11",
    dates,
    branches,
    products: [product],
    sales,
    onHand,
    demand: sales,
  };
}

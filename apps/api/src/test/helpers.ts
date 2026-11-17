import type { FastifyInstance } from "fastify";
import {
  BAHRAIN_BRANCHES,
  type ActedBy,
  type ActionRecord,
  type Analysis,
  type AuditEntry,
  type Branch,
  type Dataset,
  type Product,
  type ProductChangeRecord,
  type Role,
  type StockAlert,
} from "@stockflow/core";
import { buildApp } from "../plugins/app.js";
import { InMemoryRepository } from "../repositories/memory.js";
import { MemoryStockAlertStore } from "../repositories/memoryAlerts.js";
import { InMemoryUserRepository } from "../repositories/memoryUser.js";
import type { CachedPlanRecord, SaveDecisionBatchResult, StockRepository } from "../repositories/types.js";
import type { UserRepository } from "../repositories/userTypes.js";
import { createStockServices, type StockServices } from "../services/index.js";

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
  private readonly actions: ActionRecord[] = [];
  private readonly audit: AuditEntry[] = [];
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
  peekActionsSync(): ActionRecord[] {
    return [...this.actions];
  }
  peekAuditSync(): AuditEntry[] {
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
  listActions(): Promise<ActionRecord[]> {
    return Promise.resolve([...this.actions]);
  }
  saveAction(record: ActionRecord): Promise<void> {
    this.actions.push(record);
    return Promise.resolve();
  }
  saveActions(records: ActionRecord[]): Promise<void> {
    this.actions.push(...records);
    return Promise.resolve();
  }
  listAudit(): Promise<AuditEntry[]> {
    return Promise.resolve([...this.audit]);
  }
  saveAudit(entry: AuditEntry): Promise<void> {
    this.audit.push(entry);
    return Promise.resolve();
  }
  saveAudits(entries: AuditEntry[]): Promise<void> {
    this.audit.push(...entries);
    return Promise.resolve();
  }
  async saveDecisionBatch(records: ActionRecord[], entries: AuditEntry[]): Promise<SaveDecisionBatchResult> {
    const persistedIds = new Set<string>();
    const duplicateIds = new Set<string>();
    const existing = new Set(this.actions.map((a) => a.recommendationId));
    const entryByRecId = new Map(entries.map((e) => [e.recommendationId, e]));
    const toActions: ActionRecord[] = [];
    const toAudits: AuditEntry[] = [];
    for (const r of records) {
      if (existing.has(r.recommendationId) || persistedIds.has(r.recommendationId)) {
        duplicateIds.add(r.recommendationId);
        continue;
      }
      const entry = entryByRecId.get(r.recommendationId);
      if (!entry) throw new Error(`Missing audit entry for ${r.recommendationId}`);
      toActions.push(r);
      toAudits.push(entry);
      persistedIds.add(r.recommendationId);
    }
    if (toActions.length > 0) {
      await this.saveAudits(toAudits);
      await this.saveActions(toActions);
    }
    return { persistedIds, duplicateIds };
  }
  clearDecisions(): Promise<{ actionsRemoved: number; auditsRemoved: number }> {
    const actionsRemoved = this.actions.length;
    const auditsRemoved = this.audit.length;
    this.actions.length = 0;
    this.audit.length = 0;
    return Promise.resolve({ actionsRemoved, auditsRemoved });
  }
  saveProduct(product: Product): Promise<void> {
    const idx = this.data.products.findIndex((p) => p.sku === product.sku);
    if (idx >= 0) this.data.products[idx] = product;
    else this.data.products.push(product);
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

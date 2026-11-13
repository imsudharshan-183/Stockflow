import type { FastifyInstance } from "fastify";
import type {
  ActionRecord,
  Analysis,
  AuditEntry,
  Branch,
  Dataset,
  Product,
  Role,
} from "@stockflow/core";
import { buildApp } from "../plugins/app.js";
import { InMemoryRepository } from "../repositories/memory.js";
import { InMemoryUserRepository } from "../repositories/memoryUser.js";
import type { StockRepository } from "../repositories/types.js";
import type { UserRepository } from "../repositories/userTypes.js";
import { StockService } from "../services/stockService.js";

export const TEST_JWT_SECRET = "test-secret-at-least-32-characters-long-key";

/** Seeded users (see repositories/seedData.ts). */
export const SEED_USERS = {
  admin: { id: "usr_admin_01", email: "admin@stockflow.dev", role: "admin", password: "Admin@12345" },
  managerMidwest: {
    id: "usr_mgr_01",
    email: "manager.midwest@stockflow.dev",
    role: "manager",
    password: "Manager@12345",
    branchIds: ["BR-001", "BR-002"],
  },
  managerWest: {
    id: "usr_mgr_02",
    email: "manager.west@stockflow.dev",
    role: "manager",
    password: "Manager@12345",
    branchIds: ["BR-005", "BR-006", "BR-008", "BR-011"],
  },
  staffChicago: {
    id: "usr_stf_01",
    email: "staff.chicago@stockflow.dev",
    role: "staff",
    password: "Staff@12345",
    branchIds: ["BR-001"],
  },
  staffLincoln: {
    id: "usr_stf_02",
    email: "staff.lincoln@stockflow.dev",
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
  service: StockService;
  repo: StockRepository;
}

export async function setupApp(
  options: { authEnabled?: boolean; repo?: StockRepository } = {},
): Promise<TestContext> {
  const repo = options.repo ?? InMemoryRepository.create();
  const service = await StockService.create(repo);
  const app = await buildApp(service, {
    AUTH_ENABLED: options.authEnabled ?? true,
    JWT_SECRET: TEST_JWT_SECRET,
  });
  await app.ready();
  return { app, service, repo };
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

  constructor(private readonly data: Dataset) {}

  loadDataset(): Promise<Dataset> {
    return Promise.resolve(this.data);
  }
  loadAnalysis(): Promise<Analysis | null> {
    return Promise.resolve(null);
  }
  saveAnalysis(): Promise<void> {
    return Promise.resolve();
  }
  listActions(): Promise<ActionRecord[]> {
    return Promise.resolve([...this.actions]);
  }
  saveAction(record: ActionRecord): Promise<void> {
    this.actions.push(record);
    return Promise.resolve();
  }
  listAudit(): Promise<AuditEntry[]> {
    return Promise.resolve([...this.audit]);
  }
  saveAudit(entry: AuditEntry): Promise<void> {
    this.audit.push(entry);
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

const TINY_DAYS = 60;

/**
 * One SKU, three branches:
 *  - BR-001 (Midwest) is overstocked: sells 2/day, holds 300  -> donor
 *  - BR-005 (West) is short: sells 5/day, holds 10            -> transfer receiver
 *  - BR-009 is in nobody's seeded scope and steady
 * Mirrors the engine's worked example (60 units from B to A).
 */
export function transferDataset(): Dataset {
  const branches: Branch[] = [
    { id: "BR-001", name: "Chicago - Loop", city: "Chicago", region: "Midwest" },
    { id: "BR-005", name: "Santa Monica", city: "Los Angeles", region: "West" },
    { id: "BR-009", name: "Miami - Brickell", city: "Miami", region: "South" },
  ];
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

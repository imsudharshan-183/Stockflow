import { BAHRAIN_BRANCHES, type Branch, type Dataset, type Product, type Role, type User } from "@stockflow/core";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import type { Env } from "../config/env.js";
import { buildApp } from "../plugins/app.js";
import { InMemoryRepository } from "../repositories/memory.js";
import { MongoRepository } from "../repositories/mongo.js";
import type { StockRepository } from "../repositories/types.js";
import { StockService } from "../services/stockService.js";
import { TEST_JWT_SECRET } from "./helpers.js";

const SMALL_DAYS = 60;

/**
 * Small deterministic dataset with 3 branches and 3 SKUs:
 * - SKU-90001: BR-001 overstocked (300, 2/day), BR-005 short (10, 5/day) -> TRANSFER
 * - SKU-90002: BR-001 short (5, 4/day), BR-005 normal (40, 2/day) -> REORDER
 * - SKU-90003: BR-001 heavy overstock (500, 0.2/day), BR-005 steady (40, 2/day) -> MARKDOWN
 */
export function smallSeededDataset(): Dataset {
  const branches: Branch[] = ["BR-001", "BR-005", "BR-009"].map((id) => {
    const found = BAHRAIN_BRANCHES.find((b) => b.id === id);
    if (!found) throw new Error(`Missing branch ${id} in BAHRAIN_BRANCHES`);
    return { ...found };
  });
  const products: Product[] = [
    {
      sku: "SKU-90001",
      name: "Test Transfer Jacket",
      category: "Outerwear",
      price: 140,
      cost: 80,
      leadTimeDays: 7,
      status: "active",
    },
    {
      sku: "SKU-90002",
      name: "Test Reorder Mug",
      category: "Household",
      price: 28,
      cost: 10,
      leadTimeDays: 10,
      status: "active",
    },
    {
      sku: "SKU-90003",
      name: "Test Markdown Blanket",
      category: "Household",
      price: 90,
      cost: 40,
      leadTimeDays: 7,
      status: "active",
    },
  ];
  const start = Date.UTC(2026, 8, 13);
  const dates = Array.from({ length: SMALL_DAYS }, (_, i) =>
    new Date(start + i * 86_400_000).toISOString().slice(0, 10),
  );
  const fill = (v: number) => Array.from({ length: SMALL_DAYS }, () => v);
  const sparse = (step: number) =>
    Array.from({ length: SMALL_DAYS }, (_, i) => (i % step === 0 ? 1 : 0));

  const sales = [
    [fill(2), fill(5), fill(3)],
    [fill(4), fill(2), fill(2)],
    [sparse(5), fill(2), fill(2)],
  ];
  const onHand = [
    [fill(300), fill(10), fill(60)],
    [fill(5), fill(40), fill(40)],
    [fill(500), fill(40), fill(40)],
  ];
  return {
    seed: 1,
    asOf: dates[SMALL_DAYS - 1] ?? "2026-11-11",
    dates,
    branches,
    products,
    sales,
    onHand,
    demand: sales,
  };
}

export async function buildTestApp(
  repo: StockRepository,
  envOverrides?: Partial<Env>,
): Promise<{ app: FastifyInstance; service: StockService }> {
  const service = await StockService.create(repo);
  const app = await buildApp(service, {
    AUTH_ENABLED: true,
    JWT_SECRET: TEST_JWT_SECRET,
    ...envOverrides,
  });
  await app.ready();
  return { app, service };
}

export async function createUser(
  repo: StockRepository,
  role: Role,
  branchIds: string[],
  overrides: Partial<{ id: string; email: string; name: string; password: string; isActive: boolean }> = {},
): Promise<{ user: User; password: string }> {
  const password = overrides.password ?? "TestPass@12345";
  const passwordHash = await bcrypt.hash(password, 4);
  const email = overrides.email ?? `${role}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}@stockflow.test`;
  const user = await repo.users.create({
    email,
    name: overrides.name ?? `Test ${role}`,
    role,
    branchIds,
    passwordHash,
    isActive: overrides.isActive ?? true,
  });
  return { user, password };
}

export interface CookieJarSession {
  accessToken: string;
  cookies: Record<string, string>;
  cookieHeader: string;
  authHeader: { authorization: string };
}

export function extractCookies(setCookieHeaders: string | string[] | undefined): Record<string, string> {
  const jar: Record<string, string> = {};
  const list = Array.isArray(setCookieHeaders)
    ? setCookieHeaders
    : setCookieHeaders
      ? [setCookieHeaders]
      : [];
  for (const header of list) {
    const first = header.split(";")[0];
    if (!first) continue;
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    jar[name] = value;
  }
  return jar;
}

export function formatCookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

export async function loginAs(
  app: FastifyInstance,
  email: string,
  password: string,
): Promise<CookieJarSession> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password },
  });
  if (res.statusCode !== 200) {
    throw new Error(`loginAs(${email}) failed with status ${res.statusCode}: ${res.body}`);
  }
  const body = JSON.parse(res.body) as { token: string };
  const cookies = extractCookies(res.headers["set-cookie"]);
  return {
    accessToken: body.token,
    cookies,
    cookieHeader: formatCookieHeader(cookies),
    authHeader: { authorization: `Bearer ${body.token}` },
  };
}

export function assertTestMongoDatabaseName(dbName: string): void {
  if (!dbName.endsWith("_test")) {
    throw new Error(`Refusing to run Mongo tests against non-test database "${dbName}"`);
  }
}

export type RepoKind = "memory" | "mongo-memory";

export async function createDualRepo(
  kind: RepoKind,
  dataset: Dataset = smallSeededDataset(),
): Promise<{ repo: StockRepository; cleanup: () => Promise<void> }> {
  if (kind === "memory") {
    const repo = InMemoryRepository.createFromDataset(dataset);
    return {
      repo,
      cleanup: async () => {
        await repo.close();
      },
    };
  }

  const dbName = "stockflow_test";
  assertTestMongoDatabaseName(dbName);
  const mongod = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  const uri = mongod.getUri();
  const repo = await MongoRepository.connect(uri, dbName);
  await repo.seed(dataset, true);
  return {
    repo,
    cleanup: async () => {
      await repo.close();
      await mongod.stop();
    },
  };
}

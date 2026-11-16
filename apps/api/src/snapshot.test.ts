import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SEED_USERS, bearer, setupApp, tokenFor } from "./test/helpers.js";

/**
 * Fixture-based snapshot of the two endpoints the morning screen is built from.
 * Fixtures are tracked in git (src/__fixtures__). A missing fixture is a hard failure,
 * never a silent pass. Regenerate deliberately with `pnpm --filter @stockflow/api fixtures:update`.
 */
const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");

function readFixture(name: string): string {
  const file = path.join(FIXTURE_DIR, name);
  if (!fs.existsSync(file)) {
    throw new Error(
      `Snapshot fixture missing: ${file}. Run \`pnpm --filter @stockflow/api fixtures:update\` and commit it.`,
    );
  }
  const raw = fs.readFileSync(file, "utf8");
  expect(raw.length, `fixture ${name} is empty`).toBeGreaterThan(100);
  return raw;
}

function expectMatchesFixture(payload: string, name: string): void {
  const fixture = readFixture(name);
  // Structural diff first (readable failure output), then the byte-level check.
  expect(JSON.parse(payload)).toStrictEqual(JSON.parse(fixture));
  expect(payload).toBe(fixture.trimEnd());
}

describe("snapshot: /api/recommendations and /api/kpis match tracked fixtures", () => {
  let noAuth: FastifyInstance;
  let withAuth: FastifyInstance;

  beforeAll(async () => {
    noAuth = (await setupApp({ authEnabled: false })).app;
    withAuth = (await setupApp({ authEnabled: true })).app;
  }, 30_000);
  afterAll(async () => {
    await noAuth.close();
    await withAuth.close();
  });

  it("fixtures exist and contain the expected shape", () => {
    const recs = JSON.parse(readFixture("recommendations.json")) as { recommendations: unknown[]; total: number };
    const kpis = JSON.parse(readFixture("kpis.json")) as { asOf: string };
    expect(recs.recommendations.length).toBeGreaterThan(0);
    expect(recs.total).toBe(recs.recommendations.length);
    expect(kpis.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("AUTH_ENABLED=false: responses are byte-identical to the fixtures", async () => {
    const recs = await noAuth.inject({ method: "GET", url: "/api/recommendations" });
    const kpis = await noAuth.inject({ method: "GET", url: "/api/kpis" });
    expect(recs.statusCode).toBe(200);
    expect(kpis.statusCode).toBe(200);
    expectMatchesFixture(recs.payload, "recommendations.json");
    expectMatchesFixture(kpis.payload, "kpis.json");
  });

  it("AUTH_ENABLED=true as admin: responses are byte-identical to the fixtures", async () => {
    const headers = bearer(tokenFor(withAuth, SEED_USERS.admin));
    const recs = await withAuth.inject({ method: "GET", url: "/api/recommendations", headers });
    const kpis = await withAuth.inject({ method: "GET", url: "/api/kpis", headers });
    expect(recs.statusCode).toBe(200);
    expect(kpis.statusCode).toBe(200);
    expectMatchesFixture(recs.payload, "recommendations.json");
    expectMatchesFixture(kpis.payload, "kpis.json");
  });
});

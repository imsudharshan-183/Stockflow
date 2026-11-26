import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { simulateNextDay } from "@stockflow/core";
import { readEnv } from "../config/env.js";
import {
  clearMemorySalesEntries, clearRecomputeCallLog, getRecomputeCallLog,
  listImportLogs, listSalesEntries, upsertSalesEntry,
} from "../db.js";
import { buildTestApp, createDualRepo, createUser, smallSeededDataset } from "../test/dualRepo.js";
import { bearer, tokenFor } from "../test/helpers.js";

const url = "/api/catalog/simulate-next-day";
it("requires an explicit true flag and keeps sign-in enabled for an unrecognized value", () => {
  for (const value of [undefined, "false", "0", "typo", "true"]) {
    const env = readEnv({ AUTH_ENABLED: "true", JWT_SECRET: "test-only", ALLOW_SYNTHETIC_DATA: value });
    expect(env.AUTH_ENABLED).toBe(true);
    expect(env.ALLOW_SYNTHETIC_DATA).toBe(value === "true");
  }
});
beforeEach(() => {
  clearMemorySalesEntries();
  clearRecomputeCallLog();
});
afterEach(() => vi.restoreAllMocks());

describe.each(["memory", "mongo-memory"] as const)("sales simulation (%s)", kind => {
  it("advances one dataset day per Bahrain day and publishes one batch per click", async () => {
    const data = smallSeededDataset();
    const { repo, cleanup } = await createDualRepo(kind, data);
    const { app, services } = await buildTestApp(repo, { ALLOW_SYNTHETIC_DATA: true });
    const mongo = kind === "mongo-memory";
    try {
      let now = Date.parse("2026-11-26T20:59:00Z");
      services.setClock(() => now);
      const { user } = await createUser(repo, "admin", []);
      const headers = bearer(tokenFor(app, user));
      const post = () => app.inject({ method: "POST", url, headers });
      expect((await app.inject("/api/health")).json().allowSyntheticData).toBe(true);
      expect((await app.inject({ method: "POST", url })).statusCode).toBe(401);
      for (const role of ["staff", "manager"] as const) {
        const other = await createUser(repo, role, ["BR-001"]);
        const denied = await app.inject({ method: "POST", url, headers: bearer(tokenFor(app, other.user)) });
        expect(denied.statusCode).toBe(403);
      }
      expect((await app.inject({ method: "POST", url, headers, payload: { targetDate: "2030-01-01" } })).statusCode).toBe(400);
      const recompute = vi.spyOn(services.catalog, "recomputeSingleSku");
      const commit = vi.spyOn(services, "commitPlanVersion");
      const first = await Promise.all([post(), post()]);
      expect(first.map(r => r.statusCode).sort()).toEqual([200, 429]);
      expect(first.find(r => r.statusCode === 200)!.json()).toEqual({ targetDate: "2026-11-12", branches: 3, rows: 9 });
      const limited = await post();
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error).toContain("Bahrain calendar day");
      const restarted = await buildTestApp(repo, { ALLOW_SYNTHETIC_DATA: true });
      try {
        restarted.services.setClock(() => now);
        expect((await restarted.app.inject({ method: "POST", url, headers })).statusCode).toBe(429);
      } finally {
        await restarted.app.close();
      }
      now += 60_000;
      const second = await post();
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json()).toEqual({ targetDate: "2026-11-13", branches: 3, rows: 9 });
      expect(services.runtime.data.dates).toEqual([...data.dates, "2026-11-12", "2026-11-13"]);
      for (const series of services.runtime.data.sales.flat()) {
        expect(series).toHaveLength(services.runtime.data.dates.length);
      }
      expect(services.runtime.analysis.kpis.asOf).toBe("2026-11-13");
      expect(recompute.mock.calls.map(([sku]) => sku)).toEqual(Array(2).fill(data.products.map(p => p.sku)).flat());
      expect(getRecomputeCallLog().map(call => call.sku)).toEqual(recompute.mock.calls.map(([sku]) => sku));
      expect(commit).toHaveBeenCalledTimes(2);
      expect(await listImportLogs({}, mongo)).toMatchObject([
        { inserted: 9, updated: 0, fileName: "Synthetic sales · 2026-11-13" },
        { inserted: 9, updated: 0, fileName: "Synthetic sales · 2026-11-12" },
      ]);
      // Replay day one after both days exist. Opening stock must come from the day before the target.
      const replay = simulateNextDay(services.runtime.data, "2026-11-12");
      expect(replay).toEqual(simulateNextDay(data, "2026-11-12"));
      for (const row of replay) {
        const result = await upsertSalesEntry({ ...row, unitsSold: row.sales }, mongo, "sample");
        expect(result.created).toBe(false);
        expect(services.catalog.applySalesEntryToDataset(row.branchId, row.sku, row.date, row.sales, row.onHand).dateAdded).toBe(false);
      }
      expect((await listSalesEntries({ page: 1, limit: 20 }, mongo)).total).toBe(18);
      expect(services.runtime.data.dates.length).toBe(data.dates.length + 2);
    } finally {
      await app.close();
      await cleanup();
    }
  }, 60_000);

  it("recovers an interrupted run on the next allowed click and preserves a store's existing entry", async () => {
    const data = smallSeededDataset();
    const { repo, cleanup } = await createDualRepo(kind, data);
    const mongo = kind === "mongo-memory";
    const rows = simulateNextDay(data, "2026-11-12");
    const first = rows[0]!;
    const second = rows[1]!;
    await upsertSalesEntry({ ...first, unitsSold: first.sales }, mongo, "sample", { firstRowOn: "2026-11-25" });
    await upsertSalesEntry({ ...second, unitsSold: 17, onHand: 80 }, mongo);
    const { app, services } = await buildTestApp(repo, { ALLOW_SYNTHETIC_DATA: true });
    try {
      const { user } = await createUser(repo, "admin", []);
      const headers = bearer(tokenFor(app, user));
      services.setClock(() => Date.parse("2026-11-26T09:00:00Z"));
      const result = await app.inject({ method: "POST", url, headers });
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json()).toEqual({ rows: 7, branches: 3, targetDate: "2026-11-12" });
      expect(services.runtime.data.sales[0]![1]!.at(-1)).toBe(17);
      expect(services.runtime.data.onHand[0]![1]!.at(-1)).toBe(80);
      expect((await listSalesEntries({ page: 1, limit: 20 }, mongo)).total).toBe(9);
      expect(await listImportLogs({}, mongo)).toMatchObject([{ inserted: 7, updated: 0 }]);
    } finally {
      await app.close();
      await cleanup();
    }
  }, 60_000);
});

it.each([
  { ALLOW_SYNTHETIC_DATA: false, AUTH_ENABLED: true },
  { ALLOW_SYNTHETIC_DATA: true, AUTH_ENABLED: false },
])("blocks simulation when the flag or sign-in is disabled", async flags => {
  const { repo, cleanup } = await createDualRepo("memory");
  const { app } = await buildTestApp(repo, flags);
  try {
    const { user } = await createUser(repo, "admin", []);
    expect((await app.inject("/api/health")).json().allowSyntheticData).toBeUndefined();
    expect((await app.inject({ method: "POST", url, headers: bearer(tokenFor(app, user)) })).statusCode).toBe(403);
    expect(getRecomputeCallLog()).toHaveLength(0);
    expect(await listImportLogs({}, false)).toHaveLength(0);
  } finally {
    await app.close();
    await cleanup();
  }
});

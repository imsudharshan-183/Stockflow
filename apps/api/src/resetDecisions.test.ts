import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Recommendation, User } from "@stockflow/core";
import type { StockRepository } from "./repositories/types.js";
import { runResetDecisions } from "./resetDecisions.js";
import { buildTestApp, createDualRepo, createUser, type RepoKind } from "./test/dualRepo.js";
import { bearer, tokenFor } from "./test/helpers.js";

describe.each<RepoKind>(["memory", "mongo-memory"])("Demo Decision Reset (%s)", (kind) => {
  let repo: StockRepository;
  let cleanup: () => Promise<void>;
  let adminUser: User;
  const adminPassword = "ResetAdmin@12345";

  beforeAll(async () => {
    const setup = await createDualRepo(kind);
    repo = setup.repo;
    cleanup = setup.cleanup;
    adminUser = (
      await createUser(repo, "admin", [], {
        email: `reset.admin.${kind}@stockflow.test`,
        password: adminPassword,
      })
    ).user;
  }, 120_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("requires --yes, clears only decisions and audit entries without bumping dataVersion", async () => {
    const { app } = await buildTestApp(repo);
    try {
      const headers = bearer(tokenFor(app, adminUser));

      // 1. Obtain a refresh cookie via login so we can confirm refresh tokens survive reset
      const loginRes = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: adminUser.email, password: adminPassword },
      });
      expect(loginRes.statusCode).toBe(200);
      const refreshCookie = loginRes.cookies.find((c) => c.name === "stockflow_refresh");
      expect(refreshCookie).toBeDefined();

      // 2. Create a sales entry so sales_entries is non-empty
      const salesRes = await app.inject({
        method: "POST",
        url: "/api/sales-entries",
        headers,
        payload: {
          branchId: "BR-009",
          sku: "SKU-90002",
          date: "2026-11-11",
          unitsSold: 3,
          onHand: 50,
        },
      });
      expect(salesRes.statusCode).toBe(201);

      // 3. Approve and reject recommendations to populate actions & audit
      const recsRes = await app.inject({
        method: "GET",
        url: "/api/recommendations",
        headers,
      });
      expect(recsRes.statusCode).toBe(200);
      const recs = (JSON.parse(recsRes.body) as { recommendations: Recommendation[] }).recommendations;
      expect(recs.length).toBeGreaterThanOrEqual(2);

      const firstId = recs[0]!.id;
      const secondId = recs[1]!.id;

      const approveRes = await app.inject({
        method: "POST",
        url: `/api/recommendations/${firstId}/approve`,
        headers,
      });
      expect(approveRes.statusCode).toBe(200);

      const rejectRes = await app.inject({
        method: "POST",
        url: `/api/recommendations/${secondId}/reject`,
        headers,
        payload: { reasonCode: "SUPPLIER_DELAY" },
      });
      expect(rejectRes.statusCode).toBe(200);

      const versionBefore = await repo.getDataVersion();
      const datasetBefore = await repo.loadDataset();
      const usersBefore = await repo.users.list();
      expect((await repo.listActions()).length).toBe(2);
      expect((await repo.listAudit()).length).toBe(2);

      // 4. Without --yes, reset is refused and leaves data untouched
      const refusedLogs: string[] = [];
      const refusedErrs: string[] = [];
      const refused = await runResetDecisions([], {
        repo,
        log: (m) => refusedLogs.push(m),
        error: (m) => refusedErrs.push(m),
      });
      expect(refused.ok).toBe(false);
      expect(refusedErrs.join("\n")).toContain("--yes");
      expect((await repo.listActions()).length).toBe(2);
      expect((await repo.listAudit()).length).toBe(2);
      expect(await repo.getDataVersion()).toBe(versionBefore);

      // 5. With --yes, only actions and decision audits are removed
      const logs: string[] = [];
      const errs: string[] = [];
      const res = await runResetDecisions(["--yes"], {
        repo,
        log: (m) => logs.push(m),
        error: (m) => errs.push(m),
      });
      expect(errs).toEqual([]);
      expect(res.ok).toBe(true);
      expect(res.actionsRemoved).toBe(2);
      expect(res.auditsRemoved).toBe(2);

      const expectedDbName = kind === "mongo-memory" ? "stockflow_test" : "memory";
      expect(res.database).toBe(expectedDbName);
      expect(logs.join("\n")).toContain(expectedDbName);
      expect(logs.join("\n")).not.toContain("mongodb://");
      expect(logs.join("\n")).not.toContain("mongodb+srv://");

      // Actions and audits cleared
      expect(await repo.listActions()).toHaveLength(0);
      expect(await repo.listAudit()).toHaveLength(0);

      // dataVersion unchanged
      expect(await repo.getDataVersion()).toBe(versionBefore);

      // Catalog, sales entries, users, and refresh tokens preserved
      const datasetAfter = await repo.loadDataset();
      expect(datasetAfter.products.map((p) => p.sku)).toEqual(datasetBefore.products.map((p) => p.sku));
      expect((await repo.users.list()).length).toBe(usersBefore.length);

      const salesAfter = await app.inject({
        method: "GET",
        url: "/api/sales-entries?sku=SKU-90002",
        headers,
      });
      expect(salesAfter.statusCode).toBe(200);
      expect((JSON.parse(salesAfter.body) as { entries: unknown[] }).entries.length).toBeGreaterThanOrEqual(1);

      const refreshAfter = await app.inject({
        method: "POST",
        url: "/api/auth/refresh",
        cookies: { stockflow_refresh: refreshCookie!.value },
      });
      expect(refreshAfter.statusCode).toBe(200);

      // Recommendations are back to Pending on the queue
      const recsAfterRes = await app.inject({
        method: "GET",
        url: "/api/recommendations",
        headers,
      });
      expect(recsAfterRes.statusCode).toBe(200);
      const recsAfter = (JSON.parse(recsAfterRes.body) as { recommendations: Recommendation[] }).recommendations;
      expect(recsAfter.find((r) => r.id === firstId)?.status).toBe("PENDING");
      expect(recsAfter.find((r) => r.id === secondId)?.status).toBe("PENDING");
    } finally {
      await app.close();
    }
  });
});

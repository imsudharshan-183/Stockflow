import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as core from "@stockflow/core";
import type { Recommendation, User } from "@stockflow/core";
import type { StockRepository } from "./repositories/types.js";
import { StockService } from "./services/stockService.js";
import { buildTestApp, createDualRepo, createUser, type RepoKind } from "./test/dualRepo.js";
import { bearer, tokenFor } from "./test/helpers.js";

describe.each<RepoKind>(["memory", "mongo-memory"])("Serverless Plan Consistency (%s)", (kind) => {
  let repo: StockRepository;
  let cleanup: () => Promise<void>;
  let adminUser: User;

  beforeAll(async () => {
    const setup = await createDualRepo(kind);
    repo = setup.repo;
    cleanup = setup.cleanup;
    adminUser = (await createUser(repo, "admin", [], { email: `plan.admin.${kind}@stockflow.test` })).user;
  }, 120_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("propagates sales-entry, catalog, and decision writes from Instance A to Instance B", async () => {
    const instA = await buildTestApp(repo);
    const instB = await buildTestApp(repo);
    try {
      const headersA = bearer(tokenFor(instA.app, adminUser));
      const headersB = bearer(tokenFor(instB.app, adminUser));

      // Warm Instance B
      const initialB = JSON.parse(
        (await instB.app.inject({ method: "GET", url: "/api/recommendations", headers: headersB })).body,
      ) as { recommendations: Recommendation[] };
      const v0 = await repo.getDataVersion();

      // 1. Sales entry write on Instance A
      const entryRes = await instA.app.inject({
        method: "POST",
        url: "/api/sales-entries",
        headers: headersA,
        payload: {
          branchId: "BR-009",
          sku: "SKU-90002",
          date: "2026-11-11",
          unitsSold: 15,
          onHand: 0,
        },
      });
      expect(entryRes.statusCode).toBe(201);
      expect(await repo.getDataVersion()).toBe(v0 + 1);

      const afterEntryB = JSON.parse(
        (await instB.app.inject({ method: "GET", url: "/api/recommendations", headers: headersB })).body,
      ) as { recommendations: Recommendation[] };
      expect(afterEntryB.recommendations.some((r) => r.sku === "SKU-90002" && r.branchId === "BR-009")).toBe(true);
      expect(afterEntryB.recommendations.length).not.toBe(initialB.recommendations.length);

      // 2. Decision on Instance A -> visible on Instance B without bumping dataVersion
      const targetRec = afterEntryB.recommendations[0]!;
      const versionBeforeApprove = await repo.getDataVersion();
      const approveRes = await instA.app.inject({
        method: "POST",
        url: `/api/recommendations/${targetRec.id}/approve`,
        headers: headersA,
      });
      expect(approveRes.statusCode).toBe(200);
      expect(await repo.getDataVersion()).toBe(versionBeforeApprove);

      const afterApproveB = JSON.parse(
        (await instB.app.inject({ method: "GET", url: "/api/recommendations", headers: headersB })).body,
      ) as { recommendations: Recommendation[] };
      expect(afterApproveB.recommendations.find((r) => r.id === targetRec.id)?.status).toBe("APPROVED");

      // 3. Archive catalog product on Instance A -> visible on Instance B
      const archiveRes = await instA.app.inject({
        method: "PATCH",
        url: "/api/catalog/products/SKU-90003/archive",
        headers: headersA,
      });
      expect(archiveRes.statusCode).toBe(200);

      const afterArchiveB = JSON.parse(
        (await instB.app.inject({ method: "GET", url: "/api/recommendations", headers: headersB })).body,
      ) as { recommendations: Recommendation[] };
      expect(afterArchiveB.recommendations.some((r) => r.sku === "SKU-90003")).toBe(false);
    } finally {
      await instA.app.close();
      await instB.app.close();
    }
  });

  it("cold start with a valid persisted plan_cache does not call analyze()", async () => {
    const version = await repo.getDataVersion();
    const existing = await repo.loadCachedPlan(version);
    if (!existing) {
      const ds = await repo.loadDataset();
      await repo.saveCachedPlan(version, core.analyze(ds, core.DEFAULT_POLICY));
    }

    const analyzeSpy = vi.spyOn(core, "analyze");
    try {
      const coldService = await StockService.create(repo);
      await coldService.ensureFreshPlan();
      expect(analyzeSpy).not.toHaveBeenCalled();
      expect(coldService.kpis().branches.length).toBeGreaterThan(0);
    } finally {
      analyzeSpy.mockRestore();
    }
  });

  it("version mismatch triggers exactly one compute under concurrent reads and falls back if persist fails", async () => {
    const { app, service } = await buildTestApp(repo);
    const headers = bearer(tokenFor(app, adminUser));
    try {
      // Bump version without saving plan_cache for the new version
      await repo.bumpDataVersion();

      let computeCount = 0;
      const origLoadCached = repo.loadCachedPlan.bind(repo);
      const origSaveCached = repo.saveCachedPlan.bind(repo);

      const loadSpy = vi.spyOn(repo, "loadCachedPlan").mockImplementation(async (v) => {
        const res = await origLoadCached(v);
        if (!res) computeCount += 1;
        return res;
      });
      const saveSpy = vi.spyOn(repo, "saveCachedPlan").mockRejectedValue(new Error("Simulated Mongo write failure"));

      try {
        // Concurrent reads on version mismatch should deduplicate refresh (1 miss) and still succeed despite save failure
        const [r1, r2, r3] = await Promise.all([
          app.inject({ method: "GET", url: "/api/recommendations", headers }),
          app.inject({ method: "GET", url: "/api/recommendations", headers }),
          app.inject({ method: "GET", url: "/api/kpis", headers }),
        ]);
        expect(r1.statusCode).toBe(200);
        expect(r2.statusCode).toBe(200);
        expect(r3.statusCode).toBe(200);
        expect(computeCount).toBe(1);
        expect(service.kpis().branches.length).toBeGreaterThan(0);
      } finally {
        loadSpy.mockRestore();
        saveSpy.mockRestore();
        // Restore valid cache for current version
        const v = await repo.getDataVersion();
        const ds = await repo.loadDataset();
        await origSaveCached(v, core.analyze(ds, core.DEFAULT_POLICY));
      }
    } finally {
      await app.close();
    }
  });

  it("wipes stale sales_entries, audits, product_changes, actions, and cached plans when reseeding Mongo", async () => {
    if (kind !== "mongo-memory") return;
    const mongoRepo = repo as unknown as {
      seed: (dataset?: core.Dataset) => Promise<void>;
    };
    // Reseed with default arguments (simulating pnpm seed:mongo) after prior tests wrote sales_entries, actions, audits, and product changes
    await mongoRepo.seed(
      (await import("./test/dualRepo.js")).smallSeededDataset(),
    );
    expect(await repo.getDataVersion()).toBe(1);
    expect(await repo.listActions()).toHaveLength(0);
    expect(await repo.listAudit()).toHaveLength(0);
    expect(await repo.listProductChanges("SKU-90003")).toHaveLength(0);
    const dataset = await repo.loadDataset();
    expect(dataset.branches.map((b) => b.name)).toContain("Manama - CBD");
  });
});

import {
  DEFAULT_POLICY,
  analyze,
  backtest,
  BranchListResponseSchema,
  BranchSchema,
  type Recommendation,
} from "@stockflow/core";
import { describe, expect, it } from "vitest";
import { buildTestApp, createDualRepo, createUser, loginAs, type RepoKind } from "./test/dualRepo.js";
import {
  FixedDatasetRepository,
  SEED_USERS,
  bearer,
  json,
  setupApp,
  tokenFor,
  transferDataset,
} from "./test/helpers.js";

describe("Branch Management API (/api/branches)", () => {
  it("enforces admin-only RBAC (401 unauthenticated, 403 for manager and staff)", async () => {
    const { app } = await setupApp({ authEnabled: true });
    try {
      const managerHeader = bearer(tokenFor(app, SEED_USERS.managerManama));
      const staffHeader = bearer(tokenFor(app, SEED_USERS.staffManama));
      const adminHeader = bearer(tokenFor(app, SEED_USERS.admin));

      for (const req of [
        { method: "GET" as const, url: "/api/branches" },
        {
          method: "POST" as const,
          url: "/api/branches",
          payload: { name: "Amwaj", city: "Muharraq", region: "Muharraq", coordinates: [26.28, 50.66] },
        },
        { method: "PATCH" as const, url: "/api/branches/BR-001", payload: { status: "archived" } },
      ]) {
        const unauth = await app.inject(req);
        expect(unauth.statusCode).toBe(401);

        const mgr = await app.inject({ ...req, headers: managerHeader });
        expect(mgr.statusCode).toBe(403);

        const stf = await app.inject({ ...req, headers: staffHeader });
        expect(stf.statusCode).toBe(403);
      }

      const adminList = await app.inject({
        method: "GET",
        url: "/api/branches",
        headers: adminHeader,
      });
      expect(adminList.statusCode).toBe(200);
      const parsed = BranchListResponseSchema.parse(json(adminList.payload));
      expect(parsed.total).toBe(15);
      expect(parsed.branches.every((b) => b.status === "active")).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("cold-start: new branch pushes zero-filled arrays for every product and never crashes analyze() or backtest()", async () => {
    const { app, services } = await setupApp({ authEnabled: true });
    try {
      const adminHeader = bearer(tokenFor(app, SEED_USERS.admin));

      const createRes = await app.inject({
        method: "POST",
        url: "/api/branches",
        headers: adminHeader,
        payload: {
          name: "Amwaj Islands",
          city: "Muharraq",
          region: "Muharraq",
          coordinates: [26.2845, 50.6612],
        },
      });
      expect(createRes.statusCode).toBe(201);
      const created = BranchSchema.parse(json(createRes.payload));
      expect(created).toMatchObject({
        id: "BR-016",
        name: "Amwaj Islands",
        city: "Muharraq",
        region: "Muharraq",
        coordinates: [26.2845, 50.6612],
        status: "active",
      });

      const data = services.runtime.data;
      const newBranchIdx = data.branches.findIndex((b) => b.id === "BR-016");
      expect(newBranchIdx).toBe(15);
      const expectedDays = data.dates.length;

      // Verify exact mirror-axis cold start: every existing product now has zero-filled arrays of length dates.length
      for (let sIdx = 0; sIdx < data.products.length; sIdx += 1) {
        expect(data.sales[sIdx]).toHaveLength(data.branches.length);
        expect(data.onHand[sIdx]).toHaveLength(data.branches.length);
        expect(data.demand[sIdx]).toHaveLength(data.branches.length);

        const salesRow = data.sales[sIdx]![newBranchIdx]!;
        const onHandRow = data.onHand[sIdx]![newBranchIdx]!;
        const demandRow = data.demand[sIdx]![newBranchIdx]!;

        expect(salesRow).toHaveLength(expectedDays);
        expect(onHandRow).toHaveLength(expectedDays);
        expect(demandRow).toHaveLength(expectedDays);
        expect(salesRow.every((v) => v === 0)).toBe(true);
        expect(onHandRow.every((v) => v === 0)).toBe(true);
        expect(demandRow.every((v) => v === 0)).toBe(true);
      }

      // Direct engine calls analyze() and backtest() must not crash and must emit 0 recommendations for BR-016
      const directAnalysis = analyze(data, DEFAULT_POLICY);
      const directBacktest = backtest(data, DEFAULT_POLICY);
      expect(directBacktest.windowDays).toBeGreaterThan(0);
      expect(
        directAnalysis.recommendations.some(
          (r) => r.branchId === "BR-016" || r.donorBranchId === "BR-016",
        ),
      ).toBe(false);

      // HTTP routes must also succeed with zero recommendations for BR-016
      const recsRes = await app.inject({
        method: "GET",
        url: "/api/recommendations?branch=BR-016",
        headers: adminHeader,
      });
      expect(recsRes.statusCode).toBe(200);
      expect(json<{ total: number }>(recsRes.payload).total).toBe(0);

      const kpisRes = await app.inject({
        method: "GET",
        url: "/api/kpis",
        headers: adminHeader,
      });
      expect(kpisRes.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("generates sequential BR-0xx IDs accurately even with out-of-order and archived branches", async () => {
    const baseData = transferDataset();
    baseData.branches = [
      { ...baseData.branches[1]!, id: "BR-009" },
      { ...baseData.branches[0]!, id: "BR-020", status: "archived" },
      { ...baseData.branches[2]!, id: "BR-002", status: "active" },
    ];
    const repo = new FixedDatasetRepository(baseData);
    const { app } = await setupApp({ repo, authEnabled: true });
    try {
      const adminHeader = bearer(tokenFor(app, SEED_USERS.admin));

      const createRes = await app.inject({
        method: "POST",
        url: "/api/branches",
        headers: adminHeader,
        payload: {
          name: "Durrat Al Bahrain",
          city: "Southern",
          region: "Southern",
          coordinates: [25.838, 50.613],
        },
      });
      expect(createRes.statusCode).toBe(201);
      expect(json<{ id: string }>(createRes.payload).id).toBe("BR-021");

      const secondRes = await app.inject({
        method: "POST",
        url: "/api/branches",
        headers: adminHeader,
        payload: {
          name: "Busaiteen",
          city: "Muharraq",
          region: "Muharraq",
          coordinates: [26.265, 50.602],
        },
      });
      expect(secondRes.statusCode).toBe(201);
      expect(json<{ id: string }>(secondRes.payload).id).toBe("BR-022");
    } finally {
      await app.close();
    }
  });

  it("excludes archived branches from GET /api/locations & new recommendations, preserves historical trend/audit, and restores on unarchive", async () => {
    const repo = new FixedDatasetRepository(transferDataset());
    const { app } = await setupApp({ repo, authEnabled: true });
    try {
      const adminHeader = bearer(tokenFor(app, SEED_USERS.admin));

      // Before archiving: BR-005 is present in /api/locations and in recommendations
      const recsBeforeRes = await app.inject({
        method: "GET",
        url: "/api/recommendations",
        headers: adminHeader,
      });
      expect(recsBeforeRes.statusCode).toBe(200);
      const recsBefore = json<{ recommendations: Recommendation[] }>(recsBeforeRes.payload).recommendations;
      const br5Rec = recsBefore.find((r) => r.branchId === "BR-005");
      expect(br5Rec).toBeDefined();

      // Record an audit decision touching BR-005 before archiving it
      const decideRes = await app.inject({
        method: "POST",
        url: `/api/recommendations/${br5Rec!.id}/approve`,
        headers: adminHeader,
      });
      expect(decideRes.statusCode).toBe(200);

      // Archive BR-005
      const archiveRes = await app.inject({
        method: "PATCH",
        url: "/api/branches/BR-005",
        headers: adminHeader,
        payload: { status: "archived" },
      });
      expect(archiveRes.statusCode).toBe(200);
      expect(BranchSchema.parse(json(archiveRes.payload)).status).toBe("archived");

      // Half 1: Excluded from /api/locations and from new recommendations
      const locsAfterRes = await app.inject({
        method: "GET",
        url: "/api/locations",
        headers: adminHeader,
      });
      expect(locsAfterRes.statusCode).toBe(200);
      const locIds = json<{ locations: Array<{ branch: { id: string } }> }>(locsAfterRes.payload).locations.map(
        (l) => l.branch.id,
      );
      expect(locIds).not.toContain("BR-005");
      expect(locIds).toEqual(expect.arrayContaining(["BR-001", "BR-009"]));

      const recsAfterRes = await app.inject({
        method: "GET",
        url: "/api/recommendations",
        headers: adminHeader,
      });
      expect(recsAfterRes.statusCode).toBe(200);
      const recsAfter = json<{ recommendations: Recommendation[] }>(recsAfterRes.payload).recommendations;
      expect(
        recsAfter.some((r) => r.branchId === "BR-005" || r.donorBranchId === "BR-005"),
      ).toBe(false);

      // Admin GET /api/branches supports ?status=archived and ?status=active filters
      const archivedFilterRes = await app.inject({
        method: "GET",
        url: "/api/branches?status=archived",
        headers: adminHeader,
      });
      expect(archivedFilterRes.statusCode).toBe(200);
      expect(BranchListResponseSchema.parse(json(archivedFilterRes.payload)).branches.map((b) => b.id)).toEqual([
        "BR-005",
      ]);

      const activeFilterRes = await app.inject({
        method: "GET",
        url: "/api/branches?status=active",
        headers: adminHeader,
      });
      expect(activeFilterRes.statusCode).toBe(200);
      expect(BranchListResponseSchema.parse(json(activeFilterRes.payload)).branches.map((b) => b.id)).toEqual([
        "BR-001",
        "BR-009",
      ]);

      // Half 2: Preserved in historical trend data and audit entries
      const trendRes = await app.inject({
        method: "GET",
        url: "/api/locations/BR-005/trend?range=30",
        headers: adminHeader,
      });
      expect(trendRes.statusCode).toBe(200);
      const trendBody = json<{ branch: { id: string; status: string }; points: Array<{ salesUnits: number }> }>(
        trendRes.payload,
      );
      expect(trendBody.branch.status).toBe("archived");
      expect(trendBody.points).toHaveLength(30);
      expect(trendBody.points.every((p) => p.salesUnits === 5)).toBe(true);

      const auditRes = await app.inject({
        method: "GET",
        url: "/api/audit",
        headers: adminHeader,
      });
      expect(auditRes.statusCode).toBe(200);
      const auditEntries = json<{ entries: Array<{ recommendationId: string; branchId: string }> }>(
        auditRes.payload,
      ).entries;
      expect(auditEntries.some((e) => e.recommendationId === br5Rec!.id && e.branchId === "BR-005")).toBe(true);

      // Reversing via unarchive restores BR-005 into /api/locations and recommendations
      const unarchiveRes = await app.inject({
        method: "PATCH",
        url: "/api/branches/BR-005",
        headers: adminHeader,
        payload: { status: "active" },
      });
      expect(unarchiveRes.statusCode).toBe(200);
      expect(BranchSchema.parse(json(unarchiveRes.payload)).status).toBe("active");

      const locsRestoredRes = await app.inject({
        method: "GET",
        url: "/api/locations",
        headers: adminHeader,
      });
      expect(locsRestoredRes.statusCode).toBe(200);
      const restoredLocIds = json<{ locations: Array<{ branch: { id: string } }> }>(
        locsRestoredRes.payload,
      ).locations.map((l) => l.branch.id);
      expect(restoredLocIds).toContain("BR-005");

      const recsRestoredRes = await app.inject({
        method: "GET",
        url: "/api/recommendations",
        headers: adminHeader,
      });
      const recsRestored = json<{ recommendations: Recommendation[] }>(recsRestoredRes.payload).recommendations;
      expect(recsRestored.some((r) => r.branchId === "BR-005")).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("explicitly clears committedDeltas, committedRecommendationIds, and scopedKpiCache and bumps dataVersion on create/archive/unarchive", async () => {
    const repo = new FixedDatasetRepository(transferDataset());
    const { app, services } = await setupApp({ repo, authEnabled: true });
    try {
      const adminHeader = bearer(tokenFor(app, SEED_USERS.admin));

      const primeCaches = async () => {
        const recs = services.decisions.list({}, undefined).recommendations;
        const pendingRec = recs.find((r) => r.status === "PENDING");
        expect(pendingRec).toBeDefined();
        if (services.runtime.committedDeltas.size === 0 && pendingRec) {
          // Decide via API to populate committedDeltas and committedRecommendationIds naturally when PENDING
          const approveRes = await app.inject({
            method: "POST",
            url: `/api/recommendations/${pendingRec.id}/approve`,
            headers: adminHeader,
          });
          expect(approveRes.statusCode).toBe(200);
        }
        // Populate scopedKpiCache via /api/kpis?branch=BR-001
        const scopedRes = await app.inject({
          method: "GET",
          url: "/api/kpis?branch=BR-001",
          headers: adminHeader,
        });
        expect(scopedRes.statusCode).toBe(200);
        expect(services.runtime.scopedKpiCache.size).toBeGreaterThan(0);
      };

      // 1. Prime caches and verify CREATE invalidates all caches and bumps dataVersion
      await primeCaches();
      expect(services.runtime.committedDeltas.size).toBeGreaterThan(0);
      expect(services.runtime.committedRecommendationIds.size).toBeGreaterThan(0);
      const vBeforeCreate = await repo.getDataVersion();

      const createRes = await app.inject({
        method: "POST",
        url: "/api/branches",
        headers: adminHeader,
        payload: {
          name: "Diyar Al Muharraq",
          city: "Muharraq",
          region: "Muharraq",
          coordinates: [26.292, 50.642],
        },
      });
      expect(createRes.statusCode).toBe(201);
      expect(services.runtime.committedDeltas.size).toBe(0);
      expect(services.runtime.committedRecommendationIds.size).toBe(0);
      expect(services.runtime.scopedKpiCache.size).toBe(0);
      expect(await repo.getDataVersion()).toBe(vBeforeCreate + 1);

      // 2. Repopulate scopedKpiCache & inject a committed entry, then verify ARCHIVE clears caches & bumps version
      await injectScopedCacheAndCommitted();
      async function injectScopedCacheAndCommitted() {
        await app.inject({ method: "GET", url: "/api/kpis?branch=BR-001", headers: adminHeader });
        services.runtime.committedDeltas.set("SKU-90001::BR-001", { reserved: 5, inTransit: 0 });
        services.runtime.committedRecommendationIds.set("synthetic-rec", {
          sku: "SKU-90001",
          branchId: "BR-005",
          donorBranchId: "BR-001",
          action: "TRANSFER",
          quantity: 5,
        });
        expect(services.runtime.scopedKpiCache.size).toBeGreaterThan(0);
      }

      const vBeforeArchive = await repo.getDataVersion();
      const archiveRes = await app.inject({
        method: "PATCH",
        url: "/api/branches/BR-005",
        headers: adminHeader,
        payload: { status: "archived" },
      });
      expect(archiveRes.statusCode).toBe(200);
      expect(services.runtime.committedDeltas.size).toBe(0);
      expect(services.runtime.committedRecommendationIds.size).toBe(0);
      expect(services.runtime.scopedKpiCache.size).toBe(0);
      expect(await repo.getDataVersion()).toBe(vBeforeArchive + 1);

      // 3. Repopulate caches and verify UNARCHIVE clears all caches & bumps dataVersion
      await injectScopedCacheAndCommitted();
      const vBeforeUnarchive = await repo.getDataVersion();
      const unarchiveRes = await app.inject({
        method: "PATCH",
        url: "/api/branches/BR-005",
        headers: adminHeader,
        payload: { status: "active" },
      });
      expect(unarchiveRes.statusCode).toBe(200);
      expect(services.runtime.committedDeltas.size).toBe(0);
      expect(services.runtime.committedRecommendationIds.size).toBe(0);
      expect(services.runtime.scopedKpiCache.size).toBe(0);
      expect(await repo.getDataVersion()).toBe(vBeforeUnarchive + 1);
    } finally {
      await app.close();
    }
  });
});

describe.each<RepoKind>(["memory", "mongo-memory"])("Branch persistence roundtrip [%s]", (repoKind) => {
  it("persists created and edited branches inside MetaModel and reloads without crashing", async () => {
    const { repo, cleanup } = await createDualRepo(repoKind);
    const admin = await createUser(repo, "admin", []);
    const { app } = await buildTestApp(repo);
    try {
      const { authHeader } = await loginAs(app, admin.user.email, admin.password);
      const initialBranchCount = (await repo.loadDataset()).branches.length;
      const expectedId = "BR-010";

      const createRes = await app.inject({
        method: "POST",
        url: "/api/branches",
        headers: authHeader,
        payload: {
          name: "Marassi",
          city: "Diyar Al Muharraq",
          region: "Muharraq",
          coordinates: [26.305, 50.651],
        },
      });
      expect(createRes.statusCode).toBe(201);
      const created = BranchSchema.parse(json(createRes.payload));
      expect(created.id).toBe(expectedId);

      const patchRes = await app.inject({
        method: "PATCH",
        url: `/api/branches/${expectedId}`,
        headers: authHeader,
        payload: { status: "archived", city: "Muharraq" },
      });
      expect(patchRes.statusCode).toBe(200);
      expect(BranchSchema.parse(json(patchRes.payload))).toMatchObject({
        id: expectedId,
        city: "Muharraq",
        status: "archived",
      });

      // Reload dataset directly from repository (tests MongoRepository.read() cold-start series fallback)
      const reloaded = await repo.loadDataset();
      const reloadedBranch = reloaded.branches.find((b) => b.id === expectedId);
      expect(reloadedBranch).toMatchObject({
        id: expectedId,
        name: "Marassi",
        city: "Muharraq",
        status: "archived",
      });
      expect(reloaded.sales[0]?.[initialBranchCount]?.every((v) => v === 0)).toBe(true);
    } finally {
      await app.close();
      await cleanup();
    }
  }, 60_000);
});

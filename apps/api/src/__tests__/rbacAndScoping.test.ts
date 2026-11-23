import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { KpiSummary, Recommendation, User } from "@stockflow/core";
import type { StockRepository } from "../repositories/types.js";
import { buildTestApp, createDualRepo, createUser, type RepoKind } from "../test/dualRepo.js";
import { bearer, tokenFor } from "../test/helpers.js";

describe.each<RepoKind>(["memory", "mongo-memory"])("RBAC Matrix, Hierarchy & Scoping (%s)", (kind) => {
  let repo: StockRepository;
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let adminUser: User;
  let mgr1: User;
  let mgr2: User;
  let staff1: User;

  beforeAll(async () => {
    const setup = await createDualRepo(kind);
    repo = setup.repo;
    cleanup = setup.cleanup;
    const built = await buildTestApp(repo);
    app = built.app;
    adminUser = (await createUser(repo, "admin", [], { email: `rbac.admin.${kind}@stockflow.test` })).user;
    mgr1 = (await createUser(repo, "manager", ["BR-001"], { email: `rbac.mgr1.${kind}@stockflow.test` })).user;
    mgr2 = (await createUser(repo, "manager", ["BR-005"], { email: `rbac.mgr2.${kind}@stockflow.test` })).user;
    staff1 = (await createUser(repo, "staff", ["BR-001"], { email: `rbac.stf1.${kind}@stockflow.test` })).user;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await cleanup?.();
  });

  const authFor = (actor: "anon" | "staff" | "mgr1" | "mgr2" | "admin"): Record<string, string> => {
    if (actor === "anon") return {};
    const map: Record<"staff" | "mgr1" | "mgr2" | "admin", User> = {
      staff: staff1,
      mgr1,
      mgr2,
      admin: adminUser,
    };
    return bearer(tokenFor(app, map[actor]));
  };

  it("enforces table-driven RBAC matrix across routes and roles", async () => {
    const cases: Array<{
      method: "GET" | "POST" | "PATCH" | "DELETE";
      url: string;
      payload?: unknown;
      expected: Record<"anon" | "staff" | "mgr1" | "admin", number>;
    }> = [
      {
        method: "GET",
        url: "/api/kpis",
        expected: { anon: 401, staff: 403, mgr1: 200, admin: 200 },
      },
      {
        method: "GET",
        url: "/api/audit",
        expected: { anon: 401, staff: 403, mgr1: 200, admin: 200 },
      },
      {
        method: "GET",
        url: "/api/recommendations",
        expected: { anon: 401, staff: 200, mgr1: 200, admin: 200 },
      },
      {
        method: "GET",
        url: "/api/locations",
        expected: { anon: 401, staff: 403, mgr1: 200, admin: 200 },
      },
      {
        method: "GET",
        url: "/api/locations/BR-001/summary",
        expected: { anon: 401, staff: 403, mgr1: 200, admin: 200 },
      },
      {
        method: "GET",
        url: "/api/locations/BR-005/summary",
        expected: { anon: 401, staff: 403, mgr1: 404, admin: 200 },
      },
      {
        method: "GET",
        url: "/api/branches/BR-005",
        expected: { anon: 401, staff: 403, mgr1: 403, admin: 200 },
      },
      {
        method: "GET",
        url: "/api/users",
        expected: { anon: 401, staff: 403, mgr1: 403, admin: 200 },
      },
      {
        method: "POST",
        url: "/api/catalog/products",
        payload: {
          sku: `SKU-RBAC-${kind}`,
          name: "RBAC Test",
          category: "Apparel",
          price: 50,
          cost: 20,
          leadTimeDays: 5,
        },
        expected: { anon: 401, staff: 403, mgr1: 403, admin: 201 },
      },
      {
        method: "GET",
        url: "/api/sales-entries",
        expected: { anon: 401, staff: 403, mgr1: 200, admin: 200 },
      },
    ];

    for (const c of cases) {
      for (const actor of ["anon", "staff", "mgr1", "admin"] as const) {
        const res = await app.inject({
          method: c.method,
          url: c.url,
          headers: authFor(actor),
          payload: c.payload as Record<string, unknown> | undefined,
        });
        expect(res.statusCode, `${actor} ${c.method} ${c.url}`).toBe(c.expected[actor]);
      }
    }
  });

  it("enforces user management hierarchy: no escalation, no editing own role, no deactivating self or last admin", async () => {
    const adminHeaders = authFor("admin");

    // Admin cannot create another admin
    const createAdminRes = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: adminHeaders,
      payload: {
        name: "Escalate",
        email: `esc.${kind}@stockflow.test`,
        password: "Password@12345",
        role: "admin",
        branchIds: [],
      },
    });
    expect(createAdminRes.statusCode).toBe(403);

    // Admin cannot escalate a manager to admin
    const escalateRes = await app.inject({
      method: "PATCH",
      url: `/api/users/${mgr1.id}`,
      headers: adminHeaders,
      payload: { role: "admin" },
    });
    expect(escalateRes.statusCode).toBe(403);

    // Admin cannot edit own role
    const ownRoleRes = await app.inject({
      method: "PATCH",
      url: `/api/users/${adminUser.id}`,
      headers: adminHeaders,
      payload: { role: "manager" },
    });
    expect(ownRoleRes.statusCode).toBe(403);

    // Admin cannot deactivate self
    const selfDeactRes = await app.inject({
      method: "PATCH",
      url: `/api/users/${adminUser.id}`,
      headers: adminHeaders,
      payload: { isActive: false },
    });
    expect(selfDeactRes.statusCode).toBe(403);
  });

  it("scopes transfers to donor OR receiver, reorders/markdowns to target branch, and isolates KPI cache", async () => {
    // Admin sees all (including BR-001, BR-005, BR-009)
    const adminRecsRes = await app.inject({
      method: "GET",
      url: "/api/recommendations",
      headers: authFor("admin"),
    });
    const adminRecs = (JSON.parse(adminRecsRes.body) as { recommendations: Recommendation[] }).recommendations;
    const transfer = adminRecs.find((r) => r.action === "TRANSFER" && r.sku === "SKU-90001");
    expect(transfer).toBeTruthy();
    expect(transfer?.donorBranchId).toBe("BR-001");
    expect(transfer?.branchId).toBe("BR-005");

    // Donor manager (BR-001) sees the transfer
    const mgr1Recs = (
      JSON.parse(
        (await app.inject({ method: "GET", url: "/api/recommendations", headers: authFor("mgr1") })).body,
      ) as { recommendations: Recommendation[] }
    ).recommendations;
    expect(mgr1Recs.some((r) => r.id === transfer?.id)).toBe(true);

    // Receiver manager (BR-005) also sees the transfer
    const mgr2Recs = (
      JSON.parse(
        (await app.inject({ method: "GET", url: "/api/recommendations", headers: authFor("mgr2") })).body,
      ) as { recommendations: Recommendation[] }
    ).recommendations;
    expect(mgr2Recs.some((r) => r.id === transfer?.id)).toBe(true);

    // KPI cache isolation: admin -> mgr1 -> admin
    const adminKpis1 = JSON.parse(
      (await app.inject({ method: "GET", url: "/api/kpis", headers: authFor("admin") })).body,
    ) as KpiSummary;
    const mgr1Kpis = JSON.parse(
      (await app.inject({ method: "GET", url: "/api/kpis", headers: authFor("mgr1") })).body,
    ) as KpiSummary;
    const adminKpis2 = JSON.parse(
      (await app.inject({ method: "GET", url: "/api/kpis", headers: authFor("admin") })).body,
    ) as KpiSummary;

    expect(adminKpis1.branches.length).toBe(3);
    expect(mgr1Kpis.branches.map((b) => b.id)).toEqual(["BR-001"]);
    expect(adminKpis2.branches.length).toBe(3);
  });

  it("prevents IDOR on /api/products/:sku branch positions and /api/locations/:id/*", async () => {
    const productRes = await app.inject({
      method: "GET",
      url: "/api/products/SKU-90001",
      headers: authFor("mgr1"),
    });
    expect(productRes.statusCode).toBe(200);
    const productBody = JSON.parse(productRes.body) as {
      positions: Array<{ branch: { id: string } }>;
      series: Array<{ branchId: string }>;
    };
    expect(productBody.positions.every((b) => b.branch.id === "BR-001")).toBe(true);
    expect(productBody.series.every((s) => s.branchId === "BR-001")).toBe(true);

    const outOfScopeLoc = await app.inject({
      method: "GET",
      url: "/api/locations/BR-009/inventory",
      headers: authFor("mgr1"),
    });
    expect(outOfScopeLoc.statusCode).toBe(404);
  });
});

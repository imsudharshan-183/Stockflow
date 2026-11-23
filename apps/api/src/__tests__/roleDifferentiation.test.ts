import { describe, expect, it } from "vitest";
import { setupApp, tokenFor, bearer, SEED_USERS } from "../test/helpers.js";

async function setupTestApp() {
  const ctx = await setupApp({ authEnabled: true });
  const authHeaders = {
    admin: bearer(tokenFor(ctx.app, SEED_USERS.admin)),
    managerManama: bearer(tokenFor(ctx.app, SEED_USERS.managerManama)),
    staffManama: bearer(tokenFor(ctx.app, SEED_USERS.staffManama)),
  };
  return { client: ctx.app, authHeaders, ctx };
}

describe("Role-Differentiated API Experience", () => {
  it("Admin gets network totals across all branches", async () => {
    const { client, authHeaders } = await setupTestApp();

    const res = await client.inject({
      method: "GET",
      url: "/api/kpis",
      headers: authHeaders.admin,
    });

    expect(res.statusCode).toBe(200);
    const kpis = res.json();

    // 15 branches in network
    expect(kpis.branches).toHaveLength(15);
    expect(kpis.branchRisk).toHaveLength(15);
    expect(kpis.coverGrid.length).toBeGreaterThan(0);

    // Network rollups are positive
    expect(kpis.deadStockValue).toBeGreaterThan(0);
    expect(kpis.lostSalesAtRisk).toBeGreaterThan(0);
    expect(kpis.cashReleasable).toBeGreaterThan(0);

    // Unmodified snapshot fixture response for admin has no operational/scope wrapper
    expect(kpis.operational).toBeUndefined();
    expect(kpis.scope).toBeUndefined();
  });

  it("Manager gets branch-scoped totals and operational rollups, without seeing other branches", async () => {
    const { client, authHeaders } = await setupTestApp();

    // Fetch admin KPIs to compare totals
    const adminRes = await client.inject({
      method: "GET",
      url: "/api/kpis",
      headers: authHeaders.admin,
    });
    const adminKpis = adminRes.json();

    // Fetch manager KPIs
    const mgrRes = await client.inject({
      method: "GET",
      url: "/api/kpis",
      headers: authHeaders.managerManama,
    });
    expect(mgrRes.statusCode).toBe(200);
    const mgrKpis = mgrRes.json();

    // Manager is strictly scoped to BR-001 and BR-002
    expect(mgrKpis.branches).toHaveLength(2);
    const branchIds = mgrKpis.branches.map((b: { id: string }) => b.id).sort();
    expect(branchIds).toEqual(["BR-001", "BR-002"]);

    // Branch risk and cover grid contain only in-scope branches
    expect(mgrKpis.branchRisk.every((r: { branchId: string }) => branchIds.includes(r.branchId))).toBe(true);
    expect(mgrKpis.coverGrid.every((c: { branchId: string }) => branchIds.includes(c.branchId))).toBe(true);

    // Financial totals are strictly less than network totals
    expect(mgrKpis.deadStockValue).toBeLessThan(adminKpis.deadStockValue);
    expect(mgrKpis.lostSalesAtRisk).toBeLessThan(adminKpis.lostSalesAtRisk);
    expect(mgrKpis.cashReleasable).toBeLessThan(adminKpis.cashReleasable);

    // Operational rollups are populated for manager
    expect(mgrKpis.operational).toBeDefined();
    expect(mgrKpis.operational.pendingApprovalsCount).toBeGreaterThanOrEqual(0);
    expect(typeof mgrKpis.operational.backlogValue).toBe("number");
    expect(mgrKpis.operational.atRiskBranchCount).toBeLessThanOrEqual(2);
    expect(mgrKpis.scope).toEqual(["BR-001", "BR-002"]);

    // Manager cannot access out-of-scope branch directly
    const outOfScopeBranchRes = await client.inject({
      method: "GET",
      url: "/api/branches/BR-005",
      headers: authHeaders.managerManama,
    });
    expect(outOfScopeBranchRes.statusCode).toBe(403);

    // Manager cannot query catalog with out-of-scope branch
    const outOfScopeCatalogRes = await client.inject({
      method: "GET",
      url: "/api/catalog/products?branch=BR-005",
      headers: authHeaders.managerManama,
    });
    expect(outOfScopeCatalogRes.statusCode).toBe(403);

    // Manager can query catalog with in-scope branch and receives stats
    const inScopeCatalogRes = await client.inject({
      method: "GET",
      url: "/api/catalog/products?branch=BR-001&limit=5",
      headers: authHeaders.managerManama,
    });
    expect(inScopeCatalogRes.statusCode).toBe(200);
    const inScopeBody = inScopeCatalogRes.json();
    expect(inScopeBody.products[0].stats).toBeDefined();
    expect(inScopeBody.products[0].stats.onHand).toBeDefined();
  });

  it("Staff gets branch product stats only and is denied dashboard, audit, and user endpoints", async () => {
    const { client, authHeaders } = await setupTestApp();

    // 1. Staff is denied /api/kpis and all branch/location financial summary endpoints (403)
    for (const url of [
      "/api/kpis",
      "/api/locations",
      "/api/locations/BR-001/summary",
      "/api/locations/BR-005/summary",
      "/api/locations/BR-001/inventory",
      "/api/locations/BR-001/trend",
      "/api/branches/BR-001",
    ]) {
      const deniedRes = await client.inject({
        method: "GET",
        url,
        headers: authHeaders.staffManama,
      });
      expect(deniedRes.statusCode, `GET ${url} should be 403 for staff`).toBe(403);
    }

    // 2. Staff is denied /api/audit (403)
    const auditRes = await client.inject({
      method: "GET",
      url: "/api/audit",
      headers: authHeaders.staffManama,
    });
    expect(auditRes.statusCode).toBe(403);

    // 3. Staff is denied /api/users (403)
    const usersRes = await client.inject({
      method: "GET",
      url: "/api/users",
      headers: authHeaders.staffManama,
    });
    expect(usersRes.statusCode).toBe(403);

    // 4. Staff is denied approving recommendations (403)
    const approveRes = await client.inject({
      method: "POST",
      url: "/api/recommendations/rec-mock/approve",
      headers: authHeaders.staffManama,
    });
    expect(approveRes.statusCode).toBe(403);

    // 5. Staff is denied mutating catalog (403)
    const createProductRes = await client.inject({
      method: "POST",
      url: "/api/catalog/products",
      headers: authHeaders.staffManama,
      payload: {
        name: "Forbidden Product",
        category: "Test",
        price: 10,
        cost: 5,
        leadTimeDays: 7,
      },
    });
    expect(createProductRes.statusCode).toBe(403);

    // 6. Staff can view catalog with position stats + non-financial branch header context for BR-001
    const staffCatalogRes = await client.inject({
      method: "GET",
      url: "/api/catalog/products?page=1&limit=10",
      headers: authHeaders.staffManama,
    });
    expect(staffCatalogRes.statusCode).toBe(200);
    const catalogBody = staffCatalogRes.json();
    expect(catalogBody.products.length).toBe(10);

    // Non-financial branch header metadata and status counts only
    expect(catalogBody.branchSummary).toBeDefined();
    expect(catalogBody.branchSummary.branch.id).toBe("BR-001");
    expect(catalogBody.branchSummary.branch.name).toBe("Manama - CBD");
    expect(catalogBody.branchSummary.totalSkus).toBeGreaterThan(0);
    const counts = catalogBody.branchSummary.statusCounts;
    expect(counts.AT_RISK + counts.HEALTHY + counts.OVERSTOCK + counts.NEW).toBe(
      catalogBody.branchSummary.totalSkus,
    );

    const firstProduct = catalogBody.products[0];
    expect(firstProduct.stats).toBeDefined();
    expect(typeof firstProduct.stats.onHand).toBe("number");
    expect(typeof firstProduct.stats.inTransit).toBe("number");
    expect(typeof firstProduct.stats.reserved).toBe("number");
    expect(typeof firstProduct.stats.velocity).toBe("number");
    expect(firstProduct.stats.coverDays === null || typeof firstProduct.stats.coverDays === "number").toBe(true);
    expect(["AT_RISK", "OVERSTOCK", "HEALTHY", "NEW"]).toContain(firstProduct.stats.status);

    // Zero financial BD aggregates anywhere in payload
    for (const forbiddenKey of [
      "deadStockValue",
      "lostSalesAtRisk",
      "overstockValue",
      "cashReleasable",
      "netBenefit",
      "inventoryValue",
      "revenueAtRisk",
      "backlogValue",
      "kpis",
    ]) {
      expect(catalogBody[forbiddenKey]).toBeUndefined();
      expect(catalogBody.branchSummary[forbiddenKey]).toBeUndefined();
      expect(firstProduct.stats[forbiddenKey]).toBeUndefined();
    }

    // 7. Staff cannot query a branch outside their assigned branch (BR-002)
    const forbiddenBranchCatalogRes = await client.inject({
      method: "GET",
      url: "/api/catalog/products?branch=BR-002",
      headers: authHeaders.staffManama,
    });
    expect(forbiddenBranchCatalogRes.statusCode).toBe(403);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { KpiSummary } from "@stockflow/core";
import { SEED_USERS, bearer, json, setupApp, tokenFor } from "../test/helpers.js";

function buildMultipartCsv(filename: string, csvContent: string): { payload: Buffer; contentType: string } {
  const boundary = "----Stage0SecurityBoundary";
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: text/csv\r\n\r\n` +
    `${csvContent}\r\n` +
    `--${boundary}--\r\n`;
  return {
    payload: Buffer.from(body, "utf8"),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe("Stage 0: Sales Entry Auth & /api/kpis Scope Isolation", () => {
  let app: FastifyInstance;
  let adminHeaders: Record<string, string>;
  let managerHeaders: Record<string, string>;
  let staffHeaders: Record<string, string>;

  beforeAll(async () => {
    const ctx = await setupApp({ authEnabled: true });
    app = ctx.app;
    adminHeaders = bearer(tokenFor(app, SEED_USERS.admin));
    managerHeaders = bearer(tokenFor(app, SEED_USERS.managerManama));
    staffHeaders = bearer(tokenFor(app, SEED_USERS.staffManama));
  });

  afterAll(async () => {
    await app?.close();
  });

  it("enforces 401/403/404 and branch scope across all sales-entry routes", async () => {
    const multipart = buildMultipartCsv("sales.csv", "branchId,sku,date,unitsSold,onHand\nBR-001,SKU-00001,2026-11-12,2,10\n");

    const routes: Array<{
      method: "GET" | "POST" | "PATCH" | "DELETE";
      url: string;
      headers?: Record<string, string>;
      payload?: unknown;
    }> = [
      { method: "GET", url: "/api/sales-entries" },
      { method: "GET", url: "/api/sales-entries/template.csv" },
      {
        method: "POST",
        url: "/api/sales-entries",
        payload: { branchId: "BR-001", sku: "SKU-00001", date: "2026-11-12", unitsSold: 2, onHand: 10 },
      },
      {
        method: "PATCH",
        url: "/api/sales-entries/entry-does-not-exist",
        payload: { unitsSold: 5 },
      },
      { method: "DELETE", url: "/api/sales-entries/entry-does-not-exist" },
      {
        method: "POST",
        url: "/api/sales-entries/import",
        headers: { "content-type": multipart.contentType },
        payload: multipart.payload,
      },
    ];

    for (const r of routes) {
      const unauth = await app.inject({
        method: r.method,
        url: r.url,
        headers: r.headers,
        payload: r.payload as Record<string, unknown> | Buffer | undefined,
      });
      expect(unauth.statusCode, `unauthenticated ${r.method} ${r.url}`).toBe(401);

      const staffRes = await app.inject({
        method: r.method,
        url: r.url,
        headers: { ...staffHeaders, ...(r.headers ?? {}) },
        payload: r.payload as Record<string, unknown> | Buffer | undefined,
      });
      expect(staffRes.statusCode, `staff ${r.method} ${r.url}`).toBe(403);
    }

    // Create an entry in BR-005 as admin, then verify Manama manager isolation and 403/404
    const createRes = await app.inject({
      method: "POST",
      url: "/api/sales-entries",
      headers: adminHeaders,
      payload: { branchId: "BR-005", sku: "SKU-00001", date: "2026-11-12", unitsSold: 3, onHand: 12 },
    });
    expect(createRes.statusCode).toBe(201);
    const created = json<{ id: string }>(createRes.payload);

    try {
      const mgrQueryOos = await app.inject({
        method: "GET",
        url: "/api/sales-entries?branch=BR-005",
        headers: managerHeaders,
      });
      expect(mgrQueryOos.statusCode).toBe(403);

      const mgrList = await app.inject({
        method: "GET",
        url: "/api/sales-entries?sku=SKU-00001",
        headers: managerHeaders,
      });
      expect(mgrList.statusCode).toBe(200);
      const listBody = json<{ entries: Array<{ id: string; branchId: string }> }>(mgrList.payload);
      expect(listBody.entries.some((e) => e.id === created.id || e.branchId === "BR-005")).toBe(false);

      const mgrCreateOos = await app.inject({
        method: "POST",
        url: "/api/sales-entries",
        headers: managerHeaders,
        payload: { branchId: "BR-005", sku: "SKU-00001", date: "2026-11-12", unitsSold: 1, onHand: 5 },
      });
      expect(mgrCreateOos.statusCode).toBe(403);

      const mgrPatchOos = await app.inject({
        method: "PATCH",
        url: `/api/sales-entries/${encodeURIComponent(created.id)}`,
        headers: managerHeaders,
        payload: { unitsSold: 9 },
      });
      expect(mgrPatchOos.statusCode).toBe(403);

      const mgrDeleteOos = await app.inject({
        method: "DELETE",
        url: `/api/sales-entries/${encodeURIComponent(created.id)}`,
        headers: managerHeaders,
      });
      expect(mgrDeleteOos.statusCode).toBe(403);

      const patchMissing = await app.inject({
        method: "PATCH",
        url: "/api/sales-entries/nonexistent-id",
        headers: managerHeaders,
        payload: { unitsSold: 5 },
      });
      expect(patchMissing.statusCode).toBe(404);

      const deleteMissing = await app.inject({
        method: "DELETE",
        url: "/api/sales-entries/nonexistent-id",
        headers: adminHeaders,
      });
      expect(deleteMissing.statusCode).toBe(404);
    } finally {
      const cleanupRes = await app.inject({
        method: "DELETE",
        url: `/api/sales-entries/${encodeURIComponent(created.id)}`,
        headers: adminHeaders,
      });
      expect(cleanupRes.statusCode).toBe(200);
    }
  });

  it("enforces 401/403/404 and scoped data isolation on /api/kpis, /api/recommendations, and /api/products/:sku", async () => {
    expect((await app.inject({ method: "GET", url: "/api/kpis" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/recommendations" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/products/SKU-00001" })).statusCode).toBe(401);

    expect((await app.inject({ method: "GET", url: "/api/kpis", headers: staffHeaders })).statusCode).toBe(403);
    expect(
      (await app.inject({ method: "GET", url: "/api/kpis?branch=BR-001", headers: staffHeaders })).statusCode,
    ).toBe(403);

    const adminKpis = json<KpiSummary>(
      (await app.inject({ method: "GET", url: "/api/kpis", headers: adminHeaders })).payload,
    );
    const mgrKpisRes = await app.inject({ method: "GET", url: "/api/kpis", headers: managerHeaders });
    expect(mgrKpisRes.statusCode).toBe(200);
    const mgrKpis = json<KpiSummary>(mgrKpisRes.payload);

    expect(mgrKpis.branches.map((b) => b.id).sort()).toEqual(["BR-001", "BR-002"]);
    expect(mgrKpis.scope).toEqual(["BR-001", "BR-002"]);
    expect(mgrKpis.branchRisk.every((r) => r.branchId === "BR-001" || r.branchId === "BR-002")).toBe(true);
    expect(mgrKpis.coverGrid.every((c) => c.branchId === "BR-001" || c.branchId === "BR-002")).toBe(true);
    expect(mgrKpis.deadStockValue).toBeLessThan(adminKpis.deadStockValue);
    expect(mgrKpis.lostSalesAtRisk).toBeLessThan(adminKpis.lostSalesAtRisk);
    expect(mgrKpis.cashReleasable).toBeLessThan(adminKpis.cashReleasable);

    // Manager querying out-of-scope or unknown branch gets 403; admin querying unknown branch gets 404
    expect(
      (await app.inject({ method: "GET", url: "/api/kpis?branch=BR-005", headers: managerHeaders })).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: "GET", url: "/api/kpis?branch=BR-999", headers: managerHeaders })).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: "GET", url: "/api/kpis?branch=BR-999", headers: adminHeaders })).statusCode,
    ).toBe(404);
  });
});

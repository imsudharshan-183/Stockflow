import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AuditEntry, Recommendation, User } from "@stockflow/core";
import type { StockRepository } from "../repositories/types.js";
import { buildTestApp, createDualRepo, createUser, type RepoKind } from "../test/dualRepo.js";
import { bearer, tokenFor } from "../test/helpers.js";

describe.each<RepoKind>(["memory", "mongo-memory"])("Recommendations, Catalog & Sales Entries (%s)", (kind) => {
  let repo: StockRepository;
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let adminUser: User;
  let mgrWest: User;
  let mgrMiami: User;

  beforeAll(async () => {
    const setup = await createDualRepo(kind);
    repo = setup.repo;
    cleanup = setup.cleanup;
    const built = await buildTestApp(repo);
    app = built.app;
    adminUser = (await createUser(repo, "admin", [], { email: `rec.admin.${kind}@stockflow.test` })).user;
    mgrWest = (await createUser(repo, "manager", ["BR-005"], { email: `rec.west.${kind}@stockflow.test` })).user;
    mgrMiami = (await createUser(repo, "manager", ["BR-009"], { email: `rec.miami.${kind}@stockflow.test` })).user;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await cleanup?.();
  });

  it("approving/rejecting recommendations records audit and blocks out-of-scope managers", async () => {
    const adminHeaders = bearer(tokenFor(app, adminUser));
    const miamiHeaders = bearer(tokenFor(app, mgrMiami));
    const westHeaders = bearer(tokenFor(app, mgrWest));

    const recs = (
      JSON.parse(
        (await app.inject({ method: "GET", url: "/api/recommendations", headers: adminHeaders })).body,
      ) as { recommendations: Recommendation[] }
    ).recommendations;
    const transfer = recs.find((r) => r.action === "TRANSFER");
    expect(transfer).toBeTruthy();

    // Miami (BR-009) cannot decide a BR-001 -> BR-005 transfer
    const forbiddenRes = await app.inject({
      method: "POST",
      url: `/api/recommendations/${transfer?.id}/approve`,
      headers: miamiHeaders,
    });
    expect(forbiddenRes.statusCode).toBe(403);

    // West (BR-005) can approve it
    const approveRes = await app.inject({
      method: "POST",
      url: `/api/recommendations/${transfer?.id}/approve`,
      headers: westHeaders,
    });
    expect(approveRes.statusCode).toBe(200);
    expect((JSON.parse(approveRes.body) as Recommendation).status).toBe("APPROVED");

    const auditRes = await app.inject({
      method: "GET",
      url: "/api/audit",
      headers: adminHeaders,
    });
    const audit = (JSON.parse(auditRes.body) as { entries: AuditEntry[] }).entries;
    expect(audit.some((a) => a.recommendationId === transfer?.id && a.decision === "APPROVED")).toBe(true);
  });

  it("handles concurrent catalog POSTs cleanly (201 + 409) and validates math/history constraints", async () => {
    const adminHeaders = bearer(tokenFor(app, adminUser));
    const sku = `SKU-CONC-${kind.toUpperCase().replace(/[^A-Z0-9]/g, "")}`;
    const payload = {
      sku,
      name: "Concurrent SKU",
      category: "Apparel",
      price: 100,
      cost: 45,
      leadTimeDays: 7,
    };

    const [r1, r2] = await Promise.all([
      app.inject({ method: "POST", url: "/api/catalog/products", headers: adminHeaders, payload }),
      app.inject({ method: "POST", url: "/api/catalog/products", headers: adminHeaders, payload }),
    ]);
    const statuses = [r1.statusCode, r2.statusCode].sort();
    expect(statuses).toEqual([201, 409]);
    const createdProduct = JSON.parse((r1.statusCode === 201 ? r1 : r2).body) as { sku: string };
    const createdSku = createdProduct.sku;

    // Invalid math/negative fields -> 400
    const badPrice = await app.inject({
      method: "POST",
      url: "/api/catalog/products",
      headers: adminHeaders,
      payload: { ...payload, name: "Bad Price SKU", price: -10 },
    });
    expect(badPrice.statusCode).toBe(400);

    // Archive & restore
    const archiveRes = await app.inject({
      method: "PATCH",
      url: `/api/catalog/products/${createdSku}/archive`,
      headers: adminHeaders,
    });
    expect(archiveRes.statusCode).toBe(200);

    const restoreRes = await app.inject({
      method: "PATCH",
      url: `/api/catalog/products/${createdSku}/restore`,
      headers: adminHeaders,
    });
    expect(restoreRes.statusCode).toBe(200);

    // Existing seeded SKU with sales history cannot be permanently deleted (409)
    const delSeeded = await app.inject({
      method: "DELETE",
      url: "/api/catalog/products/SKU-90001",
      headers: adminHeaders,
    });
    expect(delSeeded.statusCode).toBe(409);

    // Fresh SKU with no sales/audits can be permanently deleted
    const createClean = await app.inject({
      method: "POST",
      url: "/api/catalog/products",
      headers: adminHeaders,
      payload: { ...payload, name: `Clean Delete ${kind}` },
    });
    expect(createClean.statusCode).toBe(201);
    const cleanSku = (JSON.parse(createClean.body) as { sku: string }).sku;
    const delClean = await app.inject({
      method: "DELETE",
      url: `/api/catalog/products/${cleanSku}`,
      headers: adminHeaders,
    });
    expect(delClean.statusCode).toBe(200);
  });

  it("handles sales-entry creation (onHand=0 with demand) and single-SKU recompute without altering other SKUs", async () => {
    const adminHeaders = bearer(tokenFor(app, adminUser));
    const beforeRecs = (
      JSON.parse(
        (await app.inject({ method: "GET", url: "/api/recommendations", headers: adminHeaders })).body,
      ) as { recommendations: Recommendation[] }
    ).recommendations;
    const sku3Before = beforeRecs.filter((r) => r.sku === "SKU-90003");

    const entryRes = await app.inject({
      method: "POST",
      url: "/api/sales-entries",
      headers: adminHeaders,
      payload: {
        branchId: "BR-009",
        sku: "SKU-90002",
        date: "2026-11-11",
        unitsSold: 12,
        onHand: 0,
      },
    });
    expect(entryRes.statusCode).toBe(201);

    const afterRecs = (
      JSON.parse(
        (await app.inject({ method: "GET", url: "/api/recommendations", headers: adminHeaders })).body,
      ) as { recommendations: Recommendation[] }
    ).recommendations;
    const sku3After = afterRecs.filter((r) => r.sku === "SKU-90003");
    expect(sku3After).toEqual(sku3Before);

    // BR-009 SKU-90002 now has onHand=0 with demand and should surface a recommendation
    expect(afterRecs.some((r) => r.sku === "SKU-90002" && r.branchId === "BR-009")).toBe(true);
  });
});

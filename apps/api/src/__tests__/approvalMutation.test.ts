import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BAHRAIN_BRANCHES,
  DEFAULT_POLICY,
  analyze,
  type Analysis,
  type Branch,
  type Dataset,
  type KpiSummary,
  type Product,
  type ProductDetail,
  type Recommendation,
} from "@stockflow/core";
import { describe, expect, it } from "vitest";
import { InMemoryRepository } from "../repositories/memory.js";
import { project } from "../services/index.js";
import { buildTestApp, createDualRepo, createUser, smallSeededDataset, type RepoKind } from "../test/dualRepo.js";
import { FixedDatasetRepository, SEED_USERS, bearer, setupApp, tokenFor, transferDataset } from "../test/helpers.js";

const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../__fixtures__");

function makeCompetingTransfersDataset(): { data: Dataset; plan: Analysis; t1: Recommendation; t2: Recommendation } {
  // Donor BR-001 has surplus ~ 36 (onHand 100, velocity 2/day -> 30d floor + SS = 64 -> surplus 36)
  // Two deficit branches (BR-005 & BR-009) each need 30 units -> only one 30-unit transfer can come from BR-001!
  const branches: Branch[] = ["BR-001", "BR-005", "BR-009"].map((id) => ({
    ...BAHRAIN_BRANCHES.find((b) => b.id === id)!,
  }));
  const product: Product = {
    sku: "SKU-CONFLICT-1",
    name: "Competing Donor Product",
    category: "Household",
    price: 40,
    cost: 20,
    leadTimeDays: 7,
    status: "active",
  };
  const days = 60;
  const start = Date.UTC(2026, 8, 13);
  const dates = Array.from({ length: days }, (_, i) => new Date(start + i * 86_400_000).toISOString().slice(0, 10));
  const fill = (v: number) => Array.from({ length: days }, () => v);

  // BR-001: velocity 1/day, onHand 65 -> coverDays 65 (> 60 OVERSTOCK), floor 30 -> surplus 35.
  // BR-005 & BR-009: velocity 5/day, onHand 10 -> AT_RISK (need 60 each).
  const data: Dataset = {
    seed: 9,
    asOf: dates[days - 1]!,
    dates,
    branches,
    products: [product],
    sales: [[fill(1), fill(5), fill(5)]],
    onHand: [[fill(65), fill(10), fill(10)]],
    demand: [[fill(1), fill(5), fill(5)]],
  };

  const basePlan = analyze(data, DEFAULT_POLICY);
  const donorPos = basePlan.positions[0]![0]!;
  // Craft a morning plan where two competing transfers (25 + 20 = 45 > surplus 35) target the same donor.
  const baseTransfer = basePlan.recommendations.find((r) => r.action === "TRANSFER")!;
  expect(baseTransfer).toBeDefined();
  expect(donorPos.surplus).toBeGreaterThanOrEqual(25);
  expect(donorPos.surplus).toBeLessThan(45);

  const t1: Recommendation = {
    ...baseTransfer,
    id: "rec_conflict_1",
    branchId: "BR-005",
    branchName: branches[1]!.name,
    donorBranchId: "BR-001",
    donorBranchName: branches[0]!.name,
    quantity: 25,
    rank: 1,
  };
  const t2: Recommendation = {
    ...baseTransfer,
    id: "rec_conflict_2",
    branchId: "BR-009",
    branchName: branches[2]!.name,
    donorBranchId: "BR-001",
    donorBranchName: branches[0]!.name,
    quantity: 20,
    rank: 2,
  };

  const plan: Analysis = {
    ...basePlan,
    recommendations: [t1, t2],
  };
  return { data, plan, t1, t2 };
}

describe("Approval ledger mutation protection & pure project()", () => {
  it("projects donor reserved & receiver inTransit without mutating raw engine positions", () => {
    const raw = {
      skuIndex: 0,
      branchIndex: 0,
      onHand: 100,
      velocity: 2,
      sigma: 0,
      inStockDays: 60,
      safetyStock: 0,
      reorderPoint: 14,
      coverDays: 50,
      status: "OVERSTOCK" as const,
      surplus: 40,
      need: 0,
      lostUnits: 0,
      leadTimeDays: 7,
    };
    Object.freeze(raw);

    const projectedDonor = project(raw, { reserved: 25, inTransit: 0 });
    expect(projectedDonor.onHand).toBe(75);
    expect(projectedDonor.surplus).toBe(15);
    expect(projectedDonor.reserved).toBe(25);
    expect(projectedDonor.inTransit).toBe(0);
    // Raw snapshot untouched
    expect(raw.onHand).toBe(100);
    expect(raw.surplus).toBe(40);

    const receiverRaw = Object.freeze({
      skuIndex: 0,
      branchIndex: 1,
      onHand: 10,
      velocity: 5,
      sigma: 0,
      inStockDays: 60,
      safetyStock: 0,
      reorderPoint: 35,
      coverDays: 2,
      status: "AT_RISK" as const,
      surplus: 0,
      need: 60,
      lostUnits: 25,
      leadTimeDays: 7,
    });

    const projectedReceiver = project(receiverRaw, { reserved: 0, inTransit: 25 });
    expect(projectedReceiver.inTransit).toBe(25);
    expect(projectedReceiver.coverDays).toBe(7);
    expect(projectedReceiver.status).toBe("HEALTHY");
    expect(projectedReceiver.lostUnits).toBe(0);
    expect(receiverRaw.onHand).toBe(10);
    expect(receiverRaw.status).toBe("AT_RISK");
  });

  it("decreases donor surplus and increases receiver inTransit across reads after transfer approval without mutating analysis snapshot", async () => {
    const repo = new FixedDatasetRepository(transferDataset());
    const { app, services } = await setupApp({ repo, authEnabled: true });
    try {
      const adminHeader = bearer(tokenFor(app, SEED_USERS.admin));

      const recsBody = JSON.parse(
        (await app.inject({ method: "GET", url: "/api/recommendations", headers: adminHeader })).payload,
      ) as { recommendations: Recommendation[] };
      const rawSnapshot = structuredClone(services.runtime.analysis);
      const transfer = recsBody.recommendations.find((r) => r.action === "TRANSFER")!;
      expect(transfer).toBeDefined();

      // Warm-cache admin & branch-scoped KPIs before approval to verify scopedKpiCache.clear()
      const mgrManamaHeader = bearer(tokenFor(app, SEED_USERS.managerManama));
      const beforeKpis = JSON.parse(
        (await app.inject({ method: "GET", url: "/api/kpis", headers: adminHeader })).payload,
      ) as KpiSummary;
      const beforeScopedKpis = JSON.parse(
        (await app.inject({ method: "GET", url: "/api/kpis", headers: mgrManamaHeader })).payload,
      ) as KpiSummary;

      const beforeProduct = JSON.parse(
        (await app.inject({ method: "GET", url: `/api/products/${transfer.sku}`, headers: adminHeader })).payload,
      ) as ProductDetail;
      const donorBefore = beforeProduct.positions.find((p) => p.branch.id === transfer.donorBranchId)!;
      const receiverBefore = beforeProduct.positions.find((p) => p.branch.id === transfer.branchId)!;
      expect(donorBefore.inTransit).toBe(0);
      expect(receiverBefore.inTransit).toBe(0);

      // Approve the transfer
      const approveRes = await app.inject({
        method: "POST",
        url: `/api/recommendations/${transfer.id}/approve`,
        headers: adminHeader,
      });
      expect(approveRes.statusCode).toBe(200);

      // Verify internal analysis snapshot is byte-identical (unmutated)
      expect(services.runtime.analysis).toStrictEqual(rawSnapshot);

      // Next read via /api/products/:sku shows reduced donor surplus & increased receiver inTransit
      const afterProduct = JSON.parse(
        (await app.inject({ method: "GET", url: `/api/products/${transfer.sku}`, headers: adminHeader })).payload,
      ) as ProductDetail;
      const donorAfter = afterProduct.positions.find((p) => p.branch.id === transfer.donorBranchId)!;
      const receiverAfter = afterProduct.positions.find((p) => p.branch.id === transfer.branchId)!;

      expect(donorAfter.surplus).toBe((donorBefore.surplus ?? 0) - transfer.quantity);
      expect(donorAfter.reserved).toBe(transfer.quantity);
      expect(donorAfter.onHand).toBe(donorBefore.onHand - transfer.quantity);
      expect(receiverAfter.inTransit).toBe(transfer.quantity);

      // Verify listCatalogProducts() & KPIs also reflect projection (cache cleared on decision)
      const staffCatalog = JSON.parse(
        (
          await app.inject({
            method: "GET",
            url: `/api/catalog/products?branch=${transfer.branchId}`,
            headers: adminHeader,
          })
        ).payload,
      ) as { products: Array<{ sku: string; stats?: { inTransit?: number; reserved?: number; status: string } }> };
      const catalogItem = staffCatalog.products.find((p) => p.sku === transfer.sku);
      expect(catalogItem?.stats?.inTransit).toBe(transfer.quantity);

      const afterKpis = JSON.parse(
        (await app.inject({ method: "GET", url: "/api/kpis", headers: adminHeader })).payload,
      ) as KpiSummary;
      const afterScopedKpis = JSON.parse(
        (await app.inject({ method: "GET", url: "/api/kpis", headers: mgrManamaHeader })).payload,
      ) as KpiSummary;
      expect(afterKpis.cashReleasable).toBeLessThan(beforeKpis.cashReleasable);
      expect(afterKpis.lostSalesAtRisk).toBeLessThan(beforeKpis.lostSalesAtRisk);
      expect(afterScopedKpis.cashReleasable).toBeLessThan(beforeScopedKpis.cashReleasable);
    } finally {
      await app.close();
    }
  });

  it("rejects the second competing transfer against a depleted donor with 409 Conflict (sequential & concurrent)", async () => {
    const { data, plan, t1, t2 } = makeCompetingTransfersDataset();

    // Sequential check
    const seqRepo = new FixedDatasetRepository(data);
    await seqRepo.saveCachedPlan(1, plan);
    const seqCtx = await setupApp({ repo: seqRepo, authEnabled: true });
    try {
      const adminHeader = bearer(tokenFor(seqCtx.app, SEED_USERS.admin));

      const firstRes = await seqCtx.app.inject({
        method: "POST",
        url: `/api/recommendations/${t1.id}/approve`,
        headers: adminHeader,
      });
      expect(firstRes.statusCode).toBe(200);

      const secondRes = await seqCtx.app.inject({
        method: "POST",
        url: `/api/recommendations/${t2.id}/approve`,
        headers: adminHeader,
      });
      expect(secondRes.statusCode).toBe(409);
      expect(JSON.parse(secondRes.payload)).toEqual({
        error: "Donor stock already committed to another approved transfer",
      });

      // Only t1 wrote to actions/audit & donor reserved stayed 25
      expect(await seqRepo.listActions()).toHaveLength(1);
      expect(seqCtx.services.decisions.projectPosition("SKU-CONFLICT-1", "BR-001")?.reserved).toBe(25);
    } finally {
      await seqCtx.app.close();
    }

    // Concurrent race check: Promise.all must allow one 200 and reject the other with 409
    const raceRepo = new FixedDatasetRepository(data);
    await raceRepo.saveCachedPlan(1, plan);
    const raceCtx = await setupApp({ repo: raceRepo, authEnabled: true });
    try {
      const adminHeader = bearer(tokenFor(raceCtx.app, SEED_USERS.admin));
      const [r1, r2] = await Promise.all([
        raceCtx.app.inject({ method: "POST", url: `/api/recommendations/${t1.id}/approve`, headers: adminHeader }),
        raceCtx.app.inject({ method: "POST", url: `/api/recommendations/${t2.id}/approve`, headers: adminHeader }),
      ]);
      expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 409]);
      expect(await raceRepo.listActions()).toHaveLength(1);
    } finally {
      await raceCtx.app.close();
    }
  });

  it("tracks reorder/markdown committed quantities until the next sales or catalog refresh", async () => {
    const repo = InMemoryRepository.createFromDataset(smallSeededDataset());
    const { app, services } = await setupApp({ repo, authEnabled: true });
    try {
      const adminHeader = bearer(tokenFor(app, SEED_USERS.admin));
      const recs = JSON.parse(
        (await app.inject({ method: "GET", url: "/api/recommendations", headers: adminHeader })).payload,
      ) as { recommendations: Recommendation[] };

      const reorder = recs.recommendations.find((r) => r.action === "REORDER" && r.sku === "SKU-90002")!;
      const markdown = recs.recommendations.find((r) => r.action === "MARKDOWN" && r.sku === "SKU-90003")!;
      expect(reorder).toBeDefined();
      expect(markdown).toBeDefined();

      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/recommendations/${reorder.id}/approve`,
            headers: adminHeader,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/recommendations/${markdown.id}/approve`,
            headers: adminHeader,
          })
        ).statusCode,
      ).toBe(200);

      // Before refresh: committed quantities appear in projections
      expect(services.decisions.projectPosition("SKU-90002", reorder.branchId)?.inTransit).toBe(reorder.quantity);
      const mdProj = services.decisions.projectPosition("SKU-90003", markdown.branchId)!;
      expect(mdProj.reserved).toBe(markdown.quantity);
      expect(mdProj.surplus).toBe(0);

      // After sales/catalog refresh on SKU-90002: stale delta clears cleanly
      const asOfDate = smallSeededDataset().asOf;
      const salesRes = await app.inject({
        method: "POST",
        url: "/api/sales-entries",
        headers: adminHeader,
        payload: {
          branchId: reorder.branchId,
          sku: "SKU-90002",
          date: asOfDate,
          unitsSold: 1,
          onHand: 5 + reorder.quantity,
        },
      });
      expect(salesRes.statusCode).toBe(201);
      expect(services.decisions.projectPosition("SKU-90002", reorder.branchId)?.inTransit).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("keeps the untouched golden fixtures byte-identical across fresh booted instances", async () => {
    const { app } = await setupApp({ authEnabled: false });
    try {
      const expectedRecs = fs.readFileSync(path.join(FIXTURE_DIR, "recommendations.json"), "utf8").trimEnd();
      const expectedKpis = fs.readFileSync(path.join(FIXTURE_DIR, "kpis.json"), "utf8").trimEnd();

      const recsRes = await app.inject({ method: "GET", url: "/api/recommendations" });
      const kpisRes = await app.inject({ method: "GET", url: "/api/kpis" });
      expect(recsRes.statusCode).toBe(200);
      expect(kpisRes.statusCode).toBe(200);
      expect(recsRes.payload).toBe(expectedRecs);
      expect(kpisRes.payload).toBe(expectedKpis);
    } finally {
      await app.close();
    }
  });

  it("preserves conflicting-transfer 409 guard after reinstantiating StockServices from persisted audit", async () => {
    const { data, plan, t1, t2 } = makeCompetingTransfersDataset();
    const repo = new FixedDatasetRepository(data);
    await repo.saveCachedPlan(1, plan);

    const first = await setupApp({ repo, authEnabled: true });
    try {
      const adminHeader = bearer(tokenFor(first.app, SEED_USERS.admin));
      const res1 = await first.app.inject({
        method: "POST",
        url: `/api/recommendations/${t1.id}/approve`,
        headers: adminHeader,
      });
      expect(res1.statusCode).toBe(200);
    } finally {
      await first.app.close();
    }

    // Reinstantiate a brand-new StockServices composition root over the same repository (fresh in-memory ledger)
    const restarted = await setupApp({ repo, authEnabled: true });
    try {
      const adminHeader = bearer(tokenFor(restarted.app, SEED_USERS.admin));
      expect(restarted.services.decisions.projectPosition("SKU-CONFLICT-1", "BR-001")?.reserved).toBe(25);
      expect(restarted.services.decisions.projectPosition("SKU-CONFLICT-1", "BR-005")?.inTransit).toBe(25);

      const res2 = await restarted.app.inject({
        method: "POST",
        url: `/api/recommendations/${t2.id}/approve`,
        headers: adminHeader,
      });
      expect(res2.statusCode).toBe(409);
      expect(JSON.parse(res2.payload)).toEqual({
        error: "Donor stock already committed to another approved transfer",
      });
    } finally {
      await restarted.app.close();
    }
  });
});

describe.each<RepoKind>(["memory", "mongo-memory"])("Boot-time audit ledger replay [%s]", (repoKind) => {
  it("replays APPROVED transfers from audits into committedDeltas after a server restart", async () => {
    const created = await createDualRepo(repoKind, transferDataset());
    try {
      const adminUser = (await createUser(created.repo, "admin", [])).user;

      // Boot instance #1 and approve the transfer
      const inst1 = await buildTestApp(created.repo);
      let transfer: Recommendation;
      try {
        const headers = bearer(tokenFor(inst1.app, adminUser));
        const listBody = JSON.parse(
          (await inst1.app.inject({ method: "GET", url: "/api/recommendations", headers })).payload,
        ) as { recommendations: Recommendation[] };
        transfer = listBody.recommendations.find((r) => r.action === "TRANSFER")!;
        expect(transfer).toBeDefined();

        const approveRes = await inst1.app.inject({
          method: "POST",
          url: `/api/recommendations/${transfer.id}/approve`,
          headers,
        });
        expect(approveRes.statusCode).toBe(200);
      } finally {
        await inst1.app.close();
      }

      // Simulate API restart: instantiate a brand-new StockServices container backed by the same repo
      const inst2 = await buildTestApp(created.repo);
      try {
        const headers = bearer(tokenFor(inst2.app, adminUser));
        const productRes = await inst2.app.inject({
          method: "GET",
          url: `/api/products/${transfer.sku}`,
          headers,
        });
        expect(productRes.statusCode).toBe(200);
        const detail = JSON.parse(productRes.payload) as ProductDetail;

        const donorPos = detail.positions.find((p) => p.branch.id === transfer.donorBranchId)!;
        const receiverPos = detail.positions.find((p) => p.branch.id === transfer.branchId)!;
        expect(donorPos.reserved).toBe(transfer.quantity);
        expect(donorPos.onHand).toBe(300 - transfer.quantity);
        expect(receiverPos.inTransit).toBe(transfer.quantity);

        const donorInv = JSON.parse(
          (
            await inst2.app.inject({
              method: "GET",
              url: `/api/locations/${transfer.donorBranchId}/inventory?search=${transfer.sku}`,
              headers,
            })
          ).payload,
        ) as { items: Array<{ sku: string; reserved?: number; inTransit?: number }> };
        expect(donorInv.items[0]?.reserved).toBe(transfer.quantity);
      } finally {
        await inst2.app.close();
      }
    } finally {
      await created.cleanup();
    }
  }, 60_000);
});

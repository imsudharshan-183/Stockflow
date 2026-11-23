import type { KpiSummary, ProductDetail, Recommendation } from "@stockflow/core";
import { describe, expect, it } from "vitest";
import { buildTestApp, createDualRepo, createUser, type RepoKind } from "../test/dualRepo.js";
import { bearer, tokenFor } from "../test/helpers.js";

describe.each<RepoKind>(["memory", "mongo-memory"])(
  "Bi-directional cache & committedDeltas invalidation [%s]",
  (repoKind) => {
    it("clears scopedKpiCache immediately when DecisionService approves a recommendation", async () => {
      const created = await createDualRepo(repoKind);
      try {
        const { app } = await buildTestApp(created.repo);
        try {
          const mgr = (await createUser(created.repo, "manager", ["BR-001"])).user;
          const headers = bearer(tokenFor(app, mgr));

          // 1. Warm scopedKpiCache for manager (BR-001)
          const beforeRes = await app.inject({ method: "GET", url: "/api/kpis", headers });
          expect(beforeRes.statusCode).toBe(200);
          const beforeKpi = JSON.parse(beforeRes.payload) as KpiSummary;
          const initialPending = beforeKpi.operational?.pendingApprovalsCount ?? 0;
          expect(initialPending).toBeGreaterThan(0);

          // 2. Find and approve a pending recommendation touching BR-001
          const listRes = await app.inject({ method: "GET", url: "/api/recommendations", headers });
          const recs = (JSON.parse(listRes.payload) as { recommendations: Recommendation[] }).recommendations;
          const transfer = recs.find(
            (r) =>
              r.status === "PENDING" &&
              r.action === "TRANSFER" &&
              (r.branchId === "BR-001" || r.donorBranchId === "BR-001"),
          )!;
          expect(transfer).toBeDefined();

          const approveRes = await app.inject({
            method: "POST",
            url: `/api/recommendations/${transfer.id}/approve`,
            headers,
          });
          expect(approveRes.statusCode).toBe(200);

          // 3. Immediately re-query GET /api/kpis and verify scopedKpiCache was invalidated
          const afterRes = await app.inject({ method: "GET", url: "/api/kpis", headers });
          expect(afterRes.statusCode).toBe(200);
          const afterKpi = JSON.parse(afterRes.payload) as KpiSummary;
          expect(afterKpi.operational?.pendingApprovalsCount).toBe(initialPending - 1);
          expect(afterKpi.cashReleasable).not.toBe(beforeKpi.cashReleasable);
        } finally {
          await app.close();
        }
      } finally {
        await created.cleanup();
      }
    }, 60_000);

    it("clears committedDeltas, committedRecommendationIds, and scopedKpiCache on catalog edit and CSV sales import", async () => {
      const created = await createDualRepo(repoKind);
      try {
        const { app, services } = await buildTestApp(created.repo);
        try {
          const adminUser = (await createUser(created.repo, "admin", [])).user;
          const mgr = (await createUser(created.repo, "manager", ["BR-001"])).user;
          const adminHeaders = bearer(tokenFor(app, adminUser));
          const mgrHeaders = bearer(tokenFor(app, mgr));

          // 1. Approve TRANSFER on SKU-90001 (BR-001 -> BR-005) and warm manager scopedKpiCache
          const listRes = await app.inject({ method: "GET", url: "/api/recommendations", headers: adminHeaders });
          const recs = (JSON.parse(listRes.payload) as { recommendations: Recommendation[] }).recommendations;
          const transfer = recs.find((r) => r.sku === "SKU-90001" && r.action === "TRANSFER")!;
          expect(transfer).toBeDefined();

          const approveRes = await app.inject({
            method: "POST",
            url: `/api/recommendations/${transfer.id}/approve`,
            headers: adminHeaders,
          });
          expect(approveRes.statusCode).toBe(200);

          expect(services.decisions.projectPosition("SKU-90001", "BR-001")?.reserved).toBe(transfer.quantity);
          expect(services.decisions.projectPosition("SKU-90001", "BR-005")?.inTransit).toBe(transfer.quantity);

          const warmKpiRes = await app.inject({ method: "GET", url: "/api/kpis", headers: mgrHeaders });
          expect(warmKpiRes.statusCode).toBe(200);

          // 2. Math-changing catalog edit on SKU-90001 must clear committedDeltas + scopedKpiCache
          const patchRes = await app.inject({
            method: "PATCH",
            url: "/api/catalog/products/SKU-90001",
            headers: adminHeaders,
            payload: { price: 155, leadTimeDays: 9 },
          });
          expect(patchRes.statusCode).toBe(200);

          const detailAfterEdit = JSON.parse(
            (await app.inject({ method: "GET", url: "/api/products/SKU-90001", headers: adminHeaders })).payload,
          ) as ProductDetail;
          const br1AfterEdit = detailAfterEdit.positions.find((p) => p.branch.id === "BR-001")!;
          const br5AfterEdit = detailAfterEdit.positions.find((p) => p.branch.id === "BR-005")!;
          expect(br1AfterEdit.reserved).toBe(0);
          expect(br5AfterEdit.inTransit).toBe(0);

          // 3. Approve a SKU-90002 REORDER, warm KPI cache, then import CSV sales for SKU-90002 -> clears deltas & KPI cache
          const recs2 = (
            JSON.parse(
              (await app.inject({ method: "GET", url: "/api/recommendations", headers: adminHeaders })).payload,
            ) as { recommendations: Recommendation[] }
          ).recommendations;
          const reorder = recs2.find((r) => r.sku === "SKU-90002" && r.action === "REORDER" && r.status === "PENDING")!;
          expect(reorder).toBeDefined();
          expect(
            (
              await app.inject({
                method: "POST",
                url: `/api/recommendations/${reorder.id}/approve`,
                headers: adminHeaders,
              })
            ).statusCode,
          ).toBe(200);
          expect(services.decisions.projectPosition("SKU-90002", reorder.branchId)?.inTransit).toBe(reorder.quantity);

          const kpiBeforeCsv = JSON.parse(
            (await app.inject({ method: "GET", url: "/api/kpis", headers: mgrHeaders })).payload,
          ) as KpiSummary;

          const today = new Date().toISOString().slice(0, 10);
          const boundary = "----StockFlowBoundary";
          const multipartBody = [
            `--${boundary}`,
            'Content-Disposition: form-data; name="file"; filename="sales.csv"',
            "Content-Type: text/csv",
            "",
            `branchId,sku,date,unitsSold,onHand\nBR-001,SKU-90002,${today},25,0`,
            `--${boundary}--`,
            "",
          ].join("\r\n");

          const importRes = await app.inject({
            method: "POST",
            url: "/api/sales-entries/import",
            headers: {
              ...adminHeaders,
              "content-type": `multipart/form-data; boundary=${boundary}`,
            },
            payload: Buffer.from(multipartBody, "utf8"),
          });
          expect(importRes.statusCode).toBe(200);

          // Stale inTransit reservation cleared after single-SKU recompute and KPI cache reflects new AT_RISK shortage
          expect(services.decisions.projectPosition("SKU-90002", reorder.branchId)?.inTransit).toBe(0);
          const kpiAfterCsv = JSON.parse(
            (await app.inject({ method: "GET", url: "/api/kpis", headers: mgrHeaders })).payload,
          ) as KpiSummary;
          expect(kpiBeforeCsv.lostSalesAtRisk).toBe(0);
          expect(kpiAfterCsv.lostSalesAtRisk).toBeGreaterThan(0);
        } finally {
          await app.close();
        }
      } finally {
        await created.cleanup();
      }
    }, 60_000);
  },
);

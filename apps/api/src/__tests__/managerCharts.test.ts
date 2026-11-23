import type { KpiSummary, Recommendation, RecommendationList } from "@stockflow/core";
import { describe, expect, it } from "vitest";
import { InMemoryRepository } from "../repositories/memory.js";
import { buildTestApp, createUser } from "../test/dualRepo.js";
import { FixedDatasetRepository, SEED_USERS, bearer, setupApp, tokenFor, transferDataset } from "../test/helpers.js";

function summarizeActionMix(rows: readonly Recommendation[]) {
  return {
    TRANSFER: rows.filter((r) => r.action === "TRANSFER").length,
    REORDER: rows.filter((r) => r.action === "REORDER").length,
    MARKDOWN: rows.filter((r) => r.action === "MARKDOWN").length,
  };
}

function summarizeTopSkus(rows: readonly Recommendation[]) {
  const totals = new Map<string, number>();
  for (const r of rows) {
    totals.set(r.sku, (totals.get(r.sku) ?? 0) + r.netBenefit);
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
}

describe("Manager-scoped chart data & donor/receiver transfer visibility", () => {
  it("provides consistent scoped chart data for a 2-branch manager, a 1-branch manager, and blocks staff KPIs", async () => {
    const repo = InMemoryRepository.create();
    const { app } = await buildTestApp(repo);
    try {
      const twoBranchMgr = (await createUser(repo, "manager", ["BR-001", "BR-002"], {
        email: "mgr.two@stockflow.test",
      })).user;
      const oneBranchMgr = (await createUser(repo, "manager", ["BR-005"], {
        email: "mgr.one@stockflow.test",
      })).user;
      const staff = (await createUser(repo, "staff", ["BR-001"], {
        email: "staff.one@stockflow.test",
      })).user;

      // 1. Manager with 2 branches (BR-001, BR-002)
      const twoHeaders = bearer(tokenFor(app, twoBranchMgr));
      const [twoKpiRes, twoRecRes, twoBr1RecRes, twoOosRecRes] = await Promise.all([
        app.inject({ method: "GET", url: "/api/kpis", headers: twoHeaders }),
        app.inject({ method: "GET", url: "/api/recommendations", headers: twoHeaders }),
        app.inject({ method: "GET", url: "/api/recommendations?branch=BR-001", headers: twoHeaders }),
        app.inject({ method: "GET", url: "/api/recommendations?branch=BR-005", headers: twoHeaders }),
      ]);
      expect(twoKpiRes.statusCode).toBe(200);
      expect(twoRecRes.statusCode).toBe(200);
      expect(twoBr1RecRes.statusCode).toBe(200);
      expect(twoOosRecRes.statusCode).toBe(200);

      const twoKpi = JSON.parse(twoKpiRes.payload) as KpiSummary;
      const twoRecs = (JSON.parse(twoRecRes.payload) as RecommendationList).recommendations;
      const twoBr1Recs = (JSON.parse(twoBr1RecRes.payload) as RecommendationList).recommendations;
      const twoOosRecs = (JSON.parse(twoOosRecRes.payload) as RecommendationList).recommendations;

      expect(twoKpi.branches.map((b) => b.id).sort()).toEqual(["BR-001", "BR-002"]);
      expect(twoKpi.branchRisk.length).toBe(2);
      expect(twoKpi.coverGrid.length).toBeGreaterThan(0);
      expect(twoRecs.length).toBeGreaterThan(0);
      expect(twoKpi.operational?.pendingApprovalsCount).toBe(
        twoRecs.filter((r) => r.status === "PENDING").length,
      );
      expect(twoBr1Recs.length).toBeGreaterThan(0);
      expect(
        twoBr1Recs.every(
          (r) => r.branchId === "BR-001" || (r.action === "TRANSFER" && r.donorBranchId === "BR-001"),
        ),
      ).toBe(true);
      expect(twoOosRecs).toEqual([]);

      const twoMix = summarizeActionMix(twoRecs);
      expect(twoMix.TRANSFER + twoMix.REORDER + twoMix.MARKDOWN).toBe(twoRecs.length);
      expect(summarizeTopSkus(twoRecs).length).toBeGreaterThan(0);

      // 2. Manager with 1 branch (BR-005)
      const oneHeaders = bearer(tokenFor(app, oneBranchMgr));
      const [oneKpiRes, oneRecRes, oneBr5RecRes] = await Promise.all([
        app.inject({ method: "GET", url: "/api/kpis", headers: oneHeaders }),
        app.inject({ method: "GET", url: "/api/recommendations", headers: oneHeaders }),
        app.inject({ method: "GET", url: "/api/recommendations?branch=BR-005", headers: oneHeaders }),
      ]);
      expect(oneKpiRes.statusCode).toBe(200);
      expect(oneRecRes.statusCode).toBe(200);
      expect(oneBr5RecRes.statusCode).toBe(200);

      const oneKpi = JSON.parse(oneKpiRes.payload) as KpiSummary;
      const oneRecs = (JSON.parse(oneRecRes.payload) as RecommendationList).recommendations;
      const oneBr5Recs = (JSON.parse(oneBr5RecRes.payload) as RecommendationList).recommendations;

      expect(oneKpi.branches.map((b) => b.id)).toEqual(["BR-005"]);
      expect(oneKpi.branchRisk.map((b) => b.branchId)).toEqual(["BR-005"]);
      expect(oneKpi.coverGrid.every((c) => c.branchId === "BR-005")).toBe(true);
      expect(oneRecs.length).toBeGreaterThan(0);
      expect(oneBr5Recs.length).toBe(oneRecs.length);
      expect(oneKpi.operational?.pendingApprovalsCount).toBe(
        oneRecs.filter((r) => r.status === "PENDING").length,
      );
      expect(
        oneRecs.every(
          (r) => r.branchId === "BR-005" || (r.action === "TRANSFER" && r.donorBranchId === "BR-005"),
        ),
      ).toBe(true);
      expect(summarizeTopSkus(oneRecs).length).toBeGreaterThan(0);

      // 3. Staff (BR-001): denied /api/kpis (403) and sees only BR-001 recommendations
      const staffHeaders = bearer(tokenFor(app, staff));
      const [staffKpiRes, staffRecRes, staffOosRecRes] = await Promise.all([
        app.inject({ method: "GET", url: "/api/kpis", headers: staffHeaders }),
        app.inject({ method: "GET", url: "/api/recommendations", headers: staffHeaders }),
        app.inject({ method: "GET", url: "/api/recommendations?branch=BR-002", headers: staffHeaders }),
      ]);
      expect(staffKpiRes.statusCode).toBe(403);
      expect(staffRecRes.statusCode).toBe(200);
      expect(staffOosRecRes.statusCode).toBe(200);

      const staffRecs = (JSON.parse(staffRecRes.payload) as RecommendationList).recommendations;
      expect(staffRecs.length).toBeGreaterThan(0);
      expect(
        staffRecs.every(
          (r) => r.branchId === "BR-001" || (r.action === "TRANSFER" && r.donorBranchId === "BR-001"),
        ),
      ).toBe(true);
      expect((JSON.parse(staffOosRecRes.payload) as RecommendationList).recommendations).toEqual([]);
    } finally {
      await app.close();
      await repo.close();
    }
  });

  it("includes transfers in both unfiltered and ?branch= filtered chart queries when branch is donor OR receiver", async () => {
    const repo = new FixedDatasetRepository(transferDataset());
    const ctx = await setupApp({ repo });
    try {
      const donorMgr = await repo.users.create({
        name: "Donor Only Manager",
        email: "donor.mgr@stockflow.test",
        passwordHash: "x",
        role: "manager",
        branchIds: ["BR-001"],
        isActive: true,
      });
      const receiverMgr = await repo.users.create({
        name: "Receiver Only Manager",
        email: "receiver.mgr@stockflow.test",
        passwordHash: "x",
        role: "manager",
        branchIds: ["BR-005"],
        isActive: true,
      });
      const outsiderMgr = await repo.users.create({
        name: "Bystander Manager",
        email: "bystander.mgr@stockflow.test",
        passwordHash: "x",
        role: "manager",
        branchIds: ["BR-009"],
        isActive: true,
      });

      const donorHeaders = bearer(tokenFor(ctx.app, donorMgr));
      const receiverHeaders = bearer(tokenFor(ctx.app, receiverMgr));
      const outsiderHeaders = bearer(tokenFor(ctx.app, outsiderMgr));
      const staffHeaders = bearer(tokenFor(ctx.app, SEED_USERS.staffManama));

      // Donor 1-branch manager sees transfer in KPIs, unfiltered recommendations, and ?branch=BR-001
      const [donorKpiRes, donorRecRes, donorFilteredRes] = await Promise.all([
        ctx.app.inject({ method: "GET", url: "/api/kpis", headers: donorHeaders }),
        ctx.app.inject({ method: "GET", url: "/api/recommendations", headers: donorHeaders }),
        ctx.app.inject({ method: "GET", url: "/api/recommendations?branch=BR-001", headers: donorHeaders }),
      ]);
      expect(donorKpiRes.statusCode).toBe(200);
      expect((JSON.parse(donorKpiRes.payload) as KpiSummary).operational?.pendingApprovalsCount).toBe(1);
      expect((JSON.parse(donorRecRes.payload) as RecommendationList).recommendations).toHaveLength(1);
      expect((JSON.parse(donorFilteredRes.payload) as RecommendationList).recommendations).toHaveLength(1);

      // Out-of-scope ?branch=BR-005 for donorMgr (only assigned BR-001) still returns empty
      const donorOosRes = await ctx.app.inject({
        method: "GET",
        url: "/api/recommendations?branch=BR-005",
        headers: donorHeaders,
      });
      expect(donorOosRes.statusCode).toBe(200);
      expect((JSON.parse(donorOosRes.payload) as RecommendationList).recommendations).toEqual([]);

      // Receiver 1-branch manager sees transfer too
      const [recvKpiRes, recvFilteredRes] = await Promise.all([
        ctx.app.inject({ method: "GET", url: "/api/kpis", headers: receiverHeaders }),
        ctx.app.inject({ method: "GET", url: "/api/recommendations?branch=BR-005", headers: receiverHeaders }),
      ]);
      expect((JSON.parse(recvKpiRes.payload) as KpiSummary).operational?.pendingApprovalsCount).toBe(1);
      expect((JSON.parse(recvFilteredRes.payload) as RecommendationList).recommendations).toHaveLength(1);

      // Bystander 1-branch manager sees 0
      const [outKpiRes, outRecRes] = await Promise.all([
        ctx.app.inject({ method: "GET", url: "/api/kpis", headers: outsiderHeaders }),
        ctx.app.inject({ method: "GET", url: "/api/recommendations", headers: outsiderHeaders }),
      ]);
      expect((JSON.parse(outKpiRes.payload) as KpiSummary).operational?.pendingApprovalsCount).toBe(0);
      expect((JSON.parse(outRecRes.payload) as RecommendationList).recommendations).toEqual([]);

      // Staff at donor branch (BR-001) gets 403 on /api/kpis, sees transfer in /api/recommendations
      const staffKpi = await ctx.app.inject({ method: "GET", url: "/api/kpis", headers: staffHeaders });
      const staffRecs = await ctx.app.inject({ method: "GET", url: "/api/recommendations", headers: staffHeaders });
      expect(staffKpi.statusCode).toBe(403);
      expect((JSON.parse(staffRecs.payload) as RecommendationList).recommendations).toHaveLength(1);
    } finally {
      await ctx.app.close();
    }
  });
});

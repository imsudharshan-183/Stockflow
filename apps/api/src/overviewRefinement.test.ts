import type { KpiSummary, LocationListResponse } from "@stockflow/core";
import { describe, expect, it } from "vitest";
import { resolveRiskChart } from "../../web/src/features/overview/riskChart.js";
import { formatMoney, formatMoneyFull } from "../../web/src/lib/format.js";
import { InMemoryRepository } from "./repositories/memory.js";
import { buildTestApp, createUser } from "./test/dualRepo.js";
import { SEED_USERS, bearer, tokenFor } from "./test/helpers.js";

describe("Overview refinement & formatting invariants", () => {
  it("formats KPI money compactly and table/detail money in whole BD (3 decimals only below BD 1)", () => {
    expect(formatMoney(0)).toBe("BD 0");
    expect(formatMoney(0.75)).toBe("BD 0.750");
    expect(formatMoney(420.4)).toBe("BD 420");
    expect(formatMoney(9420)).toBe("BD 9.4K");
    expect(formatMoney(155400)).toBe("BD 155.4K");
    expect(formatMoney(1250000)).toBe("BD 1.3M");

    expect(formatMoneyFull(0)).toBe("BD 0");
    expect(formatMoneyFull(0.75)).toBe("BD 0.750");
    expect(formatMoneyFull(186.4)).toBe("BD 186");
    expect(formatMoneyFull(1241.32)).toBe("BD 1,241");
    expect(formatMoneyFull(-0.25)).toBe("-BD 0.250");
  });

  it("ensures deadStockValue <= cashReleasable and sorted categoryRisk across network, branches, and managers", async () => {
    const repo = InMemoryRepository.create();
    const { app } = await buildTestApp(repo);
    try {
      const adminToken = bearer(tokenFor(app, SEED_USERS.admin));
      const twoBranchMgr = (
        await createUser(repo, "manager", ["BR-001", "BR-002"], {
          email: "mgr.refinement@stockflow.test",
        })
      ).user;
      const mgrToken = bearer(tokenFor(app, twoBranchMgr));

      // 1. Network KPIs + all 15 individual branches
      const netRes = await app.inject({ method: "GET", url: "/api/kpis", headers: adminToken });
      expect(netRes.statusCode).toBe(200);
      const netKpis = JSON.parse(netRes.payload) as KpiSummary;
      expect(netKpis.deadStockValue).toBeLessThanOrEqual(netKpis.cashReleasable);

      const netChart = resolveRiskChart(null, netKpis);
      expect(netChart.mode).toBe("branches");
      expect(netChart.rows).toHaveLength(8);
      for (let i = 1; i < netChart.rows.length; i += 1) {
        expect(netChart.rows[i - 1]!.revenueAtRisk).toBeGreaterThanOrEqual(
          netChart.rows[i]!.revenueAtRisk,
        );
      }

      const netCategories = netKpis.categoryRisk ?? [];
      expect(netCategories.length).toBeGreaterThan(0);
      for (let i = 1; i < netCategories.length; i += 1) {
        expect(netCategories[i - 1]!.revenueAtRisk).toBeGreaterThanOrEqual(
          netCategories[i]!.revenueAtRisk,
        );
      }

      // Single branch BR-004 check + resolveRiskChart category mode
      const br4Res = await app.inject({
        method: "GET",
        url: "/api/kpis?branch=BR-004",
        headers: adminToken,
      });
      expect(br4Res.statusCode).toBe(200);
      const br4Kpis = JSON.parse(br4Res.payload) as KpiSummary;
      expect(br4Kpis.deadStockValue).toBeLessThanOrEqual(br4Kpis.cashReleasable);

      const catChart = resolveRiskChart("BR-004", br4Kpis);
      expect(catChart.mode).toBe("categories");
      expect(catChart.rows.length).toBeGreaterThan(0);
      expect(catChart.rows[0]!.href).toBe(
        `/branches/BR-004?cat=${encodeURIComponent(catChart.rows[0]!.id)}&status=AT_RISK`,
      );
      for (let i = 1; i < catChart.rows.length; i += 1) {
        expect(catChart.rows[i - 1]!.revenueAtRisk).toBeGreaterThanOrEqual(
          catChart.rows[i]!.revenueAtRisk,
        );
      }

      // Check all 15 branches and manager cluster
      for (const b of netKpis.branches) {
        const res = await app.inject({
          method: "GET",
          url: `/api/kpis?branch=${b.id}`,
          headers: adminToken,
        });
        expect(res.statusCode).toBe(200);
        const branchKpi = JSON.parse(res.payload) as KpiSummary;
        expect(branchKpi.deadStockValue).toBeLessThanOrEqual(branchKpi.cashReleasable);
      }

      const mgrRes = await app.inject({ method: "GET", url: "/api/kpis", headers: mgrToken });
      expect(mgrRes.statusCode).toBe(200);
      const mgrKpis = JSON.parse(mgrRes.payload) as KpiSummary;
      expect(mgrKpis.deadStockValue).toBeLessThanOrEqual(mgrKpis.cashReleasable);
      expect(mgrKpis.branches.map((b) => b.id).sort()).toEqual(["BR-001", "BR-002"]);

      // 2. Network-relative sidebar location health dots
      const locRes = await app.inject({ method: "GET", url: "/api/locations", headers: adminToken });
      expect(locRes.statusCode).toBe(200);
      const { locations } = JSON.parse(locRes.payload) as LocationListResponse;
      expect(locations).toHaveLength(15);

      const sortedRisks = locations.map((l) => l.lostSalesAtRisk).sort((a, b) => a - b);
      const mid = Math.floor(sortedRisks.length / 2);
      const medianRisk = sortedRisks[mid]!;

      for (const loc of locations) {
        const expectedHealth =
          loc.lostSalesAtRisk <= medianRisk
            ? "green"
            : loc.lostSalesAtRisk <= medianRisk * 1.5
              ? "amber"
              : "red";
        expect(loc.health).toBe(expectedHealth);
      }

      // Hotspots BR-004/BR-005/BR-009 should sit well above the median; low-risk BR-003/BR-010/BR-015 should be green
      const healthById = new Map(locations.map((l) => [l.branch.id, l.health]));
      expect(healthById.get("BR-003")).toBe("green");
      expect(healthById.get("BR-010")).toBe("green");
      expect(healthById.get("BR-015")).toBe("green");
      expect(healthById.get("BR-004")).toBe("red");
    } finally {
      await app.close();
    }
  });
});

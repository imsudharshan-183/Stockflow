import { afterEach, describe, expect, it } from "vitest";
import { clearMemorySalesEntries } from "../db.js";
import type { StockRepository } from "../repositories/types.js";
import { buildTestApp, createDualRepo, createUser, type RepoKind } from "../test/dualRepo.js";
import { bearer, json, tokenFor } from "../test/helpers.js";

describe.each<RepoKind>(["memory", "mongo-memory"])(
  "Workstream 3: Live network overview, Bahrain dates & KPI freshness [%s]",
  (kind) => {
    const cleanups: Array<() => Promise<void>> = [];

    afterEach(async () => {
      clearMemorySalesEntries();
      while (cleanups.length > 0) {
        const fn = cleanups.pop();
        if (fn) await fn();
      }
    });

    it("returns per-metric freshness envelopes, advances asOfDataDate on sales writes, bumps decisionVersion on decisions/alerts, and enforces RBAC", async () => {
      const setup = await createDualRepo(kind);
      cleanups.push(setup.cleanup);
      const repo: StockRepository = setup.repo;

      const admin = (await createUser(repo, "admin", [], { name: "Admin Live" })).user;
      const mgr = (await createUser(repo, "manager", ["BR-001"], { name: "Manager Manama" })).user;
      const staff = (await createUser(repo, "staff", ["BR-001"], { name: "Staff Manama" })).user;

      const built = await buildTestApp(repo);
      // 2026-11-24 10:30 AST (07:30 UTC)
      let clock = Date.UTC(2026, 10, 24, 7, 30, 0);
      built.services.setClock(() => clock);

      // Auth & scope checks
      expect((await built.app.inject({ method: "GET", url: "/api/kpis/live" })).statusCode).toBe(401);

      const hAdmin = bearer(tokenFor(built.app, admin));
      const hMgr = bearer(tokenFor(built.app, mgr));
      const hStaff = bearer(tokenFor(built.app, staff));

      expect(
        (await built.app.inject({ method: "GET", url: "/api/kpis/live", headers: hStaff })).statusCode,
      ).toBe(403);
      expect(
        (
          await built.app.inject({
            method: "GET",
            url: "/api/kpis/live?branch=BR-005",
            headers: hMgr,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await built.app.inject({
            method: "GET",
            url: "/api/kpis/live?branch=BR-999",
            headers: hAdmin,
          })
        ).statusCode,
      ).toBe(404);

      const initialLive = json<{
        meta: {
          computedAt: string;
          dataVersion: number;
          decisionVersion: number;
          todayBahrain: string;
          asOfDataDate: string;
          staleDataDays: number;
        };
        metrics: {
          stockoutRate: { value: number; decisionVersion: number; dataVersion: number };
          pendingActionsCount: { value: number; decisionVersion: number };
          pendingEstimatedGain: { value: number; decisionVersion: number };
        };
        stockoutSparkline: number[];
        pendingRecommendations: Array<{ id: string; netBenefit: number }>;
      }>(
        (
          await built.app.inject({
            method: "GET",
            url: "/api/kpis/live?branch=BR-001",
            headers: hMgr,
          })
        ).payload,
      );

      expect(initialLive.meta.todayBahrain).toBe("2026-11-24");
      expect(initialLive.meta.computedAt).toBe("2026-11-24T07:30:00.000Z");
      expect(initialLive.meta.staleDataDays).toBeGreaterThanOrEqual(0);
      expect(initialLive.stockoutSparkline.length).toBeGreaterThan(0);

      // Prime /api/kpis?meta=1 too
      const metaRes = await built.app.inject({
        method: "GET",
        url: "/api/kpis?meta=1",
        headers: hAdmin,
      });
      expect(metaRes.statusCode).toBe(200);
      const metaBody = json<{ meta: { todayBahrain: string; dataVersion: number } }>(metaRes.payload);
      expect(metaBody.meta.todayBahrain).toBe("2026-11-24");

      // Approving a pending BR-001 recommendation bumps decisionVersion and updates pending count + cached KPI immediately
      const targetRec = initialLive.pendingRecommendations[0]!;
      expect(
        (
          await built.app.inject({
            method: "POST",
            url: `/api/recommendations/${targetRec.id}/approve`,
            headers: hMgr,
          })
        ).statusCode,
      ).toBe(200);

      const afterApprove = json<typeof initialLive>(
        (
          await built.app.inject({
            method: "GET",
            url: "/api/kpis/live?branch=BR-001",
            headers: hMgr,
          })
        ).payload,
      );
      expect(afterApprove.meta.decisionVersion).toBeGreaterThan(initialLive.meta.decisionVersion);
      expect(afterApprove.metrics.pendingActionsCount.value).toBe(
        initialLive.metrics.pendingActionsCount.value - 1,
      );

      // Advance clock 3 days into the future (2026-11-27 00:05 Bahrain = 2026-11-26 21:05 UTC)
      clock = Date.UTC(2026, 10, 26, 21, 5, 0);
      const staleView = json<typeof initialLive>(
        (
          await built.app.inject({
            method: "GET",
            url: "/api/kpis/live?branch=BR-001",
            headers: hMgr,
          })
        ).payload,
      );
      expect(staleView.meta.todayBahrain).toBe("2026-11-27");
      expect(staleView.meta.staleDataDays).toBeGreaterThan(1);

      // Posting sales entry for 2026-11-27 advances asOfDataDate -> staleDataDays drops to 0 and dataVersion bumps
      const salesRes = await built.app.inject({
        method: "POST",
        url: "/api/sales-entries",
        headers: { ...hMgr, "content-type": "application/json" },
        payload: JSON.stringify({
          branchId: "BR-001",
          sku: built.services.runtime.data.products[0]!.sku,
          date: "2026-11-27",
          unitsSold: 6,
          onHand: 18,
        }),
      });
      expect(salesRes.statusCode).toBe(201);

      const freshView = json<typeof initialLive>(
        (
          await built.app.inject({
            method: "GET",
            url: "/api/kpis/live?branch=BR-001",
            headers: hMgr,
          })
        ).payload,
      );
      expect(freshView.meta.asOfDataDate).toBe("2026-11-27");
      expect(freshView.meta.staleDataDays).toBe(0);
      expect(freshView.meta.dataVersion).toBeGreaterThan(initialLive.meta.dataVersion);

      // Resolving a stock alert bumps decisionVersion too
      const createdAlert = json<{ id: string }>(
        (
          await built.app.inject({
            method: "POST",
            url: "/api/stock-alerts",
            headers: { ...hStaff, "content-type": "application/json" },
            payload: JSON.stringify({
              branchId: "BR-001",
              sku: built.services.runtime.data.products[0]!.sku,
              category: "CRITICAL_LOW",
              reportedQty: 2,
              note: "Low shelf count",
            }),
          })
        ).payload,
      );
      expect(
        (
          await built.app.inject({
            method: "POST",
            url: `/api/stock-alerts/${createdAlert.id}/resolve`,
            headers: { ...hMgr, "content-type": "application/json" },
            payload: JSON.stringify({ action: "ACKNOWLEDGED", comment: "Checked shelf" }),
          })
        ).statusCode,
      ).toBe(200);

      const afterAlert = json<typeof initialLive>(
        (
          await built.app.inject({
            method: "GET",
            url: "/api/kpis/live?branch=BR-001",
            headers: hMgr,
          })
        ).payload,
      );
      expect(afterAlert.meta.decisionVersion).toBeGreaterThan(freshView.meta.decisionVersion);
    });
  },
);

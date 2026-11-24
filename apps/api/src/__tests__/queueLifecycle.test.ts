import { afterEach, describe, expect, it } from "vitest";
import { clearMemorySalesEntries } from "../db.js";
import type { StockRepository } from "../repositories/types.js";
import { buildTestApp, createDualRepo, createUser, type RepoKind } from "../test/dualRepo.js";
import { bearer, json, tokenFor } from "../test/helpers.js";

const DAY_MS = 86_400_000;

describe.each<RepoKind>(["memory", "mongo-memory"])(
  "Workstream 2: Action queue lifecycle [%s]",
  (kind) => {
    const cleanups: Array<() => Promise<void>> = [];

    afterEach(async () => {
      clearMemorySalesEntries();
      while (cleanups.length > 0) {
        const fn = cleanups.pop();
        if (fn) await fn();
      }
    });

    async function setupFresh(hourOffset = 0) {
      const setup = await createDualRepo(kind);
      cleanups.push(setup.cleanup);
      const repo: StockRepository = setup.repo;
      const admin = (await createUser(repo, "admin", [], { name: "Admin Queue" })).user;
      const built = await buildTestApp(repo);
      let clock = Date.UTC(2026, 10, 24, 9 + hourOffset, 0, 0);
      built.services.setClock(() => clock);
      built.services.setLifecycleConfig({
        approvedActiveDays: 3,
        rejectSnoozeDays: 3,
        reopenWindowHours: 24,
      });
      return {
        repo,
        admin,
        headers: bearer(tokenFor(built.app, admin)),
        app: built.app,
        services: built.services,
        advanceMs: (ms: number) => {
          clock += ms;
        },
      };
    }

    it("tracks legacy approve 3-day active window, active order until RECEIVED, and view totals", async () => {
      const ctx = await setupFresh();

      const pendingRes = await ctx.app.inject({
        method: "GET",
        url: "/api/recommendations?view=pending",
        headers: ctx.headers,
      });
      expect(pendingRes.statusCode).toBe(200);
      const pendingBody = json<{
        recommendations: Array<{ id: string; action: string; netBenefit: number }>;
        total: number;
        totalNetBenefit: number;
        view: string;
      }>(pendingRes.payload);
      expect(pendingBody.total).toBeGreaterThan(2);

      const expectedPendingTotal =
        Math.round(pendingBody.recommendations.reduce((s, r) => s + r.netBenefit, 0) * 100) / 100;
      expect(pendingBody.totalNetBenefit).toBeCloseTo(expectedPendingTotal, 2);

      // Pick first two recommendations: one for legacy approve (3-day rule), one for workflow order (RECEIVED rule)
      const recA = pendingBody.recommendations[0]!;
      const recB =
        pendingBody.recommendations.find((r) => r.id !== recA.id && r.action === "REORDER") ??
        pendingBody.recommendations[1]!;

      const initialDataVersion = await ctx.repo.getDataVersion();

      // Legacy approve recA -> immediately leaves Pending and enters In progress
      const approveRes = await ctx.app.inject({
        method: "POST",
        url: `/api/recommendations/${recA.id}/approve`,
        headers: ctx.headers,
      });
      expect(approveRes.statusCode).toBe(200);
      expect(await ctx.repo.getDataVersion()).toBe(initialDataVersion);

      const pendingAfterA = json<{ recommendations: Array<{ id: string }>; total: number; totalNetBenefit: number }>(
        (
          await ctx.app.inject({
            method: "GET",
            url: "/api/recommendations?view=pending",
            headers: ctx.headers,
          })
        ).payload,
      );
      expect(pendingAfterA.recommendations.some((r) => r.id === recA.id)).toBe(false);
      expect(pendingAfterA.total).toBe(pendingBody.total - 1);
      expect(pendingAfterA.totalNetBenefit).toBeCloseTo(
        pendingBody.totalNetBenefit - recA.netBenefit,
        2,
      );

      // Workflow commit recB -> enters In progress
      const commitBRes = await ctx.app.inject({
        method: "POST",
        url: `/api/orders/${recB.id}/commit`,
        headers: { ...ctx.headers, "content-type": "application/json" },
        payload: JSON.stringify({ comment: "Confirmed PO" }),
      });
      expect(commitBRes.statusCode).toBe(200);

      // Check In progress via orders?view=in_progress: only recB (recA has legacy action + may be migrated on ensureOrdersSynced)
      // First check /api/recommendations?view=in_progress before migration
      const inProgBeforeAdvance = json<{
        recommendations: Array<{ id: string }>;
        total: number;
        totalNetBenefit: number;
      }>(
        (
          await ctx.app.inject({
            method: "GET",
            url: "/api/orders?queue=suggested&view=in_progress",
            headers: ctx.headers,
          })
        ).payload.replace(/"orders":/, '"recommendations":'),
      );
      expect(inProgBeforeAdvance.recommendations.some((r) => r.id === recA.id)).toBe(true);
      expect(inProgBeforeAdvance.recommendations.some((r) => r.id === recB.id)).toBe(true);

      // Advance clock past APPROVED_ACTIVE_DAYS (3 days + 1 hour)
      ctx.advanceMs(3 * DAY_MS + 3_600_000);

      const inProgAfter3d = json<{
        orders: Array<{ id: string }>;
        total: number;
        totalNetBenefit: number;
      }>(
        (
          await ctx.app.inject({
            method: "GET",
            url: "/api/orders?queue=suggested&view=in_progress",
            headers: ctx.headers,
          })
        ).payload,
      );
      // Migrated legacy recA moves to Decided after 3 days, while workflow order recB stays In progress until RECEIVED
      expect(inProgAfter3d.orders.some((o) => o.id === recA.id)).toBe(false);
      expect(inProgAfter3d.orders.some((o) => o.id === recB.id)).toBe(true);
      expect(inProgAfter3d.totalNetBenefit).toBeCloseTo(recB.netBenefit, 2);

      const decidedAfter3d = json<{ orders: Array<{ id: string }> }>(
        (
          await ctx.app.inject({
            method: "GET",
            url: "/api/orders?queue=suggested&view=decided",
            headers: ctx.headers,
          })
        ).payload,
      );
      expect(decidedAfter3d.orders.some((o) => o.id === recA.id)).toBe(true);

      // Receive recB -> moves to Decided immediately
      const receiveRes = await ctx.app.inject({
        method: "POST",
        url: `/api/orders/${recB.id}/receive`,
        headers: { ...ctx.headers, "content-type": "application/json" },
        payload: JSON.stringify({ comment: "Stock received on dock" }),
      });
      expect(receiveRes.statusCode).toBe(200);

      const decidedAfterReceive = json<{ orders: Array<{ id: string; status: string; canReopen?: boolean }> }>(
        (
          await ctx.app.inject({
            method: "GET",
            url: "/api/orders?queue=suggested&view=decided",
            headers: ctx.headers,
          })
        ).payload,
      );
      const receivedRow = decidedAfterReceive.orders.find((o) => o.id === recB.id);
      expect(receivedRow?.status).toBe("RECEIVED");
      expect(receivedRow?.canReopen).toBe(false);
    });

    it("handles reject snooze expiry, vanished engine items, and >=50% worsened early re-open", async () => {
      const ctx = await setupFresh();

      const pendingInit = json<{
        recommendations: Array<{
          id: string;
          netBenefit: number;
          metrics: { coverDays: number | null };
        }>;
      }>(
        (
          await ctx.app.inject({
            method: "GET",
            url: "/api/recommendations?view=pending",
            headers: ctx.headers,
          })
        ).payload,
      );
      const recSnooze = pendingInit.recommendations[0]!;
      const recWorsen = pendingInit.recommendations[1]!;

      // Reject recSnooze with reason
      const rej1 = await ctx.app.inject({
        method: "POST",
        url: `/api/recommendations/${recSnooze.id}/reject`,
        headers: { ...ctx.headers, "content-type": "application/json" },
        payload: JSON.stringify({ reasonCode: "SHELF_SPACE", comment: "Backroom full today" }),
      });
      expect(rej1.statusCode).toBe(200);

      // Reject recWorsen via order decline
      const dec2 = await ctx.app.inject({
        method: "POST",
        url: `/api/orders/${recWorsen.id}/decline`,
        headers: { ...ctx.headers, "content-type": "application/json" },
        payload: JSON.stringify({ comment: "Supplier holiday" }),
      });
      expect(dec2.statusCode).toBe(200);

      // Immediately after: both are in Decided, neither is in Pending
      const decidedNow = json<{ orders: Array<{ id: string; rejectedUntil: string | null }> }>(
        (
          await ctx.app.inject({
            method: "GET",
            url: "/api/orders?queue=suggested&view=decided",
            headers: ctx.headers,
          })
        ).payload,
      );
      expect(decidedNow.orders.some((o) => o.id === recSnooze.id)).toBe(true);
      expect(decidedNow.orders.some((o) => o.id === recWorsen.id)).toBe(true);
      expect(decidedNow.orders.find((o) => o.id === recSnooze.id)?.rejectedUntil).toBeTruthy();

      // Advance 1 day (< 3d snooze) and simulate netBenefit rising >= 50% on recWorsen -> early re-open
      ctx.advanceMs(1 * DAY_MS);
      const targetRec = ctx.services.runtime.analysis.recommendations.find(
        (r) => r.id === recWorsen.id,
      )!;
      targetRec.netBenefit = Math.round(recWorsen.netBenefit * 1.6 * 100) / 100;

      const pendingDay1 = json<{
        orders: Array<{ id: string; reopenBadge: { kind: string; label: string } | null }>;
      }>(
        (
          await ctx.app.inject({
            method: "GET",
            url: "/api/orders?queue=suggested&view=pending",
            headers: ctx.headers,
          })
        ).payload,
      );
      expect(pendingDay1.orders.some((o) => o.id === recSnooze.id)).toBe(false);
      const worsenedRow = pendingDay1.orders.find((o) => o.id === recWorsen.id);
      expect(worsenedRow?.reopenBadge?.label).toBe("Situation worsened");

      // Advance another 3 days (total 4d > 3d snooze) -> recSnooze re-enters Pending with "Rejected 4 days ago"
      ctx.advanceMs(3 * DAY_MS);
      const pendingDay4 = json<{
        orders: Array<{ id: string; reopenBadge: { kind: string; daysAgo?: number; label: string } | null }>;
      }>(
        (
          await ctx.app.inject({
            method: "GET",
            url: "/api/orders?queue=suggested&view=pending",
            headers: ctx.headers,
          })
        ).payload,
      );
      const resurfaced = pendingDay4.orders.find((o) => o.id === recSnooze.id);
      expect(resurfaced?.reopenBadge?.kind).toBe("snooze_expired");
      expect(resurfaced?.reopenBadge?.label).toBe("Rejected 4 days ago: Backroom full today");

      // Can re-approve resurfaced order via /orders/:id/commit (note if transfer cross-cluster, admin commits)
      const recommitRes = await ctx.app.inject({
        method: "POST",
        url: `/api/orders/${recSnooze.id}/commit`,
        headers: { ...ctx.headers, "content-type": "application/json" },
        payload: JSON.stringify({ force: true, comment: "Re-approved after snooze" }),
      });
      expect(recommitRes.statusCode).toBe(200);

      // Verify vanished engine recommendation stays in Decided even after snooze expiry
      // Use a fresh rejected recC and remove it from analysis recommendations
      const recVanish = pendingInit.recommendations[2]!;
      await ctx.app.inject({
        method: "POST",
        url: `/api/recommendations/${recVanish.id}/reject`,
        headers: { ...ctx.headers, "content-type": "application/json" },
        payload: JSON.stringify({ comment: "No longer needed" }),
      });
      ctx.advanceMs(4 * DAY_MS);
      ctx.services.runtime.analysis.recommendations =
        ctx.services.runtime.analysis.recommendations.filter((r) => r.id !== recVanish.id);

      const pendingAfterVanish = json<{ orders: Array<{ id: string }> }>(
        (
          await ctx.app.inject({
            method: "GET",
            url: "/api/orders?queue=suggested&view=pending",
            headers: ctx.headers,
          })
        ).payload,
      );
      expect(pendingAfterVanish.orders.some((o) => o.id === recVanish.id)).toBe(false);

      const decidedAfterVanish = json<{ orders: Array<{ id: string }> }>(
        (
          await ctx.app.inject({
            method: "GET",
            url: "/api/orders?queue=suggested&view=decided",
            headers: ctx.headers,
          })
        ).payload,
      );
      expect(decidedAfterVanish.orders.some((o) => o.id === recVanish.id)).toBe(true);
    });

    it("supports reopen within 24h (writes REOPENED audit, preserves history, reverts deltas) and rejects >24h with 409", async () => {
      const ctx = await setupFresh();

      const pending = json<{
        recommendations: Array<{ id: string; action: string }>;
      }>(
        (
          await ctx.app.inject({
            method: "GET",
            url: "/api/recommendations?view=pending",
            headers: ctx.headers,
          })
        ).payload,
      );
      const transferRec =
        pending.recommendations.find((r) => r.action === "TRANSFER") ?? pending.recommendations[0]!;
      const secondRec = pending.recommendations.find((r) => r.id !== transferRec.id)!;

      const startDataVer = await ctx.repo.getDataVersion();

      // Approve transferRec -> reserves donor / adds inTransit
      expect(
        (
          await ctx.app.inject({
            method: "POST",
            url: `/api/orders/${transferRec.id}/commit`,
            headers: { ...ctx.headers, "content-type": "application/json" },
            payload: JSON.stringify({ force: true, comment: "Commit before reopen test" }),
          })
        ).statusCode,
      ).toBe(200);
      expect(ctx.services.runtime.committedRecommendationIds.has(transferRec.id)).toBe(true);

      // Reopen 2 hours later -> succeeds
      ctx.advanceMs(2 * 3_600_000);
      const reopenRes = await ctx.app.inject({
        method: "POST",
        url: `/api/orders/${transferRec.id}/reopen`,
        headers: { ...ctx.headers, "content-type": "application/json" },
        payload: JSON.stringify({ comment: "Entered wrong quantity" }),
      });
      expect(reopenRes.statusCode).toBe(200);
      expect(ctx.services.runtime.committedRecommendationIds.has(transferRec.id)).toBe(false);
      expect(await ctx.repo.getDataVersion()).toBe(startDataVer);

      // Reopened item is back in Pending
      const pendingAgain = json<{ orders: Array<{ id: string }> }>(
        (
          await ctx.app.inject({
            method: "GET",
            url: "/api/orders?queue=suggested&view=pending",
            headers: ctx.headers,
          })
        ).payload,
      );
      expect(pendingAgain.orders.some((o) => o.id === transferRec.id)).toBe(true);

      // Audit contains REOPENED entry and OrderEvents keep history (none deleted)
      const audits = json<{ entries: Array<{ recommendationId: string; decision: string }> }>(
        (await ctx.app.inject({ method: "GET", url: "/api/audit", headers: ctx.headers })).payload,
      );
      expect(
        audits.entries.some(
          (e) => e.recommendationId === transferRec.id && e.decision === "REOPENED",
        ),
      ).toBe(true);

      const events = await ctx.repo.listOrderEvents(transferRec.id);
      expect(events.some((e) => e.action === "COMMIT")).toBe(true);
      expect(events.some((e) => e.dispositionCode === "REOPENED")).toBe(true);

      // Decide secondRec and advance >24 hours -> reopen fails with 409
      expect(
        (
          await ctx.app.inject({
            method: "POST",
            url: `/api/recommendations/${secondRec.id}/approve`,
            headers: ctx.headers,
          })
        ).statusCode,
      ).toBe(200);

      ctx.advanceMs(25 * 3_600_000);
      const lateReopen = await ctx.app.inject({
        method: "POST",
        url: `/api/recommendations/${secondRec.id}/reopen`,
        headers: { ...ctx.headers, "content-type": "application/json" },
        payload: JSON.stringify({}),
      });
      expect(lateReopen.statusCode).toBe(409);
    });
  },
);

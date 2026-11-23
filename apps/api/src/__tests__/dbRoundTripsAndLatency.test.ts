import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as core from "@stockflow/core";
import type { Dataset, Recommendation, User } from "@stockflow/core";
import type { InMemoryRepository } from "../repositories/memory.js";
import { AuditModel } from "../repositories/models.js";
import type { StockRepository } from "../repositories/types.js";
import { buildTestApp, createDualRepo, createUser, smallSeededDataset, type RepoKind } from "../test/dualRepo.js";
import { bearer, tokenFor } from "../test/helpers.js";

function datasetWith60Recs(): Dataset {
  const base = smallSeededDataset();
  const products = [...base.products];
  const sales = [...base.sales];
  const onHand = [...base.onHand];

  for (let i = 4; i <= 180; i += 1) {
    const templateIdx = (i - 1) % 3;
    const templateProduct = base.products[templateIdx]!;
    products.push({
      ...templateProduct,
      sku: `SKU-${90000 + i}`,
      name: `${templateProduct.name} #${i}`,
    });
    sales.push(base.sales[templateIdx]!);
    onHand.push(base.onHand[templateIdx]!);
  }

  return {
    ...base,
    products,
    sales,
    onHand,
    demand: sales,
  };
}

const TRACKED_OPS = [
  "getDataVersion",
  "bumpDataVersion",
  "loadCachedPlan",
  "saveCachedPlan",
  "loadDataset",
  "listActions",
  "saveAction",
  "saveActions",
  "listAudit",
  "saveAudit",
  "saveAudits",
  "saveDecisionBatch",
] as const;

type TrackedOp = (typeof TRACKED_OPS)[number];

function instrumentRepo(repo: StockRepository) {
  const counts: Record<TrackedOp, number> = {
    getDataVersion: 0,
    bumpDataVersion: 0,
    loadCachedPlan: 0,
    saveCachedPlan: 0,
    loadDataset: 0,
    listActions: 0,
    saveAction: 0,
    saveActions: 0,
    listAudit: 0,
    saveAudit: 0,
    saveAudits: 0,
    saveDecisionBatch: 0,
  };

  const originals = new Map<TrackedOp, (...args: unknown[]) => unknown>();
  const mutableRepo = repo as unknown as Record<TrackedOp, (...args: unknown[]) => unknown>;

  for (const op of TRACKED_OPS) {
    const orig = mutableRepo[op].bind(repo);
    originals.set(op, orig);
    mutableRepo[op] = (...args: unknown[]) => {
      counts[op] += 1;
      return orig(...args);
    };
  }

  const reset = () => {
    for (const op of TRACKED_OPS) counts[op] = 0;
  };

  const total = () =>
    TRACKED_OPS.reduce(
      (sum, op) => sum + (op === "saveDecisionBatch" ? counts[op] * 2 : counts[op]),
      0,
    );
  const snapshot = () => ({ ...counts, total: total() });
  const restore = () => {
    for (const op of TRACKED_OPS) {
      const orig = originals.get(op);
      if (orig) mutableRepo[op] = orig;
    }
  };

  return { reset, total, snapshot, restore };
}

describe.each<RepoKind>(["memory", "mongo-memory"])("DB Round-trips, Decision Overlay & Latency (%s)", (kind) => {
  let repo: StockRepository;
  let cleanup: () => Promise<void>;
  let adminUser: User;

  beforeAll(async () => {
    const setup = await createDualRepo(kind, datasetWith60Recs());
    repo = setup.repo;
    cleanup = setup.cleanup;
    adminUser = (await createUser(repo, "admin", [], { email: `roundtrip.admin.${kind}@stockflow.test` })).user;
  }, 120_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("keeps warm reads <= 3 DB ops, avoids dataVersion bumps on decisions, and meets latency targets", async () => {
    const instA = await buildTestApp(repo);
    const instB = await buildTestApp(repo);
    const meter = instrumentRepo(repo);

    try {
      const headersA = bearer(tokenFor(instA.app, adminUser));
      const headersB = bearer(tokenFor(instB.app, adminUser));

      // Warm both instances once
      const warmRes = await instA.app.inject({ method: "GET", url: "/api/recommendations", headers: headersA });
      expect(warmRes.statusCode).toBe(200);
      await instB.app.inject({ method: "GET", url: "/api/recommendations", headers: headersB });

      const { recommendations } = JSON.parse(warmRes.body) as { recommendations: Recommendation[] };
      expect(recommendations.length).toBeGreaterThan(55);
      const branchId = recommendations[0]!.branchId;

      // 1. Warm read DB-op counts
      const readTargets = [
        { name: "GET /api/recommendations", url: "/api/recommendations" },
        { name: "GET /api/kpis", url: "/api/kpis" },
        { name: "GET /api/locations", url: "/api/locations" },
        { name: `GET /api/locations/${branchId}/summary`, url: `/api/locations/${branchId}/summary` },
        { name: `GET /api/branches/${branchId}`, url: `/api/branches/${branchId}` },
      ];

      const opReport: Record<string, ReturnType<typeof meter.snapshot>> = {};
      for (const target of readTargets) {
        meter.reset();
        const res = await instA.app.inject({ method: "GET", url: target.url, headers: headersA });
        expect(res.statusCode).toBe(200);
        const snap = meter.snapshot();
        opReport[target.name] = snap;
        expect(snap.total).toBeLessThanOrEqual(3);
      }

      // 2. Single approve: does not bump dataVersion, <= 3 DB ops, no analyze()
      const analyzeSpy = vi.spyOn(core, "analyze");
      const vBefore = await repo.getDataVersion();
      const singleRec = recommendations[0]!;

      meter.reset();
      const tSingleStart = performance.now();
      const singleApproveRes = await instA.app.inject({
        method: "POST",
        url: `/api/recommendations/${singleRec.id}/approve`,
        headers: headersA,
      });
      const singleApproveMs = performance.now() - tSingleStart;
      expect(singleApproveRes.statusCode).toBe(200);
      const singleSnap = meter.snapshot();
      opReport["POST /api/recommendations/:id/approve (single)"] = singleSnap;

      expect(singleSnap.total).toBeLessThanOrEqual(3);
      expect(singleSnap.bumpDataVersion).toBe(0);
      expect(singleSnap.saveCachedPlan).toBe(0);
      expect(analyzeSpy).not.toHaveBeenCalled();
      expect(await repo.getDataVersion()).toBe(vBefore);

      // First queue read on Instance B after single approve
      meter.reset();
      const tQueueAfterSingleStart = performance.now();
      const queueAfterSingleRes = await instB.app.inject({
        method: "GET",
        url: "/api/recommendations",
        headers: headersB,
      });
      const queueAfterSingleMs = performance.now() - tQueueAfterSingleStart;
      expect(queueAfterSingleRes.statusCode).toBe(200);
      const queueAfterSingleBody = JSON.parse(queueAfterSingleRes.body) as { recommendations: Recommendation[] };
      expect(queueAfterSingleBody.recommendations.find((r) => r.id === singleRec.id)?.status).toBe("APPROVED");

      // 3. Bulk approve of 50 via POST /api/recommendations/batch/decide (<= 3 DB ops)
      const bulkTargets = recommendations.slice(1, 51);
      expect(bulkTargets).toHaveLength(50);

      meter.reset();
      const tBulkStart = performance.now();
      const bulkRes = await instA.app.inject({
        method: "POST",
        url: "/api/recommendations/batch/decide",
        headers: headersA,
        payload: {
          ids: bulkTargets.map((r) => r.id),
          decision: "approve",
        },
      });
      const bulkApproveMs = performance.now() - tBulkStart;
      expect(bulkRes.statusCode).toBe(200);
      const bulkBody = JSON.parse(bulkRes.body) as {
        results: Array<{ id: string; status: string }>;
      };
      expect(bulkBody.results).toHaveLength(50);
      expect(bulkBody.results.every((r) => r.status === "ok")).toBe(true);

      const bulkSnap = meter.snapshot();
      opReport["POST /api/recommendations/batch/decide (50)"] = bulkSnap;

      expect(bulkSnap.total).toBeLessThanOrEqual(3);
      expect(bulkSnap.bumpDataVersion).toBe(0);
      expect(bulkSnap.saveCachedPlan).toBe(0);
      expect(analyzeSpy).not.toHaveBeenCalled();
      expect(await repo.getDataVersion()).toBe(vBefore);

      // Repeat the same batch -> idempotent ("already_decided", 0 writes)
      meter.reset();
      const repeatRes = await instA.app.inject({
        method: "POST",
        url: "/api/recommendations/batch/decide",
        headers: headersA,
        payload: {
          ids: bulkTargets.map((r) => r.id),
          decision: "approve",
        },
      });
      expect(repeatRes.statusCode).toBe(200);
      const repeatBody = JSON.parse(repeatRes.body) as {
        results: Array<{ id: string; status: string }>;
      };
      expect(repeatBody.results.every((r) => r.status === "already_decided")).toBe(true);
      const repeatSnap = meter.snapshot();
      expect(repeatSnap.saveActions).toBe(0);
      expect(repeatSnap.saveAudits).toBe(0);
      expect(await repo.getDataVersion()).toBe(vBefore);

      // First queue read on Instance B after bulk approve
      meter.reset();
      const tQueueAfterBulkStart = performance.now();
      const queueAfterBulkRes = await instB.app.inject({
        method: "GET",
        url: "/api/recommendations",
        headers: headersB,
      });
      const queueAfterBulkMs = performance.now() - tQueueAfterBulkStart;
      expect(queueAfterBulkRes.statusCode).toBe(200);
      const queueAfterBulkBody = JSON.parse(queueAfterBulkRes.body) as { recommendations: Recommendation[] };
      for (const rec of bulkTargets) {
        expect(queueAfterBulkBody.recommendations.find((r) => r.id === rec.id)?.status).toBe("APPROVED");
      }

      // 4. Reject also does not bump dataVersion and propagates across instances
      const rejectTarget = recommendations[51]!;
      const rejectRes = await instA.app.inject({
        method: "POST",
        url: `/api/recommendations/${rejectTarget.id}/reject`,
        headers: headersA,
      });
      expect(rejectRes.statusCode).toBe(200);
      expect(await repo.getDataVersion()).toBe(vBefore);
      const afterRejectB = JSON.parse(
        (await instB.app.inject({ method: "GET", url: "/api/recommendations", headers: headersB })).body,
      ) as { recommendations: Recommendation[] };
      expect(afterRejectB.recommendations.find((r) => r.id === rejectTarget.id)?.status).toBe("REJECTED");

      // 5. Sales entry STILL bumps dataVersion and invalidates the plan on Instance B
      const entryRes = await instA.app.inject({
        method: "POST",
        url: "/api/sales-entries",
        headers: headersA,
        payload: {
          branchId: "BR-009",
          sku: "SKU-90002",
          date: "2026-11-12",
          unitsSold: 12,
          onHand: 0,
        },
      });
      expect(entryRes.statusCode).toBe(201);
      expect(await repo.getDataVersion()).toBe(vBefore + 1);

      const afterEntryB = JSON.parse(
        (await instB.app.inject({ method: "GET", url: "/api/recommendations", headers: headersB })).body,
      ) as { recommendations: Recommendation[] };
      expect(afterEntryB.recommendations.some((r) => r.sku === "SKU-90002" && r.branchId === "BR-009")).toBe(true);

      if (kind === "memory") {
        expect(singleApproveMs).toBeLessThan(300);
        expect(queueAfterSingleMs).toBeLessThan(300);
        expect(bulkApproveMs).toBeLessThan(300);
        expect(queueAfterBulkMs).toBeLessThan(300);
      }

      console.info(
        `[roundtrip:${kind}] ops=${JSON.stringify(
          Object.fromEntries(Object.entries(opReport).map(([k, v]) => [k, v.total])),
        )} | singleApprove=${singleApproveMs.toFixed(1)}ms | queueAfterSingle=${queueAfterSingleMs.toFixed(1)}ms | bulkApprove50=${bulkApproveMs.toFixed(1)}ms | queueAfterBulk=${queueAfterBulkMs.toFixed(1)}ms`,
      );

      analyzeSpy.mockRestore();
    } finally {
      meter.restore();
      await instA.app.close();
      await instB.app.close();
    }
  });

  it("handles mixed valid, out-of-scope, unknown, and already-decided ids without failing the batch", async () => {
    const managerUser = (
      await createUser(repo, "manager", ["BR-005"], { email: `batch.mgr.${kind}@stockflow.test` })
    ).user;
    const staffUser = (
      await createUser(repo, "staff", ["BR-005"], { email: `batch.staff.${kind}@stockflow.test` })
    ).user;

    const { app } = await buildTestApp(repo);
    try {
      const adminHeaders = bearer(tokenFor(app, adminUser));
      const mgrHeaders = bearer(tokenFor(app, managerUser));
      const staffHeaders = bearer(tokenFor(app, staffUser));

      const recRes = await app.inject({ method: "GET", url: "/api/recommendations", headers: adminHeaders });
      expect(recRes.statusCode).toBe(200);
      const { recommendations } = JSON.parse(recRes.body) as { recommendations: Recommendation[] };

      const inScopeList = recommendations.filter(
        (r) => r.status === "PENDING" && (r.branchId === "BR-005" || r.donorBranchId === "BR-005"),
      );
      expect(inScopeList.length).toBeGreaterThanOrEqual(2);
      const alreadyDecided = inScopeList[0]!;
      const inScopePending = inScopeList[1]!;
      const outOfScopePending = recommendations.find(
        (r) => r.status === "PENDING" && r.branchId !== "BR-005" && r.donorBranchId !== "BR-005",
      );
      expect(outOfScopePending).toBeDefined();

      // Pre-decide one in-scope item so the mixed batch sees "already_decided"
      const preDecideRes = await app.inject({
        method: "POST",
        url: `/api/recommendations/${alreadyDecided.id}/approve`,
        headers: adminHeaders,
      });
      expect(preDecideRes.statusCode).toBe(200);

      // Staff is forbidden from batch decide
      const staffRes = await app.inject({
        method: "POST",
        url: "/api/recommendations/batch/decide",
        headers: staffHeaders,
        payload: { ids: [inScopePending!.id], decision: "reject" },
      });
      expect(staffRes.statusCode).toBe(403);

      // Validation: > 200 ids rejected with 400
      const tooManyRes = await app.inject({
        method: "POST",
        url: "/api/recommendations/batch/decide",
        headers: adminHeaders,
        payload: {
          ids: Array.from({ length: 201 }, (_, idx) => `rec-${idx}`),
          decision: "approve",
        },
      });
      expect(tooManyRes.statusCode).toBe(400);

      const vBefore = await repo.getDataVersion();
      const mixedRes = await app.inject({
        method: "POST",
        url: "/api/recommendations/batch/decide",
        headers: mgrHeaders,
        payload: {
          ids: [inScopePending!.id, outOfScopePending!.id, "unknown-rec-id", alreadyDecided!.id],
          decision: "reject",
          reasonCode: "MANUAL_REVIEW",
        },
      });
      expect(mixedRes.statusCode).toBe(200);
      const mixedBody = JSON.parse(mixedRes.body) as {
        results: Array<{ id: string; status: string }>;
      };
      expect(mixedBody.results).toEqual([
        { id: inScopePending!.id, status: "ok" },
        { id: outOfScopePending!.id, status: "forbidden" },
        { id: "unknown-rec-id", status: "not_found" },
        { id: alreadyDecided!.id, status: "already_decided" },
      ]);
      expect(await repo.getDataVersion()).toBe(vBefore);

      // Verify the in-scope item is now REJECTED and out-of-scope stayed PENDING
      const afterRes = await app.inject({ method: "GET", url: "/api/recommendations", headers: adminHeaders });
      const afterRecs = (JSON.parse(afterRes.body) as { recommendations: Recommendation[] }).recommendations;
      expect(afterRecs.find((r) => r.id === inScopePending!.id)?.status).toBe("REJECTED");
      expect(afterRecs.find((r) => r.id === outOfScopePending!.id)?.status).toBe("PENDING");

      // Reject without reasonCode -> 400; whitespace reasonCode -> 400
      const missingReasonRes = await app.inject({
        method: "POST",
        url: "/api/recommendations/batch/decide",
        headers: adminHeaders,
        payload: { ids: [outOfScopePending!.id], decision: "reject" },
      });
      expect(missingReasonRes.statusCode).toBe(400);

      const blankReasonRes = await app.inject({
        method: "POST",
        url: "/api/recommendations/batch/decide",
        headers: adminHeaders,
        payload: { ids: [outOfScopePending!.id], decision: "reject", reasonCode: "   " },
      });
      expect(blankReasonRes.statusCode).toBe(400);

      // Approve ignores reasonCode
      const approveWithReasonRes = await app.inject({
        method: "POST",
        url: "/api/recommendations/batch/decide",
        headers: adminHeaders,
        payload: { ids: [outOfScopePending!.id], decision: "approve", reasonCode: "IGNORED_CODE" },
      });
      expect(approveWithReasonRes.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("enforces uniqueness and atomicity across concurrent instances and simulated audit failures", async () => {
    const instA = await buildTestApp(repo);
    const instB = await buildTestApp(repo);
    try {
      const headersA = bearer(tokenFor(instA.app, adminUser));
      const headersB = bearer(tokenFor(instB.app, adminUser));

      const recRes = await instA.app.inject({ method: "GET", url: "/api/recommendations", headers: headersA });
      const { recommendations } = JSON.parse(recRes.body) as { recommendations: Recommendation[] };
      const pending = recommendations.filter((r) => r.status === "PENDING");
      expect(pending.length).toBeGreaterThanOrEqual(10);

      const overlapIds = pending.slice(0, 4).map((r) => r.id);
      const batchAIds = pending.slice(0, 6).map((r) => r.id);
      const batchBIds = [...overlapIds, ...pending.slice(6, 8).map((r) => r.id)];

      // 1. Two concurrent batches with overlapping IDs across Instance A and Instance B
      const [resA, resB] = await Promise.all([
        instA.app.inject({
          method: "POST",
          url: "/api/recommendations/batch/decide",
          headers: headersA,
          payload: { ids: batchAIds, decision: "approve" },
        }),
        instB.app.inject({
          method: "POST",
          url: "/api/recommendations/batch/decide",
          headers: headersB,
          payload: { ids: batchBIds, decision: "reject", reasonCode: "OVERSTOCK_COVER" },
        }),
      ]);

      expect(resA.statusCode).toBe(200);
      expect(resB.statusCode).toBe(200);

      const bodyA = JSON.parse(resA.body) as { results: Array<{ id: string; status: string }> };
      const bodyB = JSON.parse(resB.body) as { results: Array<{ id: string; status: string }> };
      const mapA = new Map(bodyA.results.map((r) => [r.id, r.status]));
      const mapB = new Map(bodyB.results.map((r) => [r.id, r.status]));

      // Each overlapping ID won on one instance ("ok") and lost on the other ("already_decided")
      for (const id of overlapIds) {
        const statuses = [mapA.get(id), mapB.get(id)].sort();
        expect(statuses).toEqual(["already_decided", "ok"]);
      }

      // Exactly one action and one audit entry per decided ID
      const allDecidedIds = new Set([...batchAIds, ...batchBIds]);
      const actions = await repo.listActions();
      const audits = await repo.listAudit();
      for (const id of allDecidedIds) {
        expect(actions.filter((a) => a.recommendationId === id)).toHaveLength(1);
        expect(audits.filter((a) => a.recommendationId === id)).toHaveLength(1);
      }

      // 2. Simulated audit-write failure leaves zero orphan actions
      const failTarget = pending[8]!;
      const actionsBeforeFail = await repo.listActions();
      const spy =
        kind === "mongo-memory"
          ? vi.spyOn(AuditModel, "insertMany").mockRejectedValueOnce(new Error("Simulated audit failure"))
          : vi.spyOn(repo as InMemoryRepository, "commitAuditEntries").mockRejectedValueOnce(new Error("Simulated audit failure"));

      const failRes = await instA.app.inject({
        method: "POST",
        url: "/api/recommendations/batch/decide",
        headers: headersA,
        payload: { ids: [failTarget.id], decision: "approve" },
      });
      spy.mockRestore();
      expect(failRes.statusCode).toBe(500);

      const actionsAfterFail = await repo.listActions();
      expect(actionsAfterFail.some((a) => a.recommendationId === failTarget.id)).toBe(false);
      expect(actionsAfterFail).toHaveLength(actionsBeforeFail.length);
    } finally {
      await instA.app.close();
      await instB.app.close();
    }
  });
});

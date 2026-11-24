import { readFileSync } from "node:fs";
import {
  analyze,
  BAHRAIN_BRANCHES,
  DEFAULT_POLICY,
  DonorCandidatesResponseSchema,
  OrderListResponseSchema,
  ReplenishmentOrderSchema,
  type Branch,
  type Dataset,
  type Product,
  type User,
} from "@stockflow/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearMemorySalesEntries } from "../db.js";
import type { StockRepository } from "../repositories/types.js";
import { buildTestApp, createDualRepo, createUser, type RepoKind } from "../test/dualRepo.js";
import { bearer, buildMultipartPayload, json, tokenFor } from "../test/helpers.js";

const DEMO_DAYS = 30;

function makeStageEDemoDataset(): Dataset {
  const branchIds = ["BR-001", "BR-005", "BR-014"] as const;
  const branches: Branch[] = branchIds.map((id) => {
    const found = BAHRAIN_BRANCHES.find((b) => b.id === id);
    if (!found) throw new Error(`Missing branch ${id} in BAHRAIN_BRANCHES`);
    return { ...found };
  });

  const products: Product[] = [
    {
      sku: "SKU-00012",
      name: "Clearwater Brewed Iced Tea, 500 ml",
      category: "Beverages",
      price: 5.0,
      cost: 3.0,
      leadTimeDays: 7,
      status: "active",
    },
  ];

  const start = Date.UTC(2026, 0, 1);
  const dates = Array.from({ length: DEMO_DAYS }, (_, i) =>
    new Date(start + i * 86_400_000).toISOString().slice(0, 10),
  );
  const zeroMatrix = () =>
    Array.from({ length: branches.length }, () => Array.from({ length: DEMO_DAYS }, () => 0));

  return {
    seed: 12,
    asOf: dates[DEMO_DAYS - 1] ?? "2026-01-30",
    dates,
    branches,
    products,
    sales: [zeroMatrix()],
    onHand: [zeroMatrix()],
    demand: [zeroMatrix()],
  };
}

describe.each<RepoKind>(["memory", "mongo-memory"])(
  "Stage E: SKU-00012 demo pipeline & donor surplus exhaustion [%s]",
  (kind) => {
    let repo: StockRepository;
    let cleanup: () => Promise<void>;
    let adminUser: User;
    let mgrManama: User;
    let staffManama: User;
    let mgrHidd: User;

    beforeAll(async () => {
      const setup = await createDualRepo(kind, makeStageEDemoDataset());
      repo = setup.repo;
      cleanup = setup.cleanup;
      adminUser = (
        await createUser(repo, "admin", [], { email: `stagee.admin.${kind}@stockflow.test` })
      ).user;
      mgrManama = (
        await createUser(repo, "manager", ["BR-001"], {
          email: `stagee.manama.${kind}@stockflow.test`,
        })
      ).user;
      staffManama = (
        await createUser(repo, "staff", ["BR-001"], {
          email: `stagee.stf.manama.${kind}@stockflow.test`,
        })
      ).user;
      mgrHidd = (
        await createUser(repo, "manager", ["BR-005"], {
          email: `stagee.hidd.${kind}@stockflow.test`,
        })
      ).user;
    }, 120_000);

    beforeEach(() => {
      clearMemorySalesEntries();
    });

    afterAll(async () => {
      clearMemorySalesEntries();
      await cleanup?.();
    });

    it("imports sales_demo_SKU-00012.csv, emits 15-unit transfer & 35-unit reorder, walks SUGGESTED -> AWAITING_DONOR -> COMMITTED -> RECEIVED, and returns 409 when BR-005 surplus is exhausted", async () => {
      const { app, services } = await buildTestApp(repo);
      try {
        const hAdmin = bearer(tokenFor(app, adminUser));
        const hManama = bearer(tokenFor(app, mgrManama));
        const hStaffManama = bearer(tokenFor(app, staffManama));
        const hHidd = bearer(tokenFor(app, mgrHidd));

        // 1. Load sales_demo_SKU-00012.csv via the CSV import endpoint.
        const csvText = readFileSync(
          new URL("../__fixtures__/sales_demo_SKU-00012.csv", import.meta.url),
          "utf8",
        );
        const { payload, contentType } = buildMultipartPayload(
          "file",
          "sales_demo_SKU-00012.csv",
          csvText,
        );
        const importRes = await app.inject({
          method: "POST",
          url: "/api/sales-entries/import",
          headers: { ...hAdmin, "content-type": contentType },
          payload,
        });
        expect(importRes.statusCode).toBe(200);
        expect(json(importRes.payload)).toEqual({ inserted: 90, updated: 0, errors: [] });

        // Confirm loaded ending on-hand balances match BR-001=20, BR-005=120, BR-014=90.
        const lastDayIdx = DEMO_DAYS - 1;
        expect(services.runtime.data.onHand[0]?.[0]?.[lastDayIdx]).toBe(20);
        expect(services.runtime.data.onHand[0]?.[1]?.[lastDayIdx]).toBe(120);
        expect(services.runtime.data.onHand[0]?.[2]?.[lastDayIdx]).toBe(90);

        // 2. Assert engine emits a 15-unit transfer BR-005 -> BR-001 and a 35-unit reorder for BR-001.
        const freshAnalysis = analyze(services.runtime.data, DEFAULT_POLICY);
        for (const recs of [services.runtime.analysis.recommendations, freshAnalysis.recommendations]) {
          const transferRec = recs.find(
            (r) =>
              r.sku === "SKU-00012" &&
              r.action === "TRANSFER" &&
              r.branchId === "BR-001" &&
              r.donorBranchId === "BR-005",
          );
          expect(transferRec).toBeDefined();
          expect(transferRec?.quantity).toBe(15);
          expect(transferRec?.netBenefit).toBeGreaterThanOrEqual(9.5);

          const reorderRec = recs.find(
            (r) => r.sku === "SKU-00012" && r.action === "REORDER" && r.branchId === "BR-001",
          );
          expect(reorderRec).toBeDefined();
          expect(reorderRec?.quantity).toBe(35);

          expect(
            recs.some((r) => r.sku === "SKU-00012" && r.action === "TRANSFER" && r.donorBranchId === "BR-014"),
          ).toBe(false);
        }

        const versionAfterImport = await repo.getDataVersion();

        // 3a. SUGGESTED (virtual, zero committedDeltas)
        const suggestedRes = await app.inject({
          method: "GET",
          url: "/api/orders?queue=suggested",
          headers: hManama,
        });
        expect(suggestedRes.statusCode).toBe(200);
        const suggestedList = OrderListResponseSchema.parse(json(suggestedRes.payload));
        const suggestedTransfer = suggestedList.orders.find(
          (o) =>
            o.sku === "SKU-00012" &&
            o.type === "TRANSFER" &&
            o.sourceBranchId === "BR-005" &&
            o.targetBranchId === "BR-001",
        );
        if (!suggestedTransfer) {
          throw new Error("Expected virtual 15-unit BR-005 -> BR-001 transfer in suggested queue");
        }
        expect(suggestedTransfer.status).toBe("SUGGESTED");
        expect(suggestedTransfer.isVirtual).toBe(true);
        expect(suggestedTransfer.origin).toBe("ENGINE");
        expect(suggestedTransfer.quantity).toBe(15);
        expect(services.runtime.committedDeltas.size).toBe(0);
        const originalReasonCodes = [...suggestedTransfer.engineSnapshot.reasonCodes];

        // 3b. SUGGESTED -> AWAITING_DONOR (intent state; committedDeltas & dataVersion untouched)
        const requestRes = await app.inject({
          method: "POST",
          url: `/api/orders/${suggestedTransfer.id}/request`,
          headers: hManama,
          payload: {
            dispositionCode: "STOCKOUT_IMMINENT",
            comment: "Need 15 units immediately to cover 7-day lead time",
          },
        });
        expect(requestRes.statusCode).toBe(200);
        const awaitingDonor = ReplenishmentOrderSchema.parse(json(requestRes.payload));
        expect(awaitingDonor.id).toBe(suggestedTransfer.id);
        expect(awaitingDonor.status).toBe("AWAITING_DONOR");
        expect(Boolean(awaitingDonor.isVirtual)).toBe(false);
        expect(await repo.getOrder(awaitingDonor.id)).not.toBeNull();
        expect(awaitingDonor.awaitingDonorSince).toBeTruthy();
        expect(services.runtime.committedDeltas.size).toBe(0);
        expect(await repo.getDataVersion()).toBe(versionAfterImport);

        // 3c. AWAITING_DONOR -> COMMITTED (Hidd donor sees live surplus 90 & cover 105d, releases)
        const incomingRes = await app.inject({
          method: "GET",
          url: "/api/orders?queue=incoming",
          headers: hHidd,
        });
        expect(incomingRes.statusCode).toBe(200);
        const incomingList = OrderListResponseSchema.parse(json(incomingRes.payload));
        const incomingItem = incomingList.orders.find((o) => o.id === awaitingDonor.id);
        expect(incomingItem?.donorAvailableSurplus).toBe(90);
        expect(incomingItem?.donorCoverDaysAfter).toBe(105);

        const commitRes = await app.inject({
          method: "POST",
          url: `/api/orders/${awaitingDonor.id}/commit`,
          headers: hHidd,
          payload: { comment: "Releasing 15 units from Muharraq - Hidd surplus" },
        });
        expect(commitRes.statusCode).toBe(200);
        const committedOrder = ReplenishmentOrderSchema.parse(json(commitRes.payload));
        expect(committedOrder.status).toBe("COMMITTED");
        expect(committedOrder.committedAt).toBeTruthy();
        expect(services.runtime.committedDeltas.get("SKU-00012::BR-005")).toEqual({
          reserved: 15,
          inTransit: 0,
        });
        expect(services.runtime.committedDeltas.get("SKU-00012::BR-001")).toEqual({
          reserved: 0,
          inTransit: 15,
        });
        expect(await repo.getDataVersion()).toBe(versionAfterImport);

        // 3d. COMMITTED -> RECEIVED (Manama staff confirms receipt; inTransit cleared, donor reserved kept)
        const receiveRes = await app.inject({
          method: "POST",
          url: `/api/orders/${committedOrder.id}/receive`,
          headers: hStaffManama,
          payload: { comment: "Counted 15 units on shelf at Manama CBD" },
        });
        expect(receiveRes.statusCode).toBe(200);
        const receivedOrder = ReplenishmentOrderSchema.parse(json(receiveRes.payload));
        expect(receivedOrder.status).toBe("RECEIVED");
        expect(receivedOrder.receivedAt).toBeTruthy();
        expect(services.runtime.committedDeltas.get("SKU-00012::BR-001")?.inTransit ?? 0).toBe(0);
        expect(services.runtime.committedDeltas.get("SKU-00012::BR-005")).toEqual({
          reserved: 15,
          inTransit: 0,
        });
        expect(await repo.getDataVersion()).toBe(versionAfterImport);

        const detailRes = await app.inject({
          method: "GET",
          url: `/api/orders/${receivedOrder.id}`,
          headers: hManama,
        });
        expect(detailRes.statusCode).toBe(200);
        const detailOrder = ReplenishmentOrderSchema.parse(json(detailRes.payload));
        expect(detailOrder.events.map((e) => e.action)).toEqual([
          "REQUEST_TRANSFER",
          "COMMIT",
          "RECEIVE",
        ]);
        expect(detailOrder.engineSnapshot.reasonCodes).toEqual(originalReasonCodes);

        // 4. Exhaust BR-005's remaining 75 surplus units (90 - 15 reserved = 75) and assert next request fails with 409.
        const candidatesRes = await app.inject({
          method: "GET",
          url: "/api/orders/donor-candidates?sku=SKU-00012&target=BR-001&qty=50",
          headers: hManama,
        });
        expect(candidatesRes.statusCode).toBe(200);
        const candidatesBody = DonorCandidatesResponseSchema.parse(json(candidatesRes.payload));
        const hiddCandidate = candidatesBody.candidates.find((c) => c.branchId === "BR-005");
        const hamadCandidate = candidatesBody.candidates.find((c) => c.branchId === "BR-014");
        expect(hiddCandidate?.availableSurplusUnits).toBe(75);
        expect(hamadCandidate?.availableSurplusUnits).toBe(60);

        const exhaustCreateRes = await app.inject({
          method: "POST",
          url: "/api/orders",
          headers: hManama,
          payload: {
            type: "TRANSFER",
            sku: "SKU-00012",
            targetBranchId: "BR-001",
            sourceBranchId: "BR-005",
            quantity: 75,
            comment: "Pull remaining 75 units of BR-005 surplus",
          },
        });
        expect(exhaustCreateRes.statusCode).toBe(201);
        const exhaustOrder = ReplenishmentOrderSchema.parse(json(exhaustCreateRes.payload));
        expect(exhaustOrder.status).toBe("AWAITING_DONOR");

        const exhaustCommitRes = await app.inject({
          method: "POST",
          url: `/api/orders/${exhaustOrder.id}/commit`,
          headers: hHidd,
          payload: { comment: "Releasing remaining 75 units" },
        });
        expect(exhaustCommitRes.statusCode).toBe(200);
        expect(services.runtime.committedDeltas.get("SKU-00012::BR-005")).toEqual({
          reserved: 90,
          inTransit: 0,
        });

        // Second request against BR-005 when surplus is exhausted (available = 0) -> 409 Conflict on commit.
        const secondCreateRes = await app.inject({
          method: "POST",
          url: "/api/orders",
          headers: hManama,
          payload: {
            type: "TRANSFER",
            sku: "SKU-00012",
            targetBranchId: "BR-001",
            sourceBranchId: "BR-005",
            quantity: 10,
            comment: "Second request exceeding exhausted surplus",
          },
        });
        expect(secondCreateRes.statusCode).toBe(201);
        const secondOrder = ReplenishmentOrderSchema.parse(json(secondCreateRes.payload));
        expect(secondOrder.status).toBe("AWAITING_DONOR");

        const conflictRes = await app.inject({
          method: "POST",
          url: `/api/orders/${secondOrder.id}/commit`,
          headers: hHidd,
          payload: { comment: "Attempt commit with exhausted donor stock" },
        });
        expect(conflictRes.statusCode).toBe(409);

        const adminConflictRes = await app.inject({
          method: "POST",
          url: `/api/orders/${secondOrder.id}/commit`,
          headers: hAdmin,
          payload: { force: true, comment: "Admin force attempt against exhausted donor" },
        });
        expect(adminConflictRes.statusCode).toBe(409);

        // State and reservation remain untouched after 409 Conflict.
        const unchangedRes = await app.inject({
          method: "GET",
          url: `/api/orders/${secondOrder.id}`,
          headers: hManama,
        });
        expect(unchangedRes.statusCode).toBe(200);
        expect(ReplenishmentOrderSchema.parse(json(unchangedRes.payload)).status).toBe(
          "AWAITING_DONOR",
        );
        expect(services.runtime.committedDeltas.get("SKU-00012::BR-005")).toEqual({
          reserved: 90,
          inTransit: 0,
        });
      } finally {
        await app.close();
      }
    });
  },
);

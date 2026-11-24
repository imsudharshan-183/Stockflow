import {
  BAHRAIN_BRANCHES,
  DonorCandidatesResponseSchema,
  ResolveStockAlertResponseSchema,
  StockAlertListSchema,
  StockAlertSchema,
  type Branch,
  type Dataset,
  type Product,
  type User,
} from "@stockflow/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { InMemoryRepository } from "../repositories/memory.js";
import { OrderEventModel } from "../repositories/models.js";
import type { StockRepository } from "../repositories/types.js";
import { buildTestApp, createDualRepo, createUser, type RepoKind } from "../test/dualRepo.js";
import { bearer, json, tokenFor } from "../test/helpers.js";

function makeAlertResolutionDataset(): Dataset {
  const branchIds = ["BR-001", "BR-005", "BR-008", "BR-009"] as const;
  const branches: Branch[] = branchIds.map((id) => {
    const found = BAHRAIN_BRANCHES.find((b) => b.id === id);
    if (!found) throw new Error(`Missing branch ${id}`);
    return { ...found };
  });

  const products: Product[] = [
    {
      sku: "SKU-ALT-1",
      name: "Clearwater Mineral Water, 500 ml",
      category: "Beverages",
      price: 20,
      cost: 10,
      leadTimeDays: 7,
      status: "active",
    },
    {
      sku: "SKU-ALT-2",
      name: "Brampton Olive Oil, 750 ml",
      category: "Snacks",
      price: 15,
      cost: 8,
      leadTimeDays: 7,
      status: "active",
    },
    {
      sku: "SKU-ALT-3",
      name: "Solis Oat Granola, 400 g",
      category: "Snacks",
      price: 12,
      cost: 6,
      leadTimeDays: 7,
      status: "active",
    },
  ];

  const days = 30;
  const start = Date.UTC(2026, 9, 1);
  const dates = Array.from({ length: days }, (_, i) =>
    new Date(start + i * 86_400_000).toISOString().slice(0, 10),
  );

  const buildMatrix = (sArr: number[], stArr: number[]) => ({
    sales: sArr.map((s) => Array.from({ length: days }, () => s)),
    onHand: stArr.map((st) => Array.from({ length: days }, () => st)),
    demand: sArr.map((s) => Array.from({ length: days }, () => s)),
  });

  // Order of branches: BR-001, BR-005, BR-008, BR-009
  // SKU-ALT-1: BR-001 short (5/d, 10), BR-005 overstock (2/d, 300 -> 240 surplus), BR-008 overstock (2/d, 200 -> 140 surplus), BR-009 steady (2/d, 80)
  const m1 = buildMatrix([5, 2, 2, 2], [10, 300, 200, 80]);
  // SKU-ALT-2: BR-001 healthy (5/d, 50), BR-005 overstock (2/d, 180 -> 120 surplus), BR-008 & BR-009 below 30d floor (2/d, 50 -> 0 surplus)
  const m2 = buildMatrix([5, 2, 2, 2], [50, 180, 50, 50]);
  // SKU-ALT-3: BR-001 healthy (5/d, 40 -> reorderPoint 35), shrinkage -15 drops to 25 (AT_RISK)
  const m3 = buildMatrix([5, 2, 2, 2], [40, 80, 80, 80]);

  return {
    seed: 88,
    asOf: dates[days - 1]!,
    dates,
    branches,
    products,
    sales: [m1.sales, m2.sales, m3.sales],
    onHand: [m1.onHand, m2.onHand, m3.onHand],
    demand: [m1.demand, m2.demand, m3.demand],
  };
}

describe.each<RepoKind>(["memory", "mongo-memory"])(
  "Stage C: StockAlert resolution linked to ReplenishmentOrder [%s]",
  (kind) => {
    let repo: StockRepository;
    let cleanup: () => Promise<void>;
    let adminUser: User;
    let mgrManama: User;
    let mgrRegional: User;
    let staffManama: User;
    let staffHidd: User;

    beforeAll(async () => {
      const created = await createDualRepo(kind, makeAlertResolutionDataset());
      repo = created.repo;
      cleanup = created.cleanup;
      adminUser = (await createUser(repo, "admin", [], { email: `alt.admin.${kind}@stockflow.test` })).user;
      mgrManama = (
        await createUser(repo, "manager", ["BR-001"], { email: `alt.manama.${kind}@stockflow.test` })
      ).user;
      mgrRegional = (
        await createUser(repo, "manager", ["BR-005", "BR-008"], {
          email: `alt.regional.${kind}@stockflow.test`,
        })
      ).user;
      staffManama = (
        await createUser(repo, "staff", ["BR-001"], { email: `alt.stf.manama.${kind}@stockflow.test` })
      ).user;
      staffHidd = (
        await createUser(repo, "staff", ["BR-005"], { email: `alt.stf.hidd.${kind}@stockflow.test` })
      ).user;
    }, 60_000);

    afterAll(async () => {
      await cleanup?.();
    });

    it("enforces permissions, supports CONVERTED_TO_REQUEST (unrouted and routed), and surfaces linkage to staff", async () => {
      const { app, services } = await buildTestApp(repo);
      try {
        const hAdmin = bearer(tokenFor(app, adminUser));
        const hManama = bearer(tokenFor(app, mgrManama));
        const hRegional = bearer(tokenFor(app, mgrRegional));
        const hStaffManama = bearer(tokenFor(app, staffManama));

        // 1. Staff creates alert with reportedQty
        const createRes1 = await app.inject({
          method: "POST",
          url: "/api/stock-alerts",
          headers: hStaffManama,
          payload: {
            branchId: "BR-001",
            sku: "SKU-ALT-1",
            category: "CRITICAL_LOW",
            reportedQty: 6,
            note: "Shelf nearly bare after morning rush",
          },
        });
        expect(createRes1.statusCode).toBe(201);
        const alert1 = StockAlertSchema.parse(json(createRes1.payload));
        expect(alert1.reportedQty).toBe(6);
        expect(alert1.resolution).toBeNull();

        // RBAC & 404 guards on /resolve
        expect(
          (
            await app.inject({
              method: "POST",
              url: `/api/stock-alerts/${alert1.id}/resolve`,
              headers: hStaffManama,
              payload: { action: "ACKNOWLEDGED" },
            })
          ).statusCode,
        ).toBe(403);
        expect(
          (
            await app.inject({
              method: "POST",
              url: `/api/stock-alerts/${alert1.id}/resolve`,
              headers: hRegional,
              payload: { action: "ACKNOWLEDGED" },
            })
          ).statusCode,
        ).toBe(403);
        expect(
          (
            await app.inject({
              method: "POST",
              url: "/api/stock-alerts/alt_does_not_exist/resolve",
              headers: hAdmin,
              payload: { action: "ACKNOWLEDGED" },
            })
          ).statusCode,
        ).toBe(404);

        const versionBefore = await repo.getDataVersion();

        // 2. Convert alert1 WITHOUT donor -> OPEN_REQUEST (origin ALERT_ESCALATION, linkedAlertId)
        const convertRes = await app.inject({
          method: "POST",
          url: `/api/stock-alerts/${alert1.id}/resolve`,
          headers: hManama,
          payload: {
            action: "CONVERTED_TO_REQUEST",
            quantity: 40,
            comment: "Escalated from staff shelf report for inter-branch pull",
          },
        });
        expect(convertRes.statusCode).toBe(200);
        const resolved1 = ResolveStockAlertResponseSchema.parse(json(convertRes.payload));
        expect(resolved1.alert.status).toBe("RESOLVED");
        expect(resolved1.alert.resolution?.action).toBe("CONVERTED_TO_REQUEST");
        expect(resolved1.alert.resolution?.linkedOrderId).toBe(resolved1.order?.id);
        expect(resolved1.alert.resolution?.comment).toBe(
          "Escalated from staff shelf report for inter-branch pull",
        );
        expect(resolved1.alert.linkedOrderStatus).toBe("OPEN_REQUEST");

        const order1 = resolved1.order!;
        expect(order1.origin).toBe("ALERT_ESCALATION");
        expect(order1.status).toBe("OPEN_REQUEST");
        expect(order1.linkedAlertId).toBe(alert1.id);
        expect(order1.sourceBranchId).toBeNull();
        expect(order1.quantity).toBe(40);
        expect(order1.events).toHaveLength(1);
        expect(order1.events[0]?.action).toBe("CREATED");
        expect(order1.events[0]?.dispositionCode).toBe("CRITICAL_LOW");
        expect(order1.events[0]?.comment).toBe(
          "Escalated from staff shelf report for inter-branch pull",
        );

        // Intent state must not touch committedDeltas or bump dataVersion
        expect(await repo.getDataVersion()).toBe(versionBefore);
        expect(services.runtime.committedDeltas.get("SKU-ALT-1::BR-001")).toBeUndefined();

        // 3. Walk linked order OPEN_REQUEST -> AWAITING_DONOR -> COMMITTED -> RECEIVED and inspect staff GET /api/stock-alerts
        expect(
          (
            await app.inject({
              method: "POST",
              url: `/api/orders/${order1.id}/request`,
              headers: hManama,
              payload: { sourceBranchId: "BR-005", comment: "Requesting from Hidd surplus" },
            })
          ).statusCode,
        ).toBe(200);

        const staffViewAwaiting = StockAlertListSchema.parse(
          json((await app.inject({ method: "GET", url: "/api/stock-alerts", headers: hStaffManama })).payload),
        ).alerts.find((a) => a.id === alert1.id);
        expect(staffViewAwaiting?.linkedOrderStatus).toBe("AWAITING_DONOR");
        expect(staffViewAwaiting?.resolution?.comment).toBe(
          "Escalated from staff shelf report for inter-branch pull",
        );

        expect(
          (
            await app.inject({
              method: "POST",
              url: `/api/orders/${order1.id}/commit`,
              headers: hRegional,
              payload: { comment: "Releasing 40 units from Hidd" },
            })
          ).statusCode,
        ).toBe(200);

        const staffViewCommitted = StockAlertListSchema.parse(
          json((await app.inject({ method: "GET", url: "/api/stock-alerts", headers: hStaffManama })).payload),
        ).alerts.find((a) => a.id === alert1.id);
        expect(staffViewCommitted?.linkedOrderStatus).toBe("COMMITTED");

        expect(
          (
            await app.inject({
              method: "POST",
              url: `/api/orders/${order1.id}/receive`,
              headers: hStaffManama,
              payload: { comment: "Stock shelved at Manama" },
            })
          ).statusCode,
        ).toBe(200);

        const staffViewReceived = StockAlertListSchema.parse(
          json((await app.inject({ method: "GET", url: "/api/stock-alerts", headers: hStaffManama })).payload),
        ).alerts.find((a) => a.id === alert1.id);
        expect(staffViewReceived?.linkedOrderStatus).toBe("RECEIVED");

        // 4. Convert a second alert WITH chosen donor -> AWAITING_DONOR immediately in same transaction
        const createRes2 = await app.inject({
          method: "POST",
          url: "/api/stock-alerts",
          headers: hStaffManama,
          payload: {
            branchId: "BR-001",
            sku: "SKU-ALT-1",
            category: "CRITICAL_LOW",
            note: "Secondary shelf display needs top-up",
          },
        });
        const alert2 = StockAlertSchema.parse(json(createRes2.payload));

        const convertRoutedRes = await app.inject({
          method: "POST",
          url: `/api/stock-alerts/${alert2.id}/resolve`,
          headers: hManama,
          payload: {
            action: "CONVERTED_TO_REQUEST",
            sourceBranchId: "BR-008",
            quantity: 20,
            comment: "Route straight to Jasra donor",
          },
        });
        expect(convertRoutedRes.statusCode).toBe(200);
        const resolved2 = ResolveStockAlertResponseSchema.parse(json(convertRoutedRes.payload));
        expect(resolved2.order?.status).toBe("AWAITING_DONOR");
        expect(resolved2.order?.sourceBranchId).toBe("BR-008");
        expect(resolved2.order?.awaitingDonorSince).toBeTruthy();
        expect(resolved2.order?.linkedAlertId).toBe(alert2.id);
        expect(resolved2.alert.linkedOrderStatus).toBe("AWAITING_DONOR");
      } finally {
        await app.close();
      }
    });

    it("rolls back alert resolution cleanly when creating the linked order/event fails atomically", async () => {
      const { app } = await buildTestApp(repo);
      const hStaffManama = bearer(tokenFor(app, staffManama));
      const hManama = bearer(tokenFor(app, mgrManama));

      try {
        const createRes = await app.inject({
          method: "POST",
          url: "/api/stock-alerts",
          headers: hStaffManama,
          payload: {
            branchId: "BR-001",
            sku: "SKU-ALT-1",
            category: "CRITICAL_LOW",
            note: "Atomic failure test alert",
          },
        });
        expect(createRes.statusCode).toBe(201);
        const alert = StockAlertSchema.parse(json(createRes.payload));
        const ordersBefore = await repo.listOrders();

        const spy =
          kind === "memory"
            ? vi
                .spyOn(InMemoryRepository.prototype, "commitOrderEvent")
                .mockRejectedValueOnce(new Error("Simulated alert escalation event failure"))
            : vi
                .spyOn(OrderEventModel, "create")
                .mockRejectedValueOnce(new Error("Simulated alert escalation event failure"));

        try {
          const failRes = await app.inject({
            method: "POST",
            url: `/api/stock-alerts/${alert.id}/resolve`,
            headers: hManama,
            payload: {
              action: "CONVERTED_TO_REQUEST",
              quantity: 15,
              comment: "Should roll back completely",
            },
          });
          expect(failRes.statusCode).toBe(500);
        } finally {
          spy.mockRestore();
        }

        const persistedAlert = await repo.getStockAlert(alert.id);
        expect(persistedAlert?.status).toBe("PENDING");
        expect(persistedAlert?.resolution).toBeNull();
        expect(persistedAlert?.decidedBy).toBeNull();

        const ordersAfter = await repo.listOrders();
        expect(ordersAfter).toHaveLength(ordersBefore.length);
        expect(ordersAfter.some((o) => o.linkedAlertId === alert.id)).toBe(false);
      } finally {
        await app.close();
      }
    });

    it("applies LOGGED_ADJUSTMENT as a live overlay without bumping dataVersion and replays across restarts", async () => {
      const { app, services } = await buildTestApp(repo);
      const hAdmin = bearer(tokenFor(app, adminUser));
      const hManama = bearer(tokenFor(app, mgrManama));
      const hRegional = bearer(tokenFor(app, mgrRegional));
      const hStaffManama = bearer(tokenFor(app, staffManama));
      const hStaffHidd = bearer(tokenFor(app, staffHidd));

      try {
        // Warm scoped + network KPI caches before logging adjustments
        const beforeManamaKpi = json<{ lostSalesAtRisk: number }>(
          (await app.inject({ method: "GET", url: "/api/kpis", headers: hManama })).payload,
        );
        const versionBefore = await repo.getDataVersion();

        // 1. Staff at BR-001 flags SKU-ALT-3 with physical count 25 (system onHand = 40)
        const flagShrink = await app.inject({
          method: "POST",
          url: "/api/stock-alerts",
          headers: hStaffManama,
          payload: {
            branchId: "BR-001",
            sku: "SKU-ALT-3",
            category: "COUNT_MISMATCH",
            reportedQty: 25,
            note: "Shelf physical count shows 25 vs 40 in system",
          },
        });
        expect(flagShrink.statusCode).toBe(201);
        const shrinkAlert = StockAlertSchema.parse(json(flagShrink.payload));

        // Guard against adjustment driving onHand below zero
        expect(
          (
            await app.inject({
              method: "POST",
              url: `/api/stock-alerts/${shrinkAlert.id}/resolve`,
              headers: hManama,
              payload: {
                action: "LOGGED_ADJUSTMENT",
                adjustmentDelta: -100,
                comment: "Too large negative delta",
              },
            })
          ).statusCode,
        ).toBe(400);

        // Omit explicit adjustedOnHand/adjustmentDelta -> infers delta from reportedQty (25 - 40 = -15)
        const adjRes = await app.inject({
          method: "POST",
          url: `/api/stock-alerts/${shrinkAlert.id}/resolve`,
          headers: hManama,
          payload: {
            action: "LOGGED_ADJUSTMENT",
            comment: "Confirmed shrinkage of 15 units during cycle count",
          },
        });
        expect(adjRes.statusCode).toBe(200);
        const resolvedAdj = ResolveStockAlertResponseSchema.parse(json(adjRes.payload));
        expect(resolvedAdj.alert.status).toBe("RESOLVED");
        expect(resolvedAdj.alert.resolution?.action).toBe("LOGGED_ADJUSTMENT");
        expect(resolvedAdj.alert.resolution?.adjustedOnHand).toBe(25);
        expect(resolvedAdj.alert.resolution?.adjustmentDelta).toBe(-15);
        expect(resolvedAdj.order).toBeNull();

        // Must NOT bump dataVersion or rewrite plan_cache
        expect(await repo.getDataVersion()).toBe(versionBefore);
        expect(services.runtime.scopedKpiCache.size).toBe(0);

        // Live reads immediately show adjusted onHand = 25 (AT_RISK) and updated KPIs
        const prodList = json<{ products: Array<{ sku: string; stats?: { onHand: number; status: string } }> }>(
          (
            await app.inject({
              method: "GET",
              url: "/api/catalog/products?branch=BR-001&search=SKU-ALT-3",
              headers: hAdmin,
            })
          ).payload,
        );
        const alt3Stats = prodList.products.find((p) => p.sku === "SKU-ALT-3")?.stats;
        expect(alt3Stats?.onHand).toBe(25);
        expect(alt3Stats?.status).toBe("AT_RISK");

        const afterManamaKpi = json<{ lostSalesAtRisk: number }>(
          (await app.inject({ method: "GET", url: "/api/kpis", headers: hManama })).payload,
        );
        expect(afterManamaKpi.lostSalesAtRisk).toBeGreaterThan(beforeManamaKpi.lostSalesAtRisk);

        // 2. Also log donor shrinkage (-50) on BR-005 / SKU-ALT-2 (180 -> 130, floor 60 -> surplus drops 120 -> 70)
        const hiddFlag = await app.inject({
          method: "POST",
          url: "/api/stock-alerts",
          headers: hStaffHidd,
          payload: {
            branchId: "BR-005",
            sku: "SKU-ALT-2",
            category: "DAMAGED_SHRINKAGE",
            note: "Water leak damaged 50 cartons in Hidd storeroom",
          },
        });
        const hiddAlert = StockAlertSchema.parse(json(hiddFlag.payload));

        const hiddAdjRes = await app.inject({
          method: "POST",
          url: `/api/stock-alerts/${hiddAlert.id}/resolve`,
          headers: hRegional,
          payload: {
            action: "LOGGED_ADJUSTMENT",
            adjustmentDelta: -50,
            comment: "Write-off 50 damaged units",
          },
        });
        expect(hiddAdjRes.statusCode).toBe(200);
        expect(await repo.getDataVersion()).toBe(versionBefore);

        const donors = DonorCandidatesResponseSchema.parse(
          json(
            (
              await app.inject({
                method: "GET",
                url: "/api/orders/donor-candidates?sku=SKU-ALT-2&target=BR-001&qty=120",
                headers: hManama,
              })
            ).payload,
          ),
        );
        expect(donors.candidates).toHaveLength(1);
        expect(donors.candidates[0]!.branchId).toBe("BR-005");
        expect(donors.candidates[0]!.availableSurplusUnits).toBe(70);
        expect(donors.candidates[0]!.offeredQty).toBe(70);
        expect(donors.candidates[0]!.isPartial).toBe(true);
      } finally {
        await app.close();
      }

      // 3. Restart app over same repository and confirm live adjustments replay cleanly
      const restarted = await buildTestApp(repo);
      try {
        const hAdmin2 = bearer(tokenFor(restarted.app, adminUser));
        const hManama2 = bearer(tokenFor(restarted.app, mgrManama));

        const prodAfterRestart = json<{
          products: Array<{ sku: string; stats?: { onHand: number; status: string } }>;
        }>(
          (
            await restarted.app.inject({
              method: "GET",
              url: "/api/catalog/products?branch=BR-001&search=SKU-ALT-3",
              headers: hAdmin2,
            })
          ).payload,
        );
        expect(prodAfterRestart.products.find((p) => p.sku === "SKU-ALT-3")?.stats?.onHand).toBe(25);

        const donorsAfterRestart = DonorCandidatesResponseSchema.parse(
          json(
            (
              await restarted.app.inject({
                method: "GET",
                url: "/api/orders/donor-candidates?sku=SKU-ALT-2&target=BR-001&qty=120",
                headers: hManama2,
              })
            ).payload,
          ),
        );
        expect(donorsAfterRestart.candidates[0]!.availableSurplusUnits).toBe(70);
      } finally {
        await restarted.app.close();
      }
    });

    it("enforces required comment for DISMISSED, supports ACKNOWLEDGED, and blocks repeat decisions with 409", async () => {
      const { app } = await buildTestApp(repo);
      const hManama = bearer(tokenFor(app, mgrManama));
      const hAdmin = bearer(tokenFor(app, adminUser));
      const hStaffManama = bearer(tokenFor(app, staffManama));

      try {
        const createA = await app.inject({
          method: "POST",
          url: "/api/stock-alerts",
          headers: hStaffManama,
          payload: { branchId: "BR-001", sku: "SKU-ALT-2", category: "OTHER", note: "Possible mislabel" },
        });
        const alertA = StockAlertSchema.parse(json(createA.payload));

        const createB = await app.inject({
          method: "POST",
          url: "/api/stock-alerts",
          headers: hStaffManama,
          payload: { branchId: "BR-001", sku: "SKU-ALT-1", category: "OTHER", note: "False alarm near register" },
        });
        const alertB = StockAlertSchema.parse(json(createB.payload));

        // DISMISSED without comment or whitespace comment -> 400
        expect(
          (
            await app.inject({
              method: "POST",
              url: `/api/stock-alerts/${alertB.id}/resolve`,
              headers: hManama,
              payload: { action: "DISMISSED" },
            })
          ).statusCode,
        ).toBe(400);
        expect(
          (
            await app.inject({
              method: "POST",
              url: `/api/stock-alerts/${alertB.id}/resolve`,
              headers: hManama,
              payload: { action: "DISMISSED", comment: "   " },
            })
          ).statusCode,
        ).toBe(400);

        const dismissRes = await app.inject({
          method: "POST",
          url: `/api/stock-alerts/${alertB.id}/resolve`,
          headers: hManama,
          payload: { action: "DISMISSED", comment: "Duplicate morning delivery already stocked backroom" },
        });
        expect(dismissRes.statusCode).toBe(200);
        const dismissed = ResolveStockAlertResponseSchema.parse(json(dismissRes.payload));
        expect(dismissed.alert.status).toBe("RESOLVED");
        expect(dismissed.alert.resolution?.action).toBe("DISMISSED");
        expect(dismissed.alert.resolution?.comment).toBe(
          "Duplicate morning delivery already stocked backroom",
        );

        const ackRes = await app.inject({
          method: "POST",
          url: `/api/stock-alerts/${alertA.id}/resolve`,
          headers: hManama,
          payload: { action: "ACKNOWLEDGED", comment: "Noted for next audit pass" },
        });
        expect(ackRes.statusCode).toBe(200);
        const acknowledged = ResolveStockAlertResponseSchema.parse(json(ackRes.payload));
        expect(acknowledged.alert.status).toBe("RESOLVED");
        expect(acknowledged.alert.resolution?.action).toBe("ACKNOWLEDGED");

        // Staff sees resolution comment on their alerts
        const staffList = StockAlertListSchema.parse(
          json((await app.inject({ method: "GET", url: "/api/stock-alerts", headers: hStaffManama })).payload),
        );
        const staffDismissedView = staffList.alerts.find((a) => a.id === alertB.id);
        expect(staffDismissedView?.resolution?.comment).toBe(
          "Duplicate morning delivery already stocked backroom",
        );

        // Repeat resolve OR legacy approve/reject on resolved alert -> 409 Conflict
        expect(
          (
            await app.inject({
              method: "POST",
              url: `/api/stock-alerts/${alertB.id}/resolve`,
              headers: hAdmin,
              payload: { action: "ACKNOWLEDGED" },
            })
          ).statusCode,
        ).toBe(409);
        expect(
          (
            await app.inject({
              method: "PATCH",
              url: `/api/stock-alerts/${alertA.id}/approve`,
              headers: hAdmin,
            })
          ).statusCode,
        ).toBe(409);
        expect(
          (
            await app.inject({
              method: "PATCH",
              url: `/api/stock-alerts/${alertB.id}/reject`,
              headers: hAdmin,
            })
          ).statusCode,
        ).toBe(409);
      } finally {
        await app.close();
      }
    });
  },
);

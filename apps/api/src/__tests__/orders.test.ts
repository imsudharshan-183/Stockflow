import {
  BAHRAIN_BRANCHES,
  DonorCandidatesResponseSchema,
  OrderListResponseSchema,
  ReplenishmentOrderSchema,
  type Branch,
  type Dataset,
  type Product,
  type User,
} from "@stockflow/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { InMemoryRepository } from "../repositories/memory.js";
import { OrderEventModel } from "../repositories/models.js";
import type { StockRepository } from "../repositories/types.js";
import { createStockServices } from "../services/index.js";
import { buildTestApp, createDualRepo, createUser, type RepoKind } from "../test/dualRepo.js";
import { bearer, json, tokenFor } from "../test/helpers.js";

function makeOrdersDataset(): Dataset {
  const branchIds = ["BR-001", "BR-002", "BR-005", "BR-008", "BR-009"] as const;
  const branches: Branch[] = branchIds.map((id) => {
    const found = BAHRAIN_BRANCHES.find((b) => b.id === id);
    if (!found) throw new Error(`Missing branch ${id}`);
    return { ...found };
  });

  const products: Product[] = [
    {
      sku: "SKU-ORD-1",
      name: "Clearwater Sparkling Water, 330 ml",
      category: "Beverages",
      price: 20,
      cost: 10,
      leadTimeDays: 7,
      status: "active",
    },
    {
      sku: "SKU-ORD-2",
      name: "Veritas Ceramic Bowl, 14 in",
      category: "Kitchenware",
      price: 25,
      cost: 12,
      leadTimeDays: 7,
      status: "active",
    },
  ];

  const days = 30;
  const start = Date.UTC(2026, 9, 1);
  const dates = Array.from({ length: days }, (_, i) =>
    new Date(start + i * 86_400_000).toISOString().slice(0, 10),
  );

  // Per branch for SKU-ORD-1: BR-001 donor (2/d, 300 -> 240 surplus), BR-002 short intra-cluster (5/d, 10),
  // BR-005 short cross-cluster (5/d, 10), BR-008 donor2 (2/d, 300 -> 240 surplus), BR-009 steady (2/d, 80).
  const sku1Sales = [2, 5, 5, 2, 2];
  const sku1Stock = [300, 10, 10, 300, 80];

  // SKU-ORD-2: BR-001 short (5/d, 10), BR-002 donor intra-cluster (2/d, 300), others steady (2/d, 80)
  const sku2Sales = [5, 2, 2, 2, 2];
  const sku2Stock = [10, 300, 80, 80, 80];

  const buildMatrix = (sArr: number[], stArr: number[]) => ({
    sales: sArr.map((s) => Array.from({ length: days }, () => s)),
    onHand: stArr.map((st) => Array.from({ length: days }, () => st)),
    demand: sArr.map((s) => Array.from({ length: days }, () => s)),
  });

  const m1 = buildMatrix(sku1Sales, sku1Stock);
  const m2 = buildMatrix(sku2Sales, sku2Stock);

  return {
    seed: 77,
    asOf: dates[days - 1]!,
    dates,
    branches,
    products,
    sales: [m1.sales, m2.sales],
    onHand: [m1.onHand, m2.onHand],
    demand: [m1.demand, m2.demand],
  };
}

describe.each<RepoKind>(["memory", "mongo-memory"])(
  "Stage B: ReplenishmentOrder lifecycle [%s]",
  (kind) => {
    let repo: StockRepository;
    let cleanup: () => Promise<void>;
    let adminUser: User;
    let mgrManama: User; // BR-001, BR-002 (donor for BR-001 + intra-cluster BR-001<->BR-002)
    let mgrHidd: User; // BR-005
    let staffHidd: User; // BR-005
    let mgrSitra: User; // BR-008
    let mgrTubli: User; // BR-009 (unrelated)
    let staffTubli: User; // BR-009 (unrelated)

    beforeAll(async () => {
      const setup = await createDualRepo(kind, makeOrdersDataset());
      repo = setup.repo;
      cleanup = setup.cleanup;
      adminUser = (await createUser(repo, "admin", [], { email: `ord.admin.${kind}@stockflow.test` })).user;
      mgrManama = (
        await createUser(repo, "manager", ["BR-001", "BR-002"], {
          email: `ord.manama.${kind}@stockflow.test`,
        })
      ).user;
      mgrHidd = (
        await createUser(repo, "manager", ["BR-005"], {
          email: `ord.hidd.${kind}@stockflow.test`,
        })
      ).user;
      staffHidd = (
        await createUser(repo, "staff", ["BR-005"], {
          email: `ord.stf.hidd.${kind}@stockflow.test`,
        })
      ).user;
      mgrSitra = (
        await createUser(repo, "manager", ["BR-008"], {
          email: `ord.sitra.${kind}@stockflow.test`,
        })
      ).user;
      mgrTubli = (
        await createUser(repo, "manager", ["BR-009"], {
          email: `ord.tubli.${kind}@stockflow.test`,
        })
      ).user;
      staffTubli = (
        await createUser(repo, "staff", ["BR-009"], {
          email: `ord.stf.tubli.${kind}@stockflow.test`,
        })
      ).user;
    }, 120_000);

    afterAll(async () => {
      await cleanup?.();
    });

    it("enforces two-party cross-cluster handshake, intra-cluster single-step commit, decline/reroute/cancel/receive, and event invariants", async () => {
      const { app, services } = await buildTestApp(repo);
      try {
        const hAdmin = bearer(tokenFor(app, adminUser));
        const hManama = bearer(tokenFor(app, mgrManama));
        const hHidd = bearer(tokenFor(app, mgrHidd));
        const hStaffHidd = bearer(tokenFor(app, staffHidd));
        const hSitra = bearer(tokenFor(app, mgrSitra));
        const hTubli = bearer(tokenFor(app, mgrTubli));
        const hStaffTubli = bearer(tokenFor(app, staffTubli));
        const vStart = await repo.getDataVersion();

        // 0. Unauthenticated & staff RBAC guards
        expect((await app.inject({ method: "GET", url: "/api/orders" })).statusCode).toBe(401);
        expect(
          (
            await app.inject({
              method: "POST",
              url: "/api/orders",
              headers: hStaffHidd,
              payload: { type: "REORDER", sku: "SKU-ORD-1", targetBranchId: "BR-005", quantity: 10 },
            })
          ).statusCode,
        ).toBe(403);
        expect(
          (
            await app.inject({
              method: "GET",
              url: "/api/orders/donor-candidates?sku=SKU-ORD-1&target=BR-005&qty=40",
              headers: hStaffHidd,
            })
          ).statusCode,
        ).toBe(403);

        // 1. Ranked donor candidates endpoint
        const dcRes = await app.inject({
          method: "GET",
          url: "/api/orders/donor-candidates?sku=SKU-ORD-1&target=BR-005&qty=40",
          headers: hHidd,
        });
        expect(dcRes.statusCode).toBe(200);
        const dcBody = DonorCandidatesResponseSchema.parse(json(dcRes.payload));
        expect(dcBody.candidates.some((c) => c.branchId === "BR-001" && c.eligible)).toBe(true);

        // 2. Lazy materialization check: engine suggestions start virtual until first action
        const suggRes = await app.inject({
          method: "GET",
          url: "/api/orders?queue=suggested",
          headers: hAdmin,
        });
        expect(suggRes.statusCode).toBe(200);
        const suggList = OrderListResponseSchema.parse(json(suggRes.payload));
        const intraClusterVirtual = suggList.orders.find(
          (o) =>
            o.sku === "SKU-ORD-2" &&
            o.type === "TRANSFER" &&
            o.targetBranchId === "BR-001" &&
            o.sourceBranchId === "BR-002",
        );
        expect(intraClusterVirtual).toBeTruthy();
        expect(intraClusterVirtual?.isVirtual).toBe(true);
        expect(intraClusterVirtual?.status).toBe("SUGGESTED");

        // Unrelated manager gets 404 on out-of-scope order ID
        expect(
          (
            await app.inject({
              method: "GET",
              url: `/api/orders/${intraClusterVirtual!.id}`,
              headers: hTubli,
            })
          ).statusCode,
        ).toBe(404);

        // Intra-cluster manager commits directly in one step -> lazy materialization reuses deterministic rec id
        const intraCommitRes = await app.inject({
          method: "POST",
          url: `/api/orders/${intraClusterVirtual!.id}/commit`,
          headers: hManama,
          payload: { dispositionCode: "INTRA_APPROVED", comment: "Same Manama cluster transfer" },
        });
        expect(intraCommitRes.statusCode).toBe(200);
        const intraCommitted = ReplenishmentOrderSchema.parse(json(intraCommitRes.payload));
        expect(intraCommitted.id).toBe(intraClusterVirtual!.id);
        expect(intraCommitted.status).toBe("COMMITTED");
        expect(intraCommitted.events.at(-1)?.comment).toBe("Same Manama cluster transfer");
        expect(intraCommitted.events.at(-1)?.dispositionCode).toBe("INTRA_APPROVED");
        // engineSnapshot.reasonCodes stayed read-only
        expect(intraCommitted.engineSnapshot.reasonCodes).toEqual(
          intraClusterVirtual!.engineSnapshot.reasonCodes,
        );

        // 3. Receiver manager requests cross-cluster transfer manually -> UUID id, AWAITING_DONOR, zero committedDeltas
        const createRes = await app.inject({
          method: "POST",
          url: "/api/orders",
          headers: hHidd,
          payload: {
            type: "TRANSFER",
            sku: "SKU-ORD-1",
            targetBranchId: "BR-005",
            sourceBranchId: "BR-001",
            quantity: 40,
            dispositionCode: "SHELF_LOW",
            comment: "Need 40 units in Hidd",
          },
        });
        expect(createRes.statusCode).toBe(201);
        const crossOrder = ReplenishmentOrderSchema.parse(json(createRes.payload));
        expect(crossOrder.id.startsWith("ord_")).toBe(true);
        expect(crossOrder.origin).toBe("MANAGER_REQUEST");
        expect(crossOrder.status).toBe("AWAITING_DONOR");
        // No delta touched before COMMITTED
        expect(services.runtime.committedDeltas.get("SKU-ORD-1::BR-001")).toBeUndefined();
        expect(services.runtime.committedDeltas.get("SKU-ORD-1::BR-005")).toBeUndefined();

        // Receiver manager CANNOT commit cross-cluster transfer directly (403); non-requester CANNOT cancel (403)
        expect(
          (
            await app.inject({
              method: "POST",
              url: `/api/orders/${crossOrder.id}/commit`,
              headers: hHidd,
              payload: {},
            })
          ).statusCode,
        ).toBe(403);
        expect(
          (
            await app.inject({
              method: "POST",
              url: `/api/orders/${crossOrder.id}/cancel`,
              headers: hManama,
              payload: {},
            })
          ).statusCode,
        ).toBe(403);

        // Donor manager sees it in incoming queue and CANNOT decline without comment (400)
        const incomingRes = await app.inject({
          method: "GET",
          url: "/api/orders?queue=incoming",
          headers: hManama,
        });
        expect(incomingRes.statusCode).toBe(200);
        const incoming = OrderListResponseSchema.parse(json(incomingRes.payload));
        const incomingItem = incoming.orders.find((o) => o.id === crossOrder.id);
        expect(incomingItem).toBeTruthy();
        expect(incomingItem?.donorAvailableSurplus).toBe(240);

        expect(
          (
            await app.inject({
              method: "POST",
              url: `/api/orders/${crossOrder.id}/decline`,
              headers: hManama,
              payload: { comment: "   " },
            })
          ).statusCode,
        ).toBe(400);

        // Receiver manager CANNOT decline awaiting-donor request (403)
        expect(
          (
            await app.inject({
              method: "POST",
              url: `/api/orders/${crossOrder.id}/decline`,
              headers: hHidd,
              payload: { comment: "Should fail" },
            })
          ).statusCode,
        ).toBe(403);

        // Donor manager declines with comment -> REJECTED
        const decRes = await app.inject({
          method: "POST",
          url: `/api/orders/${crossOrder.id}/decline`,
          headers: hManama,
          payload: { dispositionCode: "LOCAL_PROMO", comment: "Weekend promo in CBD" },
        });
        expect(decRes.statusCode).toBe(200);
        expect(ReplenishmentOrderSchema.parse(json(decRes.payload)).status).toBe("REJECTED");

        // Receiver manager reroutes declined order to BR-008 -> AWAITING_DONOR (donor manager gets 403)
        expect(
          (
            await app.inject({
              method: "POST",
              url: `/api/orders/${crossOrder.id}/reroute`,
              headers: hManama,
              payload: { sourceBranchId: "BR-008" },
            })
          ).statusCode,
        ).toBe(403);
        const rerouteRes = await app.inject({
          method: "POST",
          url: `/api/orders/${crossOrder.id}/reroute`,
          headers: hHidd,
          payload: { sourceBranchId: "BR-008", comment: "Switching to Sitra stock" },
        });
        expect(rerouteRes.statusCode).toBe(200);
        const rerouted = ReplenishmentOrderSchema.parse(json(rerouteRes.payload));
        expect(rerouted.status).toBe("AWAITING_DONOR");
        expect(rerouted.sourceBranchId).toBe("BR-008");

        // Warm KPI cache before commit to prove COMMITTED invalidates scopedKpiCache
        await app.inject({ method: "GET", url: "/api/kpis?branch=BR-005", headers: hHidd });
        await app.inject({ method: "GET", url: "/api/kpis?branch=BR-008", headers: hSitra });
        expect(services.runtime.scopedKpiCache.size).toBeGreaterThan(0);

        // RECEIVE is illegal before COMMITTED -> 409
        expect(
          (
            await app.inject({
              method: "POST",
              url: `/api/orders/${crossOrder.id}/receive`,
              headers: hStaffHidd,
              payload: {},
            })
          ).statusCode,
        ).toBe(409);

        // Donor manager (Sitra BR-008) commits release -> COMMITTED, donor.reserved += 40, target.inTransit += 40
        const commitRes = await app.inject({
          method: "POST",
          url: `/api/orders/${crossOrder.id}/commit`,
          headers: hSitra,
          payload: { comment: "Dispatched 40 units" },
        });
        expect(commitRes.statusCode).toBe(200);
        expect(services.runtime.scopedKpiCache.size).toBe(0);
        expect(services.runtime.committedDeltas.get("SKU-ORD-1::BR-008")).toEqual({
          reserved: 40,
          inTransit: 0,
        });
        expect(services.runtime.committedDeltas.get("SKU-ORD-1::BR-005")).toEqual({
          reserved: 0,
          inTransit: 40,
        });

        // Cancel after COMMITTED -> 409
        expect(
          (
            await app.inject({
              method: "POST",
              url: `/api/orders/${crossOrder.id}/cancel`,
              headers: hHidd,
              payload: {},
            })
          ).statusCode,
        ).toBe(409);

        // Donor manager and unrelated staff CANNOT confirm receipt -> 403 / 404
        expect(
          (
            await app.inject({
              method: "POST",
              url: `/api/orders/${crossOrder.id}/receive`,
              headers: hSitra,
              payload: {},
            })
          ).statusCode,
        ).toBe(403);
        expect(
          (
            await app.inject({
              method: "POST",
              url: `/api/orders/${crossOrder.id}/receive`,
              headers: hStaffTubli,
              payload: {},
            })
          ).statusCode,
        ).toBe(404);

        // Warm KPI cache, then target branch staff confirms receipt -> RECEIVED, inTransit cleared, cache cleared!
        await app.inject({ method: "GET", url: "/api/kpis?branch=BR-005", headers: hHidd });
        expect(services.runtime.scopedKpiCache.size).toBeGreaterThan(0);

        const recRes = await app.inject({
          method: "POST",
          url: `/api/orders/${crossOrder.id}/receive`,
          headers: hStaffHidd,
          payload: { comment: "Checked off at Hidd receiving bay" },
        });
        expect(recRes.statusCode).toBe(200);
        const receivedOrder = ReplenishmentOrderSchema.parse(await repo.getOrder(crossOrder.id));
        expect(recRes.json()).not.toHaveProperty("engineSnapshot");
        expect(recRes.json().status).toBe("RECEIVED");
        expect(receivedOrder.status).toBe("RECEIVED");
        expect(receivedOrder.receivedAt).toBeTruthy();
        expect(receivedOrder.events.map((e) => e.action)).toEqual([
          "CREATED",
          "DECLINE",
          "REROUTE",
          "COMMIT",
          "RECEIVE",
        ]);
        expect(services.runtime.scopedKpiCache.size).toBe(0);
        // inTransit cleared; donor reservation retained until next dataVersion refresh
        expect(services.runtime.committedDeltas.get("SKU-ORD-1::BR-005")).toBeUndefined();
        expect(services.runtime.committedDeltas.get("SKU-ORD-1::BR-008")).toEqual({
          reserved: 40,
          inTransit: 0,
        });

        // 4. Requester cancels an OPEN_REQUEST before commit, and Admin force-commit requires comment
        const openRes = await app.inject({
          method: "POST",
          url: "/api/orders",
          headers: hHidd,
          payload: {
            type: "TRANSFER",
            sku: "SKU-ORD-1",
            targetBranchId: "BR-005",
            quantity: 15,
          },
        });
        const openOrder = ReplenishmentOrderSchema.parse(json(openRes.payload));
        expect(openOrder.status).toBe("OPEN_REQUEST");

        // Admin force-commit without comment -> 400; with comment -> 200 isAdminOverride
        expect(
          (
            await app.inject({
              method: "POST",
              url: `/api/orders/${crossOrder.id}/commit`,
              headers: hAdmin,
              payload: {},
            })
          ).statusCode,
        ).toBe(409); // already terminal

        const awaitingAdminRes = await app.inject({
          method: "POST",
          url: "/api/orders",
          headers: hHidd,
          payload: {
            type: "TRANSFER",
            sku: "SKU-ORD-1",
            targetBranchId: "BR-005",
            sourceBranchId: "BR-008",
            quantity: 10,
          },
        });
        const awaitingAdmin = ReplenishmentOrderSchema.parse(json(awaitingAdminRes.payload));
        expect(
          (
            await app.inject({
              method: "POST",
              url: `/api/orders/${awaitingAdmin.id}/commit`,
              headers: hAdmin,
              payload: {},
            })
          ).statusCode,
        ).toBe(400);
        const forceOkRes = await app.inject({
          method: "POST",
          url: `/api/orders/${awaitingAdmin.id}/commit`,
          headers: hAdmin,
          payload: { comment: "Admin emergency override", dispositionCode: "ADMIN_OVERRIDE" },
        });
        expect(forceOkRes.statusCode).toBe(200);
        expect(
          ReplenishmentOrderSchema.parse(json(forceOkRes.payload)).events.at(-1)?.isAdminOverride,
        ).toBe(true);

        // Requester cancels openOrder
        const cancelRes = await app.inject({
          method: "POST",
          url: `/api/orders/${openOrder.id}/cancel`,
          headers: hHidd,
          payload: { comment: "No longer needed" },
        });
        expect(cancelRes.statusCode).toBe(200);
        expect(ReplenishmentOrderSchema.parse(json(cancelRes.payload)).status).toBe("CANCELLED");

        // Hard rule: dataVersion never bumped across all order transitions
        expect(await repo.getDataVersion()).toBe(vStart);
      } finally {
        await app.close();
      }
    });

    it("enforces atomic order+event writes and returns 409 on concurrent commits against a shared donor", async () => {
      const fresh = await createDualRepo(kind, makeOrdersDataset());
      const { app } = await buildTestApp(fresh.repo);
      try {
        const localHidd = (
          await createUser(fresh.repo, "manager", ["BR-005"], {
            email: `conc.hidd.${kind}@stockflow.test`,
          })
        ).user;
        const localManama = (
          await createUser(fresh.repo, "manager", ["BR-001", "BR-002"], {
            email: `conc.manama.${kind}@stockflow.test`,
          })
        ).user;
        const hHidd = bearer(tokenFor(app, localHidd));
        const hManama = bearer(tokenFor(app, localManama));

        // Atomic rollback when event write throws
        const beforeOrders = await fresh.repo.listOrders();
        const eventSpy =
          kind === "mongo-memory"
            ? vi.spyOn(OrderEventModel, "create").mockRejectedValueOnce(new Error("Simulated event write failure"))
            : vi
                .spyOn(InMemoryRepository.prototype, "commitOrderEvent")
                .mockRejectedValueOnce(new Error("Simulated event write failure"));
        try {
          const failedCreate = await app.inject({
            method: "POST",
            url: "/api/orders",
            headers: hHidd,
            payload: {
              type: "TRANSFER",
              sku: "SKU-ORD-1",
              targetBranchId: "BR-005",
              sourceBranchId: "BR-001",
              quantity: 20,
            },
          });
          expect(failedCreate.statusCode).toBe(500);
        } finally {
          eventSpy.mockRestore();
        }
        expect(await fresh.repo.listOrders()).toHaveLength(beforeOrders.length);

        // Two concurrent commits each asking for 150 units from BR-001 (available surplus 240)
        const r1 = await app.inject({
          method: "POST",
          url: "/api/orders",
          headers: hHidd,
          payload: {
            type: "TRANSFER",
            sku: "SKU-ORD-1",
            targetBranchId: "BR-005",
            sourceBranchId: "BR-001",
            quantity: 150,
          },
        });
        const r2 = await app.inject({
          method: "POST",
          url: "/api/orders",
          headers: hHidd,
          payload: {
            type: "TRANSFER",
            sku: "SKU-ORD-1",
            targetBranchId: "BR-005",
            sourceBranchId: "BR-001",
            quantity: 150,
          },
        });
        const o1 = ReplenishmentOrderSchema.parse(json(r1.payload));
        const o2 = ReplenishmentOrderSchema.parse(json(r2.payload));

        const [c1, c2] = await Promise.all([
          app.inject({ method: "POST", url: `/api/orders/${o1.id}/commit`, headers: hManama, payload: {} }),
          app.inject({ method: "POST", url: `/api/orders/${o2.id}/commit`, headers: hManama, payload: {} }),
        ]);

        const statuses = [c1.statusCode, c2.statusCode].sort((a, b) => a - b);
        expect(statuses).toEqual([200, 409]);
      } finally {
        await app.close();
        await fresh.cleanup();
      }
    });

    it("migrates legacy decisions idempotently on startup and escalates overdue AWAITING_DONOR orders after 24h", async () => {
      const fresh = await createDualRepo(kind, makeOrdersDataset());
      try {
        const localAdmin = (
          await createUser(fresh.repo, "admin", [], {
            email: `mig.admin.${kind}@stockflow.test`,
          })
        ).user;
        const localHidd = (
          await createUser(fresh.repo, "manager", ["BR-005"], {
            email: `mig.hidd.${kind}@stockflow.test`,
          })
        ).user;

        const { app, services } = await buildTestApp(fresh.repo);
        try {
          const hAdmin = bearer(tokenFor(app, localAdmin));
          const recsRes = await app.inject({
            method: "GET",
            url: "/api/recommendations",
            headers: hAdmin,
          });
          const recs = (json<{ recommendations: Array<{ id: string }> }>(recsRes.payload))
            .recommendations;
          const targetRec = recs[0]!;

          // Approve via legacy endpoint (writes actions + audit)
          const appRes = await app.inject({
            method: "POST",
            url: `/api/recommendations/${targetRec.id}/approve`,
            headers: hAdmin,
          });
          expect(appRes.statusCode).toBe(200);

          // Boot a new service instance twice to prove startup migration is idempotent
          const bootedServices = createStockServices(fresh.repo);
          await bootedServices.ensureInitialized();
          const ordersAfterBoot1 = await fresh.repo.listOrders();
          expect(ordersAfterBoot1.filter((o) => o.id === targetRec.id)).toHaveLength(1);
          expect(ordersAfterBoot1.find((o) => o.id === targetRec.id)?.status).toBe("COMMITTED");
          expect(ordersAfterBoot1.find((o) => o.id === targetRec.id)?.events[0]?.action).toBe("MIGRATED");

          await bootedServices.orders.initializeAndMigrate();
          const ordersAfterBoot2 = await fresh.repo.listOrders();
          expect(ordersAfterBoot2.filter((o) => o.id === targetRec.id)).toHaveLength(1);
          expect(ordersAfterBoot2.find((o) => o.id === targetRec.id)?.events).toHaveLength(1);

          // 24h AWAITING_DONOR escalation check
          const created = await services.orders.create(
            {
              type: "TRANSFER",
              sku: "SKU-ORD-1",
              targetBranchId: "BR-005",
              sourceBranchId: "BR-008",
              quantity: 12,
            },
            localHidd,
          );
          const t0 = Date.parse(created.awaitingDonorSince!);
          expect(await services.orders.checkEscalations(t0 + 23 * 3_600_000)).toEqual([]);
          const escalated = await services.orders.checkEscalations(t0 + 25 * 3_600_000);
          expect(escalated).toHaveLength(1);
          expect(escalated[0]?.isEscalated).toBe(true);
          expect(escalated[0]?.events.at(-1)?.action).toBe("ESCALATE");
          expect(escalated[0]?.events.at(-1)?.dispositionCode).toBe("DONOR_TIMEOUT_24H");
          // Repeat check is idempotent
          expect(await services.orders.checkEscalations(t0 + 26 * 3_600_000)).toEqual([]);
        } finally {
          await app.close();
        }
      } finally {
        await fresh.cleanup();
      }
    });
  },
);

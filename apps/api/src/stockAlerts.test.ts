import { StockAlertListSchema, StockAlertSchema } from "@stockflow/core";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StockRepository } from "./repositories/types.js";
import { buildTestApp, createDualRepo, createUser, loginAs, type RepoKind } from "./test/dualRepo.js";

describe.each<RepoKind>(["memory", "mongo-memory"])("Stock alerts API [%s]", (repoKind) => {
  let repo: StockRepository;
  let cleanup: () => Promise<void>;
  let app: FastifyInstance;
  let staffManamaHeader: { authorization: string };
  let staffHiddHeader: { authorization: string };
  let staffIsaHeader: { authorization: string };
  let managerManamaHeader: { authorization: string };
  let managerHiddHeader: { authorization: string };
  let adminHeader: { authorization: string };

  beforeAll(async () => {
    const created = await createDualRepo(repoKind);
    repo = created.repo;
    cleanup = created.cleanup;
    ({ app } = await buildTestApp(repo));

    const staffManama = await createUser(repo, "staff", ["BR-001"]);
    const staffHidd = await createUser(repo, "staff", ["BR-005"]);
    const staffIsa = await createUser(repo, "staff", ["BR-009"]);
    const mgrManama = await createUser(repo, "manager", ["BR-001"]);
    const mgrHidd = await createUser(repo, "manager", ["BR-005"]);
    const admin = await createUser(repo, "admin", []);

    staffManamaHeader = (await loginAs(app, staffManama.user.email, staffManama.password)).authHeader;
    staffHiddHeader = (await loginAs(app, staffHidd.user.email, staffHidd.password)).authHeader;
    // Use a distinct loopback address for the 6th setup login so /api/auth/login's max-5 rate limit isn't tripped in beforeAll.
    const isaLoginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "127.0.0.2",
      payload: { email: staffIsa.user.email, password: staffIsa.password },
    });
    expect(isaLoginRes.statusCode).toBe(200);
    staffIsaHeader = { authorization: `Bearer ${(JSON.parse(isaLoginRes.body) as { token: string }).token}` };
    managerManamaHeader = (await loginAs(app, mgrManama.user.email, mgrManama.password)).authHeader;
    managerHiddHeader = (await loginAs(app, mgrHidd.user.email, mgrHidd.password)).authHeader;
    adminHeader = (await loginAs(app, admin.user.email, admin.password)).authHeader;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await cleanup?.();
  });

  it("enforces staff-only create scope and manager/admin decision scope with post-decision immutability", async () => {
    // 1. Out-of-scope staff branch cannot create flag -> 403
    const crossBranchRes = await app.inject({
      method: "POST",
      url: "/api/stock-alerts",
      headers: staffManamaHeader,
      payload: {
        branchId: "BR-005",
        sku: "SKU-90001",
        note: "Should fail cross-branch",
      },
    });
    expect(crossBranchRes.statusCode).toBe(403);

    // 2. Manager and Admin are create-blocked on POST /api/stock-alerts (stock:flag is staff-only) -> 403
    for (const headers of [managerManamaHeader, adminHeader]) {
      const forbidCreate = await app.inject({
        method: "POST",
        url: "/api/stock-alerts",
        headers,
        payload: {
          branchId: "BR-001",
          sku: "SKU-90001",
          note: "Managers/Admins cannot create staff flags",
        },
      });
      expect(forbidCreate.statusCode).toBe(403);
    }

    // 3. Own-branch staff creates PENDING stock alerts with default CRITICAL_LOW and explicit categories -> 201
    const createRes = await app.inject({
      method: "POST",
      url: "/api/stock-alerts",
      headers: staffManamaHeader,
      payload: {
        branchId: "BR-001",
        sku: "SKU-90002",
        note: "Shelf empty ahead of weekend surge",
      },
    });
    expect(createRes.statusCode).toBe(201);
    const createdAlert = StockAlertSchema.parse(JSON.parse(createRes.payload));
    expect(createdAlert.branchId).toBe("BR-001");
    expect(createdAlert.sku).toBe("SKU-90002");
    expect(createdAlert.category).toBe("CRITICAL_LOW");
    expect(createdAlert.status).toBe("PENDING");
    expect(createdAlert.decidedBy).toBeNull();
    expect(createdAlert.decidedAt).toBeNull();
    expect(createdAlert.flaggedBy.role).toBe("staff");

    const damageRes = await app.inject({
      method: "POST",
      url: "/api/stock-alerts",
      headers: staffManamaHeader,
      payload: {
        branchId: "BR-001",
        sku: "SKU-90001",
        category: "DAMAGED_SHRINKAGE",
        note: "Two cartons damaged during morning unload",
      },
    });
    expect(damageRes.statusCode).toBe(201);
    const damagedAlert = StockAlertSchema.parse(JSON.parse(damageRes.payload));
    expect(damagedAlert.category).toBe("DAMAGED_SHRINKAGE");

    const invalidCatRes = await app.inject({
      method: "POST",
      url: "/api/stock-alerts",
      headers: staffManamaHeader,
      payload: {
        branchId: "BR-001",
        sku: "SKU-90001",
        category: "INVALID_CATEGORY",
        note: "Should fail category validation",
      },
    });
    expect(invalidCatRes.statusCode).toBe(400);

    const createHiddRes = await app.inject({
      method: "POST",
      url: "/api/stock-alerts",
      headers: staffHiddHeader,
      payload: {
        branchId: "BR-005",
        sku: "SKU-90001",
        category: "COUNT_MISMATCH",
        note: "Physical shelf count 6 units short vs system",
      },
    });
    expect(createHiddRes.statusCode).toBe(201);
    const hiddAlert = StockAlertSchema.parse(JSON.parse(createHiddRes.payload));
    expect(hiddAlert.category).toBe("COUNT_MISMATCH");

    const createOtherRes = await app.inject({
      method: "POST",
      url: "/api/stock-alerts",
      headers: staffIsaHeader,
      payload: {
        branchId: "BR-009",
        sku: "SKU-90002",
        category: "OTHER",
        note: "Chiller thermostat fluctuating near dairy display",
      },
    });
    expect(createOtherRes.statusCode).toBe(201);
    const isaOtherAlert = StockAlertSchema.parse(JSON.parse(createOtherRes.payload));
    expect(isaOtherAlert.category).toBe("OTHER");
    expect(isaOtherAlert.branchId).toBe("BR-009");

    // 4. GET /api/stock-alerts allows staff & manager (branch-scoped) vs network for admin, and rejects out-of-scope ?branchId=
    const staffGetRes = await app.inject({ method: "GET", url: "/api/stock-alerts", headers: staffManamaHeader });
    expect(staffGetRes.statusCode).toBe(200);
    const staffList = StockAlertListSchema.parse(JSON.parse(staffGetRes.payload));
    expect(staffList.alerts.map((a) => a.id).sort()).toEqual([createdAlert.id, damagedAlert.id].sort());
    expect(staffList.alerts.some((a) => a.branchId === "BR-005")).toBe(false);

    const staffOwnBranchQueryRes = await app.inject({
      method: "GET",
      url: "/api/stock-alerts?branchId=BR-001",
      headers: staffManamaHeader,
    });
    expect(staffOwnBranchQueryRes.statusCode).toBe(200);
    expect(StockAlertListSchema.parse(JSON.parse(staffOwnBranchQueryRes.payload)).alerts).toHaveLength(2);

    const staffOutOfScopeQueryRes = await app.inject({
      method: "GET",
      url: "/api/stock-alerts?branchId=BR-005",
      headers: staffManamaHeader,
    });
    expect(staffOutOfScopeQueryRes.statusCode).toBe(403);

    const mgrOutOfScopeQueryRes = await app.inject({
      method: "GET",
      url: "/api/stock-alerts?branchId=BR-005",
      headers: managerManamaHeader,
    });
    expect(mgrOutOfScopeQueryRes.statusCode).toBe(403);

    const mgrList = StockAlertListSchema.parse(
      JSON.parse((await app.inject({ method: "GET", url: "/api/stock-alerts", headers: managerManamaHeader })).payload),
    );
    expect(mgrList.alerts.map((a) => a.id).sort()).toEqual([createdAlert.id, damagedAlert.id].sort());
    expect(mgrList.alerts.some((a) => a.branchId === "BR-009")).toBe(false);

    const mgrHiddList = StockAlertListSchema.parse(
      JSON.parse((await app.inject({ method: "GET", url: "/api/stock-alerts", headers: managerHiddHeader })).payload),
    );
    expect(mgrHiddList.alerts.map((a) => a.id)).toEqual([hiddAlert.id]);

    const adminList = StockAlertListSchema.parse(
      JSON.parse((await app.inject({ method: "GET", url: "/api/stock-alerts", headers: adminHeader })).payload),
    );
    expect(adminList.alerts.map((a) => a.id).sort()).toEqual(
      [createdAlert.id, damagedAlert.id, hiddAlert.id, isaOtherAlert.id].sort(),
    );
    expect(new Set(adminList.alerts.filter((a) => a.status === "PENDING").map((a) => a.branchId))).toEqual(
      new Set(["BR-001", "BR-005", "BR-009"]),
    );

    const adminHiddFiltered = StockAlertListSchema.parse(
      JSON.parse((await app.inject({ method: "GET", url: "/api/stock-alerts?branchId=BR-005", headers: adminHeader })).payload),
    );
    expect(adminHiddFiltered.alerts.map((a) => a.id)).toEqual([hiddAlert.id]);

    // 5. Staff cannot approve or reject -> 403
    const staffDecideRes = await app.inject({
      method: "PATCH",
      url: `/api/stock-alerts/${createdAlert.id}/approve`,
      headers: staffManamaHeader,
    });
    expect(staffDecideRes.statusCode).toBe(403);

    // 6. Out-of-scope manager cannot decide BR-001 alert -> 403
    const outOfScopeMgrRes = await app.inject({
      method: "PATCH",
      url: `/api/stock-alerts/${createdAlert.id}/approve`,
      headers: managerHiddHeader,
    });
    expect(outOfScopeMgrRes.statusCode).toBe(403);

    // 7. In-scope manager approves BR-001 alert -> 200 with attribution, and staff sees resolution via GET /api/stock-alerts
    const approveRes = await app.inject({
      method: "PATCH",
      url: `/api/stock-alerts/${createdAlert.id}/approve`,
      headers: managerManamaHeader,
    });
    expect(approveRes.statusCode).toBe(200);
    const approvedAlert = StockAlertSchema.parse(JSON.parse(approveRes.payload));
    expect(approvedAlert.status).toBe("APPROVED");
    expect(approvedAlert.decidedBy?.role).toBe("manager");
    expect(approvedAlert.decidedAt).toBeTruthy();

    const staffAfterDecisionList = StockAlertListSchema.parse(
      JSON.parse((await app.inject({ method: "GET", url: "/api/stock-alerts", headers: staffManamaHeader })).payload),
    );
    const staffResolvedView = staffAfterDecisionList.alerts.find((a) => a.id === createdAlert.id);
    expect(staffResolvedView?.status).toBe("APPROVED");
    expect(staffResolvedView?.category).toBe("CRITICAL_LOW");
    expect(staffResolvedView?.decidedBy?.name).toBe(approvedAlert.decidedBy?.name);

    // 8. Once decided, alert is immutable — repeat approve or reject returns 409 Conflict
    const repeatRejectRes = await app.inject({
      method: "PATCH",
      url: `/api/stock-alerts/${createdAlert.id}/reject`,
      headers: managerManamaHeader,
    });
    expect(repeatRejectRes.statusCode).toBe(409);

    const adminOverwriteRes = await app.inject({
      method: "PATCH",
      url: `/api/stock-alerts/${createdAlert.id}/approve`,
      headers: adminHeader,
    });
    expect(adminOverwriteRes.statusCode).toBe(409);

    // Confirm persisted status did not mutate
    const afterList = StockAlertListSchema.parse(
      JSON.parse((await app.inject({ method: "GET", url: "/api/stock-alerts", headers: adminHeader })).payload),
    );
    const persisted = afterList.alerts.find((a) => a.id === createdAlert.id);
    expect(persisted?.status).toBe("APPROVED");
    expect(persisted?.decidedAt).toBe(approvedAlert.decidedAt);

    // 9. Admin can decide alerts from any branch (BR-005 Hidd, BR-009 Isa Town OTHER) -> 200, then immutable -> 409
    const adminRejectRes = await app.inject({
      method: "PATCH",
      url: `/api/stock-alerts/${hiddAlert.id}/reject`,
      headers: adminHeader,
    });
    expect(adminRejectRes.statusCode).toBe(200);
    expect(StockAlertSchema.parse(JSON.parse(adminRejectRes.payload)).status).toBe("REJECTED");

    const adminApproveIsaRes = await app.inject({
      method: "PATCH",
      url: `/api/stock-alerts/${isaOtherAlert.id}/approve`,
      headers: adminHeader,
    });
    expect(adminApproveIsaRes.statusCode).toBe(200);
    const approvedIsa = StockAlertSchema.parse(JSON.parse(adminApproveIsaRes.payload));
    expect(approvedIsa.status).toBe("APPROVED");
    expect(approvedIsa.category).toBe("OTHER");
    expect(approvedIsa.decidedBy?.role).toBe("admin");

    const retryApproveHidd = await app.inject({
      method: "PATCH",
      url: `/api/stock-alerts/${hiddAlert.id}/approve`,
      headers: managerHiddHeader,
    });
    expect(retryApproveHidd.statusCode).toBe(409);

    // 10. Nonexistent ID -> 404
    const missingRes = await app.inject({
      method: "PATCH",
      url: "/api/stock-alerts/alt_missing/approve",
      headers: adminHeader,
    });
    expect(missingRes.statusCode).toBe(404);
  });
});

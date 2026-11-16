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
    const mgrManama = await createUser(repo, "manager", ["BR-001"]);
    const mgrHidd = await createUser(repo, "manager", ["BR-005"]);
    const admin = await createUser(repo, "admin", []);

    staffManamaHeader = (await loginAs(app, staffManama.user.email, staffManama.password)).authHeader;
    staffHiddHeader = (await loginAs(app, staffHidd.user.email, staffHidd.password)).authHeader;
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

    // 3. Own-branch staff creates PENDING critical stock alerts in BR-001 and BR-005 -> 201
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
    expect(createdAlert.status).toBe("PENDING");
    expect(createdAlert.decidedBy).toBeNull();
    expect(createdAlert.decidedAt).toBeNull();
    expect(createdAlert.flaggedBy.role).toBe("staff");

    const createHiddRes = await app.inject({
      method: "POST",
      url: "/api/stock-alerts",
      headers: staffHiddHeader,
      payload: {
        branchId: "BR-005",
        sku: "SKU-90001",
        note: "Critical display gap in Hidd",
      },
    });
    expect(createHiddRes.statusCode).toBe(201);
    const hiddAlert = StockAlertSchema.parse(JSON.parse(createHiddRes.payload));

    // 4. GET /api/stock-alerts respects branch scoping for staff & manager vs full list for admin
    const staffList = StockAlertListSchema.parse(
      JSON.parse((await app.inject({ method: "GET", url: "/api/stock-alerts", headers: staffManamaHeader })).payload),
    );
    expect(staffList.alerts.map((a) => a.id)).toEqual([createdAlert.id]);

    const mgrList = StockAlertListSchema.parse(
      JSON.parse((await app.inject({ method: "GET", url: "/api/stock-alerts", headers: managerManamaHeader })).payload),
    );
    expect(mgrList.alerts.map((a) => a.id)).toEqual([createdAlert.id]);

    const adminList = StockAlertListSchema.parse(
      JSON.parse((await app.inject({ method: "GET", url: "/api/stock-alerts", headers: adminHeader })).payload),
    );
    expect(adminList.alerts.map((a) => a.id).sort()).toEqual([createdAlert.id, hiddAlert.id].sort());

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

    // 7. In-scope manager approves BR-001 alert -> 200 with attribution
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

    // 9. Admin can reject remaining Hidd alert -> 200, then immutable -> 409
    const adminRejectRes = await app.inject({
      method: "PATCH",
      url: `/api/stock-alerts/${hiddAlert.id}/reject`,
      headers: adminHeader,
    });
    expect(adminRejectRes.statusCode).toBe(200);
    expect(StockAlertSchema.parse(JSON.parse(adminRejectRes.payload)).status).toBe("REJECTED");

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

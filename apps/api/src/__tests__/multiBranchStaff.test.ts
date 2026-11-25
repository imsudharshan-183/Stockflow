import { StoreProductListSchema, StockAlertListSchema, StockAlertSchema, UserSchema } from "@stockflow/core";
import { describe, expect, it } from "vitest";
import { resolveStaffActiveBranch } from "../../../web/src/hooks/staffBranchScope.js";
import { InMemoryRepository } from "../repositories/memory.js";
import { buildTestApp, createUser, loginAs } from "../test/dualRepo.js";
import { SEED_USERS, bearer, tokenFor } from "../test/helpers.js";

describe("Multi-branch staff assignment, switching, and scoping", () => {
  it("resolves active staff branch to first assigned by default, switches within scope, and rejects unassigned", () => {
    expect(resolveStaffActiveBranch([], null)).toBeNull();
    expect(resolveStaffActiveBranch(["BR-001", "BR-002"], null)).toBe("BR-001");
    expect(resolveStaffActiveBranch(["BR-001", "BR-002"], "BR-002")).toBe("BR-002");
    expect(resolveStaffActiveBranch(["BR-001", "BR-002"], "BR-005")).toBe("BR-001");
  });

  it("allows admins to assign 2+ branches to staff and lets staff switch branches while blocking unassigned ones", async () => {
    const repo = InMemoryRepository.create();
    const { app } = await buildTestApp(repo);
    try {
      const adminAuth = bearer(tokenFor(app, SEED_USERS.admin));

      // 1. Admin creates a staff user assigned to 2 branches via POST /api/users
      const createStaffRes = await app.inject({
        method: "POST",
        url: "/api/users",
        headers: adminAuth,
        payload: {
          name: "Multi Branch Floor Staff",
          email: "multi.staff@stockflow.test",
          password: "StaffPassword1!",
          role: "staff",
          branchIds: ["BR-001", "BR-002"],
        },
      });
      expect(createStaffRes.statusCode).toBe(201);
      const createdStaff = UserSchema.parse(JSON.parse(createStaffRes.payload));
      expect(createdStaff.role).toBe("staff");
      expect(createdStaff.branchIds).toEqual(["BR-001", "BR-002"]);

      // Also verify an existing single-branch staff can be updated to 2+ branches via PATCH /api/users/:id
      const singleStaff = await createUser(repo, "staff", ["BR-003"], {
        email: "upgrade.staff@stockflow.test",
      });
      const patchStaffRes = await app.inject({
        method: "PATCH",
        url: `/api/users/${singleStaff.user.id}`,
        headers: adminAuth,
        payload: { branchIds: ["BR-003", "BR-004"] },
      });
      expect(patchStaffRes.statusCode).toBe(200);
      expect(UserSchema.parse(JSON.parse(patchStaffRes.payload)).branchIds).toEqual(["BR-003", "BR-004"]);

      // Seed an alert at an out-of-scope branch (BR-005) using another staff account so we verify isolation
      const hiddStaff = await createUser(repo, "staff", ["BR-005"], {
        email: "hidd.staff@stockflow.test",
      });
      const hiddAuth = (await loginAs(app, hiddStaff.user.email, hiddStaff.password)).authHeader;
      const hiddAlertRes = await app.inject({
        method: "POST",
        url: "/api/stock-alerts",
        headers: hiddAuth,
        payload: { branchId: "BR-005", sku: "SKU-00001", note: "Out-of-scope BR-005 alert" },
      });
      expect(hiddAlertRes.statusCode).toBe(201);

      // 2. Log in as the 2-branch staff user (BR-001 + BR-002)
      const multiAuth = (await loginAs(app, createdStaff.email, "StaffPassword1!")).authHeader;

      // Default catalog inventory call resolves to first assigned branch (BR-001)
      const defaultInvRes = await app.inject({
        method: "GET",
        url: "/api/catalog/products?page=1&limit=5",
        headers: multiAuth,
      });
      expect(defaultInvRes.statusCode).toBe(200);
      expect(defaultInvRes.json().products[0]).not.toHaveProperty("cost");
      expect(defaultInvRes.json().products[0]).not.toHaveProperty("price");
      const defaultInv = StoreProductListSchema.parse(JSON.parse(defaultInvRes.payload));
      expect(defaultInv.branchSummary?.branch.id).toBe("BR-001");

      // Switching to the second assigned branch (BR-002) returns BR-002 inventory
      const br2InvRes = await app.inject({
        method: "GET",
        url: "/api/catalog/products?page=1&limit=5&branch=BR-002",
        headers: multiAuth,
      });
      expect(br2InvRes.statusCode).toBe(200);
      const br2Inv = StoreProductListSchema.parse(JSON.parse(br2InvRes.payload));
      expect(br2Inv.branchSummary?.branch.id).toBe("BR-002");

      // Viewing inventory for an unassigned branch (BR-005) is forbidden (403)
      const oosInvRes = await app.inject({
        method: "GET",
        url: "/api/catalog/products?page=1&limit=5&branch=BR-005",
        headers: multiAuth,
      });
      expect(oosInvRes.statusCode).toBe(403);

      // 3. Flagging stock succeeds for BOTH BR-001 and BR-002 and stays scoped per active branch
      const flagBr1Res = await app.inject({
        method: "POST",
        url: "/api/stock-alerts",
        headers: multiAuth,
        payload: {
          branchId: "BR-001",
          sku: "SKU-00001",
          category: "CRITICAL_LOW",
          note: "CBD shelf low",
        },
      });
      expect(flagBr1Res.statusCode).toBe(201);
      const alertBr1 = StockAlertSchema.parse(JSON.parse(flagBr1Res.payload));
      expect(alertBr1.branchId).toBe("BR-001");

      const flagBr2Res = await app.inject({
        method: "POST",
        url: "/api/stock-alerts",
        headers: multiAuth,
        payload: {
          branchId: "BR-002",
          sku: "SKU-00002",
          category: "COUNT_MISMATCH",
          note: "Juffair count off by 3",
        },
      });
      expect(flagBr2Res.statusCode).toBe(201);
      const alertBr2 = StockAlertSchema.parse(JSON.parse(flagBr2Res.payload));
      expect(alertBr2.branchId).toBe("BR-002");

      // Flagging an unassigned branch (BR-005) fails with 403
      const oosFlagRes = await app.inject({
        method: "POST",
        url: "/api/stock-alerts",
        headers: multiAuth,
        payload: {
          branchId: "BR-005",
          sku: "SKU-00001",
          category: "CRITICAL_LOW",
          note: "Unauthorized branch flag attempt",
        },
      });
      expect(oosFlagRes.statusCode).toBe(403);

      // Viewing alerts returns only assigned branches and filters cleanly per switched branch
      const allScopedAlerts = StockAlertListSchema.parse(
        JSON.parse(
          (await app.inject({ method: "GET", url: "/api/stock-alerts", headers: multiAuth }))
            .payload,
        ),
      );
      expect(allScopedAlerts.alerts.map((a) => a.branchId).sort()).toEqual(["BR-001", "BR-002"]);
      expect(allScopedAlerts.alerts.some((a) => a.branchId === "BR-005")).toBe(false);

      const br2AlertsOnly = StockAlertListSchema.parse(
        JSON.parse(
          (
            await app.inject({
              method: "GET",
              url: "/api/stock-alerts?branchId=BR-002",
              headers: multiAuth,
            })
          ).payload,
        ),
      );
      expect(br2AlertsOnly.alerts.map((a) => a.id)).toEqual([alertBr2.id]);

      const oosAlertsRes = await app.inject({
        method: "GET",
        url: "/api/stock-alerts?branchId=BR-005",
        headers: multiAuth,
      });
      expect(oosAlertsRes.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});

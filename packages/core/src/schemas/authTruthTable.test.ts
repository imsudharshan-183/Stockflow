import { describe, expect, it } from "vitest";
import {
  PermissionActionSchema,
  RoleSchema,
  can,
  canManageRole,
  scopeBranches,
  type PermissionAction,
  type Role,
  type User,
} from "./auth.js";

const makeUser = (role: Role, branchIds: string[]): User => ({
  id: `usr_${role}`,
  name: `Test ${role}`,
  email: `${role}@stockflow.test`,
  role,
  branchIds,
  isActive: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastLoginAt: null,
});

const EXPECTED_PERMISSIONS: Record<Role, readonly PermissionAction[]> = {
  admin: PermissionActionSchema.options.filter((p) => p !== "stock:flag"),
  manager: [
    "recommendations:read",
    "recommendations:decide",
    "audit:read",
    "dashboard:financial:scoped",
    "dashboard:operational:scoped",
    "catalog:view",
    "sales:enter",
    "orders:receive",
    "stock:flag:decide",
  ],
  staff: ["sales:enter", "recommendations:read", "catalog:view", "orders:receive", "stock:flag"],
};

describe("RBAC Truth Tables (packages/core)", () => {
  const roles = RoleSchema.options;
  const actions = PermissionActionSchema.options;

  it("can(role, action) matches exhaustive permission matrix", () => {
    for (const role of roles) {
      const allowed = new Set<PermissionAction>(EXPECTED_PERMISSIONS[role]);
      for (const action of actions) {
        expect(can(role, action)).toBe(allowed.has(action));
      }
    }
  });

  it("canManageRole(actor, target) enforces strict hierarchy", () => {
    const expected: Record<Role, Record<Role, boolean>> = {
      admin: { admin: false, manager: true, staff: true },
      manager: { admin: false, manager: false, staff: true },
      staff: { admin: false, manager: false, staff: false },
    };
    for (const actor of roles) {
      for (const target of roles) {
        expect(canManageRole(actor, target)).toBe(expected[actor][target]);
      }
    }
  });

  it("scopeBranches(user, allBranchIds) returns all branches for admin and assigned for manager/staff", () => {
    const allBranches = ["BR-001", "BR-002", "BR-003"];
    expect(scopeBranches(makeUser("admin", ["BR-001"]), allBranches)).toEqual(allBranches);
    expect(scopeBranches(makeUser("admin", []), allBranches)).toEqual(allBranches);
    expect(scopeBranches(makeUser("manager", ["BR-001", "BR-002"]), allBranches)).toEqual([
      "BR-001",
      "BR-002",
    ]);
    expect(scopeBranches(makeUser("staff", ["BR-001"]), allBranches)).toEqual(["BR-001"]);
  });
});

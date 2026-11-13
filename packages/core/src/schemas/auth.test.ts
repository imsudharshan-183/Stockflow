import { describe, expect, it } from "vitest";
import {
  can,
  canManageRole,
  isBranchInScope,
  scopeBranches,
  CreateUserSchema,
  UserSchema,
  type User,
} from "./auth.js";

describe("auth helpers and schemas", () => {
  it("enforces role permissions correctly", () => {
    // Admin permissions
    expect(can("admin", "recommendations:read")).toBe(true);
    expect(can("admin", "recommendations:decide")).toBe(true);
    expect(can("admin", "audit:read")).toBe(true);
    expect(can("admin", "users:manage")).toBe(true);
    expect(can("admin", "branches:view_all")).toBe(true);
    expect(can("admin", "products:manage")).toBe(true);

    // Manager permissions
    expect(can("manager", "recommendations:read")).toBe(true);
    expect(can("manager", "recommendations:decide")).toBe(true);
    expect(can("manager", "audit:read")).toBe(true);
    expect(can("manager", "users:manage")).toBe(false);
    expect(can("manager", "branches:view_all")).toBe(false);
    expect(can("manager", "products:manage")).toBe(false);

    // Staff permissions
    expect(can("staff", "recommendations:read")).toBe(true);
    expect(can("staff", "recommendations:decide")).toBe(false);
    expect(can("staff", "audit:read")).toBe(false);
    expect(can("staff", "users:manage")).toBe(false);
    expect(can("staff", "branches:view_all")).toBe(false);
    expect(can("staff", "products:manage")).toBe(false);
  });

  it("enforces role management hierarchy (strictly lower role)", () => {
    // Admin can manage manager and staff, but not other admins
    expect(canManageRole("admin", "manager")).toBe(true);
    expect(canManageRole("admin", "staff")).toBe(true);
    expect(canManageRole("admin", "admin")).toBe(false);

    // Manager cannot manage admin, manager, or staff (in v1 hierarchy rule: manager hierarchy = 2, staff = 1, but manager lacks users:manage)
    expect(canManageRole("manager", "admin")).toBe(false);
    expect(canManageRole("manager", "manager")).toBe(false);
    expect(canManageRole("staff", "staff")).toBe(false);
    expect(canManageRole("staff", "manager")).toBe(false);
  });

  it("scopes branches properly per role", () => {
    const allBranches = ["BR-1", "BR-2", "BR-3", "BR-4"];
    const adminUser: User = {
      id: "u1",
      name: "Admin",
      email: "admin@example.com",
      role: "admin",
      branchIds: ["BR-1"],
      isActive: true,
      createdAt: "2026-01-01T00:00:00Z",
    };
    const managerUser: User = {
      id: "u2",
      name: "Manager",
      email: "manager@example.com",
      role: "manager",
      branchIds: ["BR-2", "BR-3"],
      isActive: true,
      createdAt: "2026-01-01T00:00:00Z",
    };
    const staffUser: User = {
      id: "u3",
      name: "Staff",
      email: "staff@example.com",
      role: "staff",
      branchIds: ["BR-4"],
      isActive: true,
      createdAt: "2026-01-01T00:00:00Z",
    };

    expect(scopeBranches(adminUser, allBranches)).toEqual(allBranches);
    expect(scopeBranches(managerUser, allBranches)).toEqual(["BR-2", "BR-3"]);
    expect(scopeBranches(staffUser, allBranches)).toEqual(["BR-4"]);

    expect(isBranchInScope(adminUser, "BR-4")).toBe(true);
    expect(isBranchInScope(managerUser, "BR-2")).toBe(true);
    expect(isBranchInScope(managerUser, "BR-1")).toBe(false);
    expect(isBranchInScope(staffUser, "BR-4")).toBe(true);
    expect(isBranchInScope(staffUser, "BR-2")).toBe(false);
  });

  it("validates and transforms schemas", () => {
    const parsed = CreateUserSchema.parse({
      name: "Alice",
      email: "ALICE@EXAMPLE.COM",
      password: "password123",
      role: "manager",
      branchIds: ["BR-1"],
    });
    expect(parsed.email).toBe("alice@example.com");

    const validUser = UserSchema.safeParse({
      id: "u1",
      name: "Alice",
      email: "alice@example.com",
      role: "manager",
      branchIds: ["BR-1"],
      isActive: true,
      createdAt: "2026-01-01T00:00:00Z",
    });
    expect(validUser.success).toBe(true);
  });
});

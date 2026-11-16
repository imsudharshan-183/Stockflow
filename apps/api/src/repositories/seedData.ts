import { BAHRAIN_BRANCHES } from "@stockflow/core";
import bcryptjs from "bcryptjs";
import type { UserRecord } from "./userTypes.js";

const passwordHashCache = new Map<string, string>();

function cachedHash(password: string): string {
  const existing = passwordHashCache.get(password);
  if (existing) return existing;
  const computed = bcryptjs.hashSync(password, 10);
  passwordHashCache.set(password, computed);
  return computed;
}

function branchId(id: string): string {
  const found = BAHRAIN_BRANCHES.find((b) => b.id === id);
  if (!found) throw new Error(`Unknown branch ID ${id} in BAHRAIN_BRANCHES`);
  return found.id;
}

export function getInitialSeedUsers(adminPassword = "Admin@12345"): UserRecord[] {
  const adminHash = cachedHash(adminPassword);
  const managerHash = cachedHash("Manager@12345");
  const staffHash = cachedHash("Staff@12345");
  const now = "2026-01-01T00:00:00.000Z";

  return [
    {
      id: "usr_admin_01",
      name: "System Admin",
      email: "admin@stockflow.dev",
      passwordHash: adminHash,
      role: "admin",
      branchIds: [],
      isActive: true,
      createdAt: now,
    },
    {
      id: "usr_mgr_01",
      name: "Marcus Vance",
      email: "manager.manama@stockflow.dev",
      passwordHash: managerHash,
      role: "manager",
      branchIds: [branchId("BR-001"), branchId("BR-002")],
      isActive: true,
      createdAt: now,
    },
    {
      id: "usr_mgr_02",
      name: "Nadia Al-Dosari",
      email: "manager.regional@stockflow.dev",
      passwordHash: managerHash,
      role: "manager",
      branchIds: [
        branchId("BR-005"),
        branchId("BR-006"),
        branchId("BR-008"),
        branchId("BR-011"),
      ],
      isActive: true,
      createdAt: now,
    },
    {
      id: "usr_stf_01",
      name: "Alex Chen",
      email: "staff.manama@stockflow.dev",
      passwordHash: staffHash,
      role: "staff",
      branchIds: [branchId("BR-001")],
      isActive: true,
      createdAt: now,
    },
    {
      id: "usr_stf_02",
      name: "Yusuf Al-Mahmood",
      email: "staff.juffair@stockflow.dev",
      passwordHash: staffHash,
      role: "staff",
      branchIds: [branchId("BR-002")],
      isActive: true,
      createdAt: now,
    },
    {
      id: "usr_stf_03",
      name: "Mariam Al-Mannai",
      email: "staff.hidd@stockflow.dev",
      passwordHash: staffHash,
      role: "staff",
      branchIds: [branchId("BR-005")],
      isActive: true,
      createdAt: now,
    },
  ];
}

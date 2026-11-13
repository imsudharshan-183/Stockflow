import bcryptjs from "bcryptjs";
import type { UserRecord } from "./userTypes.js";

export function getInitialSeedUsers(adminPassword = "Admin@12345"): UserRecord[] {
  const adminHash = bcryptjs.hashSync(adminPassword, 10);
  const managerHash = bcryptjs.hashSync("Manager@12345", 10);
  const staffHash = bcryptjs.hashSync("Staff@12345", 10);
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
      email: "manager.midwest@stockflow.dev",
      passwordHash: managerHash,
      role: "manager",
      branchIds: ["BR-001", "BR-002"],
      isActive: true,
      createdAt: now,
    },
    {
      id: "usr_mgr_02",
      name: "Sarah Connor",
      email: "manager.west@stockflow.dev",
      passwordHash: managerHash,
      role: "manager",
      branchIds: ["BR-005", "BR-006", "BR-008", "BR-011"],
      isActive: true,
      createdAt: now,
    },
    {
      id: "usr_stf_01",
      name: "Alex Chen",
      email: "staff.chicago@stockflow.dev",
      passwordHash: staffHash,
      role: "staff",
      branchIds: ["BR-001"],
      isActive: true,
      createdAt: now,
    },
    {
      id: "usr_stf_02",
      name: "Jordan Bell",
      email: "staff.lincoln@stockflow.dev",
      passwordHash: staffHash,
      role: "staff",
      branchIds: ["BR-002"],
      isActive: true,
      createdAt: now,
    },
    {
      id: "usr_stf_03",
      name: "Elena Gomez",
      email: "staff.santamonica@stockflow.dev",
      passwordHash: staffHash,
      role: "staff",
      branchIds: ["BR-005"],
      isActive: true,
      createdAt: now,
    },
  ];
}

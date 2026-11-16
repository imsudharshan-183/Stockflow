import { z } from "zod";

export const RoleSchema = z.enum(["admin", "manager", "staff"]);
export type Role = z.infer<typeof RoleSchema>;

export const ROLE_HIERARCHY: Record<Role, number> = {
  admin: 3,
  manager: 2,
  staff: 1,
};

export const PermissionActionSchema = z.enum([
  "recommendations:read",
  "recommendations:decide",
  "audit:read",
  "users:manage",
  "branches:view_all",
  "products:manage",
  "dashboard:financial:network",
  "dashboard:financial:scoped",
  "dashboard:operational:scoped",
  "catalog:view",
  "sales:enter",
  // DECISION: Strict separation of duties — store staff can flag floor shortages in their own branch
  // (`stock:flag`), while only scoped managers/admins can decide escalations (`stock:flag:decide`).
  "stock:flag",
  "stock:flag:decide",
]);
export type PermissionAction = z.infer<typeof PermissionActionSchema>;

const ROLE_PERMISSIONS: Record<Role, ReadonlySet<PermissionAction>> = {
  admin: new Set([
    "recommendations:read",
    "recommendations:decide",
    "audit:read",
    "users:manage",
    "branches:view_all",
    "products:manage",
    "dashboard:financial:network",
    "dashboard:financial:scoped",
    "dashboard:operational:scoped",
    "catalog:view",
    "sales:enter",
    "stock:flag:decide",
  ]),
  manager: new Set([
    "recommendations:read",
    "recommendations:decide",
    "audit:read",
    "dashboard:financial:scoped",
    "dashboard:operational:scoped",
    "catalog:view",
    "sales:enter",
    "stock:flag:decide",
  ]),
  staff: new Set([
    "recommendations:read",
    "catalog:view",
    "stock:flag",
  ]),
};

export function can(role: Role, action: PermissionAction): boolean {
  return ROLE_PERMISSIONS[role]?.has(action) ?? false;
}

export function canManageRole(actorRole: Role, targetRole: Role): boolean {
  return ROLE_HIERARCHY[actorRole] > ROLE_HIERARCHY[targetRole];
}

export function scopeBranches(
  user: { role: Role; branchIds: readonly string[] | string[] },
  allBranchIds: readonly string[] | string[],
): string[] {
  if (user.role === "admin") {
    return [...allBranchIds];
  }
  return [...user.branchIds];
}

export function isBranchInScope(
  user: { role: Role; branchIds: readonly string[] | string[] },
  branchId: string,
): boolean {
  if (user.role === "admin") return true;
  return user.branchIds.includes(branchId);
}

export const UserSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email().toLowerCase(),
  role: RoleSchema,
  branchIds: z.array(z.string()),
  isActive: z.boolean(),
  createdAt: z.string().min(1),
  lastLoginAt: z.string().nullable().optional(),
});
export type User = z.infer<typeof UserSchema>;

export const LoginRequestSchema = z.object({
  email: z.string().min(1).toLowerCase(),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.object({
  user: UserSchema,
  token: z.string().min(1),
  expiresIn: z.number().optional(),
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

export const CreateUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email().toLowerCase(),
  password: z.string().min(6, "Password must be at least 6 characters"),
  role: RoleSchema,
  branchIds: z.array(z.string()),
});
export type CreateUser = z.infer<typeof CreateUserSchema>;

export const UpdateUserSchema = z.object({
  name: z.string().min(1).optional(),
  role: RoleSchema.optional(),
  branchIds: z.array(z.string()).optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(6).optional(),
});
export type UpdateUser = z.infer<typeof UpdateUserSchema>;

export const UserListSchema = z.object({
  users: z.array(UserSchema),
});
export type UserList = z.infer<typeof UserListSchema>;

export const ActedBySchema = z.object({
  userId: z.string().min(1),
  name: z.string().min(1),
  role: RoleSchema,
});
export type ActedBy = z.infer<typeof ActedBySchema>;

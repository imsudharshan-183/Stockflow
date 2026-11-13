import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  CreateUserSchema,
  ErrorBodySchema,
  UpdateUserSchema,
  UserListSchema,
  UserSchema,
  canManageRole,
} from "@stockflow/core";
import type { AuthContext } from "../plugins/auth.js";
import { toPublicUser, type AuthService } from "../services/authService.js";
import type { UserRepository } from "../repositories/userTypes.js";

const ResetPasswordSchema = z.object({
  password: z.string().min(6, "Password must be at least 6 characters"),
});

export function registerUsersRoutes(
  app: FastifyInstance,
  userRepo: UserRepository,
  authService: AuthService,
  authGuards: AuthContext,
): void {
  // All user management routes require users:manage permission (admin)
  app.register(async (adminScope) => {
    adminScope.addHook("preHandler", authGuards.requirePermission("users:manage"));

    adminScope.get("/users", async () => {
      const records = await userRepo.list();
      return UserListSchema.parse({
        users: records.map((r) => toPublicUser(r)),
      });
    });

    adminScope.post("/users", async (request, reply) => {
      const parsed = CreateUserSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send(ErrorBodySchema.parse({ error: parsed.error.issues[0]?.message || "Invalid input" }));
      }

      const input = parsed.data;
      if (!canManageRole(request.currentUser.role, input.role)) {
        return reply.code(403).send(
          ErrorBodySchema.parse({ error: "Cannot create user with role equal to or higher than yours" }),
        );
      }

      const existing = await userRepo.findByEmail(input.email);
      if (existing) {
        return reply.code(409).send(ErrorBodySchema.parse({ error: "Email already in use" }));
      }

      const passwordHash = await authService.hashPassword(input.password);
      const created = await userRepo.create({
        name: input.name,
        email: input.email,
        passwordHash,
        role: input.role,
        branchIds: input.branchIds,
        isActive: true,
      });

      return reply.code(201).send(UserSchema.parse(toPublicUser(created)));
    });

    adminScope.patch("/users/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = UpdateUserSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send(ErrorBodySchema.parse({ error: parsed.error.issues[0]?.message || "Invalid input" }));
      }

      const target = await userRepo.findById(id);
      if (!target) {
        return reply.code(404).send(ErrorBodySchema.parse({ error: "User not found" }));
      }

      if (!canManageRole(request.currentUser.role, target.role)) {
        return reply.code(403).send(
          ErrorBodySchema.parse({ error: "Cannot modify a user with role equal to or higher than yours" }),
        );
      }

      const input = parsed.data;
      if (input.role && !canManageRole(request.currentUser.role, input.role)) {
        return reply.code(403).send(
          ErrorBodySchema.parse({ error: "Cannot assign role equal to or higher than yours" }),
        );
      }

      let passwordHash: string | undefined;
      if (input.password) {
        passwordHash = await authService.hashPassword(input.password);
      }

      const updated = await userRepo.update(id, {
        ...(input.name ? { name: input.name } : {}),
        ...(input.role ? { role: input.role } : {}),
        ...(input.branchIds ? { branchIds: input.branchIds } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(passwordHash ? { passwordHash } : {}),
      });

      if (!updated) {
        return reply.code(404).send(ErrorBodySchema.parse({ error: "User not found" }));
      }

      if (input.isActive === false) {
        await userRepo.deleteRefreshTokensForUser(id);
      }

      return UserSchema.parse(toPublicUser(updated));
    });

    adminScope.post("/users/:id/reset-password", async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = ResetPasswordSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send(ErrorBodySchema.parse({ error: parsed.error.issues[0]?.message || "Invalid input" }));
      }

      const target = await userRepo.findById(id);
      if (!target) {
        return reply.code(404).send(ErrorBodySchema.parse({ error: "User not found" }));
      }

      if (!canManageRole(request.currentUser.role, target.role)) {
        return reply.code(403).send(
          ErrorBodySchema.parse({ error: "Cannot modify a user with role equal to or higher than yours" }),
        );
      }

      const passwordHash = await authService.hashPassword(parsed.data.password);
      await userRepo.update(id, { passwordHash });
      await userRepo.deleteRefreshTokensForUser(id);

      return { ok: true };
    });

    adminScope.delete("/users/:id", async (request, reply) => {
      const { id } = request.params as { id: string };
      const target = await userRepo.findById(id);
      if (!target) {
        return reply.code(404).send(ErrorBodySchema.parse({ error: "User not found" }));
      }

      if (!canManageRole(request.currentUser.role, target.role)) {
        return reply.code(403).send(
          ErrorBodySchema.parse({ error: "Cannot modify a user with role equal to or higher than yours" }),
        );
      }

      await userRepo.update(id, { isActive: false });
      await userRepo.deleteRefreshTokensForUser(id);
      return { ok: true };
    });
  });
}

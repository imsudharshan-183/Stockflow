import type { FastifyReply, FastifyRequest } from "fastify";
import {
  can,
  type PermissionAction,
  type Role,
  type User,
} from "@stockflow/core";
import type { Env } from "../config/env.js";
import { toPublicUser } from "../services/authService.js";
import type { UserRepository } from "../repositories/userTypes.js";

declare module "fastify" {
  interface FastifyRequest {
    currentUser: User;
  }
}

export const SYNTHETIC_ADMIN: User = {
  id: "usr_synthetic_admin",
  name: "System Admin",
  email: "admin@stockflow.dev",
  role: "admin",
  branchIds: [],
  isActive: true,
  createdAt: "2026-01-01T00:00:00.000Z",
};

export interface AuthContext {
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requirePermission: (
    action: PermissionAction,
  ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireRole: (
    roles: Role[],
  ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

export function createAuthGuards(env: Env, userRepo: UserRepository): AuthContext {
  const authenticate = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!env.AUTH_ENABLED) {
      request.currentUser = SYNTHETIC_ADMIN;
      return;
    }

    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "Authentication required" });
    }

    const token = authHeader.substring(7).trim();
    try {
      const decoded = await request.server.jwt.verify<{ sub: string; role: Role }>(token);
      const userRecord = await userRepo.findById(decoded.sub);
      if (!userRecord || !userRecord.isActive) {
        return reply.code(401).send({ error: "Invalid or inactive user" });
      }
      request.currentUser = toPublicUser(userRecord);
    } catch {
      return reply.code(401).send({ error: "Invalid or expired token" });
    }
  };

  const requirePermission = (action: PermissionAction) => {
    return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      await authenticate(request, reply);
      if (reply.sent) return;

      if (!can(request.currentUser.role, action)) {
        return reply.code(403).send({ error: "Forbidden: Insufficient permissions" });
      }
    };
  };

  const requireRole = (roles: Role[]) => {
    return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      await authenticate(request, reply);
      if (reply.sent) return;

      if (!roles.includes(request.currentUser.role)) {
        return reply.code(403).send({ error: "Forbidden: Role not authorized" });
      }
    };
  };

  return {
    authenticate,
    requirePermission,
    requireRole,
  };
}

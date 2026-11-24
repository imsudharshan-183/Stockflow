import type { FastifyInstance } from "fastify";
import {
  ErrorBodySchema,
  LoginRequestSchema,
  LoginResponseSchema,
} from "@stockflow/core";
import { AuthError, type AuthService } from "../services/authService.js";
import type { AuthContext } from "../plugins/auth.js";
import type { Env } from "../config/env.js";

const COOKIE_NAME = "stockflow_refresh";

function issueSessionResponse(
  app: FastifyInstance,
  reply: {
    setCookie: (name: string, value: string, options: Record<string, unknown>) => unknown;
  },
  env: Env,
  user: { id: string; email: string; role: string },
  refreshToken: string,
  expiresAt: Date,
) {
  const accessToken = app.jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    { expiresIn: env.ACCESS_TOKEN_TTL },
  );
  reply.setCookie(COOKIE_NAME, refreshToken, {
    httpOnly: true,
    path: "/api/auth",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires: expiresAt,
  });
  return LoginResponseSchema.parse({ user, token: accessToken });
}

export function registerAuthRoutes(
  app: FastifyInstance,
  authService: AuthService,
  authGuards: AuthContext,
  env: Env,
): void {
  // RBAC: Public (rate-limited 5 req/min; verifies credentials and sets HTTP-only refresh cookie).
  app.post(
    "/auth/login",
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      try {
        const parsed = LoginRequestSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send(ErrorBodySchema.parse({ error: "Invalid credentials" }));
        }

        const { user, refreshToken, expiresAt } = await authService.login(
          parsed.data.email,
          parsed.data.password,
        );
        return issueSessionResponse(app, reply, env, user, refreshToken, expiresAt);
      } catch (err) {
        if (err instanceof AuthError) {
          return reply.code(err.statusCode).send(ErrorBodySchema.parse({ error: err.message }));
        }
        return reply.code(500).send(ErrorBodySchema.parse({ error: "Authentication failed" }));
      }
    },
  );

  // RBAC: Public with valid refresh cookie/token (rotates refresh token and issues new access JWT).
  app.post("/auth/refresh", async (request, reply) => {
    try {
      const cookieToken = request.cookies[COOKIE_NAME];
      const body = request.body as { refreshToken?: string } | undefined;
      const refreshToken = cookieToken || body?.refreshToken;

      if (!refreshToken) {
        return reply.code(401).send(ErrorBodySchema.parse({ error: "Refresh token required" }));
      }

      const { user, newRefreshToken, expiresAt } = await authService.refresh(refreshToken);
      return issueSessionResponse(app, reply, env, user, newRefreshToken, expiresAt);
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(err.statusCode).send(ErrorBodySchema.parse({ error: err.message }));
      }
      return reply.code(401).send(ErrorBodySchema.parse({ error: "Token refresh failed" }));
    }
  });

  // RBAC: Public (revokes presented refresh cookie/token).
  app.post("/auth/logout", async (request, reply) => {
    const refreshToken = request.cookies[COOKIE_NAME];
    await authService.logout(refreshToken);
    reply.clearCookie(COOKIE_NAME, { path: "/api/auth" });
    return { ok: true };
  });

  // RBAC: Authenticated (any active role; returns current user session).
  app.get(
    "/auth/me",
    { preHandler: [authGuards.authenticate] },
    async (request) => {
      return { user: request.currentUser };
    },
  );
}

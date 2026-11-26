import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { readEnv, type Env } from "../config/env.js";
import { redactSecrets } from "../config/redact.js";
import { registerAuthRoutes } from "../routes/auth.js";
import { registerBriefRoute } from "../routes/brief.js";
import { registerBranchRoutes } from "../routes/branches.js";
import { registerCatalogRoutes } from "../routes/catalog.js";
import { registerLocationRoutes } from "../routes/locations.js";
import { registerOrderRoutes } from "../routes/orders.js";
import { registerSalesEntriesRoutes } from "../routes/salesEntries.js";
import { registerStockRoutes } from "../routes/stock.js";
import { registerStockAlertsRoutes } from "../routes/stockAlerts.js";
import { registerUsersRoutes } from "../routes/users.js";
import { AuthService } from "../services/authService.js";
import type { StockServices } from "../services/index.js";
import { createAuthGuards } from "./auth.js";
import { registerErrors } from "./errors.js";

declare module "fastify" {
  interface FastifyInstance {
    stockServices: StockServices;
  }
}

const LOCAL_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"] as const;

export async function buildApp(
  services: StockServices,
  envOverrides?: Partial<Env>,
  diagnostics?: { startupError?: string | null },
): Promise<FastifyInstance> {
  let env: Env;
  let startupError: string | null = diagnostics?.startupError
    ? redactSecrets(diagnostics.startupError)
    : null;
  try {
    env = readEnv();
  } catch (err) {
    if (!startupError && !envOverrides) {
      startupError = redactSecrets(
        err instanceof Error ? err.message : "startup configuration error",
      );
    }
    env = {
      PORT: 3001,
      HOST: "127.0.0.1",
      MONGODB_URI: "",
      AUTH_ENABLED: false,
      JWT_SECRET: "default-dev-secret",
      ACCESS_TOKEN_TTL: "15m",
      REFRESH_TOKEN_TTL: "7d",
      ADMIN_PASSWORD: "Admin@12345",
      WEB_ORIGIN: "",
      APPROVED_ACTIVE_DAYS: 3,
      REJECT_SNOOZE_DAYS: 3,
    };
  }
  if (envOverrides) {
    env = { ...env, ...envOverrides };
  }

  const app = Fastify({
    bodyLimit: 1_048_576,
    logger: { level: process.env.NODE_ENV === "test" ? "silent" : "info" },
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
  });

  const configuredOrigins = env.WEB_ORIGIN.split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  const allowedOrigins =
    process.env.NODE_ENV === "production"
      ? configuredOrigins
      : [...LOCAL_ORIGINS, ...configuredOrigins];

  // Production with WEB_ORIGIN unset is single-origin, so no CORS headers are emitted.
  if (allowedOrigins.length > 0) {
    await app.register(cors, {
      origin: allowedOrigins,
      credentials: true,
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    });
  }

  await app.register(cookie);
  await app.register(jwt, {
    secret: env.JWT_SECRET || "fallback-secret-for-development-and-testing-only",
  });
  await app.register(rateLimit, {
    global: false,
  });

  app.decorate("stockServices", services);
  registerErrors(app);

  const authService = new AuthService(services.userRepo);
  const authGuards = createAuthGuards(env, services.userRepo);

  await app.register(
    (scope) => {
      registerAuthRoutes(scope, authService, authGuards, env);
      registerBriefRoute(scope, services, authGuards, env);
      registerUsersRoutes(scope, services.userRepo, authService, authGuards);
      registerStockRoutes(scope, services, authGuards, { env, startupError });
      registerLocationRoutes(scope, services, authGuards);
      registerBranchRoutes(scope, services, authGuards);
      registerCatalogRoutes(scope, services, authGuards);
      registerSalesEntriesRoutes(scope, services, authGuards);
      registerStockAlertsRoutes(scope, services, authGuards);
      registerOrderRoutes(scope, services, authGuards);
    },
    { prefix: "/api" },
  );

  return app;
}

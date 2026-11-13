import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { readEnv, type Env } from "../config/env.js";
import { registerAuthRoutes } from "../routes/auth.js";
import { registerSalesEntriesRoutes } from "../routes/salesEntries.js";
import { registerStockRoutes } from "../routes/stock.js";
import { registerUsersRoutes } from "../routes/users.js";
import { AuthService } from "../services/authService.js";
import { createAuthGuards } from "./auth.js";
import { registerErrors } from "./errors.js";
import type { StockService } from "../services/stockService.js";

const LOCAL_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"] as const;

export async function buildApp(
  service: StockService,
  envOverrides?: Partial<Env>,
): Promise<FastifyInstance> {
  let env: Env;
  try {
    env = readEnv();
  } catch {
    env = {
      PORT: 3001,
      HOST: "127.0.0.1",
      MONGODB_URI: "",
      AUTH_ENABLED: false,
      JWT_SECRET: "default-dev-secret",
      ACCESS_TOKEN_TTL: "15m",
      REFRESH_TOKEN_TTL: "7d",
      ADMIN_PASSWORD: "Admin@12345",
    };
  }
  if (envOverrides) {
    env = { ...env, ...envOverrides };
  }

  const app = Fastify({ logger: { level: process.env.NODE_ENV === "test" ? "silent" : "info" } });

  // Production is one origin, so the browser does not need CORS. Local calls to the API port do.
  if (process.env.NODE_ENV !== "production") {
    await app.register(cors, {
      origin: [...LOCAL_ORIGINS],
      credentials: true,
    });
  }

  await app.register(cookie);
  await app.register(jwt, {
    secret: env.JWT_SECRET || "fallback-secret-for-development-and-testing-only",
  });
  await app.register(rateLimit, {
    global: false,
  });

  registerErrors(app);

  const authService = new AuthService(service.userRepo);
  const authGuards = createAuthGuards(env, service.userRepo);

  await app.register(
    (scope) => {
      registerAuthRoutes(scope, authService, authGuards, env);
      registerUsersRoutes(scope, service.userRepo, authService, authGuards);
      registerStockRoutes(scope, service, authGuards);
      registerSalesEntriesRoutes(scope, authGuards);
    },
    { prefix: "/api" },
  );

  return app;
}

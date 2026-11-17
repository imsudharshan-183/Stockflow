import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { loadDotenv, readEnv, type Env } from "./config/env.js";
import { formatFatalError } from "./config/redact.js";
import { buildApp } from "./plugins/app.js";
import { createRepository } from "./repositories/create.js";
import type { StockRepository } from "./repositories/types.js";
import { createStockServices, type StockServices } from "./services/index.js";

export interface RuntimeContext {
  app: FastifyInstance;
  env: Env;
  repo: StockRepository;
  services: StockServices;
}

const FATAL_HANDLERS_FLAG = Symbol.for("stockflow.api.fatalHandlersRegistered");

export function handleFatalError(
  error: unknown,
  exitFn: (code: number) => void = (code) => process.exit(code),
): void {
  console.error(formatFatalError(error));
  exitFn(1);
}

export function registerFatalHandlers(
  exitFn: (code: number) => void = (code) => process.exit(code),
): void {
  const proc = process as NodeJS.Process & { [FATAL_HANDLERS_FLAG]?: boolean };
  if (proc[FATAL_HANDLERS_FLAG]) return;
  proc[FATAL_HANDLERS_FLAG] = true;

  process.on("uncaughtException", (error) => {
    handleFatalError(error, exitFn);
  });
  process.on("unhandledRejection", (reason) => {
    handleFatalError(reason, exitFn);
  });
}

let cachedRuntimePromise: Promise<RuntimeContext> | null = null;

/**
 * Lazily constructs the Fastify server without awaiting MongoDB connectivity or dataset loading.
 */
export async function getApp(): Promise<RuntimeContext> {
  if (!cachedRuntimePromise) {
    cachedRuntimePromise = (async () => {
      loadDotenv();
      const env = readEnv();
      const repo = await createRepository(env.MONGODB_URI);
      const services = createStockServices(repo);
      const app = await buildApp(services, env);
      await app.ready();
      return { app, env, repo, services };
    })().catch((error: unknown) => {
      cachedRuntimePromise = null;
      throw error;
    });
  }
  return cachedRuntimePromise;
}

export function resetCachedAppForTests(): void {
  cachedRuntimePromise = null;
}

/**
 * Serverless request entrypoint for Vercel Functions / Services.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let runtime: RuntimeContext;
  try {
    runtime = await getApp();
  } catch (error) {
    handleFatalError(error);
    return;
  }

  await new Promise<void>((resolve) => {
    const done = () => resolve();
    res.once("finish", done);
    res.once("close", done);
    runtime.app.server.emit("request", req, res);
    if (res.writableEnded) {
      resolve();
    }
  });
}

function isMainEntrypoint(): boolean {
  if (process.env.VERCEL || process.env.NODE_ENV === "test") return false;
  if (!process.argv[1]) return true;
  try {
    return pathResolve(process.argv[1]) === pathResolve(fileURLToPath(import.meta.url));
  } catch {
    return true;
  }
}

async function startLocalServer(): Promise<void> {
  const startupStartedAt = performance.now();
  let runtime: RuntimeContext | null = null;
  try {
    runtime = await getApp();
    const { app, env, repo, services } = runtime;

    const shutdown = async () => {
      await app.close();
      await repo.close();
    };

    process.on("SIGINT", () => {
      void shutdown();
    });
    process.on("SIGTERM", () => {
      void shutdown();
    });

    await app.listen({ port: env.PORT, host: env.HOST });
    const listenMs = Math.round(performance.now() - startupStartedAt);
    console.log(
      `listening on ${env.HOST}:${env.PORT} (repository: ${services.repositoryKind()}) (${listenMs}ms)`,
    );
  } catch (error) {
    if (runtime) {
      await runtime.repo.close().catch(() => undefined);
    }
    handleFatalError(error);
  }
}

if (process.env.NODE_ENV !== "test") {
  registerFatalHandlers();
  if (isMainEntrypoint()) {
    void startLocalServer();
  }
}

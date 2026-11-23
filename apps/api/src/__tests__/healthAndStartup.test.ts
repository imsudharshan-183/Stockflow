import { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMissingRequiredEnvVars } from "../config/env.js";
import { formatFatalError, redactSecrets } from "../config/redact.js";
import handler, { getApp, handleFatalError, resetCachedAppForTests } from "../index.js";
import { buildApp } from "../plugins/app.js";
import { createRepository } from "../repositories/create.js";
import { InMemoryRepository } from "../repositories/memory.js";
import { MongoRepository } from "../repositories/mongo.js";
import { createStockServices } from "../services/index.js";

const FAKE_SECRETS = {
  mongoPass: "FakeMongoSecretPass!9911",
  mongoUser: "fake_mongo_user",
  jwt: "FakeJwtSecretSigningKey!7788",
  adminPw: "FakeAdminPassword!5566",
} as const;

const FAKE_MONGO_URI = `mongodb+srv://${FAKE_SECRETS.mongoUser}:${FAKE_SECRETS.mongoPass}@unreachable-cluster.invalid/stockflow_test?retryWrites=true`;

function assertNoSecrets(output: string): void {
  expect(output).not.toContain(FAKE_SECRETS.mongoPass);
  expect(output).not.toContain(FAKE_SECRETS.mongoUser);
  expect(output).not.toContain(FAKE_SECRETS.jwt);
  expect(output).not.toContain(FAKE_SECRETS.adminPw);
  expect(output).not.toContain("unreachable-cluster.invalid");
}

function invokeHandlerInMemory(url: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const reqSocket = new PassThrough();
    const req = new IncomingMessage(reqSocket as never);
    req.method = "GET";
    req.url = url;
    req.headers = { host: "127.0.0.1" };
    req.push(null);

    const res = new ServerResponse(req);
    const chunks: Buffer[] = [];
    const sink = new PassThrough();
    sink.on("data", (chunk: Buffer) => chunks.push(chunk));
    res.assignSocket(sink as never);

    res.on("finish", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const splitIdx = raw.indexOf("\r\n\r\n");
      const body = splitIdx >= 0 ? raw.slice(splitIdx + 4) : raw;
      resolve({ statusCode: res.statusCode, body });
    });

    handler(req, res).catch(reject);
  });
}

describe("Startup resilience, redaction, and health diagnostics", () => {
  const savedEnv = {
    MONGODB_URI: process.env.MONGODB_URI,
    JWT_SECRET: process.env.JWT_SECRET,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    AUTH_ENABLED: process.env.AUTH_ENABLED,
    VERCEL: process.env.VERCEL,
  };

  afterEach(async () => {
    vi.useRealTimers();
    const cached = await getApp().catch(() => null);
    resetCachedAppForTests();
    if (cached) {
      await cached.app.close().catch(() => undefined);
      await cached.repo.close().catch(() => undefined);
    }

    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  });

  it("responds on /api/health immediately when Mongo is unreachable without leaking secrets", async () => {
    process.env.MONGODB_URI = FAKE_MONGO_URI;
    process.env.JWT_SECRET = FAKE_SECRETS.jwt;
    process.env.ADMIN_PASSWORD = FAKE_SECRETS.adminPw;
    process.env.AUTH_ENABLED = "true";

    const t0 = performance.now();
    // Lazy repository construction does NOT connect to Mongo at module/startup time.
    const repo = await createRepository(FAKE_MONGO_URI);
    expect(repo.kind).toBe("mongo");

    const services = createStockServices(repo);
    const app = await buildApp(
      services,
      { AUTH_ENABLED: true, JWT_SECRET: FAKE_SECRETS.jwt, MONGODB_URI: FAKE_MONGO_URI },
      { startupError: `Boot warning on ${FAKE_MONGO_URI} using ${FAKE_SECRETS.jwt}` },
    );
    await app.ready();

    try {
      const res = await app.inject({ method: "GET", url: "/api/health" });
      const elapsedMs = performance.now() - t0;

      expect(res.statusCode).toBe(200);
      expect(elapsedMs).toBeLessThan(1500);
      const parsed = JSON.parse(res.body) as {
        status: string;
        repository: string;
        startupError: string | null;
        missingEnv: string[];
      };
      expect(parsed.status).toBe("ok");
      expect(parsed.repository).toBe("mongo");
      expect(parsed.startupError).toContain("mongodb://***");
      expect(parsed.startupError).toContain("[REDACTED]");
      expect(parsed.missingEnv).toEqual([]);
      assertNoSecrets(res.body);
    } finally {
      await app.close();
      await repo.close();
    }
  });

  it("caches GET /api/health/db for 30s, redacts DB error secrets, and recovers on ok ping", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-18T00:00:00Z"));

    process.env.MONGODB_URI = FAKE_MONGO_URI;
    process.env.JWT_SECRET = FAKE_SECRETS.jwt;
    process.env.ADMIN_PASSWORD = FAKE_SECRETS.adminPw;

    const repo = MongoRepository.createLazy(FAKE_MONGO_URI, "stockflow_test");
    const pingErr = new Error(
      `Server selection failed for ${FAKE_MONGO_URI} token=${FAKE_SECRETS.jwt} admin=${FAKE_SECRETS.adminPw}`,
    );
    pingErr.name = "MongoServerSelectionError";
    const pingSpy = vi.spyOn(repo, "ping").mockRejectedValueOnce(pingErr).mockResolvedValueOnce();

    const services = createStockServices(repo);
    const app = await buildApp(services, { AUTH_ENABLED: true, JWT_SECRET: FAKE_SECRETS.jwt });
    await app.ready();

    try {
      // 1. First failed ping returns 503 with redacted error message
      const firstErrRes = await app.inject({ method: "GET", url: "/api/health/db" });
      expect(firstErrRes.statusCode).toBe(503);
      const firstErrBody = JSON.parse(firstErrRes.body) as {
        db: string;
        name: string;
        message: string;
        missingEnv: string[];
      };
      expect(firstErrBody.db).toBe("error");
      expect(firstErrBody.name).toBe("MongoServerSelectionError");
      expect(firstErrBody.message).toContain("mongodb://***");
      expect(firstErrBody.missingEnv).toEqual([]);
      assertNoSecrets(firstErrRes.body);
      expect(pingSpy).toHaveBeenCalledTimes(1);

      // 2. Within 30s, cached response is returned without re-pinging
      vi.advanceTimersByTime(15_000);
      const cachedErrRes = await app.inject({ method: "GET", url: "/api/health/db" });
      expect(cachedErrRes.statusCode).toBe(503);
      expect(pingSpy).toHaveBeenCalledTimes(1);

      // 3. After 30s cache expiry, re-ping executes and caches { db: "ok" }
      vi.advanceTimersByTime(16_000);
      const okRes = await app.inject({ method: "GET", url: "/api/health/db" });
      expect(okRes.statusCode).toBe(200);
      expect(JSON.parse(okRes.body)).toEqual({ db: "ok", missingEnv: [] });
      expect(pingSpy).toHaveBeenCalledTimes(2);

      // Subsequent call within 30s hits ok cache
      const cachedOkRes = await app.inject({ method: "GET", url: "/api/health/db" });
      expect(cachedOkRes.statusCode).toBe(200);
      expect(pingSpy).toHaveBeenCalledTimes(2);
    } finally {
      pingSpy.mockRestore();
      await app.close();
    }
  });

  it("reports missing required environment variables by NAME only, never by value", async () => {
    delete process.env.MONGODB_URI;
    delete process.env.JWT_SECRET;
    process.env.ADMIN_PASSWORD = FAKE_SECRETS.adminPw;
    process.env.VERCEL = "1";

    expect(getMissingRequiredEnvVars(process.env)).toEqual(["MONGODB_URI", "JWT_SECRET"]);

    const repo = InMemoryRepository.create();
    const app = await buildApp(createStockServices(repo), {
      AUTH_ENABLED: false,
      JWT_SECRET: "",
    });
    await app.ready();
    try {
      const healthRes = await app.inject({ method: "GET", url: "/api/health" });
      expect(healthRes.statusCode).toBe(200);
      expect(JSON.parse(healthRes.body)).toEqual({
        status: "ok",
        repository: "memory",
        startupError: null,
        missingEnv: ["MONGODB_URI", "JWT_SECRET"],
      });
      assertNoSecrets(healthRes.body);

      const dbRes = await app.inject({ method: "GET", url: "/api/health/db" });
      expect(dbRes.statusCode).toBe(503);
      const dbBody = JSON.parse(dbRes.body) as { db: string; name: string; missingEnv: string[] };
      expect(dbBody.db).toBe("error");
      expect(dbBody.name).toBe("ConfigurationError");
      expect(dbBody.missingEnv).toEqual(["MONGODB_URI", "JWT_SECRET"]);
      assertNoSecrets(dbRes.body);
    } finally {
      await app.close();
      await repo.close();
    }
  });

  it("formats fatal startup errors as a single redacted line with name, message, and first 3 stack frames", () => {
    process.env.MONGODB_URI = FAKE_MONGO_URI;
    process.env.JWT_SECRET = FAKE_SECRETS.jwt;
    process.env.ADMIN_PASSWORD = FAKE_SECRETS.adminPw;

    const err = new Error(
      `Startup exploded\nuri=${FAKE_MONGO_URI}\njwt=${FAKE_SECRETS.jwt}\npw=${FAKE_SECRETS.adminPw}`,
    );
    err.name = "StartupConfigError";
    err.stack = [
      `StartupConfigError: ${err.message}`,
      `    at frameOne (file:///app/index.ts:10:1)`,
      `    at frameTwo (file:///app/env.ts:20:2?secret=${FAKE_SECRETS.jwt})`,
      `    at frameThree (file:///app/app.ts:30:3)`,
      `    at frameFour (file:///app/ignored.ts:40:4)`,
    ].join("\n");

    const envSnapshot: NodeJS.ProcessEnv = {
      MONGODB_URI: FAKE_MONGO_URI,
      JWT_SECRET: FAKE_SECRETS.jwt,
      ADMIN_PASSWORD: FAKE_SECRETS.adminPw,
    };

    const formatted = formatFatalError(err, envSnapshot);
    expect(formatted).not.toContain("\n");
    expect(formatted).toContain("StartupConfigError:");
    expect(formatted).toContain("frameOne");
    expect(formatted).toContain("frameTwo");
    expect(formatted).toContain("frameThree");
    expect(formatted).not.toContain("frameFour");
    assertNoSecrets(formatted);
    expect(redactSecrets(`Bearer ${FAKE_SECRETS.jwt}`, envSnapshot)).toBe("Bearer [REDACTED]");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = vi.fn();
    try {
      handleFatalError(err, exitSpy);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logged = String(errorSpy.mock.calls[0]?.[0] ?? "");
      expect(logged).not.toContain("\n");
      assertNoSecrets(logged);
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("handles requests cleanly when Vercel imports apps/api/src/index.ts with VERCEL=1 and unreachable Mongo", async () => {
    process.env.VERCEL = "1";
    process.env.MONGODB_URI = FAKE_MONGO_URI;
    process.env.JWT_SECRET = FAKE_SECRETS.jwt;
    process.env.ADMIN_PASSWORD = FAKE_SECRETS.adminPw;
    process.env.AUTH_ENABLED = "true";
    resetCachedAppForTests();

    const response = await invokeHandlerInMemory("/api/health");
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      status: string;
      repository: string;
      startupError: string | null;
      missingEnv: string[];
    };
    expect(body).toEqual({
      status: "ok",
      repository: "mongo",
      startupError: null,
      missingEnv: [],
    });
    assertNoSecrets(response.body);
  });
});

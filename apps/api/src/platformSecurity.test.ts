import { describe, expect, it, vi } from "vitest";
import type { Dataset } from "@stockflow/core";
import { buildApp } from "./plugins/app.js";
import { InMemoryRepository } from "./repositories/memory.js";
import { createStockServices } from "./services/index.js";
import { buildTestApp, createUser, smallSeededDataset } from "./test/dualRepo.js";
import { FixedDatasetRepository, TEST_JWT_SECRET, bearer, tokenFor } from "./test/helpers.js";

describe("Platform Security, CORS, Headers, Route Prefix & Cold-Start Perf", () => {
  it("sets Helmet security headers, enforces bodyLimit (413), and keeps /api/health & all routes under /api", async () => {
    const repo = InMemoryRepository.create();
    const { app } = await buildTestApp(repo);
    try {
      const health = await app.inject({ method: "GET", url: "/api/health" });
      expect(health.statusCode).toBe(200);
      expect(JSON.parse(health.body)).toEqual({ status: "ok", repository: "memory" });
      expect(health.headers["x-content-type-options"]).toBe("nosniff");
      expect(health.headers["x-frame-options"]).toBeTruthy();

      // Every registered route lives under /api
      const routeTree = app.printRoutes({ commonPrefix: true });
      expect(routeTree).toContain("└── api/");
      const nonApiRes = await app.inject({ method: "GET", url: "/health" });
      expect(nonApiRes.statusCode).toBe(404);

      // Oversized payload > 1 MiB -> 413
      const { user } = await createUser(repo, "admin", [], { email: "perf.admin@stockflow.test" });
      const bigPayload = "x".repeat(1_200_000);
      const tooBig = await app.inject({
        method: "POST",
        url: "/api/catalog/products",
        headers: {
          ...bearer(tokenFor(app, user)),
          "content-type": "application/json",
        },
        payload: JSON.stringify({ name: bigPayload }),
      });
      expect(tooBig.statusCode).toBe(413);
    } finally {
      await app.close();
      await repo.close();
    }
  });

  it("enforces CORS for WEB_ORIGIN in production and emits no CORS headers when WEB_ORIGIN is unset", async () => {
    const repo = InMemoryRepository.create();
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      // 1. Production with WEB_ORIGIN unset -> no CORS headers
      const noCors = await buildTestApp(repo, { WEB_ORIGIN: "" });
      const resNoCors = await noCors.app.inject({
        method: "GET",
        url: "/api/health",
        headers: { origin: "https://app.stockflow.example" },
      });
      expect(resNoCors.headers["access-control-allow-origin"]).toBeUndefined();
      await noCors.app.close();

      // 2. Production with WEB_ORIGIN set -> allowed origin gets header + credentials; disallowed gets none
      const withCors = await buildTestApp(repo, { WEB_ORIGIN: "https://app.stockflow.example" });
      const allowedRes = await withCors.app.inject({
        method: "OPTIONS",
        url: "/api/sales-entries/123",
        headers: {
          origin: "https://app.stockflow.example",
          "access-control-request-method": "PATCH",
        },
      });
      expect(allowedRes.headers["access-control-allow-origin"]).toBe("https://app.stockflow.example");
      expect(allowedRes.headers["access-control-allow-credentials"]).toBe("true");
      expect(String(allowedRes.headers["access-control-allow-methods"] ?? "")).toContain("PATCH");
      expect(String(allowedRes.headers["access-control-allow-methods"] ?? "")).toContain("DELETE");

      const disallowedRes = await withCors.app.inject({
        method: "GET",
        url: "/api/health",
        headers: { origin: "https://evil.example" },
      });
      expect(disallowedRes.headers["access-control-allow-origin"]).toBeUndefined();
      await withCors.app.close();
    } finally {
      process.env.NODE_ENV = prevEnv;
      await repo.close();
    }
  });

  it("hides stack traces in production 500 responses", async () => {
    const repo = InMemoryRepository.create();
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const services = createStockServices(repo);
      const app = await buildApp(services, { AUTH_ENABLED: true, JWT_SECRET: TEST_JWT_SECRET });
      app.get("/api/test-boom", async () => {
        throw new Error("Sensitive internal failure mongodb+srv://user:pass@host");
      });
      await app.ready();
      const res = await app.inject({ method: "GET", url: "/api/test-boom" });
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain("Sensitive internal failure");
      expect(res.body).not.toContain("mongodb+srv");
      expect(res.body).not.toContain("stack");
      await app.close();
    } finally {
      process.env.NODE_ENV = prevEnv;
      await repo.close();
    }
  });

  it("serves first /api/recommendations under 10s on full seeded dataset and maintains fast warm p95", async () => {
    const t0 = performance.now();
    const repo = InMemoryRepository.create();
    const services = createStockServices(repo);
    const { app } = await buildTestApp(repo);
    const { user } = await createUser(repo, "admin", [], { email: "perf.full@stockflow.test" });
    const headers = bearer(tokenFor(app, user));

    const firstRes = await app.inject({ method: "GET", url: "/api/recommendations", headers });
    const firstMs = performance.now() - t0;
    expect(firstRes.statusCode).toBe(200);
    // DECISION: Use a generous 10s budget so slower machines or parallel test runs do not flake
    // on cold bcrypt seeding + 7,500-position dataset generation + initial plan compute, while
    // always logging the measured value for regression visibility.
    console.info(`[PERF] cold_first_recommendations_ms=${firstMs.toFixed(1)}`);
    expect(firstMs).toBeLessThan(10_000);

    const warmLatencies: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const s = performance.now();
      const r = await app.inject({ method: "GET", url: "/api/recommendations", headers });
      expect(r.statusCode).toBe(200);
      warmLatencies.push(performance.now() - s);
    }
    warmLatencies.sort((a, b) => a - b);
    const p95 = warmLatencies[Math.floor(warmLatencies.length * 0.95)] ?? 0;

    // Cold start with pre-warmed plan_cache (no analyze())
    const tCached0 = performance.now();
    const cachedApp = await buildTestApp(repo);
    const cachedRes = await cachedApp.app.inject({ method: "GET", url: "/api/recommendations", headers });
    const cachedColdMs = performance.now() - tCached0;
    expect(cachedRes.statusCode).toBe(200);
    await cachedApp.app.close();

    console.info(
      `[PERF] cold_compute_ms=${firstMs.toFixed(1)} cold_with_plan_cache_ms=${cachedColdMs.toFixed(1)} warm_p95_ms=${p95.toFixed(1)} service_repo=${services.repositoryKind()}`,
    );
    expect(p95).toBeLessThan(150);

    await app.close();
    await repo.close();
  });

  it("responds to /api/health before the dataset finishes loading (lazy plan load on first use)", async () => {
    const dataset = smallSeededDataset();
    const baseRepo = new FixedDatasetRepository(dataset);

    let datasetFinishedLoading = false;
    let notifyLoadStarted!: () => void;
    const loadStarted = new Promise<void>((resolve) => {
      notifyLoadStarted = resolve;
    });
    let releaseDataset!: (data: Dataset) => void;
    const datasetGate = new Promise<Dataset>((resolve) => {
      releaseDataset = (data: Dataset) => {
        datasetFinishedLoading = true;
        resolve(data);
      };
    });

    const loadDatasetSpy = vi.spyOn(baseRepo, "loadDataset").mockImplementation(() => {
      notifyLoadStarted();
      return datasetGate;
    });
    const logSpy = vi.spyOn(console, "log");

    const services = createStockServices(baseRepo);
    const app = await buildApp(services, { AUTH_ENABLED: false, JWT_SECRET: TEST_JWT_SECRET });
    await app.ready();

    try {
      // 1. Before any data route is called, loadDataset() has not even started
      expect(loadDatasetSpy).not.toHaveBeenCalled();
      expect(datasetFinishedLoading).toBe(false);

      const healthBeforeStart = await app.inject({ method: "GET", url: "/api/health" });
      expect(healthBeforeStart.statusCode).toBe(200);
      expect(JSON.parse(healthBeforeStart.body)).toEqual({ status: "ok", repository: "memory" });
      expect(datasetFinishedLoading).toBe(false);

      // 2. Trigger lazy dataset + plan load on first use via /api/recommendations (remains pending on datasetGate)
      const pendingRecsPromise = app.inject({ method: "GET", url: "/api/recommendations" });
      await loadStarted;
      expect(loadDatasetSpy).toHaveBeenCalledTimes(1);
      expect(datasetFinishedLoading).toBe(false);

      // 3. While loadDataset() is still in-flight and unfinished, /api/health responds immediately
      const healthDuringLoad = await app.inject({ method: "GET", url: "/api/health" });
      expect(healthDuringLoad.statusCode).toBe(200);
      expect(JSON.parse(healthDuringLoad.body)).toEqual({ status: "ok", repository: "memory" });
      expect(datasetFinishedLoading).toBe(false);

      // 4. Release the dataset load and verify the first-use request completes and logs durations
      releaseDataset(dataset);
      const recsRes = await pendingRecsPromise;
      expect(datasetFinishedLoading).toBe(true);
      expect(recsRes.statusCode).toBe(200);

      const loggedLines = logSpy.mock.calls.map((args) => args.join(" "));
      expect(loggedLines.some((line) => /^loading dataset \(\d+ms\)$/.test(line))).toBe(true);
      expect(loggedLines.some((line) => /^computing plan \(\d+ms\)$/.test(line))).toBe(true);
    } finally {
      loadDatasetSpy.mockRestore();
      logSpy.mockRestore();
      await app.close();
      await baseRepo.close();
    }
  });
});

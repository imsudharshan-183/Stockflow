import { performance } from "node:perf_hooks";
import { buildApp } from "./plugins/app.js";
import { InMemoryRepository } from "./repositories/memory.js";
import { createStockServices } from "./services/index.js";

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx] ?? 0;
}

/**
 * Benchmarks cold start (app boot + lazy dataset generation + initial plan analysis + first response),
 * warm-plan cold boot (new app instance sharing cached plan), and warm /api/recommendations latencies.
 */
async function main(): Promise<void> {
  if (!process.env.NODE_ENV) {
    process.env.NODE_ENV = "test";
  }

  const t0 = performance.now();
  const repo = InMemoryRepository.create();
  const services = createStockServices(repo);
  const app = await buildApp(services, { AUTH_ENABLED: false });
  await app.ready();
  const appBootMs = performance.now() - t0;

  const tFirst0 = performance.now();
  const firstRes = await app.inject({ method: "GET", url: "/api/recommendations" });
  const coldFirstRequestMs = performance.now() - tFirst0;
  const coldTotalMs = performance.now() - t0;
  if (firstRes.statusCode !== 200) {
    throw new Error(`Unexpected status on cold /api/recommendations: ${firstRes.statusCode}`);
  }

  const warmLatencies: number[] = [];
  const warmRuns = 20;
  for (let i = 0; i < warmRuns; i += 1) {
    const start = performance.now();
    const res = await app.inject({ method: "GET", url: "/api/recommendations" });
    if (res.statusCode !== 200) {
      throw new Error(`Unexpected status on warm /api/recommendations: ${res.statusCode}`);
    }
    warmLatencies.push(performance.now() - start);
  }
  warmLatencies.sort((a, b) => a - b);

  // Measure cold app boot against an already-populated plan cache (warm plan_cache simulation).
  const tCached0 = performance.now();
  const cachedApp = await buildApp(createStockServices(repo), { AUTH_ENABLED: false });
  await cachedApp.ready();
  const cachedRes = await cachedApp.inject({ method: "GET", url: "/api/recommendations" });
  const coldWithPlanCacheMs = performance.now() - tCached0;
  if (cachedRes.statusCode !== 200) {
    throw new Error(`Unexpected status on cached cold /api/recommendations: ${cachedRes.statusCode}`);
  }
  await cachedApp.close();
  await app.close();
  await repo.close();

  const warmMinMs = warmLatencies[0] ?? 0;
  const warmP50Ms = percentile(warmLatencies, 0.5);
  const warmP95Ms = percentile(warmLatencies, 0.95);
  const warmMaxMs = warmLatencies[warmLatencies.length - 1] ?? 0;

  console.log(
    [
      "Cold & Warm Latency Benchmark (/api/recommendations, in-memory full dataset):",
      `  cold_app_boot_ms:        ${appBootMs.toFixed(1)}`,
      `  cold_first_request_ms:   ${coldFirstRequestMs.toFixed(1)}`,
      `  cold_total_ms:           ${coldTotalMs.toFixed(1)}`,
      `  cold_with_plan_cache_ms: ${coldWithPlanCacheMs.toFixed(1)}`,
      `  warm_runs:               ${warmRuns}`,
      `  warm_min_ms:             ${warmMinMs.toFixed(1)}`,
      `  warm_p50_ms:             ${warmP50Ms.toFixed(1)}`,
      `  warm_p95_ms:             ${warmP95Ms.toFixed(1)}`,
      `  warm_max_ms:             ${warmMaxMs.toFixed(1)}`,
    ].join("\n"),
  );
}

await main();

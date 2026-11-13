/**
 * Regenerates the API snapshot fixtures from the in-memory seed with AUTH_ENABLED=false.
 *
 *   pnpm --filter @stockflow/api fixtures:update
 *
 * Only run this when an output change is intended, and review `git diff src/__fixtures__`.
 * The snapshot tests never write fixtures themselves: a missing or stale fixture fails.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupApp } from "./helpers.js";

process.env.NODE_ENV = "test";
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, "../__fixtures__");
fs.mkdirSync(dir, { recursive: true });

const { app } = await setupApp({ authEnabled: false });
for (const [file, url] of [
  ["recommendations.json", "/api/recommendations"],
  ["kpis.json", "/api/kpis"],
] as const) {
  const res = await app.inject({ method: "GET", url });
  if (res.statusCode !== 200) throw new Error(`${url} returned ${res.statusCode}`);
  fs.writeFileSync(path.join(dir, file), res.payload, "utf8");
  console.log(`wrote ${file} (${res.payload.length} bytes)`);
}
await app.close();

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRootFrom } from "../config/env.js";

interface VercelConfig {
  services: {
    web: { root: string; rewrites: Array<{ source: string; destination: string }> };
    api: { root: string; entrypoint: string };
  };
  rewrites: Array<{ source: string; destination: { service: string } }>;
}

function toRegex(sourcePattern: string): RegExp {
  return new RegExp(`^${sourcePattern}$`);
}

describe("Vercel Services Routing & SPA Fallback", () => {
  it("routes /api/(.*) to api and covers every App.tsx client route with catch-all SPA fallback", () => {
    const root = repoRootFrom(import.meta.dirname);
    const vercel = JSON.parse(readFileSync(resolve(root, "vercel.json"), "utf8")) as VercelConfig;
    const appTsx = readFileSync(resolve(root, "apps/web/src/app/App.tsx"), "utf8");

    // Extract all <Route path="..."> definitions from App.tsx (excluding "*")
    const routePaths = Array.from(appTsx.matchAll(/<Route[^>]*\spath="([^"]+)"/g))
      .map((m) => m[1]!)
      .filter((p) => p !== "*");

    const concreteUrls = [
      "/",
      ...routePaths.map((p) => {
        const normalized = p.startsWith("/") ? p : `/${p}`;
        return normalized.replace(":id", "BR-001").replace(":sku", "SKU-00001");
      }),
    ];

    expect(concreteUrls).toEqual(
      expect.arrayContaining([
        "/login",
        "/",
        "/queue",
        "/audit",
        "/users",
        "/data",
        "/products",
        "/products/SKU-00001",
        "/branches/BR-001",
      ]),
    );

    // Top-level routing: /api/(.*) -> api, everything else -> web
    const apiRule = vercel.rewrites.find((r) => r.destination.service === "api");
    const webRule = vercel.rewrites.find((r) => r.destination.service === "web");
    expect(apiRule?.source).toBe("/api/(.*)");
    expect(webRule?.source).toBe("/(.*)");

    // Web SPA fallback covers every client route and none collide with /api/(.*)
    const apiRegex = toRegex(apiRule!.source);
    const webCatchAll = vercel.services.web.rewrites.find((r) => r.destination === "/index.html");
    expect(webCatchAll).toBeTruthy();
    const spaRegex = toRegex(webCatchAll!.source);

    for (const url of concreteUrls) {
      expect(apiRegex.test(url), `${url} should not hit api`).toBe(false);
      expect(spaRegex.test(url), `${url} should match web SPA fallback`).toBe(true);
    }
  });
});

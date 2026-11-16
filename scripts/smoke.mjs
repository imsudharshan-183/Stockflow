#!/usr/bin/env node
/* global process, console, fetch */
/**
 * Post-deploy smoke test for StockFlow (Vercel Services or local).
 * Usage:
 *   node scripts/smoke.mjs https://your-app.vercel.app
 * Optional env for authenticated checks:
 *   SMOKE_EMAIL=admin@stockflow.dev SMOKE_PASSWORD=... node scripts/smoke.mjs https://your-app.vercel.app
 */

const baseUrl = (process.argv[2] || "http://127.0.0.1:3001").replace(/\/+$/, "");

async function check(label, fn) {
  try {
    await fn();
    console.log(`PASS: ${label}`);
  } catch (err) {
    console.error(`FAIL: ${label} -> ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

await check("GET /api/health returns 200 ok", async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.status !== "ok") throw new Error(`Unexpected body: ${JSON.stringify(body)}`);
});

await check("GET / returns HTML shell", async () => {
  const res = await fetch(`${baseUrl}/`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!text.toLowerCase().includes("<!doctype html")) {
    throw new Error("Expected HTML document at /");
  }
});

const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;

if (email && password) {
  let token = "";
  await check("POST /api/auth/login succeeds", async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (!body.token) throw new Error("Missing token in login response");
    token = body.token;
  });

  if (token) {
    await check("GET /api/locations returns scoped locations", async () => {
      const res = await fetch(`${baseUrl}/api/locations`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (!Array.isArray(body.locations)) throw new Error("Expected locations array");
    });

    await check("GET /api/recommendations returns recommendations", async () => {
      const res = await fetch(`${baseUrl}/api/recommendations`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (!Array.isArray(body.recommendations)) throw new Error("Expected recommendations array");
    });
  }
} else {
  console.log("INFO: Set SMOKE_EMAIL and SMOKE_PASSWORD to run authenticated smoke checks.");
}

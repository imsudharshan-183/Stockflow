import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  MATERIAL_MIN_NET_BENEFIT,
  type AuditList,
  type KpiSummary,
  type ProductDetail,
  type RecommendationList,
  type User,
} from "@stockflow/core";
import { AuditModel, RefreshTokenModel } from "../repositories/models.js";
import { MongoUserRepository } from "../repositories/mongoUser.js";
import {
  SEED_USERS,
  TEST_JWT_SECRET,
  bearer,
  json,
  setupApp,
  tokenFor,
  type TestContext,
} from "../test/helpers.js";

type Method = "GET" | "POST" | "PATCH" | "DELETE";

function caller(app: FastifyInstance) {
  return async (method: Method, url: string, token?: string, payload?: unknown) => {
    const res = await app.inject({
      method,
      url,
      headers: token ? bearer(token) : {},
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
    return { status: res.statusCode, body: res.payload ? json<Record<string, unknown>>(res.payload) : {}, res };
  };
}

const MANAMA = new Set(["BR-001", "BR-002"]);
const ALL_BRANCH_COUNT = 15;

/* ------------------------------------------------------------------------------------------------
 * Read-only routes share one app instance.
 * ---------------------------------------------------------------------------------------------- */
describe("route matrix: read-only routes", () => {
  let ctx: TestContext;
  let call: ReturnType<typeof caller>;
  let t: { admin: string; manager: string; staff: string };

  beforeAll(async () => {
    ctx = await setupApp({ authEnabled: true });
    call = caller(ctx.app);
    t = {
      admin: tokenFor(ctx.app, SEED_USERS.admin),
      manager: tokenFor(ctx.app, SEED_USERS.managerManama),
      staff: tokenFor(ctx.app, SEED_USERS.staffManama),
    };
  });
  afterAll(async () => ctx.app.close());

  describe("GET /api/health (public)", () => {
    it("200 without a token", async () => {
      const r = await call("GET", "/api/health");
      expect(r.status).toBe(200);
      expect(r.body).toEqual({
        status: "ok",
        repository: "memory",
        startupError: null,
        missingEnv: expect.any(Array),
      });
    });
  });

  describe("unknown routes", () => {
    it("404 with JSON error body", async () => {
      const r = await call("GET", "/api/does-not-exist", t.admin);
      expect(r.status).toBe(404);
      expect(r.body).toEqual({ error: "Not found" });
    });
  });

  describe("authenticate guard (shared by every protected route)", () => {
    it.each([
      ["no header", undefined],
      ["non-bearer scheme", "Token abc"],
    ])("401 with %s", async (_label, header) => {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: header ? { authorization: header } : {},
      });
      expect(res.statusCode).toBe(401);
      expect(json(res.payload)).toEqual({ error: "Authentication required" });
    });

    it("401 for a token signed with another secret", async () => {
      const other = await setupApp({ authEnabled: true });
      // Same claims, different key.
      const forged = (other.app.jwt as unknown as { sign: (p: object, o?: object) => string }).sign(
        { sub: SEED_USERS.admin.id, email: SEED_USERS.admin.email, role: "admin" },
        { key: `${TEST_JWT_SECRET}-forged` },
      );
      await other.app.close();
      const r = await call("GET", "/api/auth/me", forged);
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ error: "Invalid or expired token" });
    });

    it("401 for an expired token", async () => {
      const expired = tokenFor(ctx.app, SEED_USERS.admin, { exp: Math.floor(Date.now() / 1000) - 60 });
      const r = await call("GET", "/api/auth/me", expired);
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ error: "Invalid or expired token" });
    });

    it("401 for a valid signature whose subject does not exist", async () => {
      const ghost = tokenFor(ctx.app, { id: "usr_ghost", email: "ghost@stockflow.dev", role: "admin" });
      const r = await call("GET", "/api/auth/me", ghost);
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ error: "Invalid or inactive user" });
    });

    it("role comes from the database, not from the token claim", async () => {
      // A staff user's token claiming admin must still be treated as staff.
      const lying = tokenFor(ctx.app, { ...SEED_USERS.staffManama, role: "admin" });
      expect((await call("GET", "/api/users", lying)).status).toBe(403);
      const me = await call("GET", "/api/auth/me", lying);
      expect((me.body.user as User).role).toBe("staff");
    });
  });

  describe("GET /api/auth/me", () => {
    it.each([
      ["admin", "admin"],
      ["manager", "manager"],
      ["staff", "staff"],
    ] as const)("200 for %s and returns that user without a password hash", async (who, role) => {
      const r = await call("GET", "/api/auth/me", t[who]);
      expect(r.status).toBe(200);
      const user = r.body.user as User & { passwordHash?: string };
      expect(user.role).toBe(role);
      expect(user.passwordHash).toBeUndefined();
    });
  });

  describe("GET /api/users", () => {
    it("401 no token, 403 staff, 403 manager, 200 admin without password hashes", async () => {
      expect((await call("GET", "/api/users")).status).toBe(401);
      expect((await call("GET", "/api/users", t.staff)).status).toBe(403);
      expect((await call("GET", "/api/users", t.manager)).status).toBe(403);
      const r = await call("GET", "/api/users", t.admin);
      expect(r.status).toBe(200);
      const users = r.body.users as Array<Record<string, unknown>>;
      expect(users.length).toBe(6);
      for (const u of users) expect(u).not.toHaveProperty("passwordHash");
    });
  });

  describe("GET /api/kpis", () => {
    it("401 without a token", async () => {
      expect((await call("GET", "/api/kpis")).status).toBe(401);
    });

    it("admin sees all 15 branches", async () => {
      const r = await call("GET", "/api/kpis", t.admin);
      expect(r.status).toBe(200);
      const k = r.body as unknown as KpiSummary;
      expect(k.branches).toHaveLength(ALL_BRANCH_COUNT);
      expect(new Set(k.coverGrid.map((c) => c.branchId)).size).toBe(ALL_BRANCH_COUNT);
    });

    it("manager is scoped to assigned branches and gets recomputed rollups", async () => {
      const admin = (await call("GET", "/api/kpis", t.admin)).body as unknown as KpiSummary;
      const r = await call("GET", "/api/kpis", t.manager);
      expect(r.status).toBe(200);
      const k = r.body as unknown as KpiSummary;
      expect(k.branches.map((b) => b.id).sort()).toEqual(["BR-001", "BR-002"]);
      expect(k.branchRisk.every((b) => MANAMA.has(b.branchId))).toBe(true);
      expect(k.coverGrid.every((c) => MANAMA.has(c.branchId))).toBe(true);
      expect(k.coverGrid.length).toBeGreaterThan(0);
      expect(k.deadStockValue).toBeLessThan(admin.deadStockValue);
      expect(k.cashReleasable).toBeLessThan(admin.cashReleasable);
      expect(k.trend).toHaveLength(admin.trend.length);
      expect(k.trend[0]!.salesValue).toBeLessThan(admin.trend[0]!.salesValue);
      expect(k.trend[0]!.inventoryValue).toBeLessThan(admin.trend[0]!.inventoryValue);
      expect(k.backtest.baselineStockoutDays).toBeLessThan(admin.backtest.baselineStockoutDays);
    });

    it("staff is denied /api/kpis (403)", async () => {
      const r = await call("GET", "/api/kpis", t.staff);
      expect(r.status).toBe(403);
    });
  });

  describe("GET /api/recommendations", () => {
    it("401 without a token", async () => {
      expect((await call("GET", "/api/recommendations")).status).toBe(401);
    });

    it("admin sees the full material queue", async () => {
      const r = await call("GET", "/api/recommendations", t.admin);
      expect(r.status).toBe(200);
      const list = r.body as unknown as RecommendationList;
      expect(list.total).toBe(list.recommendations.length);
      expect(new Set(list.recommendations.map((x) => x.branchId)).size).toBe(ALL_BRANCH_COUNT);
      for (const rec of list.recommendations) {
        expect(rec.netBenefit).toBeGreaterThanOrEqual(MATERIAL_MIN_NET_BENEFIT);
        expect(rec.quantity).toBeGreaterThanOrEqual(5);
      }
    });

    it("manager sees only actions at assigned branches (non-empty, subset of admin)", async () => {
      const admin = (await call("GET", "/api/recommendations", t.admin)).body as unknown as RecommendationList;
      const r = await call("GET", "/api/recommendations", t.manager);
      expect(r.status).toBe(200);
      const list = r.body as unknown as RecommendationList;
      expect(list.recommendations.length).toBeGreaterThan(0);
      expect(
        list.recommendations.every(
          (x) => MANAMA.has(x.branchId) || (x.donorBranchId !== null && MANAMA.has(x.donorBranchId)),
        ),
      ).toBe(true);
      const expected = admin.recommendations
        .filter(
          (x) => MANAMA.has(x.branchId) || (x.donorBranchId !== null && MANAMA.has(x.donorBranchId)),
        )
        .map((x) => x.id);
      expect(list.recommendations.map((x) => x.id)).toEqual(expected);
    });

    it("staff sees only its branch", async () => {
      const r = await call("GET", "/api/recommendations", t.staff);
      const list = r.body as unknown as RecommendationList;
      expect(list.recommendations.length).toBeGreaterThan(0);
      expect(
        list.recommendations.every(
          (x) => x.branchId === "BR-001" || x.donorBranchId === "BR-001",
        ),
      ).toBe(true);
    });

    it("manager filtering by an out-of-scope branch gets an empty list, never that branch's data", async () => {
      const r = await call("GET", "/api/recommendations?branch=BR-005", t.manager);
      expect(r.status).toBe(200);
      expect((r.body as unknown as RecommendationList).recommendations).toEqual([]);
    });

    it("filters by action and category", async () => {
      const r = await call("GET", "/api/recommendations?action=MARKDOWN&category=Toys", t.admin);
      const list = r.body as unknown as RecommendationList;
      expect(list.recommendations.length).toBeGreaterThan(0);
      expect(list.recommendations.every((x) => x.action === "MARKDOWN" && x.category === "Toys")).toBe(true);
    });

    it.each(["action=TELEPORT", "status=MAYBE"])("400 for invalid query %s", async (q) => {
      const r = await call("GET", `/api/recommendations?${q}`, t.admin);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: "Invalid request" });
    });
  });

  describe("GET /api/branches/:id", () => {
    it("401 no token", async () => {
      expect((await call("GET", "/api/branches/BR-001")).status).toBe(401);
    });
    it.each([
      ["staff", "BR-001", 403],
      ["staff", "BR-002", 403],
      ["manager", "BR-002", 200],
      ["manager", "BR-005", 403],
      ["admin", "BR-015", 200],
      ["admin", "BR-999", 404],
    ] as const)("%s -> %s = %i", async (who, id, status) => {
      const r = await call("GET", `/api/branches/${id}`, t[who]);
      expect(r.status).toBe(status);
      if (status === 200) expect((r.body.branch as { id: string }).id).toBe(id);
      if (status === 403) {
        expect(r.body).toEqual({
          error: who === "staff" ? "Forbidden: Insufficient permissions" : "Access to branch forbidden",
        });
      }
      if (status === 404) expect(r.body).toEqual({ error: "Branch not found" });
    });
  });

  describe("GET /api/products/:sku", () => {
    it("401 no token", async () => {
      expect((await call("GET", "/api/products/SKU-00001")).status).toBe(401);
    });
    it("admin sees all 15 branch positions", async () => {
      const r = await call("GET", "/api/products/SKU-00001", t.admin);
      expect(r.status).toBe(200);
      const d = r.body as unknown as ProductDetail;
      expect(d.positions).toHaveLength(ALL_BRANCH_COUNT);
    });
    it("manager sees only in-scope positions and series", async () => {
      const r = await call("GET", "/api/products/SKU-00001", t.manager);
      expect(r.status).toBe(200);
      const d = r.body as unknown as ProductDetail;
      expect(d.positions.map((p) => p.branch.id).sort()).toEqual(["BR-001", "BR-002"]);
      expect(d.series.every((s) => MANAMA.has(s.branchId))).toBe(true);
    });
    it("staff sees only its branch", async () => {
      const d = (await call("GET", "/api/products/SKU-00001", t.staff)).body as unknown as ProductDetail;
      expect(d.positions.map((p) => p.branch.id)).toEqual(["BR-001"]);
      expect(d.series.every((s) => s.branchId === "BR-001")).toBe(true);
    });
    it.each(["admin", "manager", "staff"] as const)("404 for unknown SKU as %s", async (who) => {
      const r = await call("GET", "/api/products/SKU-99999", t[who]);
      expect(r.status).toBe(404);
      expect(r.body).toEqual({ error: "Product not found" });
    });
  });
});

/* ------------------------------------------------------------------------------------------------
 * Auth: login / refresh / logout (state-changing, fresh apps).
 * ---------------------------------------------------------------------------------------------- */
describe("route matrix: /api/auth", () => {
  async function login(app: FastifyInstance, email: string, password: string) {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
    return { status: res.statusCode, body: json<Record<string, unknown>>(res.payload), cookie: res.headers["set-cookie"] };
  }

  it("POST /login: 200, 400 malformed, 401 wrong password, 401 unknown user", async () => {
    const { app } = await setupApp();
    const ok = await login(app, "ADMIN@stockflow.dev", "Admin@12345"); // email is case-insensitive
    expect(ok.status).toBe(200);
    expect(String(ok.cookie)).toContain("HttpOnly");
    expect(String(ok.cookie)).toContain("Path=/api/auth");

    const malformed = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "a@b.c" } });
    expect(malformed.statusCode).toBe(400);
    expect(json(malformed.payload)).toEqual({ error: "Invalid credentials" });

    expect((await login(app, "admin@stockflow.dev", "nope")).status).toBe(401);
    expect((await login(app, "ghost@stockflow.dev", "nope")).status).toBe(401);
    await app.close();
  });

  it("POST /login: 429 after 5 attempts in a minute", async () => {
    const { app } = await setupApp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await login(app, "ghost@stockflow.dev", "x")).status);
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[5]).toBe(429);
    await app.close();
  });

  it("POST /refresh: 401 without token, 401 bogus token, 200 via body token, rotation invalidates the old one", async () => {
    const { app } = await setupApp();
    const r0 = await app.inject({ method: "POST", url: "/api/auth/refresh" });
    expect(r0.statusCode).toBe(401);
    expect(json(r0.payload)).toEqual({ error: "Refresh token required" });

    const r1 = await app.inject({ method: "POST", url: "/api/auth/refresh", payload: { refreshToken: "bogus" } });
    expect(r1.statusCode).toBe(401);

    const l = await login(app, "manager.manama@stockflow.dev", "Manager@12345");
    const raw = String(l.cookie).match(/stockflow_refresh=([^;]+)/)?.[1];
    expect(raw).toBeTruthy();
    const r2 = await app.inject({ method: "POST", url: "/api/auth/refresh", payload: { refreshToken: raw } });
    expect(r2.statusCode).toBe(200);
    const body = json<{ token: string; user: User }>(r2.payload);
    expect(body.user.role).toBe("manager");
    // The new access token works.
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: bearer(body.token) });
    expect(me.statusCode).toBe(200);
    // The old refresh token is gone.
    const r3 = await app.inject({ method: "POST", url: "/api/auth/refresh", payload: { refreshToken: raw } });
    expect(r3.statusCode).toBe(401);
    await app.close();
  });

  it("POST /refresh: 401 once the user is deactivated", async () => {
    const { app, repo } = await setupApp();
    const l = await login(app, "staff.manama@stockflow.dev", "Staff@12345");
    await repo.users.update(SEED_USERS.staffManama.id, { isActive: false });
    const r = await app.inject({ method: "POST", url: "/api/auth/refresh", headers: { cookie: String(l.cookie) } });
    expect(r.statusCode).toBe(401);
    await app.close();
  });

  it("POST /logout: 200 without a cookie, clears the cookie", async () => {
    const { app } = await setupApp();
    const r = await app.inject({ method: "POST", url: "/api/auth/logout" });
    expect(r.statusCode).toBe(200);
    expect(json(r.payload)).toEqual({ ok: true });
    expect(String(r.headers["set-cookie"])).toContain("stockflow_refresh=;");
    await app.close();
  });

  it("an access token stops working as soon as its user is deactivated", async () => {
    const { app, repo } = await setupApp();
    const token = tokenFor(app, SEED_USERS.managerManama);
    expect((await app.inject({ method: "GET", url: "/api/kpis", headers: bearer(token) })).statusCode).toBe(200);
    await repo.users.update(SEED_USERS.managerManama.id, { isActive: false });
    const r = await app.inject({ method: "GET", url: "/api/kpis", headers: bearer(token) });
    expect(r.statusCode).toBe(401);
    expect(json(r.payload)).toEqual({ error: "Invalid or inactive user" });
    await app.close();
  });

  it("AUTH_ENABLED=false: /me returns the synthetic admin with no token", async () => {
    const { app } = await setupApp({ authEnabled: false });
    const r = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(r.statusCode).toBe(200);
    expect(json<{ user: User }>(r.payload).user.role).toBe("admin");
    await app.close();
  });
});

/* ------------------------------------------------------------------------------------------------
 * Users CRUD and the role hierarchy.
 * ---------------------------------------------------------------------------------------------- */
describe("route matrix: /api/users writes", () => {
  let ctx: TestContext;
  let call: ReturnType<typeof caller>;
  let admin: string;
  let manager: string;
  let staff: string;

  beforeAll(async () => {
    ctx = await setupApp();
    call = caller(ctx.app);
    admin = tokenFor(ctx.app, SEED_USERS.admin);
    manager = tokenFor(ctx.app, SEED_USERS.managerManama);
    staff = tokenFor(ctx.app, SEED_USERS.staffManama);
  });
  afterAll(async () => ctx.app.close());

  const newUser = {
    name: "Riley Park",
    email: "riley.park@stockflow.dev",
    password: "Secret@123",
    role: "staff",
    branchIds: ["BR-003"],
  };
  const sid = SEED_USERS.staffJuffair.id;

  it.each([
    ["POST", "/api/users", newUser],
    ["PATCH", `/api/users/${sid}`, { name: "X" }],
    ["POST", `/api/users/${sid}/reset-password`, { password: "Secret@123" }],
    ["DELETE", `/api/users/${sid}`, undefined],
  ] as const)("%s %s: 401 no token, 403 staff, 403 manager", async (method, url, payload) => {
    expect((await call(method, url, undefined, payload)).status).toBe(401);
    expect((await call(method, url, staff, payload)).status).toBe(403);
    expect((await call(method, url, manager, payload)).status).toBe(403);
  });

  it("POST: 201 creates a lower-role user who can then log in", async () => {
    const r = await call("POST", "/api/users", admin, { ...newUser, email: "Riley.Park@StockFlow.dev" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ email: "riley.park@stockflow.dev", role: "staff", branchIds: ["BR-003"], isActive: true });
    expect(r.body).not.toHaveProperty("passwordHash");
    const login = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: newUser.email, password: newUser.password },
    });
    expect(login.statusCode).toBe(200);
  });

  it("POST: 409 duplicate email (case-insensitive)", async () => {
    const r = await call("POST", "/api/users", admin, { ...newUser, email: "ADMIN@stockflow.dev" });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: "Email already in use" });
  });

  it.each([
    [{ ...newUser, email: "not-an-email" }, "Invalid email address"],
    [{ ...newUser, email: "a2@stockflow.dev", password: "123" }, "Password must be at least 8 characters"],
    [{ ...newUser, email: "a3@stockflow.dev", role: "owner" }, undefined],
    [{ ...newUser, email: "a4@stockflow.dev", name: "" }, undefined],
  ])("POST: 400 for invalid input %#", async (payload, message) => {
    const r = await call("POST", "/api/users", admin, payload);
    expect(r.status).toBe(400);
    if (message) expect(r.body.error).toBe(message);
  });

  it("POST: 403 creating an admin (equal role)", async () => {
    const r = await call("POST", "/api/users", admin, { ...newUser, email: "boss@stockflow.dev", role: "admin" });
    expect(r.status).toBe(403);
  });

  it("PATCH: 200 updates role and branches of a lower-role user", async () => {
    const r = await call("PATCH", `/api/users/${sid}`, admin, { role: "manager", branchIds: ["BR-002", "BR-003"] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ role: "manager", branchIds: ["BR-002", "BR-003"] });
    // Scope change takes effect immediately on the next request (role is read from the DB).
    const token = tokenFor(ctx.app, { id: sid, email: SEED_USERS.staffJuffair.email, role: "staff" });
    const k = (await call("GET", "/api/kpis", token)).body as unknown as KpiSummary;
    expect(k.branches.map((b) => b.id).sort()).toEqual(["BR-002", "BR-003"]);
  });

  it("PATCH: 404 unknown, 403 on self/admin, 403 promoting to admin, 400 invalid", async () => {
    expect((await call("PATCH", "/api/users/usr_nope", admin, { name: "X" })).status).toBe(404);
    expect((await call("PATCH", `/api/users/${SEED_USERS.admin.id}`, admin, { name: "X" })).status).toBe(403);
    const promote = await call("PATCH", `/api/users/${SEED_USERS.managerRegional.id}`, admin, { role: "admin" });
    expect(promote.status).toBe(403);
    expect(promote.body).toEqual({ error: "Cannot assign role equal to or higher than yours" });
    expect((await call("PATCH", `/api/users/${SEED_USERS.managerRegional.id}`, admin, { role: "owner" })).status).toBe(400);
  });

  it("PATCH isActive=false revokes refresh tokens and access", async () => {
    const login = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: SEED_USERS.managerRegional.email, password: SEED_USERS.managerRegional.password },
    });
    const cookie = String(login.headers["set-cookie"]);
    const r = await call("PATCH", `/api/users/${SEED_USERS.managerRegional.id}`, admin, { isActive: false });
    expect(r.status).toBe(200);
    const refresh = await ctx.app.inject({ method: "POST", url: "/api/auth/refresh", headers: { cookie } });
    expect(refresh.statusCode).toBe(401);
  });

  it("POST reset-password: 400 short, 404 unknown, 403 admin target, 200 swaps the password", async () => {
    const target = SEED_USERS.staffManama;
    expect((await call("POST", `/api/users/${target.id}/reset-password`, admin, { password: "1" })).status).toBe(400);
    expect((await call("POST", "/api/users/usr_nope/reset-password", admin, { password: "Secret@123" })).status).toBe(404);
    expect(
      (await call("POST", `/api/users/${SEED_USERS.admin.id}/reset-password`, admin, { password: "Secret@123" })).status,
    ).toBe(403);
    const ok = await call("POST", `/api/users/${target.id}/reset-password`, admin, { password: "NewPass@1" });
    expect(ok.status).toBe(200);
    // Login budget: this app has used 2 of 5 logins so far.
    const oldPw = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: target.email, password: target.password },
    });
    expect(oldPw.statusCode).toBe(401);
    const newPw = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: target.email, password: "NewPass@1" },
    });
    expect(newPw.statusCode).toBe(200);
  });

  it("DELETE: 404 unknown, 403 admin target, 200 soft-deactivates (user is kept)", async () => {
    expect((await call("DELETE", "/api/users/usr_nope", admin)).status).toBe(404);
    expect((await call("DELETE", `/api/users/${SEED_USERS.admin.id}`, admin)).status).toBe(403);
    const r = await call("DELETE", `/api/users/${SEED_USERS.staffManama.id}`, admin);
    expect(r.status).toBe(200);
    const list = (await call("GET", "/api/users", admin)).body.users as User[];
    expect(list.find((u) => u.id === SEED_USERS.staffManama.id)?.isActive).toBe(false);
  });
});

/* ------------------------------------------------------------------------------------------------
 * Approve / reject and the audit trail.
 * ---------------------------------------------------------------------------------------------- */
describe("route matrix: approve / reject / audit", () => {
  it.each(["approve", "reject"] as const)("POST /recommendations/:id/%s across roles and scope", async (verb) => {
    const { app, services } = await setupApp();
    const call = caller(app);
    const recs = services.decisions.list({}).recommendations;
    const inScope = recs.find((r) => r.branchId === "BR-001");
    const outOfScope = recs.find((r) => r.branchId === "BR-005");
    const elsewhere = recs.find((r) => r.branchId === "BR-010");
    expect(inScope && outOfScope && elsewhere).toBeTruthy();
    const url = (id: string) => `/api/recommendations/${id}/${verb}`;
    const expected = verb === "approve" ? "APPROVED" : "REJECTED";

    expect((await call("POST", url(inScope!.id))).status).toBe(401);
    const staff = await call("POST", url(inScope!.id), tokenFor(app, SEED_USERS.staffManama));
    expect(staff.status).toBe(403);

    const manager = tokenFor(app, SEED_USERS.managerManama);
    const out = await call("POST", url(outOfScope!.id), manager);
    expect(out.status).toBe(403);
    expect(out.body).toEqual({ error: "Cannot decide action outside your assigned branches" });
    expect((await call("POST", url("does-not-exist"), manager)).status).toBe(404);
    const ok = await call("POST", url(inScope!.id), manager);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe(expected);

    const admin = tokenFor(app, SEED_USERS.admin);
    expect((await call("POST", url(elsewhere!.id), admin)).body.status).toBe(expected);
    expect((await call("POST", url("does-not-exist"), admin)).status).toBe(404);

    // Status overlay is visible in the queue and filterable.
    const filtered = (await call("GET", `/api/recommendations?status=${expected}`, admin)).body as unknown as RecommendationList;
    expect(filtered.recommendations.map((r) => r.id).sort()).toEqual([inScope!.id, elsewhere!.id].sort());

    // Exactly two audit rows; the forbidden attempts wrote nothing.
    const audit = (await call("GET", "/api/audit", admin)).body as unknown as AuditList;
    expect(audit.entries).toHaveLength(2);
    expect(audit.entries.every((e) => e.decision === expected)).toBe(true);
    await app.close();
  });

  it("GET /api/audit: 401 none, 403 staff, manager scoped to its branches, admin sees all (newest first)", async () => {
    const { app, services } = await setupApp();
    const call = caller(app);
    const admin = tokenFor(app, SEED_USERS.admin);
    const recs = services.decisions.list({}).recommendations;
    const ids = ["BR-001", "BR-005", "BR-010"].map((b) => recs.find((r) => r.branchId === b)!.id);
    for (const id of ids) {
      expect((await call("POST", `/api/recommendations/${id}/approve`, admin)).status).toBe(200);
      await new Promise((r) => setTimeout(r, 5)); // distinct timestamps for ordering
    }

    expect((await call("GET", "/api/audit")).status).toBe(401);
    expect((await call("GET", "/api/audit", tokenFor(app, SEED_USERS.staffManama))).status).toBe(403);

    const all = (await call("GET", "/api/audit", admin)).body as unknown as AuditList;
    expect(all.entries.map((e) => e.recommendationId)).toEqual([...ids].reverse());
    expect(all.entries[0]?.actedBy).toEqual({ userId: SEED_USERS.admin.id, name: "System Admin", role: "admin" });

    const manama = (await call("GET", "/api/audit", tokenFor(app, SEED_USERS.managerManama))).body as unknown as AuditList;
    expect(manama.entries.map((e) => e.branchId)).toEqual(["BR-001"]);
    const regional = (await call("GET", "/api/audit", tokenFor(app, SEED_USERS.managerRegional))).body as unknown as AuditList;
    expect(regional.entries.map((e) => e.branchId)).toEqual(["BR-005"]);
    await app.close();
  });

  it("decisions survive a service restart on the same repository", async () => {
    const first = await setupApp();
    const rec = first.services.decisions.list({}).recommendations[0]!;
    await first.app.inject({
      method: "POST",
      url: `/api/recommendations/${rec.id}/reject`,
      headers: bearer(tokenFor(first.app, SEED_USERS.admin)),
    });
    await first.app.close();
    const second = await setupApp({ repo: first.repo });
    const after = second.services.decisions.list({}).recommendations.find((r) => r.id === rec.id);
    expect(after?.status).toBe("REJECTED");
    expect(second.services.decisions.listAudit().entries).toHaveLength(1);
    await second.app.close();
  });

  it("AuditModel Mongoose schema preserves actedBy and donorBranchId, and MongoUserRepository rejects expired refresh tokens", async () => {
    const doc = new AuditModel({
      id: "aud_1",
      at: "2026-11-13T00:00:00.000Z",
      user: "Marcus Vance",
      recommendationId: "rec_1",
      decision: "APPROVED",
      action: "TRANSFER",
      sku: "SKU-00001",
      productName: "Sample",
      branchId: "BR-005",
      branchName: "Muharraq - Hidd",
      donorBranchId: "BR-001",
      netBenefit: 120,
      reasonCodes: ["DONOR_SURPLUS"],
      actedBy: { userId: "usr_mgr_01", name: "Marcus Vance", role: "manager" },
    }).toObject();
    expect(doc.donorBranchId).toBe("BR-001");
    expect(doc.actedBy).toEqual({ userId: "usr_mgr_01", name: "Marcus Vance", role: "manager" });

    const findSpy = vi.spyOn(RefreshTokenModel, "findOne").mockReturnValue({
      lean: () =>
        Promise.resolve({
          token: "tok_expired",
          userId: "usr_stf_01",
          expiresAt: new Date(Date.now() - 10_000),
        }),
    } as never);
    const deleteSpy = vi.spyOn(RefreshTokenModel, "deleteOne").mockResolvedValue({} as never);
    const mongoUsers = new MongoUserRepository();
    const expired = await mongoUsers.findRefreshToken("tok_expired");
    expect(expired).toBeNull();
    expect(deleteSpy).toHaveBeenCalledWith({ token: "tok_expired" });
    findSpy.mockRestore();
    deleteSpy.mockRestore();
  });
});

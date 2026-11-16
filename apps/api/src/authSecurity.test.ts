import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { StockRepository } from "./repositories/types.js";
import { getAuthSecurityEvents } from "./services/authService.js";
import {
  buildTestApp,
  createDualRepo,
  createUser,
  extractCookies,
  formatCookieHeader,
  loginAs,
  type RepoKind,
} from "./test/dualRepo.js";

describe.each<RepoKind>(["memory", "mongo-memory"])("Auth & Session Security (%s)", (kind) => {
  let repo: StockRepository;
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const setup = await createDualRepo(kind);
    repo = setup.repo;
    cleanup = setup.cleanup;
    const built = await buildTestApp(repo);
    app = built.app;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await cleanup?.();
  });

  it("returns identical error body and status for unknown user vs wrong password", async () => {
    const { user } = await createUser(repo, "staff", ["BR-001"], {
      email: `known.${kind}@stockflow.test`,
      password: "RightPassword@123",
    });

    const unknownRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: `missing.${kind}@stockflow.test`, password: "RightPassword@123" },
    });
    const wrongPwRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: user.email, password: "WrongPassword@999" },
    });

    expect(unknownRes.statusCode).toBe(401);
    expect(wrongPwRes.statusCode).toBe(401);
    expect(JSON.parse(unknownRes.body)).toEqual(JSON.parse(wrongPwRes.body));
  });

  it("never exposes passwordHash in auth or user responses", async () => {
    const { user, password } = await createUser(repo, "admin", [], {
      email: `secadmin.${kind}@stockflow.test`,
    });
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: user.email, password },
    });
    expect(loginRes.statusCode).toBe(200);
    expect(loginRes.body).not.toContain("passwordHash");

    const { token } = JSON.parse(loginRes.body) as { token: string };
    const meRes = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.body).not.toContain("passwordHash");

    const usersRes = await app.inject({
      method: "GET",
      url: "/api/users",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(usersRes.statusCode).toBe(200);
    expect(usersRes.body).not.toContain("passwordHash");
  });

  it("sets HttpOnly, SameSite=Lax, and Secure when NODE_ENV=production on refresh cookie", async () => {
    const { user, password } = await createUser(repo, "staff", ["BR-001"], {
      email: `cookie.${kind}@stockflow.test`,
    });

    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const prodBuilt = await buildTestApp(repo);
      const res = await prodBuilt.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: user.email, password },
      });
      expect(res.statusCode).toBe(200);
      const setCookie = res.headers["set-cookie"];
      const cookieStr = Array.isArray(setCookie) ? setCookie.join(";") : (setCookie ?? "");
      expect(cookieStr).toMatch(/HttpOnly/i);
      expect(cookieStr).toMatch(/SameSite=Lax/i);
      expect(cookieStr).toMatch(/Secure/i);
      await prodBuilt.app.close();
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });

  it("rotates refresh tokens, revokes family + audits on replay, and leaves other sessions unaffected", async () => {
    const isolated = await buildTestApp(repo);
    try {
      const { user, password } = await createUser(repo, "manager", ["BR-001"], {
        email: `rotate.${kind}@stockflow.test`,
      });
      const { user: otherUser, password: otherPassword } = await createUser(repo, "staff", ["BR-001"], {
        email: `other.${kind}@stockflow.test`,
      });
      const session = await loginAs(isolated.app, user.email, password);
      const otherUserSession = await loginAs(isolated.app, otherUser.email, otherPassword);
      expect(session.cookies.stockflow_refresh).toBeTruthy();

      // First refresh succeeds and rotates token
      const r1 = await isolated.app.inject({
        method: "POST",
        url: "/api/auth/refresh",
        headers: { cookie: session.cookieHeader },
      });
      expect(r1.statusCode).toBe(200);
      const rotatedCookies = extractCookies(r1.headers["set-cookie"]);
      expect(rotatedCookies.stockflow_refresh).toBeTruthy();
      expect(rotatedCookies.stockflow_refresh).not.toBe(session.cookies.stockflow_refresh);

      // Reusing the old (already-rotated) refresh token is rejected with 401 and revokes the family
      const eventsBefore = getAuthSecurityEvents(user.id).length;
      const reuse = await isolated.app.inject({
        method: "POST",
        url: "/api/auth/refresh",
        headers: { cookie: session.cookieHeader },
      });
      expect(reuse.statusCode).toBe(401);
      expect(getAuthSecurityEvents(user.id).length).toBe(eventsBefore + 1);

      // The newer rotated token in that same family also stops working
      const r2 = await isolated.app.inject({
        method: "POST",
        url: "/api/auth/refresh",
        headers: { cookie: formatCookieHeader(rotatedCookies) },
      });
      expect(r2.statusCode).toBe(401);

      // Other users' sessions remain unaffected
      const otherRefresh = await isolated.app.inject({
        method: "POST",
        url: "/api/auth/refresh",
        headers: { cookie: otherUserSession.cookieHeader },
      });
      expect(otherRefresh.statusCode).toBe(200);
    } finally {
      await isolated.app.close();
    }
  });

  it("blocks deactivated users at login and refresh", async () => {
    const isolated = await buildTestApp(repo);
    try {
      const { user, password } = await createUser(repo, "staff", ["BR-001"], {
        email: `deact.${kind}@stockflow.test`,
      });
      const session = await loginAs(isolated.app, user.email, password);

      await repo.users.update(user.id, { isActive: false });

      const loginRes = await isolated.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: user.email, password },
      });
      expect(loginRes.statusCode).toBe(403);

      const refreshRes = await isolated.app.inject({
        method: "POST",
        url: "/api/auth/refresh",
        headers: { cookie: session.cookieHeader },
      });
      expect(refreshRes.statusCode).toBe(401);
    } finally {
      await isolated.app.close();
    }
  });

  it("revokes only the current family on logout", async () => {
    const isolated = await buildTestApp(repo);
    try {
      const { user, password } = await createUser(repo, "staff", ["BR-001"], {
        email: `logout.${kind}@stockflow.test`,
      });
      const sessionA = await loginAs(isolated.app, user.email, password);
      const sessionB = await loginAs(isolated.app, user.email, password);

      const logoutRes = await isolated.app.inject({
        method: "POST",
        url: "/api/auth/logout",
        headers: { cookie: sessionA.cookieHeader },
      });
      expect(logoutRes.statusCode).toBe(200);

      const refreshAfterLogoutA = await isolated.app.inject({
        method: "POST",
        url: "/api/auth/refresh",
        headers: { cookie: sessionA.cookieHeader },
      });
      expect(refreshAfterLogoutA.statusCode).toBe(401);

      // Second family for the same user stays valid
      const refreshSessionB = await isolated.app.inject({
        method: "POST",
        url: "/api/auth/refresh",
        headers: { cookie: sessionB.cookieHeader },
      });
      expect(refreshSessionB.statusCode).toBe(200);
    } finally {
      await isolated.app.close();
    }
  });

  it("rejects expired and tampered JWT tokens with 401", async () => {
    const { user } = await createUser(repo, "staff", ["BR-001"], {
      email: `jwt.${kind}@stockflow.test`,
    });
    const expiredToken = app.jwt.sign(
      { sub: user.id, email: user.email, role: user.role },
      { expiresIn: "-10s" },
    );
    const expiredRes = await app.inject({
      method: "GET",
      url: "/api/recommendations",
      headers: { authorization: `Bearer ${expiredToken}` },
    });
    expect(expiredRes.statusCode).toBe(401);

    const validToken = app.jwt.sign({ sub: user.id, email: user.email, role: user.role });
    const parts = validToken.split(".");
    const tampered = `${parts[0]}.${parts[1]}.tamperedSignatureValue`;
    const tamperedRes = await app.inject({
      method: "GET",
      url: "/api/recommendations",
      headers: { authorization: `Bearer ${tampered}` },
    });
    expect(tamperedRes.statusCode).toBe(401);
  });

  it("rate-limits /api/auth/login with 429 after repeated attempts", async () => {
    const isolated = await buildTestApp(repo);
    try {
      let lastStatus = 0;
      for (let i = 0; i < 6; i += 1) {
        const res = await isolated.app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { email: `rate.${kind}@stockflow.test`, password: "wrong" },
        });
        lastStatus = res.statusCode;
      }
      expect(lastStatus).toBe(429);
    } finally {
      await isolated.app.close();
    }
  });
});

import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AuditEntry } from "@stockflow/core";
import { InMemoryRepository } from "../repositories/memory.js";
import { createStockServices } from "../services/index.js";
import { buildApp } from "../plugins/app.js";

const JWT_SECRET = "test-secret-at-least-32-characters-long-key";

async function setupTestApp(authEnabled = true) {
  const repo = InMemoryRepository.create();
  const services = createStockServices(repo);
  const app = await buildApp(services, {
    AUTH_ENABLED: authEnabled,
    JWT_SECRET,
  });
  return { app, services, repo };
}

async function loginUser(app: FastifyInstance, email: string, password = "Admin@12345") {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password },
  });
  return { status: res.statusCode, body: JSON.parse(res.payload), headers: res.headers };
}

describe("API Auth and Scoping", () => {
  it("authenticates valid credentials and rejects invalid ones", async () => {
    const { app } = await setupTestApp(true);

    // Valid admin login
    const adminLogin = await loginUser(app, "admin@stockflow.dev", "Admin@12345");
    expect(adminLogin.status).toBe(200);
    expect(adminLogin.body.user.role).toBe("admin");
    expect(adminLogin.body.token).toBeDefined();
    expect(adminLogin.headers["set-cookie"]).toBeDefined();

    // Invalid password
    const badPass = await loginUser(app, "admin@stockflow.dev", "WrongPass123");
    expect(badPass.status).toBe(401);
    expect(badPass.body.error).toBe("Invalid credentials");

    // Non-existent user
    const noUser = await loginUser(app, "ghost@stockflow.dev", "Password123");
    expect(noUser.status).toBe(401);
    expect(noUser.body.error).toBe("Invalid credentials");
  });

  it("handles token refresh, rotation, and logout", async () => {
    const { app } = await setupTestApp(true);
    const login = await loginUser(app, "admin@stockflow.dev", "Admin@12345");
    const cookieHeader = login.headers["set-cookie"];

    // Refresh token with valid cookie
    const refreshRes = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      headers: { cookie: cookieHeader },
    });
    expect(refreshRes.statusCode).toBe(200);
    const refreshBody = JSON.parse(refreshRes.payload);
    expect(refreshBody.token).toBeDefined();
    const newCookieHeader = refreshRes.headers["set-cookie"];
    expect(newCookieHeader).toBeDefined();

    // Old refresh token must be rejected (rotation)
    const oldRefreshRes = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      headers: { cookie: cookieHeader },
    });
    expect(oldRefreshRes.statusCode).toBe(401);

    // Logout
    const logoutRes = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: newCookieHeader },
    });
    expect(logoutRes.statusCode).toBe(200);

    // After logout, refreshed token is invalid
    const afterLogout = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      headers: { cookie: newCookieHeader },
    });
    expect(afterLogout.statusCode).toBe(401);
  });

  it("rejects inactive users", async () => {
    const { app, repo } = await setupTestApp(true);
    const user = await repo.users.findByEmail("staff.manama@stockflow.dev");
    expect(user).toBeDefined();
    await repo.users.update(user!.id, { isActive: false });

    const loginRes = await loginUser(app, "staff.manama@stockflow.dev", "Staff@12345");
    expect(loginRes.status).toBe(403);
    expect(loginRes.body.error).toBe("Account is deactivated");
  });

  it("enforces route-level role permissions", async () => {
    const { app } = await setupTestApp(true);
    const admin = await loginUser(app, "admin@stockflow.dev", "Admin@12345");
    const manager = await loginUser(app, "manager.manama@stockflow.dev", "Manager@12345");
    const staff = await loginUser(app, "staff.manama@stockflow.dev", "Staff@12345");

    // /api/users: admin only
    const adminUsers = await app.inject({
      method: "GET",
      url: "/api/users",
      headers: { authorization: `Bearer ${admin.body.token}` },
    });
    expect(adminUsers.statusCode).toBe(200);

    const managerUsers = await app.inject({
      method: "GET",
      url: "/api/users",
      headers: { authorization: `Bearer ${manager.body.token}` },
    });
    expect(managerUsers.statusCode).toBe(403);

    const staffUsers = await app.inject({
      method: "GET",
      url: "/api/users",
      headers: { authorization: `Bearer ${staff.body.token}` },
    });
    expect(staffUsers.statusCode).toBe(403);

    // /api/audit: admin & manager only, staff forbidden
    const adminAudit = await app.inject({
      method: "GET",
      url: "/api/audit",
      headers: { authorization: `Bearer ${admin.body.token}` },
    });
    expect(adminAudit.statusCode).toBe(200);

    const managerAudit = await app.inject({
      method: "GET",
      url: "/api/audit",
      headers: { authorization: `Bearer ${manager.body.token}` },
    });
    expect(managerAudit.statusCode).toBe(200);

    const staffAudit = await app.inject({
      method: "GET",
      url: "/api/audit",
      headers: { authorization: `Bearer ${staff.body.token}` },
    });
    expect(staffAudit.statusCode).toBe(403);
  });

  it("applies branch scoping to transfers, reorders, and markdowns for a manager", async () => {
    const { app } = await setupTestApp(true);
    // Marcus Vance manages Manama: BR-001, BR-002
    const manager = await loginUser(app, "manager.manama@stockflow.dev", "Manager@12345");

    const recsRes = await app.inject({
      method: "GET",
      url: "/api/recommendations",
      headers: { authorization: `Bearer ${manager.body.token}` },
    });
    expect(recsRes.statusCode).toBe(200);
    const recs: Array<{ action: string; branchId: string; donorBranchId: string | null }> = JSON.parse(
      recsRes.payload,
    ).recommendations;

    expect(recs.length).toBeGreaterThan(0);
    expect(new Set(recs.map((r) => r.action))).toEqual(new Set(["TRANSFER", "REORDER", "MARKDOWN"]));
    for (const rec of recs) {
      if (rec.action === "TRANSFER") {
        expect(
          ["BR-001", "BR-002"].includes(rec.branchId) ||
            (rec.donorBranchId !== null && ["BR-001", "BR-002"].includes(rec.donorBranchId)),
        ).toBe(true);
      } else {
        expect(["BR-001", "BR-002"]).toContain(rec.branchId);
      }
    }
  });

  it("prevents manager from approving out-of-scope actions and forbids staff entirely", async () => {
    const { app, services } = await setupTestApp(true);
    const manager = await loginUser(app, "manager.manama@stockflow.dev", "Manager@12345"); // BR-001, BR-002
    const staff = await loginUser(app, "staff.manama@stockflow.dev", "Staff@12345"); // BR-001

    // Find an action for BR-005 (Hidd branch, outside Manama cluster)
    const allRecs = services.decisions.list({});
    const westRec = allRecs.recommendations.find(
      (r) => r.branchId === "BR-005" && r.donorBranchId !== "BR-001" && r.donorBranchId !== "BR-002",
    );
    expect(westRec).toBeDefined();

    // Manager attempting to approve out-of-scope action gets 403
    const managerApprove = await app.inject({
      method: "POST",
      url: `/api/recommendations/${westRec!.id}/approve`,
      headers: { authorization: `Bearer ${manager.body.token}` },
    });
    expect(managerApprove.statusCode).toBe(403);

    // Find an action in BR-001 (in staff branch)
    const staffBranchRec = allRecs.recommendations.find((r) => r.branchId === "BR-001");
    expect(staffBranchRec).toBeDefined();

    // Staff attempting to approve gets 403
    const staffApprove = await app.inject({
      method: "POST",
      url: `/api/recommendations/${staffBranchRec!.id}/approve`,
      headers: { authorization: `Bearer ${staff.body.token}` },
    });
    expect(staffApprove.statusCode).toBe(403);
  });

  it("records actedBy {userId, name, role} in audit trail upon approve", async () => {
    const { app, services } = await setupTestApp(true);
    const manager = await loginUser(app, "manager.manama@stockflow.dev", "Manager@12345");

    const allRecs = services.decisions.list({});
    const manamaRec = allRecs.recommendations.find((r) => r.branchId === "BR-001");
    expect(manamaRec).toBeDefined();

    const approveRes = await app.inject({
      method: "POST",
      url: `/api/recommendations/${manamaRec!.id}/approve`,
      headers: { authorization: `Bearer ${manager.body.token}` },
    });
    expect(approveRes.statusCode).toBe(200);

    const auditRes = await app.inject({
      method: "GET",
      url: "/api/audit",
      headers: { authorization: `Bearer ${manager.body.token}` },
    });
    expect(auditRes.statusCode).toBe(200);
    const auditEntries: AuditEntry[] = JSON.parse(auditRes.payload).entries;
    const manamaEntry = auditEntries.find((e) => e.recommendationId === manamaRec!.id);
    expect(manamaEntry).toBeDefined();
    expect(manamaEntry!.actedBy).toEqual({
      userId: manager.body.user.id,
      name: manager.body.user.name,
      role: "manager",
    });
  });

  // The fixture snapshot tests moved to snapshot.test.ts. They used to read a git-ignored
  // temp_snapshot/ folder inside `if (fs.existsSync(...))`, so on a clean checkout they
  // passed without asserting anything.
});

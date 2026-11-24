import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SEED_USERS, setupApp, tokenFor, type TestContext } from "../test/helpers.js";

describe("Workstream 4: /api/users strict validation (email, 8-char password, branchIds)", () => {
  let ctx: TestContext;
  let adminToken: string;

  beforeAll(async () => {
    ctx = await setupApp();
    adminToken = tokenFor(ctx.app, SEED_USERS.admin);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it("rejects plain or malformed emails, short (<8) passwords, and empty branches on create, patch, and reset", async () => {
    const headers = { authorization: `Bearer ${adminToken}` };

    const plainEmailRes = await ctx.app.inject({
      method: "POST",
      url: "/api/users",
      headers,
      payload: {
        name: "Bad Email",
        email: "admin",
        password: "ValidPass@1",
        role: "staff",
        branchIds: ["BR-001"],
      },
    });
    expect(plainEmailRes.statusCode).toBe(400);
    expect(plainEmailRes.json()).toEqual({ error: "Invalid email address" });

    const shortTldRes = await ctx.app.inject({
      method: "POST",
      url: "/api/users",
      headers,
      payload: {
        name: "Bad TLD",
        email: "user@domain",
        password: "ValidPass@1",
        role: "staff",
        branchIds: ["BR-001"],
      },
    });
    expect(shortTldRes.statusCode).toBe(400);

    const shortPassRes = await ctx.app.inject({
      method: "POST",
      url: "/api/users",
      headers,
      payload: {
        name: "Short Pass",
        email: "valid.staff@stockflow.dev",
        password: "Abcd123",
        role: "staff",
        branchIds: ["BR-001"],
      },
    });
    expect(shortPassRes.statusCode).toBe(400);
    expect(shortPassRes.json()).toEqual({ error: "Password must be at least 8 characters" });

    const noBranchRes = await ctx.app.inject({
      method: "POST",
      url: "/api/users",
      headers,
      payload: {
        name: "No Branch",
        email: "nobranch@stockflow.dev",
        password: "ValidPass@1",
        role: "manager",
        branchIds: [],
      },
    });
    expect(noBranchRes.statusCode).toBe(400);
    expect(noBranchRes.json()).toEqual({
      error: "Managers and staff must have at least one assigned branch",
    });

    const validCreateRes = await ctx.app.inject({
      method: "POST",
      url: "/api/users",
      headers,
      payload: {
        name: "Valid Manager",
        email: "valid.mgr@stockflow.dev",
        password: "ValidPass@1",
        role: "manager",
        branchIds: ["BR-001"],
      },
    });
    expect(validCreateRes.statusCode).toBe(201);
    const created = validCreateRes.json() as { id: string };

    const patchEmptyBranchesRes = await ctx.app.inject({
      method: "PATCH",
      url: `/api/users/${created.id}`,
      headers,
      payload: { branchIds: [] },
    });
    expect(patchEmptyBranchesRes.statusCode).toBe(400);

    const patchShortPassRes = await ctx.app.inject({
      method: "PATCH",
      url: `/api/users/${created.id}`,
      headers,
      payload: { password: "short77" },
    });
    expect(patchShortPassRes.statusCode).toBe(400);
    expect(patchShortPassRes.json()).toEqual({ error: "Password must be at least 8 characters" });

    const resetShortRes = await ctx.app.inject({
      method: "POST",
      url: `/api/users/${created.id}/reset-password`,
      headers,
      payload: { password: "1234567" },
    });
    expect(resetShortRes.statusCode).toBe(400);
    expect(resetShortRes.json()).toEqual({ error: "Password must be at least 8 characters" });

    const resetOkRes = await ctx.app.inject({
      method: "POST",
      url: `/api/users/${created.id}/reset-password`,
      headers,
      payload: { password: "StrongPass@8" },
    });
    expect(resetOkRes.statusCode).toBe(200);
  });
});

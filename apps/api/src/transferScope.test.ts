import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Recommendation, RecommendationList, User } from "@stockflow/core";
import { FixedDatasetRepository, SEED_USERS, bearer, json, setupApp, tokenFor, transferDataset } from "./test/helpers.js";

/**
 * The seeded catalog produces no TRANSFER actions at all (the engine's $12/unit transfer cost
 * never pays off there), so transfer scoping is exercised on a hand-built dataset:
 * donor BR-001 (Midwest), receiver BR-005 (West), bystander BR-009.
 */
describe("transfer scoping (donor OR receiver in scope)", () => {
  let app: FastifyInstance;
  let repo: FixedDatasetRepository;
  let transfer: Recommendation;
  let outsider: { id: string; email: string; role: "manager" };

  beforeAll(async () => {
    repo = new FixedDatasetRepository(transferDataset());
    const ctx = await setupApp({ repo });
    app = ctx.app;
    const all = ctx.service.list({}).recommendations;
    const t = all.find((r) => r.action === "TRANSFER");
    if (!t) throw new Error("fixture dataset must produce a TRANSFER");
    transfer = t;
    const rec = await repo.users.create({
      name: "Out Of Scope",
      email: "oos.manager@stockflow.dev",
      passwordHash: "x",
      role: "manager",
      branchIds: ["BR-009"],
      isActive: true,
    });
    outsider = { id: rec.id, email: rec.email, role: "manager" };
  });
  afterAll(async () => app.close());

  it("fixture produces a transfer from BR-001 to BR-005", () => {
    expect(transfer).toMatchObject({ action: "TRANSFER", branchId: "BR-005", donorBranchId: "BR-001" });
    expect(transfer.quantity).toBeGreaterThanOrEqual(5);
  });

  async function visibleIds(user: { id: string; email: string; role: User["role"] }) {
    const res = await app.inject({ method: "GET", url: "/api/recommendations", headers: bearer(tokenFor(app, user)) });
    expect(res.statusCode).toBe(200);
    return json<RecommendationList>(res.payload).recommendations.map((r) => r.id);
  }

  it.each([
    ["admin", SEED_USERS.admin, true],
    ["manager whose branch is the donor", SEED_USERS.managerMidwest, true],
    ["manager whose branch is the receiver", SEED_USERS.managerWest, true],
    ["staff at the donor branch", SEED_USERS.staffChicago, true],
    ["staff at an unrelated branch", SEED_USERS.staffLincoln, false],
  ] as const)("%s sees it: %s", async (_label, user, visible) => {
    expect((await visibleIds(user)).includes(transfer.id)).toBe(visible);
  });

  it("manager with neither branch in scope does not see it and cannot decide it", async () => {
    expect((await visibleIds(outsider)).includes(transfer.id)).toBe(false);
    const res = await app.inject({
      method: "POST",
      url: `/api/recommendations/${transfer.id}/approve`,
      headers: bearer(tokenFor(app, outsider)),
    });
    expect(res.statusCode).toBe(403);
  });

  it("staff at the donor branch cannot decide it", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/recommendations/${transfer.id}/approve`,
      headers: bearer(tokenFor(app, SEED_USERS.staffChicago)),
    });
    expect(res.statusCode).toBe(403);
  });

  it("manager whose branch is only the donor can approve it", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/recommendations/${transfer.id}/approve`,
      headers: bearer(tokenFor(app, SEED_USERS.managerMidwest)),
    });
    expect(res.statusCode).toBe(200);
    expect(json<Recommendation>(res.payload).status).toBe("APPROVED");
  });
});

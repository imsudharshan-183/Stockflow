import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { BriefResponse } from "@stockflow/core";
import { bearer, SEED_USERS, setupApp, tokenFor, type TestContext } from "../test/helpers.js";
import { writeBrief } from "../services/briefWriter.js";

const answer = (focusId: string) =>
  Response.json({
    status: "completed",
    output: [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: JSON.stringify({
              focusId,
            }),
          },
        ],
      },
    ],
  });

describe("scoped stock briefs", () => {
  let ctx: TestContext;
  const post = (who: keyof typeof SEED_USERS, payload: Record<string, string>) =>
    ctx.app.inject({
      method: "POST",
      url: "/api/ai/brief",
      headers: bearer(tokenFor(ctx.app, SEED_USERS[who])),
      payload,
    });
  beforeAll(async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-only");
    vi.stubEnv("GEMINI_API_KEY", "");
    try {
      ctx = await setupApp({ authEnabled: true });
    } finally {
      vi.unstubAllEnvs();
    }
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => ctx.app.close());

  it("only sends operational facts for the assigned store, and returns server-built links", async () => {
    const call = vi.fn<typeof fetch>().mockResolvedValue(answer("pending_flags"));
    vi.stubGlobal("fetch", call);
    const response = await post("staffManama", { branchId: "BR-001" });
    expect(response.statusCode).toBe(200);
    const result = response.json<BriefResponse>();
    expect(result.source).toBe("openai");
    expect(result.facts[0]).toMatchObject({ id: "pending_flags", href: "#store-alerts" });
    const body = JSON.parse(String(call.mock.calls[0]![1]!.body));
    const input = JSON.parse(body.input);
    expect(input.role).toBe("staff");
    for (const metric of input.metrics) {
      expect(Object.keys(metric).sort()).toEqual(["id", "value"]);
      expect(metric.id).toMatch(
        /^(at_risk_products|shelf_check_[12]|incoming_deliveries|pending_flags)$/,
      );
      expect(metric.value).toMatch(/^\d+( units on hand)?$/);
    }
    expect(body.store).toBe(false);
    expect(body.input).not.toMatch(/@|BR-\d+|BD |freight|margin|cost|https?:/);
  });

  it("rejects anonymous, out-of-scope, forged-role, and staff transfer requests before provider access", async () => {
    const call = vi.fn();
    vi.stubGlobal("fetch", call);
    expect(
      (await ctx.app.inject({ method: "POST", url: "/api/ai/brief", payload: {} })).statusCode,
    ).toBe(401);
    expect((await post("staffManama", { role: "admin" })).statusCode).toBe(400);
    expect((await post("managerManama", { branchId: "BR-015" })).statusCode).toBe(403);
    expect((await post("staffManama", { orderId: "any" })).statusCode).toBe(403);
    expect((await post("managerManama", { orderId: "missing-order" })).statusCode).toBe(404);
    expect(call).not.toHaveBeenCalled();
  });

  it("returns scoped manager records on invalid references and provider failure", async () => {
    const call = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(answer("unknown"))
      .mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", call);
    for (let i = 0; i < 2; i++) {
      const response = await post("managerManama", { branchId: "BR-001" });
      expect(response.statusCode).toBe(200);
      expect(response.json<BriefResponse>()).toMatchObject({
        source: "records",
        facts: expect.arrayContaining([
          expect.objectContaining({ id: "pending_actions", href: "/queue?location=BR-001" }),
        ]),
      });
    }
  });

  it("explains an actual scoped transfer and withholds explanations from unrelated managers", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(answer("quantity")));
    const orders = await ctx.app.inject({
      method: "GET",
      url: "/api/orders?queue=suggested&type=TRANSFER",
      headers: bearer(tokenFor(ctx.app, SEED_USERS.admin)),
    });
    const order = orders
      .json()
      .orders.find(
        (row: { sourceBranchId: string; targetBranchId: string }) =>
          !["BR-001", "BR-002"].includes(row.sourceBranchId) &&
          !["BR-001", "BR-002"].includes(row.targetBranchId),
      );
    expect(order).toBeDefined();
    expect(
      (await post("admin", { orderId: order.id })).json<BriefResponse>().facts[0],
    ).toMatchObject({ id: "quantity", value: `${order.quantity} units` });
    expect((await post("managerManama", { orderId: order.id })).statusCode).toBe(404);
  });

  it("discards invented prose even when it accompanies a real metric", async () => {
    const records = { asOf: "2026-11-25", summary: "Check shelf stock.", facts: [{ id: "low", label: "Low stock", value: "2" }] };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ focusId: "low", summary: "Your supplier confirmed the shipment." }) }] }],
    })));
    expect(await writeBrief(records, "manager", { OPENAI_API_KEY: "test-only" })).toEqual({ ...records, source: "records" });
  });

  it("uses records immediately when no provider key is configured", async () => {
    const call = vi.fn();
    vi.stubGlobal("fetch", call);
    const records = { asOf: "2026-11-25", facts: [], summary: "Review the store reports." };
    expect(await writeBrief(records, "admin", {})).toEqual({ ...records, source: "records" });
    expect(call).not.toHaveBeenCalled();
  });

  it("keeps the provider disabled for anonymous demo-admin mode", async () => {
    const call = vi.fn();
    vi.stubGlobal("fetch", call);
    const demo = await setupApp({ authEnabled: false });
    try {
      const response = await demo.app.inject({ method: "POST", url: "/api/ai/brief", payload: {} });
      expect(response.statusCode).toBe(403);
      expect(call).not.toHaveBeenCalled();
    } finally {
      await demo.app.close();
    }
  });

  it("limits generation per signed-in user", async () => {
    const call = vi.fn<typeof fetch>().mockImplementation(async () => answer("pending_flags"));
    vi.stubGlobal("fetch", call);
    for (let index = 0; index < 12; index++) {
      expect((await post("staffJuffair", {})).statusCode).toBe(200);
    }
    expect((await post("staffJuffair", {})).statusCode).toBe(429);
    expect(call).toHaveBeenCalledTimes(12);
    expect((await post("staffManama", {})).statusCode).toBe(200);
  });
});

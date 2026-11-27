import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type ChatResponse } from "@stockflow/core";
import { upsertSalesEntry } from "../db.js";
import { answerStockQuestion } from "../services/stockChat.js";
import { writeBrief } from "../services/briefWriter.js";
import { SEED_USERS, bearer, buildMultipartPayload, setupApp, tokenFor, type TestContext } from "../test/helpers.js";
import { getBahrainToday } from "../utils/bahrainDate.js";

describe("stock assistant database lookups", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    try {
      ctx = await setupApp({ authEnabled: true });
    } finally {
      vi.unstubAllEnvs();
    }
  });
  afterAll(async () => ctx.app.close());
  afterEach(() => vi.unstubAllGlobals());
  const ask = (payload: object, who: keyof typeof SEED_USERS = "staffManama") =>
    ctx.app.inject({
      method: "POST",
      url: "/api/ai/chat",
      payload,
      headers: bearer(tokenFor(ctx.app, SEED_USERS[who])),
    });
  it("sums today's reported units only inside the caller's store", async () => {
    const date = getBahrainToday(ctx.services.runtime.now()).isoDate;
    await upsertSalesEntry(
      { date, branchId: "BR-001", sku: "SKU-00001", unitsSold: 4, onHand: 3 },
      false,
    );
    await upsertSalesEntry(
      { date, branchId: "BR-002", sku: "SKU-00001", unitsSold: 8, onHand: 10 },
      false,
    );
    const first = (await ask({ question: "What sold today?" })).json<ChatResponse>();
    expect(first.source).toBe("records");
    expect(first.asOf).toBe(date);
    expect(first.facts).toHaveLength(1);
    expect(first.facts[0]).toMatchObject({ id: "BR-001", value: "4 units · 1 entry" });
    const follow = (await ask({ question: "again", previous: first.context })).json<ChatResponse>();
    expect(follow.facts).toEqual(first.facts);
  });
  it("refuses forged scope and accepts only the fixed input contract", async () => {
    expect((await ask({ question: "What sold today?", branchId: "BR-015" })).statusCode).toBe(403);
    expect((await ask({ question: "What sold today in BR-015?" })).statusCode).toBe(403);
    expect((await ask({ question: "stock?", collection: "users" })).statusCode).toBe(400);
    expect(
      (
        await ctx.app.inject({
          method: "POST",
          url: "/api/ai/chat",
          payload: { question: "hello" },
        })
      ).statusCode,
    ).toBe(401);
  });
  it("finds scoped product records and returns help for unsupported requests", async () => {
    const product = (await ask({ question: "Find SKU-00001" })).json<ChatResponse>();
    expect(product.facts).toHaveLength(1);
    expect(product.facts[0]?.id).toBe("BR-001:SKU-00001");
    expect((await ask({ question: "Delete SKU-00001" })).json<ChatResponse>().context.topic).toBe(
      "help",
    );
  });
  it("answers scoped catalog counts and filters price questions by role", async () => {
    const admin = (await ask({ question: "How many products do I have over BD 200?" }, "admin")).json<ChatResponse>();
    expect(admin.context.topic).toBe("catalog");
    expect(admin.summary).toContain("priced over BD 200.000");
    const changed = (await ask({ question: "What about 100?", previous: admin.context }, "admin")).json<ChatResponse>();
    expect(changed.context.catalog).toMatchObject({ metric: "price", operator: "gt", amount: 100 });
    const ranked = (await ask({ question: "See highest-priced products", previous: changed.context }, "admin")).json<ChatResponse>();
    const prices = ranked.facts.map((fact) => Number(fact.value.replace("BD ", "")));
    expect(prices.length).toBeGreaterThan(1);
    expect(prices).toEqual([...prices].sort((a, b) => b - a));
    const staff = (await ask({ question: "How many products do I have over BD 200?" })).json<ChatResponse>();
    expect(staff.summary).toMatch(/Selling prices are available to managers and admins/);
    const list = (await ask({ question: "List products" }, "managerManama")).json<ChatResponse>();
    expect(list.facts.length).toBeGreaterThan(0);
    expect(list.facts.length).toBeLessThanOrEqual(10);
  });
  it("refreshes today's scoped summary after a CSV import and a correction", async () => {
    const date = getBahrainToday(ctx.services.runtime.now()).isoDate;
    const who = "managerRegional";
    const upload = async (units: number) => {
      const file = buildMultipartPayload("file", "daily.csv",
        `branchId,sku,date,unitsSold,onHand\nBR-005,SKU-00003,${date},${units},12`);
      const saved = await ctx.app.inject({ method: "POST", url: "/api/sales-entries/import",
        headers: { ...bearer(tokenFor(ctx.app, SEED_USERS[who])), "content-type": file.contentType }, payload: file.payload });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().errors).toEqual([]);
    };
    const empty = (await ask({ question: "Summarize the data", page: "sales" }, who)).json<ChatResponse>();
    expect(empty.summary).toMatch(/No sales entries/);
    await upload(0);
    const zero = (await ask({ question: "Summarize today’s sales" }, who)).json<ChatResponse>();
    expect(zero.summary).toContain("0 units sold today, based on entries from 1 of 4 stores");
    expect(zero.facts.map((fact) => fact.id)).toEqual(["BR-005", "awaiting_reports"]);
    await upload(7);
    const updated = (await ask({ question: "Refresh today’s sales", previous: zero.context }, who)).json<ChatResponse>();
    expect(updated.facts[0]?.value).toBe("7 units · 1 entry");
    expect(updated.asOf).toBe(date);
  });

  it("resolves page and shortage references against authorized inventory", async () => {
    const onPage = (await ask({ question: "How much of this product is on hand?", productSku: "SKU-00002" })).json<ChatResponse>();
    expect(onPage.facts[0]?.id).toBe("BR-001:SKU-00002");
    const low = (await ask({ question: "Which products are running low?" }, "admin")).json<ChatResponse>();
    expect(low.context.firstItem).toBeDefined();
    const question = "Why is the first item at risk?";
    const explanation = (await ask({ question, previous: low.context }, "admin")).json<ChatResponse>();
    expect(explanation.context.branchId).toBe(low.context.firstItem?.branchId);
    expect(explanation.facts[0]?.id).toBe(low.context.firstItem?.sku);
    const forged = { ...low.context, firstItem: { sku: "SKU-00002", branchId: "BR-015" } };
    expect((await ask({ question, previous: forged })).statusCode).toBe(403);
    expect((await ask({ question }, "admin")).json<ChatResponse>().summary).toMatch(/Which product and store/);
  });
  it("uses the requested SKU for forecasts and reports missing matches", async () => {
    const read = async (sku: string) => (await ask({ question: "Show forecast for " + sku }, "managerRegional")).json<ChatResponse>();
    const forecast = await read("SKU-00001");
    expect(forecast.facts.length).toBeGreaterThan(0);
    expect(forecast.facts.every(f => f.id.endsWith(":SKU-00001"))).toBe(true);
    expect((await read("SKU-99999")).facts).toEqual([]);
  });

  it("preserves the named branch on refresh and declines unsupported sales periods", async () => {
    const first = (await ask({ question: "What sold today in BR-001?" }, "managerManama")).json<ChatResponse>();
    const next = (await ask({ question: "again", previous: first.context }, "managerManama")).json<ChatResponse>();
    expect(next.context.branchId).toBe("BR-001");
    expect(next.facts).toEqual(first.facts);
    const old = (await ask({ question: "What was our revenue yesterday?" }, "admin")).json<ChatResponse>();
    expect(old.context.topic).toBe("help");
    expect(old.facts).toEqual([]);
  });

  it("declines model lookups with invented product filters or thresholds", async () => {
    const admin = await ctx.repo.users.findById(SEED_USERS.admin.id);
    for (const intent of [
      { topic: "product", search: "SKU-12345", catalog: null },
      { topic: "catalog", search: "", catalog: { metric: "price", operator: "gt", amount: 999, sort: "sku", view: "count" } },
    ]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ candidates: [{
        finishReason: "STOP", content: { parts: [{ text: JSON.stringify(intent) }] },
      }] })));
      const result = await answerStockQuestion(ctx.services, admin!, { question: "Which items carry a price tag above BD 200?" }, { GEMINI_API_KEY: "test-only" });
      expect(result.context.topic).toBe("help");
      expect(result.facts).toEqual([]);
    }
  });

  it("keeps a Gemini key on Google's endpoint and falls back without forwarding on rejection", async () => {
    const call = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 429 }));
    vi.stubGlobal("fetch", call);
    const response = await writeBrief(
      {
        asOf: "2026-11-25",
        summary: "Check shelf stock.",
        facts: [{ id: "low", label: "Low stock", value: "1" }],
      },
      "staff",
      { GEMINI_API_KEY: "gemini-test-only", OPENAI_API_KEY: "openai-test-only" },
    );
    expect(response.source).toBe("records");
    expect(call).toHaveBeenCalledTimes(1);
    const [url, options] = call.mock.calls[0]!;
    expect(new URL(String(url)).hostname).toBe("generativelanguage.googleapis.com");
    expect(options?.headers).toMatchObject({ "x-goog-api-key": "gemini-test-only" });
  });
});

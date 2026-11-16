import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearMemorySalesEntries, clearRecomputeCallLog, getRecomputeCallLog } from "./db.js";
import { SEED_USERS, bearer, buildMultipartPayload, json, setupApp, tokenFor } from "./test/helpers.js";

const HEADER = "branchId,sku,date,unitsSold,onHand";
const FIVE_MB = 5 * 1024 * 1024;

let app: FastifyInstance;

beforeAll(async () => {
  app = (await setupApp({ authEnabled: false })).app;
});
afterAll(async () => app.close());
beforeEach(() => {
  clearMemorySalesEntries();
  clearRecomputeCallLog();
});

async function post(payload: unknown) {
  const res = await app.inject({ method: "POST", url: "/api/sales-entries", payload: payload as object });
  return { status: res.statusCode, body: json<Record<string, unknown>>(res.payload) };
}

async function importCsv(content: string | Buffer, field = "file") {
  const { payload, contentType } = buildMultipartPayload(field, "sales.csv", content);
  const res = await app.inject({
    method: "POST",
    url: "/api/sales-entries/import",
    headers: { "content-type": contentType },
    payload,
  });
  return {
    status: res.statusCode,
    body: json<{ inserted: number; updated: number; errors: Array<{ row: number; message: string }>; error?: string }>(
      res.payload,
    ),
  };
}

const pairs = () => getRecomputeCallLog().map((c) => `${c.branchId}:${c.sku}`);
const valid = { branchId: "BR-001", sku: "SKU-00001", date: "2026-11-13", unitsSold: 5, onHand: 20 };

describe("POST /api/sales-entries validation", () => {
  it.each([
    ["body is an array", [], "Request body must be a JSON object"],
    ["branchId missing", { ...valid, branchId: undefined }, "Field 'branchId' is required"],
    ["branchId null", { ...valid, branchId: null }, "Field 'branchId' is required"],
    ["branchId empty", { ...valid, branchId: "" }, "Field 'branchId' is required"],
    ["branchId blank", { ...valid, branchId: "   " }, "Field 'branchId' must be a non-empty string"],
    ["branchId number", { ...valid, branchId: 7 }, "Field 'branchId' must be a non-empty string"],
    ["sku missing", { ...valid, sku: undefined }, "Field 'sku' is required"],
    ["sku blank", { ...valid, sku: "  " }, "Field 'sku' must be a non-empty string"],
    ["sku number", { ...valid, sku: 1 }, "Field 'sku' must be a non-empty string"],
    ["date missing", { ...valid, date: undefined }, "Field 'date' is required"],
    ["date US format", { ...valid, date: "11/13/2026" }, "Field 'date' must be a valid date string in YYYY-MM-DD format"],
    ["date impossible", { ...valid, date: "2026-02-30" }, "Field 'date' must be a valid date string in YYYY-MM-DD format"],
    ["date with time", { ...valid, date: "2026-11-13T00:00:00Z" }, "Field 'date' must be a valid date string in YYYY-MM-DD format"],
    ["unitsSold missing", { ...valid, unitsSold: undefined }, "Field 'unitsSold' is required"],
    ["unitsSold negative", { ...valid, unitsSold: -1 }, "Field 'unitsSold' must be a non-negative number (>= 0)"],
    ["unitsSold string in JSON", { ...valid, unitsSold: "5" }, "Field 'unitsSold' must be a non-negative number (>= 0)"],
    ["onHand missing", { ...valid, onHand: undefined }, "Field 'onHand' is required"],
    ["onHand negative", { ...valid, onHand: -5 }, "Field 'onHand' must be a non-negative number (>= 0)"],
    ["onHand boolean", { ...valid, onHand: true }, "Field 'onHand' must be a non-negative number (>= 0)"],
  ])("400 when %s", async (_label, payload, message) => {
    const r = await post(payload);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: message });
    expect(getRecomputeCallLog()).toHaveLength(0);
  });

  it("reports the first invalid field in order branchId, sku, date, unitsSold, onHand", async () => {
    const r = await post({ date: "bad", unitsSold: -1 });
    expect(r.body.error).toBe("Field 'branchId' is required");
  });

  it("accepts zeros", async () => {
    const r = await post({ ...valid, unitsSold: 0, onHand: 0 });
    expect(r.status).toBe(201);
  });
});

describe("POST /api/sales-entries upsert on (branchId, sku, date)", () => {
  it("201, returns the stored entry, recomputes the pair", async () => {
    const r = await post(valid);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject(valid);
    expect(typeof r.body.updatedAt).toBe("string");
    expect(pairs()).toEqual(["BR-001:SKU-00001"]);
  });

  it("trims identifiers so ' BR-001 ' and 'BR-001' are the same key", async () => {
    const r = await post({ ...valid, branchId: " BR-001 ", sku: " SKU-00001 " });
    expect(r.body).toMatchObject({ branchId: "BR-001", sku: "SKU-00001" });
    const imp = await importCsv(`${HEADER}\nBR-001,SKU-00001,2026-11-13,9,9`);
    expect(imp.body).toMatchObject({ inserted: 0, updated: 1 });
  });

  it("same key updates; a different date, branch, or SKU inserts", async () => {
    await post(valid);
    const second = await post({ ...valid, unitsSold: 12, onHand: 37 });
    expect(second.body).toMatchObject({ unitsSold: 12, onHand: 37 });
    const imp = await importCsv(
      [
        HEADER,
        "BR-001,SKU-00001,2026-11-13,1,1", // same key -> update
        "BR-001,SKU-00001,2026-11-14,1,1", // new date
        "BR-002,SKU-00001,2026-11-13,1,1", // new branch
        "BR-001,SKU-00002,2026-11-13,1,1", // new sku
      ].join("\n"),
    );
    expect(imp.body).toEqual({ inserted: 3, updated: 1, errors: [] });
  });
});

describe("POST /api/sales-entries/import", () => {
  it("mixed file: counts inserted, updated, and per-row errors; recompute once per distinct pair", async () => {
    await post({ branchId: "BR-001", sku: "SKU-00001", date: "2026-11-10", unitsSold: 3, onHand: 50 });
    clearRecomputeCallLog();

    const csv = [
      HEADER,
      "BR-001,SKU-00001,2026-11-10,5,48", // 1 update
      "BR-001,SKU-00001,2026-11-11,6,42", // 2 insert, same pair
      "BR-002,SKU-00002,bad-date,4,20", // 3 error
      "BR-002,SKU-00002,2026-11-11,-3,20", // 4 error
      "BR-002,SKU-00003,2026-11-11,8,30", // 5 insert
      ",SKU-00004,2026-11-11,1,1", // 6 error
      "BR-003,,2026-11-11,1,1", // 7 error
      "BR-003,SKU-00005,,1,1", // 8 error
      "BR-003,SKU-00005,2026-11-11,,1", // 9 error
      "BR-003,SKU-00005,2026-11-11,abc,1", // 10 error (non-numeric)
      "BR-003,SKU-00005,2026-11-11,1,", // 11 error
      "BR-003,SKU-00005,2026-11-11,1,-1", // 12 error
      "BR-001,SKU-00001,2026-11-12,7,35", // 13 insert, same pair again
    ].join("\n");

    const r = await importCsv(csv);
    expect(r.status).toBe(200);
    expect(r.body.inserted).toBe(3);
    expect(r.body.updated).toBe(1);
    expect(r.body.errors).toEqual([
      { row: 3, message: "Field 'date' must be a valid date string in YYYY-MM-DD format" },
      { row: 4, message: "Field 'unitsSold' must be a non-negative number (>= 0)" },
      { row: 6, message: "Field 'branchId' is required" },
      { row: 7, message: "Field 'sku' is required" },
      { row: 8, message: "Field 'date' is required" },
      { row: 9, message: "Field 'unitsSold' is required" },
      { row: 10, message: "Field 'unitsSold' must be a non-negative number (>= 0)" },
      { row: 11, message: "Field 'onHand' is required" },
      { row: 12, message: "Field 'onHand' must be a non-negative number (>= 0)" },
    ]);
    // BR-002:SKU-00002 and BR-003:SKU-00005 only had bad rows: no recompute for them.
    expect(pairs()).toEqual(["BR-001:SKU-00001", "BR-002:SKU-00003"]);
  });

  it("duplicate rows in one file: first inserts, second updates, one recompute", async () => {
    const r = await importCsv([HEADER, "BR-001,SKU-00001,2026-11-13,5,20", "BR-001,SKU-00001,2026-11-13,6,19"].join("\n"));
    expect(r.body).toEqual({ inserted: 1, updated: 1, errors: [] });
    expect(pairs()).toEqual(["BR-001:SKU-00001"]);
  });

  it("handles CRLF, a UTF-8 BOM, quoted cells, reordered and extra columns, and trailing blank lines", async () => {
    const csv =
      "\uFEFFsku,note,onHand,date,unitsSold,branchId\r\n" +
      '"SKU-00001","hello, world",20,2026-11-13,5,"BR-001"\r\n' +
      ' SKU-00002 ,"say ""hi""",10,2026-11-13,2, BR-001 \r\n' +
      "\r\n\r\n";
    const r = await importCsv(csv);
    expect(r.body).toEqual({ inserted: 2, updated: 0, errors: [] });
    expect(pairs()).toEqual(["BR-001:SKU-00001", "BR-001:SKU-00002"]);
  });

  // Current behaviour: header problems are reported per row with 200, not as a file-level 400.
  // What is guaranteed (and asserted) is that nothing is written and nothing is recomputed.
  it("wrong header: nothing written, every row reported, no recompute", async () => {
    const r = await importCsv(["branch,product,day,sold,stock", "BR-001,SKU-00001,2026-11-13,5,20", "BR-002,SKU-00001,2026-11-13,5,20"].join("\n"));
    expect(r.status).toBe(200);
    expect(r.body.inserted).toBe(0);
    expect(r.body.updated).toBe(0);
    expect(r.body.errors).toEqual([
      { row: 1, message: "Field 'branchId' is required" },
      { row: 2, message: "Field 'branchId' is required" },
    ]);
    expect(getRecomputeCallLog()).toHaveLength(0);
  });

  it.each([
    ["empty file", ""],
    ["header only", `${HEADER}\n`],
  ])("%s: zero counts, no errors, no recompute", async (_label, csv) => {
    const r = await importCsv(csv);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ inserted: 0, updated: 0, errors: [] });
    expect(getRecomputeCallLog()).toHaveLength(0);
  });

  it("accepts a file of exactly 5MB", async () => {
    const head = `${HEADER}\nBR-001,SKU-00001,2026-11-13,5,20\n`;
    const file = Buffer.concat([Buffer.from(head), Buffer.alloc(FIVE_MB - Buffer.byteLength(head), "\n")]);
    expect(file.byteLength).toBe(FIVE_MB);
    const r = await importCsv(file);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ inserted: 1, updated: 0, errors: [] });
  });

  it("413 for a file one byte over 5MB, nothing written", async () => {
    const head = `${HEADER}\nBR-001,SKU-00001,2026-11-13,5,20\n`;
    const file = Buffer.concat([Buffer.from(head), Buffer.alloc(FIVE_MB + 1 - Buffer.byteLength(head), "\n")]);
    const r = await importCsv(file);
    expect(r.status).toBe(413);
    expect(r.body.error).toBe("Uploaded file exceeds the 5MB limit");
    expect(getRecomputeCallLog()).toHaveLength(0);
  });

  it("413 when the request body exceeds the parser limit", async () => {
    const r = await importCsv(Buffer.alloc(6 * 1024 * 1024, "\n"));
    expect(r.status).toBe(413);
  });

  it("400 for a JSON body instead of multipart", async () => {
    const res = await app.inject({ method: "POST", url: "/api/sales-entries/import", payload: { file: "x" } });
    expect(res.statusCode).toBe(400);
    expect(json(res.payload)).toEqual({ error: "Expected multipart/form-data with a 'file' field" });
  });

  it("400 for multipart without a boundary", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sales-entries/import",
      headers: { "content-type": "multipart/form-data" },
      payload: Buffer.from("whatever"),
    });
    expect(res.statusCode).toBe(400);
    expect(json(res.payload)).toEqual({ error: "Missing multipart/form-data boundary" });
  });

  it("400 when the part is not named 'file'", async () => {
    const r = await importCsv(`${HEADER}\nBR-001,SKU-00001,2026-11-13,5,20`, "upload");
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("Missing required file field named 'file'");
  });
});

describe("POST /api/sales-entries & /import auth and branch scoping (AUTH_ENABLED=true)", () => {
  let authedApp: FastifyInstance;

  beforeAll(async () => {
    authedApp = (await setupApp({ authEnabled: true })).app;
  });
  afterAll(async () => authedApp.close());

  it("401 without a token on both /sales-entries and /sales-entries/import", async () => {
    const single = await authedApp.inject({
      method: "POST",
      url: "/api/sales-entries",
      payload: valid,
    });
    expect(single.statusCode).toBe(401);

    const { payload, contentType } = buildMultipartPayload(
      "file",
      "sales.csv",
      `${HEADER}\nBR-001,SKU-00001,2026-11-13,5,20`,
    );
    const imp = await authedApp.inject({
      method: "POST",
      url: "/api/sales-entries/import",
      headers: { "content-type": contentType },
      payload,
    });
    expect(imp.statusCode).toBe(401);
  });

  it("enforces sales:enter permission and branch scope on POST /api/sales-entries", async () => {
    const staffToken = tokenFor(authedApp, SEED_USERS.staffManama); // BR-001 only, no sales:enter
    const mgrToken = tokenFor(authedApp, SEED_USERS.managerManama); // BR-001, BR-002

    const staffAttempt = await authedApp.inject({
      method: "POST",
      url: "/api/sales-entries",
      headers: bearer(staffToken),
      payload: { ...valid, branchId: "BR-001" },
    });
    expect(staffAttempt.statusCode).toBe(403);

    const mgrOos = await authedApp.inject({
      method: "POST",
      url: "/api/sales-entries",
      headers: bearer(mgrToken),
      payload: { ...valid, branchId: "BR-005" },
    });
    expect(mgrOos.statusCode).toBe(403);

    const mgrOk = await authedApp.inject({
      method: "POST",
      url: "/api/sales-entries",
      headers: bearer(mgrToken),
      payload: { ...valid, branchId: "BR-001" },
    });
    expect(mgrOk.statusCode).toBe(201);
  });

  it("reports out-of-scope CSV rows as row errors without failing in-scope rows", async () => {
    const mgrToken = tokenFor(authedApp, SEED_USERS.managerManama); // BR-001, BR-002
    const mixedScopeCsv = [
      HEADER,
      "BR-001,SKU-00001,2026-11-13,5,20",
      "BR-005,SKU-00001,2026-11-13,5,20", // out-of-scope
    ].join("\n");
    const bad = buildMultipartPayload("file", "sales.csv", mixedScopeCsv);
    const mixedRes = await authedApp.inject({
      method: "POST",
      url: "/api/sales-entries/import",
      headers: { ...bearer(mgrToken), "content-type": bad.contentType },
      payload: bad.payload,
    });
    expect(mixedRes.statusCode).toBe(200);
    expect(json(mixedRes.payload)).toEqual({
      inserted: 1,
      updated: 0,
      errors: [{ row: 2, message: "Branch 'BR-005' is outside your assigned scope" }],
    });

    const inScopeCsv = [
      HEADER,
      "BR-001,SKU-00001,2026-11-13,5,20",
      "BR-002,SKU-00002,2026-11-13,3,15",
    ].join("\n");
    const good = buildMultipartPayload("file", "sales.csv", inScopeCsv);
    const goodRes = await authedApp.inject({
      method: "POST",
      url: "/api/sales-entries/import",
      headers: { ...bearer(mgrToken), "content-type": good.contentType },
      payload: good.payload,
    });
    expect(goodRes.statusCode).toBe(200);
    expect(json(goodRes.payload)).toEqual({ inserted: 1, updated: 1, errors: [] });
  });

  it("supports GET, PATCH, DELETE, and template.csv with validation and scope checks", async () => {
    const mgrToken = tokenFor(authedApp, SEED_USERS.managerManama);
    const staffToken = tokenFor(authedApp, SEED_USERS.staffManama);

    // Staff blocked on GET & template
    const staffGet = await authedApp.inject({
      method: "GET",
      url: "/api/sales-entries",
      headers: bearer(staffToken),
    });
    expect(staffGet.statusCode).toBe(403);

    const tplRes = await authedApp.inject({
      method: "GET",
      url: "/api/sales-entries/template.csv",
      headers: bearer(mgrToken),
    });
    expect(tplRes.statusCode).toBe(200);
    expect(tplRes.payload).toContain("branchId,sku,date,unitsSold,onHand");

    // Future date & unknown branch/SKU rejected
    const futureRes = await authedApp.inject({
      method: "POST",
      url: "/api/sales-entries",
      headers: bearer(mgrToken),
      payload: { ...valid, date: "2099-01-01" },
    });
    expect(futureRes.statusCode).toBe(400);

    const badBranchRes = await authedApp.inject({
      method: "POST",
      url: "/api/sales-entries",
      headers: bearer(mgrToken),
      payload: { ...valid, branchId: "BR-999" },
    });
    expect(badBranchRes.statusCode).toBe(400);

    // Create, list, patch, delete
    const createdRes = await authedApp.inject({
      method: "POST",
      url: "/api/sales-entries",
      headers: bearer(mgrToken),
      payload: valid,
    });
    expect(createdRes.statusCode).toBe(201);
    const created = json<{ id: string }>(createdRes.payload);

    const listRes = await authedApp.inject({
      method: "GET",
      url: "/api/sales-entries?branch=BR-001&sku=SKU-00001",
      headers: bearer(mgrToken),
    });
    expect(listRes.statusCode).toBe(200);
    expect(json<{ total: number }>(listRes.payload).total).toBe(1);

    const immutablePatch = await authedApp.inject({
      method: "PATCH",
      url: `/api/sales-entries/${encodeURIComponent(created.id)}`,
      headers: bearer(mgrToken),
      payload: { sku: "SKU-00002", unitsSold: 10 },
    });
    expect(immutablePatch.statusCode).toBe(400);

    const patchRes = await authedApp.inject({
      method: "PATCH",
      url: `/api/sales-entries/${encodeURIComponent(created.id)}`,
      headers: bearer(mgrToken),
      payload: { unitsSold: 12, onHand: 8 },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(json<{ unitsSold: number; onHand: number }>(patchRes.payload)).toMatchObject({
      unitsSold: 12,
      onHand: 8,
    });

    const delRes = await authedApp.inject({
      method: "DELETE",
      url: `/api/sales-entries/${encodeURIComponent(created.id)}`,
      headers: bearer(mgrToken),
    });
    expect(delRes.statusCode).toBe(200);
  });
});

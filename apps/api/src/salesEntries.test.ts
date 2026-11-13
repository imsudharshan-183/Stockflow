import { beforeEach, describe, expect, it } from "vitest";
import {
  clearMemorySalesEntries,
  clearRecomputeCallLog,
  getRecomputeCallLog,
} from "./db.js";
import { buildApp } from "./plugins/app.js";
import { InMemoryRepository } from "./repositories/memory.js";
import { StockService } from "./services/stockService.js";

async function createTestServer() {
  const repo = InMemoryRepository.create();
  const service = await StockService.create(repo);
  const app = await buildApp(service, { AUTH_ENABLED: false });
  return app;
}

function buildMultipartPayload(fieldName: string, filename: string, content: string | Buffer) {
  const boundary = "----StockFlowTestBoundary7MA4YWxkTrZu0gW";
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n`,
    "utf8",
  );
  const bodyBuf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return {
    payload: Buffer.concat([prefix, bodyBuf, suffix]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe("Sales Entries API (POST /api/sales-entries & /api/sales-entries/import)", () => {
  beforeEach(() => {
    clearMemorySalesEntries();
    clearRecomputeCallLog();
  });

  it("validates each field with a specific 400 message on POST /api/sales-entries", async () => {
    const app = await createTestServer();

    const missingBranch = await app.inject({
      method: "POST",
      url: "/api/sales-entries",
      payload: { sku: "SKU-00001", date: "2026-11-13", unitsSold: 5, onHand: 20 },
    });
    expect(missingBranch.statusCode).toBe(400);
    expect(JSON.parse(missingBranch.payload).error).toContain("branchId");

    const missingSku = await app.inject({
      method: "POST",
      url: "/api/sales-entries",
      payload: { branchId: "BR-001", date: "2026-11-13", unitsSold: 5, onHand: 20 },
    });
    expect(missingSku.statusCode).toBe(400);
    expect(JSON.parse(missingSku.payload).error).toContain("sku");

    const invalidDate = await app.inject({
      method: "POST",
      url: "/api/sales-entries",
      payload: {
        branchId: "BR-001",
        sku: "SKU-00001",
        date: "11/13/2026",
        unitsSold: 5,
        onHand: 20,
      },
    });
    expect(invalidDate.statusCode).toBe(400);
    expect(JSON.parse(invalidDate.payload).error).toContain("date");

    const negativeSold = await app.inject({
      method: "POST",
      url: "/api/sales-entries",
      payload: {
        branchId: "BR-001",
        sku: "SKU-00001",
        date: "2026-11-13",
        unitsSold: -1,
        onHand: 20,
      },
    });
    expect(negativeSold.statusCode).toBe(400);
    expect(JSON.parse(negativeSold.payload).error).toContain("unitsSold");

    const negativeOnHand = await app.inject({
      method: "POST",
      url: "/api/sales-entries",
      payload: {
        branchId: "BR-001",
        sku: "SKU-00001",
        date: "2026-11-13",
        unitsSold: 4,
        onHand: -5,
      },
    });
    expect(negativeOnHand.statusCode).toBe(400);
    expect(JSON.parse(negativeOnHand.payload).error).toContain("onHand");
  });

  it("upserts on (branchId, sku, date), returns 201, and calls recomputeForSku", async () => {
    const app = await createTestServer();

    const firstRes = await app.inject({
      method: "POST",
      url: "/api/sales-entries",
      payload: {
        branchId: "BR-001",
        sku: "SKU-00001",
        date: "2026-11-13",
        unitsSold: 7,
        onHand: 42,
      },
    });
    expect(firstRes.statusCode).toBe(201);
    const firstDoc = JSON.parse(firstRes.payload);
    expect(firstDoc).toMatchObject({
      branchId: "BR-001",
      sku: "SKU-00001",
      date: "2026-11-13",
      unitsSold: 7,
      onHand: 42,
    });
    expect(firstDoc.updatedAt).toBeDefined();
    expect(getRecomputeCallLog()).toHaveLength(1);
    expect(getRecomputeCallLog()[0]).toMatchObject({ branchId: "BR-001", sku: "SKU-00001" });

    // Re-submitting same branch+SKU+date corrects the entry
    const secondRes = await app.inject({
      method: "POST",
      url: "/api/sales-entries",
      payload: {
        branchId: "BR-001",
        sku: "SKU-00001",
        date: "2026-11-13",
        unitsSold: 12,
        onHand: 37,
      },
    });
    expect(secondRes.statusCode).toBe(201);
    const secondDoc = JSON.parse(secondRes.payload);
    expect(secondDoc.unitsSold).toBe(12);
    expect(secondDoc.onHand).toBe(37);
    expect(getRecomputeCallLog()).toHaveLength(2);
  });

  it("imports CSV via POST /api/sales-entries/import, collects per-row errors, and deduplicates recomputeForSku", async () => {
    const app = await createTestServer();

    // Seed one existing entry so we can verify both `inserted` and `updated` counts
    await app.inject({
      method: "POST",
      url: "/api/sales-entries",
      payload: {
        branchId: "BR-001",
        sku: "SKU-00001",
        date: "2026-11-10",
        unitsSold: 3,
        onHand: 50,
      },
    });
    clearRecomputeCallLog();

    const csv = [
      "branchId,sku,date,unitsSold,onHand",
      "BR-001,SKU-00001,2026-11-10,5,48", // updates existing row (row 1)
      "BR-001,SKU-00001,2026-11-11,6,42", // inserts new row for SAME (BR-001, SKU-00001) (row 2)
      "BR-002,SKU-00002,bad-date,4,20", // invalid date (row 3)
      "BR-002,SKU-00002,2026-11-11,-3,20", // negative unitsSold (row 4)
      "BR-002,SKU-00003,2026-11-11,8,30", // inserts new row for (BR-002, SKU-00003) (row 5)
    ].join("\n");

    const { payload, contentType } = buildMultipartPayload("file", "sales.csv", csv);
    const res = await app.inject({
      method: "POST",
      url: "/api/sales-entries/import",
      headers: { "content-type": contentType },
      payload,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.inserted).toBe(2);
    expect(body.updated).toBe(1);
    expect(body.errors).toEqual([
      {
        row: 3,
        message: "Field 'date' must be a valid date string in YYYY-MM-DD format",
      },
      {
        row: 4,
        message: "Field 'unitsSold' must be a non-negative number (>= 0)",
      },
    ]);

    // recomputeForSku should be called ONCE for (BR-001, SKU-00001) and ONCE for (BR-002, SKU-00003) = 2 calls total
    const calls = getRecomputeCallLog();
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => `${c.branchId}:${c.sku}`)).toEqual([
      "BR-001:SKU-00001",
      "BR-002:SKU-00003",
    ]);
  });
});

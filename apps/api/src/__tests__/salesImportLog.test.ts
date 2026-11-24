import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearMemorySalesEntries, type ImportLogEntry } from "../db.js";
import type { StockRepository } from "../repositories/types.js";
import { buildTestApp, createDualRepo, createUser, type RepoKind } from "../test/dualRepo.js";
import { bearer, buildMultipartPayload, json, tokenFor } from "../test/helpers.js";

const HEADER = "branchId,sku,date,unitsSold,onHand";

describe.each<RepoKind>(["memory", "mongo-memory"])(
  "Workstream 1: import_log & GET /api/sales/imports [%s]",
  (kind) => {
    let repo: StockRepository;
    let cleanup: () => Promise<void>;

    beforeAll(async () => {
      const setup = await createDualRepo(kind);
      repo = setup.repo;
      cleanup = setup.cleanup;
    }, 120_000);

    beforeEach(() => {
      clearMemorySalesEntries();
    });

    afterAll(async () => {
      clearMemorySalesEntries();
      await cleanup?.();
    });

    it("records import_log entries with date bounds, caps at 10 newest, and scopes GET /api/sales/imports by role", async () => {
      const admin = (await createUser(repo, "admin", [], { name: "Admin One" })).user;
      const mgrA = (await createUser(repo, "manager", ["BR-001"], { name: "Manager Manama" })).user;
      const mgrB = (await createUser(repo, "manager", ["BR-005"], { name: "Manager Hidd" })).user;
      const staff = (await createUser(repo, "staff", ["BR-001"], { name: "Staff Manama" })).user;

      const { app, services } = await buildTestApp(repo);
      try {
        // 401 when unauthenticated
        expect((await app.inject({ method: "GET", url: "/api/sales/imports" })).statusCode).toBe(401);

        const hAdmin = bearer(tokenFor(app, admin));
        const hMgrA = bearer(tokenFor(app, mgrA));
        const hMgrB = bearer(tokenFor(app, mgrB));
        const hStaff = bearer(tokenFor(app, staff));

        let clock = Date.UTC(2026, 10, 24, 9, 0, 0);
        services.setClock(() => clock);

        // Manager A imports 12 valid batches across timestamps so newest 10 cap can be verified
        for (let i = 1; i <= 12; i += 1) {
          clock += 60_000;
          const csv = `${HEADER}\nBR-001,SKU-90001,2026-11-${String((i % 9) + 1).padStart(2, "0")},${i},50\n`;
          const { payload, contentType } = buildMultipartPayload(
            "file",
            `mgr-a-batch-${i}.csv`,
            csv,
          );
          const res = await app.inject({
            method: "POST",
            url: "/api/sales-entries/import",
            headers: { ...hMgrA, "content-type": contentType },
            payload,
          });
          expect(res.statusCode).toBe(200);
          expect(json(res.payload)).toEqual({
            inserted: i <= 9 ? 1 : 0,
            updated: i > 9 ? 1 : 0,
            errors: [],
          });
        }

        // Manager B imports 1 batch with 1 row error + 1 valid row
        clock += 60_000;
        const mgrBCsv = [
          HEADER,
          "BR-005,SKU-90001,2026-11-10,4,40",
          "BR-005,SKU-90001,bad-date,4,40",
        ].join("\n");
        const mpB = buildMultipartPayload("file", "hidd-mixed.csv", mgrBCsv);
        const resB = await app.inject({
          method: "POST",
          url: "/api/sales-entries/import",
          headers: { ...hMgrB, "content-type": mpB.contentType },
          payload: mpB.payload,
        });
        expect(resB.statusCode).toBe(200);

        // Admin sees up to 10 newest entries across ALL users (newest first -> hidd-mixed.csv first)
        const adminImportsRes = await app.inject({
          method: "GET",
          url: "/api/sales/imports",
          headers: hAdmin,
        });
        expect(adminImportsRes.statusCode).toBe(200);
        const adminBody = json<{ imports: ImportLogEntry[] }>(adminImportsRes.payload);
        expect(adminBody.imports).toHaveLength(10);
        expect(adminBody.imports[0]).toMatchObject({
          fileName: "hidd-mixed.csv",
          inserted: 1,
          updated: 0,
          errorCount: 1,
          minDate: "2026-11-10",
          maxDate: "2026-11-10",
          branchIds: ["BR-005"],
        });
        expect(adminBody.imports[0]?.user.userId).toBe(mgrB.id);
        expect(adminBody.imports[1]?.fileName).toBe("mgr-a-batch-12.csv");

        // Manager A sees ONLY Manager A's own imports (capped at 10)
        const mgrAImports = json<{ imports: ImportLogEntry[] }>(
          (await app.inject({ method: "GET", url: "/api/sales/imports", headers: hMgrA })).payload,
        ).imports;
        expect(mgrAImports).toHaveLength(10);
        expect(mgrAImports.every((imp) => imp.user.userId === mgrA.id)).toBe(true);
        expect(mgrAImports[0]?.fileName).toBe("mgr-a-batch-12.csv");

        // Manager B sees ONLY Manager B's own 1 import
        const mgrBImports = json<{ imports: ImportLogEntry[] }>(
          (await app.inject({ method: "GET", url: "/api/sales/imports", headers: hMgrB })).payload,
        ).imports;
        expect(mgrBImports).toHaveLength(1);
        expect(mgrBImports[0]?.fileName).toBe("hidd-mixed.csv");

        // Staff sees ONLY staff's own imports (0 here, does not see managers' imports)
        const staffRes = await app.inject({
          method: "GET",
          url: "/api/sales/imports",
          headers: hStaff,
        });
        expect(staffRes.statusCode).toBe(200);
        expect(json<{ imports: ImportLogEntry[] }>(staffRes.payload).imports).toEqual([]);
      } finally {
        await app.close();
      }
    });
  },
);

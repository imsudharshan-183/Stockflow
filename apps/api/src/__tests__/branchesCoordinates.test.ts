import { rankDonorCandidates } from "@stockflow/core";
import { afterEach, describe, expect, it } from "vitest";
import { clearMemorySalesEntries } from "../db.js";
import type { StockRepository } from "../repositories/types.js";
import { createStockServices } from "../services/index.js";
import { buildTestApp, createDualRepo, createUser, type RepoKind } from "../test/dualRepo.js";
import { bearer, json, tokenFor } from "../test/helpers.js";

describe.each<RepoKind>(["memory", "mongo-memory"])(
  "Workstream 4: Branch coordinate validation, (name, city) conflict & reload persistence [%s]",
  (kind) => {
    const cleanups: Array<() => Promise<void>> = [];

    afterEach(async () => {
      clearMemorySalesEntries();
      while (cleanups.length > 0) {
        const fn = cleanups.pop();
        if (fn) await fn();
      }
    });

    it("rounds coords to 6 decimals, enforces RBAC/400/409, persists across reload, and feeds Haversine rankDonorCandidates", async () => {
      const setup = await createDualRepo(kind);
      cleanups.push(setup.cleanup);
      const repo: StockRepository = setup.repo;

      const admin = (await createUser(repo, "admin", [], { name: "Admin Branches" })).user;
      const mgr = (await createUser(repo, "manager", ["BR-001"], { name: "Mgr Manama" })).user;

      const built = await buildTestApp(repo);
      const hAdmin = bearer(tokenFor(built.app, admin));
      const hMgr = bearer(tokenFor(built.app, mgr));

      const initialDataVersion = await repo.getDataVersion();

      // Non-admin blocked (403)
      expect(
        (
          await built.app.inject({
            method: "POST",
            url: "/api/branches",
            headers: { ...hMgr, "content-type": "application/json" },
            payload: JSON.stringify({
              name: "Forbidden Store",
              city: "Manama",
              region: "Capital",
              coordinates: [26.2285, 50.586],
            }),
          })
        ).statusCode,
      ).toBe(403);

      // Invalid / out-of-range / swapped coords rejected (400)
      for (const badPayload of [
        { name: "Bad Lat", city: "Manama", region: "Capital", coordinates: [95, 50.586] },
        { name: "Bad Lng", city: "Manama", region: "Capital", coordinates: [26.2, -190] },
        { name: "Swapped", city: "Manama", region: "Capital", coordinates: [50.586, 26.2285] },
        { name: "NonFinite", city: "Manama", region: "Capital", latitude: "abc", longitude: 50.5 },
      ]) {
        const badRes = await built.app.inject({
          method: "POST",
          url: "/api/branches",
          headers: { ...hAdmin, "content-type": "application/json" },
          payload: JSON.stringify(badPayload),
        });
        expect(badRes.statusCode).toBe(400);
      }

      // Create BR-010 with high-precision coordinates (rounds to 6 decimals)
      const createRes = await built.app.inject({
        method: "POST",
        url: "/api/branches",
        headers: { ...hAdmin, "content-type": "application/json" },
        payload: JSON.stringify({
          name: "Harbor Gate",
          city: "Manama",
          region: "Capital",
          coordinates: [26.22851234, 50.58609876],
        }),
      });
      expect(createRes.statusCode).toBe(201);
      const created = json<{ id: string; coordinates: [number, number] }>(createRes.payload);
      expect(created.id).toBe("BR-010");
      expect(created.coordinates).toEqual([26.228512, 50.586099]);
      expect(await repo.getDataVersion()).toBeGreaterThan(initialDataVersion);

      // Zero-filled daily arrays initialized for new branch
      const newBranchIdx = built.services.runtime.data.branches.findIndex((b) => b.id === "BR-010");
      expect(newBranchIdx).toBe(3);
      expect(built.services.runtime.data.sales[0]?.[newBranchIdx]?.every((v) => v === 0)).toBe(true);

      // Duplicate (name, city) fails with 409; same name in DIFFERENT city succeeds (BR-011) with latitude/longitude shape
      const dupRes = await built.app.inject({
        method: "POST",
        url: "/api/branches",
        headers: { ...hAdmin, "content-type": "application/json" },
        payload: JSON.stringify({
          name: "harbor gate",
          city: "manama",
          region: "Capital",
          coordinates: [26.23, 50.59],
        }),
      });
      expect(dupRes.statusCode).toBe(409);

      const diffCityRes = await built.app.inject({
        method: "POST",
        url: "/api/branches",
        headers: { ...hAdmin, "content-type": "application/json" },
        payload: JSON.stringify({
          name: "Harbor Gate",
          city: "Muharraq",
          region: "Muharraq",
          latitude: 26.2651239,
          longitude: 50.6198765,
        }),
      });
      expect(diffCityRes.statusCode).toBe(201);
      const diffCity = json<{ id: string; coordinates: [number, number] }>(diffCityRes.payload);
      expect(diffCity.id).toBe("BR-011");
      expect(diffCity.coordinates).toEqual([26.265124, 50.619877]);

      // Verify Haversine donor candidate distance & freight calculation uses saved coordinates
      const sku = built.services.runtime.data.products[0]!.sku;
      const candidates = rankDonorCandidates(
        built.services.runtime.data,
        built.services.runtime.committedDeltas,
        sku,
        "BR-010",
        10,
        { includeIneligible: true },
      );
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates.some((c) => Number.isFinite(c.distanceKm) && c.distanceKm > 0 && Number.isFinite(c.freightCostBhd))).toBe(true);

      // Reload from repository in fresh service instance -> persisted branches survive reload
      const reloaded = createStockServices(repo);
      await reloaded.ensureInitialized();
      const reloadedBranches = await reloaded.catalog.listBranches({}, admin);
      expect(
        reloadedBranches.branches.some((b) => b.id === "BR-010" && b.coordinates?.[0] === 26.228512),
      ).toBe(true);
      expect(
        reloadedBranches.branches.some((b) => b.id === "BR-011" && b.city === "Muharraq"),
      ).toBe(true);
    });
  },
);

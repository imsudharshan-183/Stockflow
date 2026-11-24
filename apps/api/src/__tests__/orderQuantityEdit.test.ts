import {
  BAHRAIN_BRANCHES,
  ReplenishmentOrderSchema,
  computeActionBenefitForQuantity,
  type Branch,
  type Dataset,
  type Product,
  type User,
} from "@stockflow/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StockRepository } from "../repositories/types.js";
import { buildTestApp, createDualRepo, createUser, type RepoKind } from "../test/dualRepo.js";
import { bearer, tokenFor } from "../test/helpers.js";

function makeQuantityDataset(): Dataset {
  const branchIds = ["BR-001", "BR-002", "BR-005", "BR-008"] as const;
  const branches: Branch[] = branchIds.map((id) => {
    const found = BAHRAIN_BRANCHES.find((b) => b.id === id);
    if (!found) throw new Error(`Missing branch ${id}`);
    return { ...found };
  });

  const products: Product[] = [
    {
      sku: "SKU-QTY-T",
      name: "Clearwater Mineral Case",
      category: "Beverages",
      price: 22,
      cost: 10,
      leadTimeDays: 7,
      status: "active",
    },
    {
      sku: "SKU-QTY-R",
      name: "Velo Espresso Beans",
      category: "Beverages",
      price: 26,
      cost: 12,
      leadTimeDays: 7,
      status: "active",
    },
    {
      sku: "SKU-QTY-M",
      name: "Solstice Lantern Large",
      category: "Home",
      price: 30,
      cost: 18,
      leadTimeDays: 7,
      status: "active",
    },
  ];

  const days = 30;
  const start = Date.UTC(2026, 9, 1);
  const dates = Array.from({ length: days }, (_, i) =>
    new Date(start + i * 86_400_000).toISOString().slice(0, 10),
  );

  const buildMatrix = (sArr: number[], stArr: number[]) => ({
    sales: sArr.map((s) => Array.from({ length: days }, () => s)),
    onHand: stArr.map((st) => Array.from({ length: days }, () => st)),
    demand: sArr.map((s) => Array.from({ length: days }, () => s)),
  });

  // SKU-QTY-T: BR-001 donor (~70 surplus: 2/d, 130 onHand), BR-002 short intra-cluster (~60 need: 5/d, 10 onHand), others steady
  const mT = buildMatrix([2, 5, 2, 2], [130, 10, 60, 60]);
  // SKU-QTY-R: BR-005 short (5/d, 10 onHand), others steady (2/d, 60 onHand) -> REORDER
  const mR = buildMatrix([2, 2, 5, 2], [60, 60, 10, 60]);
  // SKU-QTY-M: BR-001 zero velocity overstock (0/d, 80 onHand), others steady (2/d, 60 onHand) -> MARKDOWN
  const mM = buildMatrix([0, 2, 2, 2], [80, 60, 60, 60]);

  return {
    seed: 91,
    asOf: dates[days - 1]!,
    dates,
    branches,
    products,
    sales: [mT.sales, mR.sales, mM.sales],
    onHand: [mT.onHand, mR.onHand, mM.onHand],
    demand: [mT.demand, mR.demand, mM.demand],
  };
}

describe.each<RepoKind>(["memory", "mongo-memory"])(
  "Workstream 2: Editable approved quantity [%s]",
  (kind) => {
    let repo: StockRepository;
    let cleanup: () => Promise<void>;
    let adminUser: User;
    let mgrManama: User; // BR-001, BR-002
    let mgrHidd: User; // BR-005

    beforeAll(async () => {
      const setup = await createDualRepo(kind, makeQuantityDataset());
      repo = setup.repo;
      cleanup = setup.cleanup;
      adminUser = (await createUser(repo, "admin", [], { email: `qty.admin.${kind}@stockflow.test` })).user;
      mgrManama = (
        await createUser(repo, "manager", ["BR-001", "BR-002"], {
          email: `qty.manama.${kind}@stockflow.test`,
        })
      ).user;
      mgrHidd = (
        await createUser(repo, "manager", ["BR-005"], {
          email: `qty.hidd.${kind}@stockflow.test`,
        })
      ).user;
    }, 120_000);

    afterAll(async () => {
      await cleanup?.();
    });

    it("enforces server limits per type, recomputes benefit, checks 409 on edited qty, and records engineQty/approvedQty in OrderEvent without bumping dataVersion", async () => {
      const { app, services } = await buildTestApp(repo);
      try {
        const hAdmin = bearer(tokenFor(app, adminUser));
        const hManama = bearer(tokenFor(app, mgrManama));
        const hHidd = bearer(tokenFor(app, mgrHidd));
        const vBefore = await repo.getDataVersion();

        const listRes = await app.inject({
          method: "GET",
          url: "/api/orders",
          headers: hAdmin,
        });
        expect(listRes.statusCode).toBe(200);
        const { orders } = listRes.json() as { orders: Array<ReturnType<typeof ReplenishmentOrderSchema.parse>> };

        const transfer = orders.find((o) => o.sku === "SKU-QTY-T" && o.type === "TRANSFER");
        const reorder = orders.find((o) => o.sku === "SKU-QTY-R" && o.type === "REORDER");
        const markdown = orders.find((o) => o.sku === "SKU-QTY-M" && o.type === "MARKDOWN");
        expect(transfer).toBeDefined();
        expect(reorder).toBeDefined();
        expect(markdown).toBeDefined();

        // 1. Validation failures on TRANSFER
        const badDecimal = await app.inject({
          method: "POST",
          url: `/api/orders/${transfer!.id}/commit`,
          headers: hManama,
          payload: { approvedQty: 12.5, dispositionCode: "CASE_PACK" },
        });
        expect(badDecimal.statusCode).toBe(400);

        const belowMinTransfer = await app.inject({
          method: "POST",
          url: `/api/orders/${transfer!.id}/commit`,
          headers: hManama,
          payload: { approvedQty: 4, dispositionCode: "CASE_PACK" },
        });
        expect(belowMinTransfer.statusCode).toBe(400);

        const aboveEngineTransfer = await app.inject({
          method: "POST",
          url: `/api/orders/${transfer!.id}/commit`,
          headers: hManama,
          payload: { approvedQty: transfer!.quantity + 1, dispositionCode: "CASE_PACK" },
        });
        expect(aboveEngineTransfer.statusCode).toBe(400);

        const missingReasonTransfer = await app.inject({
          method: "POST",
          url: `/api/orders/${transfer!.id}/commit`,
          headers: hManama,
          payload: { approvedQty: Math.max(5, transfer!.quantity - 5) },
        });
        expect(missingReasonTransfer.statusCode).toBe(400);

        // 2. Create and commit a manual order consuming most of BR-001 surplus so remaining surplus < transfer.quantity
        const donorSurplusBefore = transfer!.donorAvailableSurplus ?? 70;
        const reserveQty = Math.max(5, donorSurplusBefore - 10);
        const manualRes = await app.inject({
          method: "POST",
          url: "/api/orders",
          headers: hAdmin,
          payload: {
            type: "TRANSFER",
            sku: "SKU-QTY-T",
            targetBranchId: "BR-008",
            sourceBranchId: "BR-001",
            quantity: reserveQty,
          },
        });
        expect(manualRes.statusCode).toBe(201);
        const manualOrder = manualRes.json() as ReturnType<typeof ReplenishmentOrderSchema.parse>;

        const commitManualRes = await app.inject({
          method: "POST",
          url: `/api/orders/${manualOrder.id}/commit`,
          headers: hAdmin,
          payload: { force: true, comment: "Pre-commit surplus reservation" },
        });
        expect(commitManualRes.statusCode).toBe(200);

        // Full engine qty now exceeds remaining surplus (~10 units left) -> 409 Conflict
        const fullTransferConflict = await app.inject({
          method: "POST",
          url: `/api/orders/${transfer!.id}/commit`,
          headers: hManama,
          payload: { approvedQty: transfer!.quantity },
        });
        expect(fullTransferConflict.statusCode).toBe(409);

        // Editing approvedQty down to 8 fits remaining surplus -> 200 OK
        const approvedTransferQty = 8;
        const okTransferRes = await app.inject({
          method: "POST",
          url: `/api/orders/${transfer!.id}/commit`,
          headers: hManama,
          payload: {
            approvedQty: approvedTransferQty,
            dispositionCode: "TRUCK_CAPACITY",
            comment: "Reduced to remaining van capacity",
          },
        });
        expect(okTransferRes.statusCode).toBe(200);
        const committedTransfer = ReplenishmentOrderSchema.parse(okTransferRes.json());
        expect(committedTransfer.quantity).toBe(approvedTransferQty);
        expect(committedTransfer.qty).toBe(approvedTransferQty);
        expect(committedTransfer.engineSnapshot.qty).toBe(transfer!.quantity);
        expect(committedTransfer.engineSnapshot.reasonCodes).toEqual(transfer!.engineSnapshot.reasonCodes);

        const transferCommitEvt = committedTransfer.events.find((e) => e.action === "COMMIT");
        expect(transferCommitEvt).toMatchObject({
          action: "COMMIT",
          engineQty: transfer!.quantity,
          approvedQty: approvedTransferQty,
          quantity: approvedTransferQty,
          dispositionCode: "TRUCK_CAPACITY",
          comment: "Reduced to remaining van capacity",
        });

        const expectedBenefit = computeActionBenefitForQuantity({
          type: "TRANSFER",
          quantity: approvedTransferQty,
          unitPrice: committedTransfer.engineSnapshot.unitPrice ?? 22,
          unitCost: committedTransfer.engineSnapshot.unitCost ?? 10,
          distanceKm: committedTransfer.engineSnapshot.distanceKm ?? 0,
          targetLostUnits: committedTransfer.engineSnapshot.metrics?.lostUnits ?? 0,
          donorCoverDays: committedTransfer.engineSnapshot.metrics?.donorCoverDays ?? null,
          donorVelocity: committedTransfer.engineSnapshot.donorVelocity ?? 0,
        });
        expect(committedTransfer.approvedNetBenefitBhd).toBeCloseTo(expectedBenefit.netBenefitBhd, 3);
        expect(committedTransfer.approvedFreightCostBhd).toBeCloseTo(expectedBenefit.freightCostBhd, 3);

        // committedDeltas uses approvedQty + reserveQty on donor BR-001
        const donorDelta = services.runtime.committedDeltas.get(`SKU-QTY-T::BR-001`);
        expect(donorDelta?.reserved).toBe(reserveQty + approvedTransferQty);

        // 3. REORDER rules: 1..2x, >1x requires comment + reason
        const above2xReorder = await app.inject({
          method: "POST",
          url: `/api/orders/${reorder!.id}/commit`,
          headers: hHidd,
          payload: {
            approvedQty: reorder!.quantity * 2 + 1,
            dispositionCode: "PROMO_HOLD",
            comment: "Too high",
          },
        });
        expect(above2xReorder.statusCode).toBe(400);

        const above1xNoComment = await app.inject({
          method: "POST",
          url: `/api/orders/${reorder!.id}/commit`,
          headers: hHidd,
          payload: {
            approvedQty: reorder!.quantity + 2,
            dispositionCode: "PROMO_HOLD",
          },
        });
        expect(above1xNoComment.statusCode).toBe(400);

        const boostedReorderQty = Math.min(reorder!.quantity * 2, reorder!.quantity + 5);
        const okReorderRes = await app.inject({
          method: "POST",
          url: `/api/orders/${reorder!.id}/commit`,
          headers: hHidd,
          payload: {
            approvedQty: boostedReorderQty,
            dispositionCode: "PROMO_HOLD",
            comment: "National day promo buffer",
          },
        });
        expect(okReorderRes.statusCode).toBe(200);
        const committedReorder = ReplenishmentOrderSchema.parse(okReorderRes.json());
        expect(committedReorder.qty).toBe(boostedReorderQty);
        expect(committedReorder.engineSnapshot.qty).toBe(reorder!.quantity);
        expect(committedReorder.events.find((e) => e.action === "COMMIT")).toMatchObject({
          engineQty: reorder!.quantity,
          approvedQty: boostedReorderQty,
          dispositionCode: "PROMO_HOLD",
          comment: "National day promo buffer",
        });

        // 4. MARKDOWN rules: 1..engineQty
        const aboveEngineMarkdown = await app.inject({
          method: "POST",
          url: `/api/orders/${markdown!.id}/commit`,
          headers: hManama,
          payload: {
            approvedQty: markdown!.quantity + 1,
            dispositionCode: "OTHER",
          },
        });
        expect(aboveEngineMarkdown.statusCode).toBe(400);

        const reducedMarkdownQty = Math.max(1, Math.floor(markdown!.quantity / 2));
        const okMarkdownRes = await app.inject({
          method: "POST",
          url: `/api/orders/${markdown!.id}/commit`,
          headers: hManama,
          payload: {
            approvedQty: reducedMarkdownQty,
            dispositionCode: "CASE_PACK",
          },
        });
        expect(okMarkdownRes.statusCode).toBe(200);
        const committedMarkdown = ReplenishmentOrderSchema.parse(okMarkdownRes.json());
        expect(committedMarkdown.qty).toBe(reducedMarkdownQty);
        expect(committedMarkdown.engineSnapshot.qty).toBe(markdown!.quantity);
        expect(committedMarkdown.approvedNetBenefitBhd).toBeDefined();

        // 5. dataVersion untouched
        const vAfter = await repo.getDataVersion();
        expect(vAfter).toBe(vBefore);
      } finally {
        await app.close();
      }
    });
  },
);

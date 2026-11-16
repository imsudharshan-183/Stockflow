import { describe, expect, it } from "vitest";
import { getRecomputeCallLog, clearRecomputeCallLog } from "./db.js";
import { setupApp, tokenFor, bearer, SEED_USERS } from "./test/helpers.js";

async function setupTestApp() {
  const ctx = await setupApp({ authEnabled: true });
  const authHeaders = {
    admin: bearer(tokenFor(ctx.app, SEED_USERS.admin)),
    managerManama: bearer(tokenFor(ctx.app, SEED_USERS.managerManama)),
    staffManama: bearer(tokenFor(ctx.app, SEED_USERS.staffManama)),
  };
  return { client: ctx.app, authHeaders, ctx };
}

describe("Catalog Product Management API (/api/catalog/products)", () => {
  it("GET /api/catalog/products enforces auth and supports filtering & pagination", async () => {
    const { client, authHeaders } = await setupTestApp();

    // 401 unauthenticated
    const unauth = await client.inject({
      method: "GET",
      url: "/api/catalog/products",
    });
    expect(unauth.statusCode).toBe(401);

    // 200 with admin token
    const res = await client.inject({
      method: "GET",
      url: "/api/catalog/products?page=1&limit=10",
      headers: authHeaders.admin,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.page).toBe(1);
    expect(body.limit).toBe(10);
    expect(body.products.length).toBe(10);
    expect(body.total).toBeGreaterThanOrEqual(500);

    // Filter by category
    const catRes = await client.inject({
      method: "GET",
      url: "/api/catalog/products?category=Toys&limit=5",
      headers: authHeaders.admin,
    });
    expect(catRes.statusCode).toBe(200);
    const catBody = catRes.json();
    expect(catBody.products.every((p: { category: string }) => p.category === "Toys")).toBe(true);

    // Search query
    const searchRes = await client.inject({
      method: "GET",
      url: "/api/catalog/products?search=SKU-00001",
      headers: authHeaders.admin,
    });
    expect(searchRes.statusCode).toBe(200);
    const searchBody = searchRes.json();
    expect(searchBody.products.some((p: { sku: string }) => p.sku === "SKU-00001")).toBe(true);

    // Accessible to staff as well
    const staffRes = await client.inject({
      method: "GET",
      url: "/api/catalog/products?limit=5",
      headers: authHeaders.staffManama,
    });
    expect(staffRes.statusCode).toBe(200);
  });

  it("GET /api/catalog/products/:sku returns product details, change history, and delete eligibility", async () => {
    const { client, authHeaders } = await setupTestApp();

    const notFound = await client.inject({
      method: "GET",
      url: "/api/catalog/products/SKU-99999",
      headers: authHeaders.admin,
    });
    expect(notFound.statusCode).toBe(404);

    const res = await client.inject({
      method: "GET",
      url: "/api/catalog/products/SKU-00001",
      headers: authHeaders.admin,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.product.sku).toBe("SKU-00001");
    expect(body.product.status).toBe("active");
    expect(Array.isArray(body.history)).toBe(true);
    // Seeded product has sales history, so canDeletePermanently is false
    expect(body.canDeletePermanently).toBe(false);
    expect(typeof body.cannotDeleteReason).toBe("string");
  });

  it("POST /api/catalog/products creates a product in awaiting_history with validation and auto-SKU", async () => {
    const { client, authHeaders } = await setupTestApp();

    // 403 Forbidden for Manager and Staff
    const mgrRes = await client.inject({
      method: "POST",
      url: "/api/catalog/products",
      headers: authHeaders.managerManama,
      payload: {
        name: "Test Artisan Bread, 500 g",
        category: "Snacks",
        price: 8,
        cost: 4,
        leadTimeDays: 5,
      },
    });
    expect(mgrRes.statusCode).toBe(403);

    const staffRes = await client.inject({
      method: "POST",
      url: "/api/catalog/products",
      headers: authHeaders.staffManama,
      payload: {
        name: "Test Artisan Bread, 500 g",
        category: "Snacks",
        price: 8,
        cost: 4,
        leadTimeDays: 5,
      },
    });
    expect(staffRes.statusCode).toBe(403);

    // 400 Validation: price <= cost
    const badPriceRes = await client.inject({
      method: "POST",
      url: "/api/catalog/products",
      headers: authHeaders.admin,
      payload: {
        name: "Test Loss Item, 100 g",
        category: "Snacks",
        price: 5,
        cost: 10,
        leadTimeDays: 3,
      },
    });
    expect(badPriceRes.statusCode).toBe(400);
    expect(badPriceRes.json().error).toContain("price");

    // 400 Validation: leadTimeDays > 21
    const badLeadRes = await client.inject({
      method: "POST",
      url: "/api/catalog/products",
      headers: authHeaders.admin,
      payload: {
        name: "Test Long Lead Item, 100 g",
        category: "Snacks",
        price: 15,
        cost: 5,
        leadTimeDays: 30,
      },
    });
    expect(badLeadRes.statusCode).toBe(400);

    // 201 Success: Creates product in awaiting_history with next SKU
    const createRes = await client.inject({
      method: "POST",
      url: "/api/catalog/products",
      headers: authHeaders.admin,
      payload: {
        name: "Veritas Organic Matcha Tea, 100 g",
        category: "Beverages",
        price: 24,
        cost: 12,
        leadTimeDays: 7,
      },
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json();
    expect(created.sku).toMatch(/^SKU-\d{5}$/);
    expect(created.name).toBe("Veritas Organic Matcha Tea, 100 g");
    expect(created.category).toBe("Beverages");
    expect(created.price).toBe(24);
    expect(created.cost).toBe(12);
    expect(created.leadTimeDays).toBe(7);
    expect(created.status).toBe("awaiting_history");

    // 409 Duplicate name in the same category
    const dupRes = await client.inject({
      method: "POST",
      url: "/api/catalog/products",
      headers: authHeaders.admin,
      payload: {
        name: "Veritas Organic Matcha Tea, 100 g",
        category: "Beverages",
        price: 26,
        cost: 13,
        leadTimeDays: 5,
      },
    });
    expect(dupRes.statusCode).toBe(409);
    expect(dupRes.json().error).toContain("already exists in category");

    // Verify it has change history logged
    const detailRes = await client.inject({
      method: "GET",
      url: `/api/catalog/products/${created.sku}`,
      headers: authHeaders.admin,
    });
    expect(detailRes.statusCode).toBe(200);
    const detail = detailRes.json();
    expect(detail.history.length).toBe(1);
    expect(detail.history[0].action).toBe("CREATE");
    expect(detail.canDeletePermanently).toBe(true); // Newly created with no history can be deleted
  });

  it("PATCH /api/catalog/products/:sku edits product and triggers recompute when math changes", async () => {
    const { client, authHeaders } = await setupTestApp();
    clearRecomputeCallLog();

    // Create a product to edit
    const createRes = await client.inject({
      method: "POST",
      url: "/api/catalog/products",
      headers: authHeaders.admin,
      payload: {
        name: "Northfield Trail Mix, 250 g",
        category: "Snacks",
        price: 10,
        cost: 5,
        leadTimeDays: 4,
      },
    });
    const created = createRes.json();

    // 403 Forbidden for Manager
    const mgrPatch = await client.inject({
      method: "PATCH",
      url: `/api/catalog/products/${created.sku}`,
      headers: authHeaders.managerManama,
      payload: { price: 12 },
    });
    expect(mgrPatch.statusCode).toBe(403);

    // 400 Validation: price <= cost
    const badPrice = await client.inject({
      method: "PATCH",
      url: `/api/catalog/products/${created.sku}`,
      headers: authHeaders.admin,
      payload: { price: 3 }, // Cost is 5
    });
    expect(badPrice.statusCode).toBe(400);

    // Cosmetic update: name only (no recompute)
    clearRecomputeCallLog();
    const nameRes = await client.inject({
      method: "PATCH",
      url: `/api/catalog/products/${created.sku}`,
      headers: authHeaders.admin,
      payload: { name: "Northfield Mountain Trail Mix, 250 g" },
    });
    expect(nameRes.statusCode).toBe(200);
    expect(nameRes.json().name).toBe("Northfield Mountain Trail Mix, 250 g");
    expect(getRecomputeCallLog().length).toBe(0);

    // Generate sample history to make it active
    const histRes = await client.inject({
      method: "POST",
      url: `/api/catalog/products/${created.sku}/sample-history`,
      headers: authHeaders.admin,
    });
    expect(histRes.statusCode).toBe(200);
    expect(histRes.json().salesEntriesCount).toBeGreaterThan(0);

    // Math update on active product: price & cost change triggers recompute across all 15 branches
    clearRecomputeCallLog();
    const mathRes = await client.inject({
      method: "PATCH",
      url: `/api/catalog/products/${created.sku}`,
      headers: authHeaders.admin,
      payload: { price: 18, cost: 8, leadTimeDays: 6 },
    });
    expect(mathRes.statusCode).toBe(200);
    expect(mathRes.json().price).toBe(18);
    expect(getRecomputeCallLog().length).toBe(15); // Recomputed for all 15 branches
    expect(getRecomputeCallLog().every((c) => c.sku === created.sku)).toBe(true);

    // Check history recorded all edits
    const historyRes = await client.inject({
      method: "GET",
      url: `/api/catalog/products/${created.sku}`,
      headers: authHeaders.admin,
    });
    const historyBody = historyRes.json();
    expect(historyBody.history.length).toBeGreaterThanOrEqual(3); // CREATE, UPDATE name, UPDATE sample history, UPDATE math
  }, 15_000);

  it("Archive, restore, and permanent delete lifecycle", async () => {
    const { client, authHeaders } = await setupTestApp();

    // 1. Create a mistake product
    const mistakeRes = await client.inject({
      method: "POST",
      url: "/api/catalog/products",
      headers: authHeaders.admin,
      payload: {
        name: "Accidental Product Entry, 100 g",
        category: "Household",
        price: 15,
        cost: 6,
        leadTimeDays: 5,
      },
    });
    const mistake = mistakeRes.json();

    // Can delete permanently because it has NO sales and NO decisions
    const deleteRes = await client.inject({
      method: "DELETE",
      url: `/api/catalog/products/${mistake.sku}`,
      headers: authHeaders.admin,
    });
    expect(deleteRes.statusCode).toBe(200);
    expect(deleteRes.json().ok).toBe(true);

    // Confirm it is gone
    const verifyDelete = await client.inject({
      method: "GET",
      url: `/api/catalog/products/${mistake.sku}`,
      headers: authHeaders.admin,
    });
    expect(verifyDelete.statusCode).toBe(404);

    // 2. Cannot delete SKU-00001 which has sales history
    const deleteBlocked = await client.inject({
      method: "DELETE",
      url: "/api/catalog/products/SKU-00001",
      headers: authHeaders.admin,
    });
    expect(deleteBlocked.statusCode).toBe(409);
    expect(deleteBlocked.json().error).toContain("Archive the product instead");

    // 3. Archive an active product with recommendations in the queue
    const archiveRes = await client.inject({
      method: "PATCH",
      url: "/api/catalog/products/SKU-00499/archive",
      headers: authHeaders.admin,
    });
    expect(archiveRes.statusCode).toBe(200);
    const archiveBody = archiveRes.json();
    expect(archiveBody.product.status).toBe("archived");
    expect(archiveBody.removedPendingActionsCount).toBeGreaterThan(0);

    // Product no longer produces actions in the queue
    const queueRes = await client.inject({
      method: "GET",
      url: "/api/recommendations",
      headers: authHeaders.admin,
    });
    const queueBody = queueRes.json();
    expect(queueBody.recommendations.some((r: { sku: string }) => r.sku === "SKU-00499")).toBe(false);

    // 4. Restore the product
    const restoreRes = await client.inject({
      method: "PATCH",
      url: "/api/catalog/products/SKU-00499/restore",
      headers: authHeaders.admin,
    });
    expect(restoreRes.statusCode).toBe(200);
    expect(restoreRes.json().status).toBe("active");

    // Actions reappear in the queue
    const restoredQueue = await client.inject({
      method: "GET",
      url: "/api/recommendations",
      headers: authHeaders.admin,
    });
    expect(restoredQueue.json().recommendations.some((r: { sku: string }) => r.sku === "SKU-00499")).toBe(true);
  });
});

import { expect, test } from "@playwright/test";
import {
  assertLayoutHealthy,
  attachErrorTracker,
  loginViaUi,
  setThemeMode,
  waitForLayoutFrames,
  waitForPageSettled,
} from "./helpers/uiAudit";

const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

test.describe("StockFlow UI & Responsive Audit across Profiles", () => {
  test("API test server runs isolated against InMemoryRepository", async ({ request }) => {
    const res = await request.get("http://127.0.0.1:3001/api/health");
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as { status?: string; repository?: string };
    expect(body.status).toBe("ok");
    expect(body.repository).toBe("memory");
  });

  test("Public /login page renders cleanly across mobile, tablet, desktop, and light/dark themes", async ({
    page,
  }) => {
    const tracker = attachErrorTracker(page);
    await page.goto("/login");
    await waitForPageSettled(page);

    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await setThemeMode(page, vp.name === "mobile" ? "dark" : "light");
      await assertLayoutHealthy(page, `/login (${vp.name})`);
    }

    // Interactive checks: expand Demo accounts, ModeToggle menu, Use button autofill
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByText(/Demo accounts \(click to expand\)/i).click();
    await assertLayoutHealthy(page, "/login demo accounts expanded (mobile)");

    await page.getByRole("button", { name: /^Use$/i }).first().click();
    await expect(page.locator("#email")).toHaveValue("admin@stockflow.dev");

    await page.getByRole("button", { name: /Toggle theme/i }).click();
    await expect(page.getByRole("menu", { name: /Theme options/i })).toBeVisible();
    await assertLayoutHealthy(page, "/login ModeToggle menu open (mobile)");
    await page.keyboard.press("Escape");

    tracker.assertClean("/login audit");
  });

  test("Admin profile (admin@stockflow.dev): all routes, tabs, overlays, light/dark, and responsive breakpoints", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const tracker = attachErrorTracker(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginViaUi(page, "admin@stockflow.dev", "Admin@12345");

    // Client-side navigate through all Admin routes across desktop (dark), tablet, and mobile
    const desktopRoutes = [
      { label: "Overview", to: "/" },
      { label: "Action queue", to: "/queue" },
      { label: "Products", to: "/products" },
      { label: "Daily entries", to: "/data" },
      { label: "Audit log", to: "/audit" },
      { label: "Users", to: "/users" },
      { label: "Branches", to: "/branches/manage" },
    ];

    // 1. Desktop (1440x900) in Dark mode
    await setThemeMode(page, "dark");
    for (const route of desktopRoutes) {
      await page
        .getByRole("navigation", { name: /Main sections/i })
        .getByRole("link", { name: new RegExp(`^${route.label}(?:\\s|$)`) })
        .click();
      await expect(page).toHaveURL(new RegExp(`${route.to === "/" ? "/$" : route.to}`));
      await waitForPageSettled(page);
      await assertLayoutHealthy(page, `Admin desktop dark ${route.to}`);
    }

    // Branch detail and Product detail routes + interactive overlays on Desktop Dark
    await page.goto("/branches/BR-001");
    await waitForPageSettled(page);
    await assertLayoutHealthy(page, "Admin desktop dark /branches/BR-001");

    // Open leftmost & rightmost KPI InfoPopover on BranchPage to confirm unclipped dark-mode popovers
    const stockoutInfoBtn = page.getByRole("button", { name: /About Stockout rate/i });
    await stockoutInfoBtn.click();
    await expect(page.getByRole("dialog", { name: /Stockout rate/i })).toBeVisible();
    await assertLayoutHealthy(page, "Admin desktop dark BranchPage Stockout InfoPopover");
    await page.keyboard.press("Escape");

    const pendingInfoBtn = page.getByRole("button", { name: /About Pending decisions/i });
    await pendingInfoBtn.click();
    await expect(page.getByRole("dialog", { name: /Pending decisions/i })).toBeVisible();
    await assertLayoutHealthy(page, "Admin desktop dark BranchPage Pending InfoPopover");
    await page.keyboard.press("Escape");

    // Edit branch dialog on /branches/manage (desktop)
    await page.goto("/branches/manage");
    await waitForPageSettled(page);
    await page.getByRole("button", { name: /Edit/i }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await assertLayoutHealthy(page, "Admin desktop dark Edit branch dialog");
    await page.keyboard.press("Escape");

    // Product detail route
    await page.goto("/products/SKU-00001");
    await waitForPageSettled(page);
    await assertLayoutHealthy(page, "Admin desktop dark /products/SKU-00001");

    // Queue tabs + Drawer + RequestStockDialog on Desktop Dark
    await page.goto("/queue");
    await waitForPageSettled(page);
    for (const viewLabel of ["In progress", "Decided", "Pending"]) {
      await page.getByRole("button", { name: viewLabel, exact: true }).click();
      await waitForPageSettled(page);
      await assertLayoutHealthy(page, `Admin desktop Queue view=${viewLabel}`);
    }
    for (const tabLabel of [/Requests to Fulfil/i, /My Stock Requests/i, /^Suggested$/i]) {
      await page.getByRole("tab", { name: tabLabel }).click();
      await waitForPageSettled(page);
      await assertLayoutHealthy(page, `Admin desktop Queue tab=${String(tabLabel)}`);
    }

    // Open RecommendationDrawer / OrderDrawer if a row exists
    const firstRow = page.locator("tbody tr").first();
    if ((await firstRow.count()) > 0) {
      await firstRow.click();
      await expect(page.locator('[data-slot="sheet-content"]')).toBeVisible();
      await assertLayoutHealthy(page, "Admin desktop dark Queue drawer open");
      await page.keyboard.press("Escape");
    }

    // Open CommandPalette + GlossaryDialog + LocationSwitcher + Account Menu on Desktop
    await page.locator('button[aria-label="Open command palette"]:visible').click();
    await expect(page.getByRole("dialog", { name: /Command palette/i })).toBeVisible();
    await assertLayoutHealthy(page, "Admin desktop CommandPalette");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: /Open glossary and help/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await assertLayoutHealthy(page, "Admin desktop GlossaryDialog");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: /Switch location scope/i }).click();
    await expect(page.getByRole("listbox", { name: /Locations/i })).toBeVisible();
    await assertLayoutHealthy(page, "Admin desktop LocationSwitcher");
    await page.keyboard.press("Escape");

    // Sidebar collapse & expand
    await page.getByRole("button", { name: /Collapse sidebar/i }).click();
    await waitForLayoutFrames(page);
    await assertLayoutHealthy(page, "Admin desktop collapsed sidebar");
    await page.getByRole("button", { name: /Expand sidebar/i }).click();

    // 2. Tablet (768x1024) in Light mode across key routes
    await page.setViewportSize({ width: 768, height: 1024 });
    await setThemeMode(page, "light");
    for (const path of ["/", "/queue", "/branches/BR-001", "/branches/manage", "/products", "/data", "/audit", "/users"]) {
      await page.goto(path);
      await waitForPageSettled(page);
      await assertLayoutHealthy(page, `Admin tablet light ${path}`);
    }

    // 3. Mobile (375x812) in Light mode across all routes + dialogs + Sheet + popovers
    await page.setViewportSize({ width: 375, height: 812 });
    for (const path of ["/", "/queue", "/branches/BR-001", "/branches/manage", "/products", "/products/SKU-00001", "/data", "/audit", "/users"]) {
      await page.goto(path);
      await waitForPageSettled(page);
      await assertLayoutHealthy(page, `Admin mobile ${path}`);
    }

    // Mobile hamburger Sheet + LocationSwitcher inside Sheet
    await page.goto("/");
    await waitForPageSettled(page);
    await page.getByRole("button", { name: /Open navigation menu/i }).click();
    await expect(page.locator('[data-slot="sheet-content"]')).toBeVisible();
    await assertLayoutHealthy(page, "Admin mobile navigation Sheet");
    await page.getByRole("button", { name: /Switch location scope/i }).click();
    await expect(page.getByRole("listbox", { name: /Locations/i })).toBeVisible();
    await assertLayoutHealthy(page, "Admin mobile LocationSwitcher inside Sheet");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    // Mobile User account menu & ModeToggle
    await page.getByRole("button", { name: /Account menu for System Admin/i }).click();
    await expect(page.getByRole("menu", { name: /User account details/i })).toBeVisible();
    await assertLayoutHealthy(page, "Admin mobile User account menu");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: /Toggle theme/i }).click();
    await expect(page.getByRole("menu", { name: /Theme options/i })).toBeVisible();
    await assertLayoutHealthy(page, "Admin mobile ModeToggle menu");
    await page.keyboard.press("Escape");

    // Mobile BranchPage InfoPopover viewport edge check
    await page.goto("/branches/BR-001");
    await waitForPageSettled(page);
    await page.getByRole("button", { name: /About Stockout rate/i }).click();
    await expect(page.getByRole("dialog", { name: /Stockout rate/i })).toBeVisible();
    await assertLayoutHealthy(page, "Admin mobile BranchPage Stockout InfoPopover");
    await page.keyboard.press("Escape");

    // Mobile Queue RequestStockDialog
    await page.goto("/queue");
    await waitForPageSettled(page);
    await page.getByRole("button", { name: /Request Stock/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await assertLayoutHealthy(page, "Admin mobile RequestStockDialog");
    await page.keyboard.press("Escape");

    // Mobile Products Add product dialog
    await page.goto("/products");
    await waitForPageSettled(page);
    await page.getByRole("button", { name: /Add product/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await assertLayoutHealthy(page, "Admin mobile Add product dialog");
    await page.keyboard.press("Escape");

    // Mobile Users Add user dialog
    await page.goto("/users");
    await waitForPageSettled(page);
    await page.getByRole("button", { name: /Add user/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await assertLayoutHealthy(page, "Admin mobile Add user dialog");
    await page.keyboard.press("Escape");

    // Mobile Daily entries tabs + SkuCombobox inside DailySheetEditor table
    await page.goto("/data");
    await waitForPageSettled(page);
    await page.getByRole("button", { name: /^Daily sheet$/i }).click();
    await waitForPageSettled(page);
    await assertLayoutHealthy(page, "Admin mobile Daily entries Daily sheet");
    const rowSkuCombo = page.getByRole("combobox", { name: /Row 1 SKU/i });
    await rowSkuCombo.click();
    await expect(page.getByRole("listbox", { name: /Matching products/i })).toBeVisible();
    await assertLayoutHealthy(page, "Admin mobile SkuCombobox inside table");
    await page.keyboard.press("Escape");

    await page.getByRole("tab", { name: /Recent entries/i }).click();
    await waitForPageSettled(page);
    await assertLayoutHealthy(page, "Admin mobile Daily entries Recent entries tab");

    await page.getByRole("tab", { name: /Import CSV/i }).click();
    await waitForPageSettled(page);
    await assertLayoutHealthy(page, "Admin mobile Daily entries Import CSV tab");

    tracker.assertClean("Admin full audit");
  });

  test("Manager profiles (2-branch Manama + 4-branch Regional): scoped views, RBAC redirects, and responsive layout", async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const tracker = attachErrorTracker(page);

    try {
      await loginViaUi(page, "manager.manama@stockflow.dev", "Manager@12345");

      // Desktop audit
      for (const path of ["/", "/queue", "/branches/BR-001", "/products", "/data", "/audit"]) {
        await page.goto(path);
        await waitForPageSettled(page);
        await assertLayoutHealthy(page, `Manager Manama desktop ${path}`);
      }

      // Admin-only UI elements hidden and admin routes redirect to /
      await page.goto("/products");
      await waitForPageSettled(page);
      await expect(page.getByRole("button", { name: /Add product/i })).toHaveCount(0);

      await page.goto("/data");
      await waitForPageSettled(page);
      const branchOptions = await page.locator("#entry-branch option").evaluateAll((opts) =>
        opts.map((o) => (o as HTMLOptionElement).value),
      );
      expect(branchOptions).toEqual(["BR-001", "BR-002"]);

      for (const forbidden of ["/users", "/branches/manage"]) {
        await page.goto(forbidden);
        await expect(page).toHaveURL(/\/$/);
        await waitForPageSettled(page);
      }

      // Mobile audit including RequestStockDialog + DonorPicker
      await page.setViewportSize({ width: 375, height: 812 });
      for (const path of ["/", "/queue", "/branches/BR-001", "/data", "/audit"]) {
        await page.goto(path);
        await waitForPageSettled(page);
        await assertLayoutHealthy(page, `Manager Manama mobile ${path}`);
      }
      await page.goto("/queue");
      await waitForPageSettled(page);
      await page.getByRole("button", { name: /Request Stock/i }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await assertLayoutHealthy(page, "Manager Manama mobile RequestStockDialog");
      await page.keyboard.press("Escape");

      // Tablet check
      await page.setViewportSize({ width: 768, height: 1024 });
      await page.goto("/");
      await waitForPageSettled(page);
      await assertLayoutHealthy(page, "Manager Manama tablet /");

      tracker.assertClean("Manager Manama audit");
    } finally {
      await context.close();
    }

    // 4-branch regional manager spot-check (account menu & header scope wrapping on mobile & desktop)
    const regContext = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const regPage = await regContext.newPage();
    const regTracker = attachErrorTracker(regPage);

    try {
      await loginViaUi(regPage, "manager.regional@stockflow.dev", "Manager@12345");
      await assertLayoutHealthy(regPage, "Manager Regional mobile /");
      await regPage.getByRole("button", { name: /Account menu for Nadia Al-Dosari/i }).click();
      await expect(regPage.getByRole("menu", { name: /User account details/i })).toBeVisible();
      await assertLayoutHealthy(regPage, "Manager Regional mobile Account menu");
      await regPage.keyboard.press("Escape");

      await regPage.setViewportSize({ width: 1440, height: 900 });
      await assertLayoutHealthy(regPage, "Manager Regional desktop /");
      regTracker.assertClean("Manager Regional audit");
    } finally {
      await regContext.close();
    }
  });

  test("Staff profile (staff.manama@stockflow.dev): store inventory, Flag stock dialog, zero BD leakage, RBAC redirects, and responsive viewports", async ({
    page,
  }) => {
    const tracker = attachErrorTracker(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginViaUi(page, "staff.manama@stockflow.dev", "Staff@12345");

    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto("/");
      await waitForPageSettled(page);
      await assertLayoutHealthy(page, `Staff ${vp.name} /`);

      // Staff view must never expose BD financials
      const bodyText = await page.locator("main").innerText();
      expect(bodyText).not.toMatch(/\bBD\s+\d/);

      await page.goto("/products/SKU-00001");
      await waitForPageSettled(page);
      await assertLayoutHealthy(page, `Staff ${vp.name} /products/SKU-00001`);
    }

    // Mobile Flag stock dialog & mobile Sheet nav
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    await waitForPageSettled(page);

    const flagBtn = page.getByRole("button", { name: /Flag stock/i }).first();
    if ((await flagBtn.count()) > 0) {
      await flagBtn.click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await assertLayoutHealthy(page, "Staff mobile Flag stock dialog");
      await page.keyboard.press("Escape");
    }

    await page.getByRole("button", { name: /Open navigation menu/i }).click();
    await expect(page.locator('[data-slot="sheet-content"]')).toBeVisible();
    await assertLayoutHealthy(page, "Staff mobile navigation Sheet");
    await page.keyboard.press("Escape");

    // RBAC route guards redirect staff back to /
    for (const blocked of ["/queue", "/audit", "/data", "/users", "/branches/BR-001", "/branches/manage"]) {
      await page.goto(blocked);
      await expect(page).toHaveURL(/\/$/);
      await waitForPageSettled(page);
    }

    tracker.assertClean("Staff full audit");
  });
});

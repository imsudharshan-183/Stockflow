import { expect, test } from "@playwright/test";
import { assertLayoutHealthy, loginViaUi, setThemeMode } from "./helpers/uiAudit";

const profiles = [
  { email: "admin@stockflow.dev", password: "Admin@12345", width: 1440, theme: "light", question: "How many products are over BD 200?", result: /active products priced over BD/ },
  { email: "manager.manama@stockflow.dev", password: "Manager@12345", width: 768, theme: "dark", question: "Show my stock forecast", result: /units\/day/ },
  { email: "staff.manama@stockflow.dev", password: "Staff@12345", width: 375, theme: "dark", question: "How do I flag a stock issue?", result: /Submit alert/ },
] as const;

for (const profile of profiles) {
  test(`assistant and brief for ${profile.email}`, async ({ page }) => {
    await page.setViewportSize({ width: profile.width, height: 812 });
    await loginViaUi(page, profile.email, profile.password);
    await page.goto("/");
    await setThemeMode(page, profile.theme);
    const brief = page.getByRole("region", { name: "Morning brief" });
    await brief.getByRole("button", { name: "Show my brief" }).click();
    await expect(brief.getByRole("listitem").first()).toBeVisible();
    const launcher = page.getByRole("button", { name: "Open stock assistant" });
    await launcher.click();
    await expect(page.getByText("Hi, I’m StockFlow. What would you like me to do today?")).toBeVisible();
    await assertLayoutHealthy(page, `assistant at ${profile.width}px`);
    await page.getByRole("button", { name: profile.question, exact: true }).click();
    await expect(page.getByRole("log").getByText(profile.result).first()).toBeVisible();
    await page.keyboard.press("Escape");
    await launcher.click();
    await expect(page.getByRole("log").getByText(profile.result).first()).toBeVisible();
    await page.keyboard.press("Escape");
    if (profile.email.startsWith("staff")) {
      await brief.getByRole("link", { name: "Deliveries awaiting receipt" }).click();
      await expect(page.locator("#store-deliveries")).toBeInViewport();
    }
    if (profile.email.startsWith("admin")) {
      await page.getByRole("tab", { name: "Reports and trends" }).click();
      const chartLink = page.locator('a[href="/queue?type=TRANSFER"]').first();
      await expect(chartLink).toBeVisible();
      const list = page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.pathname === "/api/orders" && url.searchParams.get("type") === "TRANSFER" && response.ok();
      });
      await chartLink.click();
      await expect(page).toHaveURL(/type=TRANSFER/);
      const order = (await (await list).json()).orders.find((row: { type: string }) => row.type === "TRANSFER");
      expect(order).toBeDefined();
      await page.goto("/queue?tab=outgoing&order=" + encodeURIComponent(order.id));
      const explanation = page.getByRole("region", { name: "Transfer explanation" });
      await explanation.getByRole("button", { name: "Explain this transfer" }).click();
      await expect(explanation.getByRole("listitem").first()).toBeVisible();
    }
  });
}

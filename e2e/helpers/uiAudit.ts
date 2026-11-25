import { expect, type Page, type Response } from "@playwright/test";

export interface ErrorTracker {
  assertClean: (contextLabel?: string) => void;
  clear: () => void;
}

export function attachErrorTracker(page: Page): ErrorTracker {
  const errors: string[] = [];

  page.on("pageerror", (err) => {
    errors.push(`[pageerror] ${err.message}`);
  });

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      // Unauthenticated initial mount on /login probes GET /api/auth/me and POST /api/auth/refresh -> expected 401.
      if (
        page.url().includes("/login") &&
        text.includes("Failed to load resource: the server responded with a status of 401")
      ) {
        return;
      }
      errors.push(`[console.error] ${text}`);
    }
  });

  page.on("response", (res: Response) => {
    if (!res.url().includes("/api/")) return;
    if (
      res.status() === 401 &&
      (res.url().includes("/api/auth/me") || res.url().includes("/api/auth/refresh"))
    ) {
      return;
    }
    if (res.status() >= 400) {
      errors.push(`[HTTP ${res.status()}] ${res.request().method()} ${res.url()}`);
    }
  });

  return {
    assertClean(contextLabel = "page") {
      const snapshot = [...errors];
      expect(snapshot, `Runtime errors detected during ${contextLabel}`).toEqual([]);
    },
    clear() {
      errors.length = 0;
    },
  };
}

export async function loginViaUi(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await expect(page.getByText(/Sign in to StockFlow/i)).toBeVisible();
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /^Sign in$/i }).click();
  await page.waitForURL((url) => url.pathname !== "/login", { timeout: 15_000 });
  await waitForPageSettled(page);
}

export async function setThemeMode(page: Page, mode: "light" | "dark"): Promise<void> {
  await page.evaluate((nextMode) => {
    window.localStorage.setItem("stockflow-theme", nextMode);
    const root = window.document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(nextMode);
  }, mode);
  await waitForLayoutFrames(page);
}

export async function waitForLayoutFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
      }),
  );
}

export async function waitForPageSettled(page: Page): Promise<void> {
  await page
    .locator('[aria-busy="true"], [data-slot="skeleton"]')
    .first()
    .waitFor({ state: "detached", timeout: 10_000 })
    .catch(() => undefined);
  await waitForLayoutFrames(page);
}

export async function assertLayoutHealthy(
  page: Page,
  contextLabel: string,
): Promise<void> {
  await waitForLayoutFrames(page);

  const violations = await page.evaluate(() => {
    const issues: string[] = [];
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const describeEl = (el: Element): string => {
      const tag = el.tagName.toLowerCase();
      const slot = el.getAttribute("data-slot");
      const role = el.getAttribute("role");
      const label = el.getAttribute("aria-label") || (el.textContent || "").trim().slice(0, 32);
      return `${tag}${slot ? `[data-slot="${slot}"]` : ""}${role ? `[role="${role}"]` : ""}${label ? `("${label.replace(/\s+/g, " ")}")` : ""}`;
    };

    const isVisible = (el: Element): boolean => {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const hasHorizontalScrollAncestor = (el: Element): boolean => {
      let cur = el.parentElement;
      while (cur && cur !== document.documentElement) {
        const st = window.getComputedStyle(cur);
        if (st.overflowX === "auto" || st.overflowX === "scroll") {
          return true;
        }
        cur = cur.parentElement;
      }
      return false;
    };

    // 1. Document-level horizontal overflow
    if (document.documentElement.scrollWidth > vw + 1) {
      const offenders: string[] = [];
      for (const el of document.querySelectorAll("*")) {
        if (!isVisible(el) || hasHorizontalScrollAncestor(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.right > vw + 2 || rect.left < -2) {
          offenders.push(`${describeEl(el)} [${Math.round(rect.left)}..${Math.round(rect.right)}]`);
          if (offenders.length >= 6) break;
        }
      }
      issues.push(
        `Document horizontal overflow: scrollWidth=${document.documentElement.scrollWidth} > innerWidth=${vw}; offenders: ${offenders.join(", ") || "unknown"}`,
      );
    }

    // 2. Key structural landmarks and cards stay within viewport bounds
    for (const el of document.querySelectorAll('header, main, [data-slot="card"], [data-slot="table-card"]')) {
      if (!isVisible(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.left < -1 || rect.right > vw + 1) {
        issues.push(
          `Container out of viewport: ${describeEl(el)} left=${Math.round(rect.left)} right=${Math.round(rect.right)} vw=${vw}`,
        );
      }
    }

    // 3. Open overlays fit viewport and are not clipped by overflow:hidden/clip ancestors
    const overlaySelector = '[data-slot="popover-content"], [data-slot="dialog-content"], [data-slot="sheet-content"], [role="menu"]';
    for (const el of document.querySelectorAll(overlaySelector)) {
      if (!isVisible(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.left < -1 || rect.top < -1 || rect.right > vw + 1 || rect.bottom > vh + 1) {
        issues.push(
          `Overlay outside viewport: ${describeEl(el)} rect=[${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.right)},${Math.round(rect.bottom)}] vp=${vw}x${vh}`,
        );
      }
      if (el.getAttribute("data-slot") === "dialog-content" && vw <= 480) {
        if (rect.left < 8 || vw - rect.right < 8) {
          issues.push(
            `Mobile dialog lacks horizontal margin: ${describeEl(el)} left=${Math.round(rect.left)} rightMargin=${Math.round(vw - rect.right)}`,
          );
        }
      }
      let cur = el.parentElement;
      while (cur && cur !== document.body && cur !== document.documentElement) {
        const st = window.getComputedStyle(cur);
        if (st.overflowX === "hidden" || st.overflowY === "hidden" || st.overflowX === "clip" || st.overflowY === "clip") {
          const pRect = cur.getBoundingClientRect();
          if (rect.right > pRect.right + 1 || rect.bottom > pRect.bottom + 1 || rect.left < pRect.left - 1 || rect.top < pRect.top - 1) {
            issues.push(
              `Overlay clipped by ancestor ${describeEl(cur)}: overlay=[${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.right)},${Math.round(rect.bottom)}] ancestor=[${Math.round(pRect.left)},${Math.round(pRect.top)},${Math.round(pRect.right)},${Math.round(pRect.bottom)}]`,
            );
          }
        }
        cur = cur.parentElement;
      }
    }

    // 4. Visible portaled/floating listboxes stay within viewport and unclipped
    for (const el of document.querySelectorAll('[role="listbox"]')) {
      if (!isVisible(el)) continue;
      const st = window.getComputedStyle(el);
      if (st.position !== "fixed" && st.position !== "absolute") continue;
      const rect = el.getBoundingClientRect();
      if (rect.left < -1 || rect.top < -1 || rect.right > vw + 1 || rect.bottom > vh + 1) {
        issues.push(
          `Floating listbox outside viewport: ${describeEl(el)} rect=[${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.right)},${Math.round(rect.bottom)}] vp=${vw}x${vh}`,
        );
      }
    }

    // 5. Active tab visual distinction
    for (const list of document.querySelectorAll('[data-slot="tabs-list"]')) {
      if (!isVisible(list)) continue;
      const active = list.querySelector('[role="tab"][aria-selected="true"]');
      const inactive = list.querySelector('[role="tab"][aria-selected="false"]');
      if (active && inactive && isVisible(active) && isVisible(inactive)) {
        const aStyle = window.getComputedStyle(active);
        const iStyle = window.getComputedStyle(inactive);
        const differs =
          aStyle.backgroundColor !== iStyle.backgroundColor ||
          aStyle.color !== iStyle.color ||
          aStyle.boxShadow !== iStyle.boxShadow;
        if (!differs) {
          issues.push(`Active tab lacks visual distinction inside ${describeEl(list)}`);
        }
      }
    }

    // 6. Interactive controls outside scroll containers are neither collapsed nor off-screen
    for (const el of document.querySelectorAll('button, a[href], input:not([type="hidden"]), select')) {
      if (!isVisible(el)) continue;
      if (el.classList.contains("sr-only")) continue;
      if (hasHorizontalScrollAncestor(el)) continue;
      if (el.closest(".recharts-wrapper")) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 14 || rect.height < 14) {
        issues.push(
          `Collapsed control: ${describeEl(el)} size=${Math.round(rect.width)}x${Math.round(rect.height)}`,
        );
      }
      if (rect.left < -2 || rect.right > vw + 2) {
        issues.push(
          `Control out of viewport: ${describeEl(el)} left=${Math.round(rect.left)} right=${Math.round(rect.right)} vw=${vw}`,
        );
      }
    }

    // 7. Check for broken/unformatted text tokens in body
    const text = document.body.innerText || "";
    const badMatches = text.match(/\b(NaN|undefined|Infinity)\b|\[object Object\]/g);
    if (badMatches && badMatches.length > 0) {
      issues.push(`Corrupt rendered value(s): ${[...new Set(badMatches)].join(", ")}`);
    }

    return issues;
  });

  expect(violations, `Layout / UI violations on ${contextLabel}`).toEqual([]);
}

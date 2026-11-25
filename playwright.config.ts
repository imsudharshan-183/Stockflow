import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
      },
    },
  ],
  webServer: [
    {
      command: "pnpm --filter @stockflow/api start",
      url: "http://127.0.0.1:3001/api/health",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        PORT: "3001",
        HOST: "127.0.0.1",
        // Single space avoids Windows empty-env-var unsetting while keeping mongoUri.trim() === "" -> InMemoryRepository.
        MONGODB_URI: " ",
        AUTH_ENABLED: "true",
        JWT_SECRET: "playwright-e2e-local-test-secret-32chars",
        ADMIN_PASSWORD: "Admin@12345",
      },
    },
    {
      command: "pnpm --filter @stockflow/web dev",
      url: "http://localhost:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});

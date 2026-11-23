import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findRepoRoot, loadDotenv, repoRootFrom } from "../config/env.js";

const tempDirs: string[] = [];

function createTempTree(options: { withRootMarker?: boolean; dotenvContent?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "stockflow-env-"));
  tempDirs.push(root);

  if (options.withRootMarker) {
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n", "utf8");
  }
  if (options.dotenvContent !== undefined) {
    writeFileSync(join(root, ".env"), options.dotenvContent, "utf8");
  }

  const nested = join(root, "apps", "api", "src", "config");
  mkdirSync(nested, { recursive: true });
  return { root, nested };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("loadDotenv & repo root discovery", () => {
  it("does not throw when no root marker exists", () => {
    const { nested } = createTempTree({ withRootMarker: false });
    const targetEnv: NodeJS.ProcessEnv = {};

    expect(findRepoRoot(nested)).toBeNull();
    expect(() => repoRootFrom(nested)).toThrow("Could not locate the repo root");
    expect(() => loadDotenv({ startDir: nested, env: targetEnv })).not.toThrow();
    expect(targetEnv).toEqual({});
  });

  it("skips loading completely when VERCEL is set", () => {
    const { nested } = createTempTree({
      withRootMarker: true,
      dotenvContent: "PORT=4999\nHOST=0.0.0.0\n",
    });
    const targetEnv: NodeJS.ProcessEnv = { VERCEL: "1" };

    expect(() => loadDotenv({ startDir: nested, env: targetEnv })).not.toThrow();
    expect(targetEnv.PORT).toBeUndefined();
    expect(targetEnv.HOST).toBeUndefined();

    const prevVercel = process.env.VERCEL;
    process.env.VERCEL = "1";
    try {
      expect(() => loadDotenv()).not.toThrow();
    } finally {
      if (prevVercel === undefined) {
        delete process.env.VERCEL;
      } else {
        process.env.VERCEL = prevVercel;
      }
    }
  });

  it("skips loading completely when NODE_ENV is production", () => {
    const { nested } = createTempTree({
      withRootMarker: true,
      dotenvContent: "PORT=4999\n",
    });
    const targetEnv: NodeJS.ProcessEnv = { NODE_ENV: "production" };

    expect(() => loadDotenv({ startDir: nested, env: targetEnv })).not.toThrow();
    expect(targetEnv.PORT).toBeUndefined();
  });

  it("continues silently locally when root marker exists without a .env file", () => {
    const { root, nested } = createTempTree({ withRootMarker: true });
    const targetEnv: NodeJS.ProcessEnv = {};

    expect(findRepoRoot(nested)).toBe(root);
    expect(() => loadDotenv({ startDir: nested, env: targetEnv })).not.toThrow();
    expect(targetEnv).toEqual({});
  });

  it("preserves local behavior by loading .env from the repo root without overriding set vars", () => {
    const { root, nested } = createTempTree({
      withRootMarker: true,
      dotenvContent: "PORT=4123\nHOST=0.0.0.0\n",
    });
    const targetEnv: NodeJS.ProcessEnv = { HOST: "127.0.0.1" };

    expect(repoRootFrom(nested)).toBe(root);
    loadDotenv({ startDir: nested, env: targetEnv });

    expect(targetEnv.PORT).toBe("4123");
    expect(targetEnv.HOST).toBe("127.0.0.1");
  });
});

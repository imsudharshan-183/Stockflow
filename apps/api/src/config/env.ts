import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().min(1).default("127.0.0.1"),
  MONGODB_URI: z.string().default(""),
  AUTH_ENABLED: z
    .preprocess((val) => {
      if (typeof val === "string") {
        const lower = val.toLowerCase().trim();
        return lower === "true" || lower === "1";
      }
      return Boolean(val);
    }, z.boolean())
    .default(false),
  JWT_SECRET: z.string().default(""),
  ACCESS_TOKEN_TTL: z.string().default("15m"),
  REFRESH_TOKEN_TTL: z.string().default("7d"),
  ADMIN_PASSWORD: z.string().default("Admin@12345"),
});

export type Env = z.infer<typeof EnvSchema>;

export function repoRootFrom(start: string): string {
  let dir = start;
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not locate the repo root");
}

export function loadDotenv(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  config({ path: resolve(repoRootFrom(here), ".env"), quiet: true });
}

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const env = EnvSchema.parse({
    PORT: source.PORT,
    HOST: source.HOST,
    MONGODB_URI: source.MONGODB_URI,
    AUTH_ENABLED: source.AUTH_ENABLED,
    JWT_SECRET: source.JWT_SECRET,
    ACCESS_TOKEN_TTL: source.ACCESS_TOKEN_TTL,
    REFRESH_TOKEN_TTL: source.REFRESH_TOKEN_TTL,
    ADMIN_PASSWORD: source.ADMIN_PASSWORD,
  });
  if (env.AUTH_ENABLED && !env.JWT_SECRET.trim()) {
    throw new Error("JWT_SECRET must be set when AUTH_ENABLED is true");
  }
  return env;
}

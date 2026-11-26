import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { z } from "zod";

const EnvSchema = z.object({
  OPENAI_API_KEY: z.string().trim().optional(),
  GEMINI_API_KEY: z.string().trim().optional(),
  GEMINI_MODEL: z.string().trim().optional(),
  OPENAI_MODEL: z.string().trim().optional(),
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().min(1).default("127.0.0.1"),
  MONGODB_URI: z.string().default(""),
  ALLOW_SYNTHETIC_DATA: z.string().optional().transform(value => value === "true"),
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
  WEB_ORIGIN: z.string().default(""),
  APPROVED_ACTIVE_DAYS: z.coerce.number().positive().default(3),
  REJECT_SNOOZE_DAYS: z.coerce.number().positive().default(3),
});

export type Env = z.infer<typeof EnvSchema>;

export interface LoadDotenvOptions {
  startDir?: string;
  env?: NodeJS.ProcessEnv;
}

export function findRepoRoot(start: string): string | null {
  let dir = start;
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function repoRootFrom(start: string): string {
  const root = findRepoRoot(start);
  if (root === null) {
    throw new Error("Could not locate the repo root");
  }
  return root;
}

export function loadDotenv(options: LoadDotenvOptions = {}): void {
  const env = options.env ?? process.env;
  // DECISION: In hosted production environments (Vercel or NODE_ENV=production),
  // runtime env vars are supplied by the platform and repo root markers are absent.
  if (Boolean(env.VERCEL?.trim()) || env.NODE_ENV === "production") {
    return;
  }

  try {
    const startDir = options.startDir ?? dirname(fileURLToPath(import.meta.url));
    const root = findRepoRoot(startDir);
    if (!root) return;

    const envPath = resolve(root, ".env");
    if (!existsSync(envPath)) return;

    config({ path: envPath, processEnv: env, quiet: true });
  } catch {
    // IMPORTANT: loadDotenv must never abort startup if .env lookup or parsing fails.
  }
}

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const env = EnvSchema.parse({
    OPENAI_API_KEY: source.OPENAI_API_KEY,
    GEMINI_API_KEY: source.GEMINI_API_KEY,
    GEMINI_MODEL: source.GEMINI_MODEL,
    OPENAI_MODEL: source.OPENAI_MODEL,
    PORT: source.PORT,
    HOST: source.HOST,
    MONGODB_URI: source.MONGODB_URI,
    ALLOW_SYNTHETIC_DATA: source.ALLOW_SYNTHETIC_DATA,
    AUTH_ENABLED: source.AUTH_ENABLED,
    JWT_SECRET: source.JWT_SECRET,
    ACCESS_TOKEN_TTL: source.ACCESS_TOKEN_TTL,
    REFRESH_TOKEN_TTL: source.REFRESH_TOKEN_TTL,
    ADMIN_PASSWORD: source.ADMIN_PASSWORD,
    WEB_ORIGIN: source.WEB_ORIGIN,
  });
  if (env.AUTH_ENABLED && !env.JWT_SECRET.trim()) {
    throw new Error("JWT_SECRET must be set when AUTH_ENABLED is true");
  }
  return env;
}

function isEnvTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase().trim();
  return normalized === "true" || normalized === "1";
}

/**
 * Returns the names (never values) of required environment variables that are currently unset.
 */
export function getMissingRequiredEnvVars(
  source: NodeJS.ProcessEnv = process.env,
  resolvedEnv?: Partial<Env>,
): string[] {
  const missing: string[] = [];
  if (!source.MONGODB_URI?.trim()) {
    missing.push("MONGODB_URI");
  }
  const authEnabled = resolvedEnv?.AUTH_ENABLED ?? isEnvTruthy(source.AUTH_ENABLED);
  const isHosted = Boolean(source.VERCEL?.trim()) || source.NODE_ENV === "production";
  const hasJwtSecret = Boolean(resolvedEnv?.JWT_SECRET?.trim() || source.JWT_SECRET?.trim());
  if ((authEnabled || isHosted) && !hasJwtSecret) {
    missing.push("JWT_SECRET");
  }
  return missing;
}

const ENV_SECRET_KEYS = ["MONGODB_URI", "JWT_SECRET", "ADMIN_PASSWORD"] as const;

/** Strip connection strings, bearer tokens, and known env secrets before printing. */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let sanitized = text
    .replace(/mongodb(?:\+srv)?:\/\/\S+/gi, "mongodb://***")
    .replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, "//***:***@")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/((?:jwt[_-]?secret|admin[_-]?password|password|secret|token)\s*=\s*)[^\s&]+/gi, "$1[REDACTED]");

  for (const key of ENV_SECRET_KEYS) {
    const value = env[key]?.trim();
    if (value && value.length >= 4) {
      sanitized = sanitized.split(value).join("[REDACTED]");
    }
  }
  return sanitized;
}

/**
 * Formats an error into a single redacted line containing error name,
 * message, and up to the first 3 stack frames.
 */
export function formatFatalError(error: unknown, env: NodeJS.ProcessEnv = process.env): string {
  const err =
    error instanceof Error
      ? error
      : new Error(typeof error === "string" ? error : "Unknown fatal error");
  const name = err.name || "Error";
  const message = err.message.replace(/\s+/g, " ").trim() || "Unknown error";
  const frames = (err.stack ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .slice(0, 3);

  const rawLine =
    frames.length > 0 ? `${name}: ${message} | ${frames.join(" | ")}` : `${name}: ${message}`;
  return redactSecrets(rawLine, env);
}

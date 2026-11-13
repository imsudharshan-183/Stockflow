/* global console */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const WEB_SRC = path.resolve(process.cwd(), "apps/web/src");

function walk(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walk(full));
    } else if (/\.(ts|tsx|css)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

const files = walk(WEB_SRC);
const violations = [];

for (const file of files) {
  const rel = path.relative(WEB_SRC, file).replace(/\\/g, "/");
  const content = fs.readFileSync(file, "utf8");
  const lines = content.split(/\r?\n/);

  const isUiComponent = rel.startsWith("components/ui/");
  const isTokenSource = rel === "index.css" || rel === "lib/tokens.ts";
  const isFeatureFile = rel.startsWith("features/");

  lines.forEach((line, idx) => {
    const lineNum = idx + 1;

    // 1. Raw <button outside components/ui
    if (!isUiComponent && /<button\b/.test(line)) {
      violations.push(
        `[raw-button] ${rel}:${lineNum} — Use shared <Button> from @/components/ui/button instead of raw <button>`,
      );
    }

    // 2. Hex color literals outside index.css and lib/tokens.ts
    if (!isTokenSource) {
      // Match #[0-9a-fA-F]{3,8} not preceded by word/url chars
      const hexMatches = line.match(/(?<![A-Za-z0-9_-])#[0-9A-Fa-f]{3,8}\b/g);
      if (hexMatches) {
        violations.push(
          `[hex-literal] ${rel}:${lineNum} — Found hardcoded hex color (${hexMatches.join(", ")}); use CSS variables or TOKENS from @/lib/tokens`,
        );
      }
    }

    // 3. Inline style setting color, background, backgroundColor, or boxShadow
    if (/style=\{\{[^}]*\b(color|background|backgroundColor|boxShadow)\s*:/.test(line)) {
      violations.push(
        `[inline-style] ${rel}:${lineNum} — Avoid inline style for color/background/boxShadow; use token utility classes`,
      );
    }

    // 4. Formatting helpers inside features/ outside @/lib/format
    if (isFeatureFile) {
      if (/\bIntl\.NumberFormat\b|\bIntl\.DateTimeFormat\b|\.toLocaleString\(|\.toFixed\(/.test(line)) {
        violations.push(
          `[raw-format] ${rel}:${lineNum} — Use shared formatters from @/lib/format instead of inline number/date formatting`,
        );
      }
    }
  });
}

if (violations.length > 0) {
  console.error("UI Guardrail Check Failed:\n" + violations.map((v) => `  - ${v}`).join("\n"));
  process.exit(1);
}

console.log(`UI Guardrail Check Passed (${files.length} files scanned in apps/web/src).`);

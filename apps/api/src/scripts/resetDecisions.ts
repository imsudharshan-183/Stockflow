import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotenv, readEnv } from "../config/env.js";
import { redactSecrets } from "../config/redact.js";
import { InMemoryRepository } from "../repositories/memory.js";
import { MongoRepository } from "../repositories/mongo.js";
import type { StockRepository } from "../repositories/types.js";

export interface ResetDecisionsOptions {
  repo?: StockRepository;
  mongoUri?: string;
  dbName?: string;
  log?: (message: string) => void;
  error?: (message: string) => void;
}

export interface ResetDecisionsResult {
  ok: boolean;
  database: string;
  actionsRemoved: number;
  auditsRemoved: number;
}

function getRepoDatabaseName(repo: StockRepository): string {
  if (repo.kind === "mongo") {
    return (repo as MongoRepository).databaseName();
  }
  return "memory";
}

/**
 * Clears only recommendation decisions (actions) and decision audit entries
 * without altering catalog items, sales entries, users, refresh tokens, or dataVersion.
 */
export async function runResetDecisions(
  argv: string[],
  options: ResetDecisionsOptions = {},
): Promise<ResetDecisionsResult> {
  const log = options.log ?? ((msg: string) => console.log(msg));
  const errorLog = options.error ?? ((msg: string) => console.error(msg));

  if (!argv.includes("--yes")) {
    errorLog("Refusing to reset decisions without --yes flag. Pass --yes to confirm.");
    return { ok: false, database: "", actionsRemoved: 0, auditsRemoved: 0 };
  }

  let repo = options.repo;
  const ownsRepo = !repo;

  try {
    if (!repo) {
      let uri = options.mongoUri ?? "";
      if (!options.mongoUri) {
        loadDotenv();
        uri = readEnv().MONGODB_URI;
      }
      if (uri.trim().length > 0) {
        repo = await MongoRepository.connect(uri, options.dbName);
      } else {
        repo = InMemoryRepository.create();
      }
    }

    const database = getRepoDatabaseName(repo);
    const { actionsRemoved, auditsRemoved } = await repo.clearDecisions();

    log(
      `Cleared decisions on database "${database}": removed ${actionsRemoved} actions and ${auditsRemoved} audit entries.`,
    );

    if (ownsRepo) {
      await repo.close();
    }

    return { ok: true, database, actionsRemoved, auditsRemoved };
  } catch (error) {
    const message = error instanceof Error ? error.message : "reset failed";
    errorLog(redactSecrets(message));
    if (ownsRepo && repo) {
      try {
        await repo.close();
      } catch {
        // Ignore cleanup failure after initial error.
      }
    }
    return { ok: false, database: "", actionsRemoved: 0, auditsRemoved: 0 };
  }
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntryPoint) {
  const result = await runResetDecisions(process.argv.slice(2));
  if (!result.ok) {
    process.exit(1);
  }
}

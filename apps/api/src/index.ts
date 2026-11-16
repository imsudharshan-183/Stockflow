import { loadDotenv, readEnv } from "./config/env.js";
import { redactSecrets } from "./config/redact.js";
import { buildApp } from "./plugins/app.js";
import { createRepository } from "./repositories/create.js";
import { StockService } from "./services/stockService.js";

const startupStartedAt = performance.now();
loadDotenv();
const env = readEnv();
const repo = await createRepository(env.MONGODB_URI);
const service = await StockService.create(repo);
const app = await buildApp(service);

const shutdown = async () => {
  await app.close();
  await repo.close();
};

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});

try {
  const host = process.env.VERCEL ? "0.0.0.0" : env.HOST;
  await app.listen({ port: env.PORT, host });
  const listenMs = Math.round(performance.now() - startupStartedAt);
  console.log(
    `listening on ${host}:${env.PORT} (repository: ${service.repositoryKind()}) (${listenMs}ms)`,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : "startup failed";
  console.error(redactSecrets(message));
  await repo.close();
  process.exit(1);
}

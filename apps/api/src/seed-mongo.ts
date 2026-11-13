import { loadDotenv, readEnv } from "./config/env.js";
import { redactSecrets } from "./config/redact.js";
import { MongoRepository } from "./repositories/mongo.js";

loadDotenv();
const env = readEnv();

if (env.MONGODB_URI.trim().length === 0) {
  console.error("MONGODB_URI is unset");
  process.exit(1);
}

try {
  const repo = await MongoRepository.connect(env.MONGODB_URI);
  await repo.seed();
  await repo.close();
  console.log("Seeded the stockflow database");
} catch (error) {
  const message = error instanceof Error ? error.message : "seed failed";
  console.error(redactSecrets(message));
  try {
    const mongoose = await import("mongoose");
    await mongoose.default.disconnect();
  } catch {
    // The connection may never have opened.
  }
  process.exit(1);
}

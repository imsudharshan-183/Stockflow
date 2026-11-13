import { loadDotenv, readEnv } from "./config/env.js";
import { MongoRepository } from "./repositories/mongo.js";
import { getInitialSeedUsers } from "./repositories/seedData.js";
import { UserModel } from "./repositories/models.js";
import { redactSecrets } from "./config/redact.js";

loadDotenv();
const env = readEnv();

if (env.MONGODB_URI.trim().length === 0) {
  console.log("Memory mode: seed users are initialized automatically.");
  console.log("Demo credentials:");
  console.log("  Admin: admin@stockflow.dev / " + env.ADMIN_PASSWORD);
  console.log("  Manager (Midwest): manager.midwest@stockflow.dev / Manager@12345");
  console.log("  Manager (West): manager.west@stockflow.dev / Manager@12345");
  console.log("  Staff: staff.chicago@stockflow.dev / Staff@12345");
  process.exit(0);
}

try {
  await MongoRepository.connect(env.MONGODB_URI);
  const users = getInitialSeedUsers(env.ADMIN_PASSWORD);
  for (const u of users) {
    await UserModel.findOneAndUpdate({ id: u.id }, { $set: u }, { upsert: true });
  }
  console.log(`Seeded ${users.length} users into MongoDB stockflow.`);
  if (process.env.NODE_ENV !== "production") {
    console.log("Demo credentials:");
    console.log("  Admin: admin@stockflow.dev / " + env.ADMIN_PASSWORD);
    console.log("  Manager (Midwest): manager.midwest@stockflow.dev / Manager@12345");
    console.log("  Manager (West): manager.west@stockflow.dev / Manager@12345");
    console.log("  Staff: staff.chicago@stockflow.dev / Staff@12345");
  }
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.message : "seed users failed";
  console.error(redactSecrets(message));
  process.exit(1);
}

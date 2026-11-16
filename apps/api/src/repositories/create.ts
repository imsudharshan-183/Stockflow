import type { StockRepository } from "./types.js";
import { InMemoryRepository } from "./memory.js";
import { MongoRepository } from "./mongo.js";

export async function createRepository(mongoUri: string): Promise<StockRepository> {
  // DECISION: Construct the repository lazily without awaiting network I/O or dataset
  // synthesis so the HTTP server can bind its port and serve /api/health immediately.
  if (mongoUri.trim().length > 0) return MongoRepository.createLazy(mongoUri.trim());
  return InMemoryRepository.create();
}

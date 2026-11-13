import type { StockRepository } from "./types.js";
import { InMemoryRepository } from "./memory.js";
import { MongoRepository } from "./mongo.js";

export async function createRepository(mongoUri: string): Promise<StockRepository> {
  if (mongoUri.trim().length > 0) return MongoRepository.connect(mongoUri.trim());
  return InMemoryRepository.create();
}

import {
  ActionRecordSchema,
  AuditEntrySchema,
  generateDataset,
  type ActionRecord,
  type Analysis,
  type AuditEntry,
  type Dataset,
} from "@stockflow/core";
import type { StockRepository } from "./types.js";
import type { UserRepository } from "./userTypes.js";
import { InMemoryUserRepository } from "./memoryUser.js";

export class InMemoryRepository implements StockRepository {
  readonly kind = "memory" as const;
  readonly users: UserRepository;
  private readonly actions: ActionRecord[] = [];
  private readonly audit: AuditEntry[] = [];

  private constructor(private readonly data: Dataset, users?: UserRepository) {
    this.users = users ?? new InMemoryUserRepository();
  }

  static create(users?: UserRepository): InMemoryRepository {
    return new InMemoryRepository(generateDataset(), users);
  }

  loadDataset(): Promise<Dataset> {
    return Promise.resolve(this.data);
  }

  loadAnalysis(): Promise<Analysis | null> {
    return Promise.resolve(null);
  }

  saveAnalysis(): Promise<void> {
    return Promise.resolve();
  }

  listActions(): Promise<ActionRecord[]> {
    return Promise.resolve(this.actions.map((action) => ActionRecordSchema.parse(action)));
  }

  saveAction(record: ActionRecord): Promise<void> {
    this.actions.push(ActionRecordSchema.parse(record));
    return Promise.resolve();
  }

  listAudit(): Promise<AuditEntry[]> {
    return Promise.resolve(this.audit.map((entry) => AuditEntrySchema.parse(entry)));
  }

  saveAudit(entry: AuditEntry): Promise<void> {
    this.audit.push(AuditEntrySchema.parse(entry));
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

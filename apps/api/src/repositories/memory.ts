import {
  ActionRecordSchema,
  AuditEntrySchema,
  generateDataset,
  type ActionRecord,
  type Analysis,
  type AuditEntry,
  type Dataset,
  type Product,
  type ProductChangeRecord,
} from "@stockflow/core";
import type { StockRepository } from "./types.js";
import type { UserRepository } from "./userTypes.js";
import { InMemoryUserRepository } from "./memoryUser.js";

export class InMemoryRepository implements StockRepository {
  readonly kind = "memory" as const;
  readonly users: UserRepository;
  private readonly actions: ActionRecord[] = [];
  private readonly audit: AuditEntry[] = [];
  private readonly productChanges: ProductChangeRecord[] = [];

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

  saveProduct(product: Product): Promise<void> {
    const idx = this.data.products.findIndex((p) => p.sku === product.sku);
    if (idx >= 0) {
      this.data.products[idx] = product;
    } else {
      this.data.products.push(product);
      this.data.sales.push(this.data.branches.map(() => this.data.dates.map(() => 0)));
      this.data.onHand.push(this.data.branches.map(() => this.data.dates.map(() => 0)));
      this.data.demand.push(this.data.branches.map(() => this.data.dates.map(() => 0)));
    }
    return Promise.resolve();
  }

  removeProduct(sku: string): Promise<void> {
    const idx = this.data.products.findIndex((p) => p.sku === sku);
    if (idx >= 0) {
      this.data.products.splice(idx, 1);
      this.data.sales.splice(idx, 1);
      this.data.onHand.splice(idx, 1);
      this.data.demand.splice(idx, 1);
    }
    return Promise.resolve();
  }

  listProductChanges(sku: string): Promise<ProductChangeRecord[]> {
    return Promise.resolve(
      this.productChanges
        .filter((c) => c.sku === sku)
        .sort((a, b) => b.at.localeCompare(a.at)),
    );
  }

  saveProductChange(change: ProductChangeRecord): Promise<void> {
    this.productChanges.push(change);
    return Promise.resolve();
  }

  hasHistoryOrAudits(sku: string): Promise<{ hasSales: boolean; hasAudits: boolean }> {
    const hasAudits = this.audit.some((a) => a.sku === sku);
    const idx = this.data.products.findIndex((p) => p.sku === sku);
    let hasSales = false;
    if (idx >= 0 && this.data.sales[idx]) {
      hasSales = this.data.sales[idx].some((byBranch) => byBranch.some((units) => units > 0));
    }
    return Promise.resolve({ hasSales, hasAudits });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

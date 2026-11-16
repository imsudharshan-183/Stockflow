import { StockAlertSchema, type ActedBy, type StockAlert } from "@stockflow/core";

export type DecideStockAlertResult =
  | { status: "decided"; alert: StockAlert }
  | { status: "not_found" }
  | { status: "already_decided"; alert: StockAlert };

/** Shared in-memory alert store enforcing conditional transitions (immutable once decided). */
export class MemoryStockAlertStore {
  private readonly alerts: StockAlert[] = [];

  list(): StockAlert[] {
    return [...this.alerts].sort((a, b) => b.flaggedAt.localeCompare(a.flaggedAt));
  }

  get(id: string): StockAlert | null {
    const found = this.alerts.find((a) => a.id === id);
    return found ? { ...found } : null;
  }

  create(alert: StockAlert): StockAlert {
    const parsed = StockAlertSchema.parse(alert);
    this.alerts.push(parsed);
    return parsed;
  }

  decide(
    id: string,
    decision: "APPROVED" | "REJECTED",
    decidedBy: ActedBy,
    decidedAt: string,
  ): DecideStockAlertResult {
    const idx = this.alerts.findIndex((a) => a.id === id);
    if (idx < 0) return { status: "not_found" };
    const existing = this.alerts[idx]!;
    if (existing.status !== "PENDING") {
      return { status: "already_decided", alert: { ...existing } };
    }
    const updated = StockAlertSchema.parse({
      ...existing,
      status: decision,
      decidedBy,
      decidedAt,
    });
    this.alerts[idx] = updated;
    return { status: "decided", alert: updated };
  }
}

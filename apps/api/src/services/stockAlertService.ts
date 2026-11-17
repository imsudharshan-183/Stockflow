import { randomUUID } from "node:crypto";
import {
  StockAlertListSchema,
  StockAlertSchema,
  can,
  type CreateStockAlert,
  type StockAlert,
  type StockAlertList,
  type User,
} from "@stockflow/core";
import {
  DecisionForbiddenError,
  StockAlertConflictError,
  StockAlertNotFoundError,
  StockAlertValidationError,
} from "./errors.js";
import { ensureInitialized, type StockRuntimeState } from "./runtimeState.js";
import { isBranchInScope } from "./scope.js";

export class StockAlertService {
  constructor(private readonly runtime: StockRuntimeState) {}

  async listStockAlerts(user?: User, branchId?: string): Promise<StockAlertList> {
    await ensureInitialized(this.runtime);
    if (branchId && user && !isBranchInScope(user, branchId)) {
      throw new DecisionForbiddenError("Cannot view stock alerts outside your assigned branches");
    }
    const all = await this.runtime.repo.listStockAlerts();
    const alerts = branchId
      ? all.filter((alert) => alert.branchId === branchId)
      : !user || user.role === "admin"
        ? all
        : all.filter((alert) => isBranchInScope(user, alert.branchId));
    return StockAlertListSchema.parse({ alerts });
  }

  async createStockAlert(input: CreateStockAlert, user: User): Promise<StockAlert> {
    await ensureInitialized(this.runtime);
    if (!can(user.role, "stock:flag")) {
      throw new DecisionForbiddenError("Only branch staff can flag stock alerts");
    }
    if (!isBranchInScope(user, input.branchId)) {
      throw new DecisionForbiddenError("Cannot flag stock outside your assigned branch");
    }

    const branch = this.runtime.data.branches.find((b) => b.id === input.branchId);
    if (!branch) {
      throw new StockAlertValidationError(`Unknown branch: ${input.branchId}`);
    }
    const product = this.runtime.data.products.find((p) => p.sku === input.sku);
    if (!product || product.status === "archived") {
      throw new StockAlertValidationError(`Unknown or archived SKU: ${input.sku}`);
    }

    const alert = StockAlertSchema.parse({
      id: `alt_${randomUUID().slice(0, 8)}`,
      branchId: branch.id,
      branchName: branch.name,
      sku: product.sku,
      productName: product.name,
      category: input.category ?? "CRITICAL_LOW",
      flaggedBy: { userId: user.id, name: user.name, role: user.role },
      flaggedAt: new Date().toISOString(),
      note: input.note.trim(),
      status: "PENDING",
      decidedBy: null,
      decidedAt: null,
    });
    return this.runtime.repo.createStockAlert(alert);
  }

  async decideStockAlert(
    id: string,
    decision: "APPROVED" | "REJECTED",
    user: User,
  ): Promise<StockAlert> {
    await ensureInitialized(this.runtime);
    if (!can(user.role, "stock:flag:decide")) {
      throw new DecisionForbiddenError("Staff cannot approve or reject stock alerts");
    }
    const existing = await this.runtime.repo.getStockAlert(id);
    if (!existing) {
      throw new StockAlertNotFoundError("Stock alert not found");
    }
    if (!isBranchInScope(user, existing.branchId)) {
      throw new DecisionForbiddenError("Cannot decide stock alert outside your assigned branches");
    }
    if (existing.status !== "PENDING") {
      throw new StockAlertConflictError("Stock alert has already been decided and is immutable");
    }

    const result = await this.runtime.repo.decideStockAlert(
      id,
      decision,
      { userId: user.id, name: user.name, role: user.role },
      new Date().toISOString(),
    );
    if (result.status === "not_found") {
      throw new StockAlertNotFoundError("Stock alert not found");
    }
    if (result.status === "already_decided") {
      throw new StockAlertConflictError("Stock alert has already been decided and is immutable");
    }
    return StockAlertSchema.parse(result.alert);
  }
}

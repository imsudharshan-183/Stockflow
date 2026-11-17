import type {
  AuditList,
  BatchDecideItemResult,
  BranchDetail,
  CreateProduct,
  CreateStockAlert,
  KpiSummary,
  LocationInventoryQuery,
  LocationInventoryResponse,
  LocationListResponse,
  LocationSummaryResponse,
  LocationTrendQuery,
  LocationTrendResponse,
  Product,
  ProductDetail,
  ProductDetailWithHistory,
  ProductListQuery,
  ProductListResponse,
  ProductStatus,
  Recommendation,
  RecommendationList,
  RecommendationQuery,
  StockAlert,
  StockAlertList,
  UpdateProduct,
  User,
} from "@stockflow/core";
import type { StockRepository } from "../repositories/types.js";
import type { UserRepository } from "../repositories/userTypes.js";
import {
  DecisionConflictError,
  DecisionForbiddenError,
  ProductConflictError,
  ProductNotFoundError,
  ProductValidationError,
  StockAlertConflictError,
  StockAlertNotFoundError,
  StockAlertValidationError,
  createStockServices,
  projectPosition as project,
  type CommittedDelta,
  type ProjectedPosition,
  type StockServices,
} from "./index.js";

export {
  DecisionConflictError,
  DecisionForbiddenError,
  ProductConflictError,
  ProductNotFoundError,
  ProductValidationError,
  StockAlertConflictError,
  StockAlertNotFoundError,
  StockAlertValidationError,
  project,
  type CommittedDelta,
  type ProjectedPosition,
};

/**
 * Strangler-Facade delegating every operation through the shared `StockServices` composition root.
 * Removed in step 5 once routes and test helpers consume `createStockServices()` directly.
 */
export class StockService {
  private readonly services: StockServices;

  private constructor(repo: StockRepository) {
    this.services = createStockServices(repo);
  }

  static async create(repo: StockRepository): Promise<StockService> {
    // DECISION: Defer dataset loading and morning plan computation until first use so
    // HTTP server startup and /api/health are never blocked by slow dataset or DB loads.
    return new StockService(repo);
  }

  get userRepo(): UserRepository {
    return this.services.userRepo;
  }

  repositoryKind(): "memory" | "mongo" {
    return this.services.repositoryKind();
  }

  async ensureInitialized(): Promise<void> {
    await this.services.ensureInitialized();
  }

  async ensureFreshPlan(options?: { syncDecisions?: boolean; syncAudit?: boolean }): Promise<void> {
    await this.services.ensureFreshPlan(options);
  }

  async commitPlanVersion(): Promise<number> {
    return this.services.commitPlanVersion();
  }

  kpis(user?: User, branchId?: string): KpiSummary {
    return this.services.kpi.kpis(user, branchId);
  }

  hasBranch(branchId: string): boolean {
    return this.services.catalog.hasBranch(branchId);
  }

  allBranchIds(): string[] {
    return this.services.catalog.allBranchIds();
  }

  getProductStatus(sku: string): ProductStatus | "unknown" {
    return this.services.catalog.getProductStatus(sku);
  }

  applySalesEntryToDataset(
    branchId: string,
    sku: string,
    date: string,
    unitsSold: number,
    onHand: number,
  ): void {
    this.services.catalog.applySalesEntryToDataset(branchId, sku, date, unitsSold, onHand);
  }

  async recomputeSingleSku(sku: string, options: { bumpVersion?: boolean } = {}): Promise<void> {
    await this.services.catalog.recomputeSingleSku(sku, options);
  }

  branch(id: string, user?: User): BranchDetail | null {
    return this.services.catalog.branch(id, user);
  }

  listLocations(user?: User): LocationListResponse {
    return this.services.catalog.listLocations(user);
  }

  locationSummary(branchId: string, user?: User): LocationSummaryResponse | null {
    return this.services.catalog.locationSummary(branchId, user);
  }

  locationInventory(
    branchId: string,
    query: LocationInventoryQuery,
    user?: User,
  ): LocationInventoryResponse | null {
    return this.services.catalog.locationInventory(branchId, query, user);
  }

  locationTrend(
    branchId: string,
    query: LocationTrendQuery,
    user?: User,
  ): LocationTrendResponse | null {
    return this.services.catalog.locationTrend(branchId, query, user);
  }

  product(sku: string, user?: User): ProductDetail | null {
    return this.services.catalog.product(sku, user);
  }

  async listCatalogProducts(query: ProductListQuery, user?: User): Promise<ProductListResponse> {
    return this.services.catalog.listCatalogProducts(query, user);
  }

  async getCatalogProduct(sku: string): Promise<ProductDetailWithHistory | null> {
    return this.services.catalog.getCatalogProduct(sku);
  }

  async createCatalogProduct(input: CreateProduct, user: User): Promise<Product> {
    return this.services.catalog.createCatalogProduct(input, user);
  }

  async updateCatalogProduct(sku: string, input: UpdateProduct, user: User): Promise<Product> {
    return this.services.catalog.updateCatalogProduct(sku, input, user);
  }

  async archiveCatalogProduct(
    sku: string,
    user: User,
  ): Promise<{ product: Product; removedPendingActionsCount: number }> {
    return this.services.catalog.archiveCatalogProduct(sku, user);
  }

  async restoreCatalogProduct(sku: string, user: User): Promise<Product> {
    return this.services.catalog.restoreCatalogProduct(sku, user);
  }

  async deleteCatalogProduct(sku: string, user: User): Promise<void> {
    await this.services.catalog.deleteCatalogProduct(sku, user);
  }

  async generateSampleHistory(
    sku: string,
    user: User,
  ): Promise<{ salesEntriesCount: number }> {
    return this.services.catalog.generateSampleHistory(sku, user);
  }

  async listStockAlerts(user?: User, branchId?: string): Promise<StockAlertList> {
    return this.services.stockAlerts.listStockAlerts(user, branchId);
  }

  async createStockAlert(input: CreateStockAlert, user: User): Promise<StockAlert> {
    return this.services.stockAlerts.createStockAlert(input, user);
  }

  async decideStockAlert(
    id: string,
    decision: "APPROVED" | "REJECTED",
    user: User,
  ): Promise<StockAlert> {
    return this.services.stockAlerts.decideStockAlert(id, decision, user);
  }

  projectPosition(sku: string, branchId: string): ProjectedPosition | null {
    return this.services.decisions.projectPosition(sku, branchId);
  }

  list(query: RecommendationQuery, user?: User): RecommendationList {
    return this.services.decisions.list(query, user);
  }

  listAudit(user?: User, branchId?: string): AuditList {
    return this.services.decisions.listAudit(user, branchId);
  }

  async decide(
    id: string,
    status: "APPROVED" | "REJECTED",
    user?: User,
  ): Promise<Recommendation | null> {
    return this.services.decisions.decide(id, status, user);
  }

  async decideBatch(
    ids: readonly string[],
    status: "APPROVED" | "REJECTED",
    user?: User,
    reasonCode?: string,
  ): Promise<BatchDecideItemResult[]> {
    return this.services.decisions.decideBatch(ids, status, user, reasonCode);
  }
}

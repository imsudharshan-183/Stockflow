import type { QueueLifecycleConfig } from "../config/queueLifecycle.js";
import type { StockRepository } from "../repositories/types.js";
import type { UserRepository } from "../repositories/userTypes.js";
import { CatalogService } from "./catalogService.js";
import { DecisionService } from "./decisionService.js";
import { KpiService } from "./kpiService.js";
import { OrderService } from "./orderService.js";
import {
  bumpDecisionVersion,
  commitPlanVersion,
  createStockRuntimeState,
  ensureFreshPlan,
  ensureInitialized,
  ensureInitializedSyncIfPossible,
  type StockRuntimeState,
} from "./runtimeState.js";
import { StockAlertService } from "./stockAlertService.js";

export * from "./errors.js";
export { projectPosition as project } from "./projection.js";

export interface StockServices {
  readonly runtime: StockRuntimeState;
  readonly kpi: KpiService;
  readonly catalog: CatalogService;
  readonly stockAlerts: StockAlertService;
  readonly decisions: DecisionService;
  readonly orders: OrderService;
  readonly userRepo: UserRepository;
  repositoryKind: () => "memory" | "mongo";
  pingDb: () => Promise<void>;
  ensureInitialized: () => Promise<void>;
  ensureInitializedSyncIfPossible: () => void;
  ensureFreshPlan: (options?: { syncDecisions?: boolean; syncAudit?: boolean }) => Promise<void>;
  commitPlanVersion: () => Promise<number>;
  setClock: (nowFn: () => number) => void;
  setLifecycleConfig: (partial: Partial<QueueLifecycleConfig>) => void;
  bumpDecisionVersion: () => number;
}

/**
 * Composition root constructing a single shared `StockRuntimeState` and injecting it
 * into each domain service without introducing service-to-service imports.
 */
export function createStockServices(
  repo: StockRepository,
  options?: { now?: () => number; lifecycleConfig?: Partial<QueueLifecycleConfig> },
): StockServices {
  const runtime = createStockRuntimeState(repo, options);
  const kpi = new KpiService(runtime);
  const catalog = new CatalogService(runtime);
  const stockAlerts = new StockAlertService(runtime);
  const decisions = new DecisionService(runtime);
  const orders = new OrderService(runtime);

  // Wire startup audit replay deterministically: dataset load -> analyze() -> replayApprovedTransfersFromAudit().
  runtime.onPhysicalRefresh = (at) => orders.reconcileStockCounts(at);
  runtime.onReplayAudit = (replayCutoffAt) => {
    decisions.replayApprovedTransfersFromAudit(replayCutoffAt);
  };
  runtime.onAfterInit = async (replayCutoffAt) => {
    await stockAlerts.syncLoggedAdjustments(replayCutoffAt);
    await orders.initializeAndMigrate(replayCutoffAt);
  };

  return {
    runtime,
    kpi,
    catalog,
    stockAlerts,
    decisions,
    orders,
    get userRepo() {
      return repo.users;
    },
    repositoryKind: () => repo.kind,
    pingDb: async () => {
      if (!repo.ping) {
        throw new Error("Database ping is not supported for in-memory repository");
      }
      await repo.ping();
    },
    ensureInitialized: () => ensureInitialized(runtime),
    ensureInitializedSyncIfPossible: () => ensureInitializedSyncIfPossible(runtime),
    ensureFreshPlan: async (optionsArg) => {
      await ensureFreshPlan(runtime, optionsArg);
      if (runtime.repo.kind === "mongo") await orders.syncPersistedOrders(false);
    },
    commitPlanVersion: () => commitPlanVersion(runtime),
    setClock: (nowFn) => {
      runtime.now = nowFn;
      runtime.scopedKpiCache.clear();
    },
    setLifecycleConfig: (partial) => {
      runtime.lifecycleConfig = { ...runtime.lifecycleConfig, ...partial };
      runtime.scopedKpiCache.clear();
    },
    bumpDecisionVersion: () => bumpDecisionVersion(runtime),
  };
}

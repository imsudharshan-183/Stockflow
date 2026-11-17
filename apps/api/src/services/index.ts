import type { StockRepository } from "../repositories/types.js";
import type { UserRepository } from "../repositories/userTypes.js";
import { CatalogService } from "./catalogService.js";
import { DecisionService } from "./decisionService.js";
import { KpiService } from "./kpiService.js";
import {
  commitPlanVersion,
  createStockRuntimeState,
  ensureFreshPlan,
  ensureInitialized,
  ensureInitializedSyncIfPossible,
  type StockRuntimeState,
} from "./runtimeState.js";
import { StockAlertService } from "./stockAlertService.js";

export * from "./errors.js";
export {
  projectPosition,
  projectPosition as project,
  type CommittedDelta,
  type ProjectedPosition,
} from "./projection.js";
export type { StockRuntimeState } from "./runtimeState.js";
export type { CatalogService } from "./catalogService.js";
export type { DecisionService } from "./decisionService.js";
export type { KpiService } from "./kpiService.js";
export type { StockAlertService } from "./stockAlertService.js";

export interface StockServices {
  readonly runtime: StockRuntimeState;
  readonly kpi: KpiService;
  readonly catalog: CatalogService;
  readonly stockAlerts: StockAlertService;
  readonly decisions: DecisionService;
  readonly userRepo: UserRepository;
  repositoryKind: () => "memory" | "mongo";
  pingDb: () => Promise<void>;
  ensureInitialized: () => Promise<void>;
  ensureInitializedSyncIfPossible: () => void;
  ensureFreshPlan: (options?: { syncDecisions?: boolean; syncAudit?: boolean }) => Promise<void>;
  commitPlanVersion: () => Promise<number>;
}

/**
 * Composition root constructing a single shared `StockRuntimeState` and injecting it
 * into each domain service without introducing service-to-service imports.
 */
export function createStockServices(repo: StockRepository): StockServices {
  const runtime = createStockRuntimeState(repo);
  const kpi = new KpiService(runtime);
  const catalog = new CatalogService(runtime);
  const stockAlerts = new StockAlertService(runtime);
  const decisions = new DecisionService(runtime);

  // Wire startup audit replay deterministically: dataset load -> analyze() -> replayApprovedTransfersFromAudit().
  runtime.onReplayAudit = (replayCutoffAt) => {
    decisions.replayApprovedTransfersFromAudit(replayCutoffAt);
  };

  return {
    runtime,
    kpi,
    catalog,
    stockAlerts,
    decisions,
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
    ensureFreshPlan: (options) => ensureFreshPlan(runtime, options),
    commitPlanVersion: () => commitPlanVersion(runtime),
  };
}

import type {
  Analysis,
  Dataset,
  KpiSummary,
  RecommendationStatus,
  ReplenishmentOrder,
} from "@stockflow/core";
import {
  readQueueLifecycleConfig,
  type QueueLifecycleConfig,
} from "../config/queueLifecycle.js";
import type {
  ActionMetaRecord,
  ApiAuditEntry,
  OrderLifecycleMeta,
  StockRepository,
} from "../repositories/types.js";
import {
  adjustCommittedDelta,
  clearAllCommittedDeltas,
  type CommittedAllocation,
  type CommittedDelta,
} from "./projection.js";
import { computeActivePlan } from "./scope.js";

export interface StockRuntimeState {
  readonly repo: StockRepository;
  now: () => number;
  lifecycleConfig: QueueLifecycleConfig;
  decisionVersion: number;
  readonly decisions: Map<string, Extract<RecommendationStatus, "APPROVED" | "REJECTED">>;
  readonly actionMeta: Map<string, ActionMetaRecord>;
  readonly orderLifecycleMeta: Map<string, OrderLifecycleMeta>;
  // In-memory projection ledger keyed by `${sku}::${branchId}`; rebuilt from post-plan audits on boot
  // and cleared per SKU (or network-wide) whenever base dataVersion advances.
  readonly committedDeltas: Map<string, CommittedDelta>;
  readonly committedRecommendationIds: Map<string, CommittedAllocation>;
  readonly alertAdjustments: Map<
    string,
    { sku: string; branchId: string; delta: number; decidedAt: string }
  >;
  readonly inflightDecisionIds: Set<string>;
  readonly orders: Map<string, ReplenishmentOrder>;
  readonly inflightOrderIds: Set<string>;
  readonly scopedKpiCache: Map<string, KpiSummary>;
  audit: ApiAuditEntry[];
  planVersion: number;
  planComputedAt?: string;
  initialized: boolean;
  inflightRefresh: Promise<void> | null;
  data: Dataset;
  analysis: Analysis;
  onReplayAudit?: (replayCutoffAt?: string) => void;
  onAfterInit?: (replayCutoffAt?: string) => Promise<void>;
}

export function createStockRuntimeState(
  repo: StockRepository,
  options?: { now?: () => number; lifecycleConfig?: Partial<QueueLifecycleConfig> },
): StockRuntimeState {
  return {
    repo,
    now: options?.now ?? (() => Date.now()),
    lifecycleConfig: readQueueLifecycleConfig(process.env, options?.lifecycleConfig),
    decisionVersion: 1,
    decisions: new Map(),
    actionMeta: new Map(),
    orderLifecycleMeta: new Map(),
    committedDeltas: new Map(),
    committedRecommendationIds: new Map(),
    alertAdjustments: new Map(),
    inflightDecisionIds: new Set(),
    orders: new Map(),
    inflightOrderIds: new Set(),
    scopedKpiCache: new Map(),
    audit: [],
    planVersion: 0,
    initialized: false,
    inflightRefresh: null,
    data: undefined as unknown as Dataset,
    analysis: undefined as unknown as Analysis,
  };
}

// IMPORTANT: Order/decision transitions bump only `decisionVersion` and clear `scopedKpiCache`.
// They intentionally never bump `dataVersion` (`planVersion`) because approvals overlay `committedDeltas`
// onto the cached network plan instead of triggering an expensive engine recomputation.
export function bumpDecisionVersion(state: StockRuntimeState): number {
  state.decisionVersion += 1;
  state.scopedKpiCache.clear();
  return state.decisionVersion;
}

export function applyDecisionHistoryToState(
  state: StockRuntimeState,
  history: ActionMetaRecord[],
): void {
  state.decisions.clear();
  state.actionMeta.clear();
  const sorted = [...history].sort((a, b) => a.decidedAt.localeCompare(b.decidedAt));
  for (const action of sorted) {
    state.actionMeta.set(action.recommendationId, action);
    const isReopened = Boolean(action.reopenedAt && action.reopenedAt >= action.decidedAt);
    if (!isReopened) {
      state.decisions.set(action.recommendationId, action.status);
    }
  }
}

export function replayApprovedTransfersIntoState(
  state: StockRuntimeState,
  replayCutoffAt?: string,
): void {
  clearAllCommittedDeltas(state.committedDeltas, state.committedRecommendationIds);
  const recById = new Map(state.analysis.recommendations.map((r) => [r.id, r]));
  const sorted = [...state.audit].sort((a, b) => a.at.localeCompare(b.at));
  const seenRecIds = new Set<string>();

  for (const entry of sorted) {
    if (entry.decision !== "APPROVED" || entry.action !== "TRANSFER") continue;
    if (replayCutoffAt && entry.at < replayCutoffAt) continue;
    if (seenRecIds.has(entry.recommendationId)) continue;
    seenRecIds.add(entry.recommendationId);

    // Respect actions collection if present (e.g. if an external script cleared decisions).
    if (state.decisions.size > 0 && state.decisions.get(entry.recommendationId) !== "APPROVED") {
      continue;
    }

    const rec = recById.get(entry.recommendationId);
    if (!rec || rec.action !== "TRANSFER" || !rec.donorBranchId) continue;

    adjustCommittedDelta(state.committedDeltas, rec.sku, rec.donorBranchId, rec.quantity, 0);
    adjustCommittedDelta(state.committedDeltas, rec.sku, rec.branchId, 0, rec.quantity);
    state.committedRecommendationIds.set(rec.id, {
      sku: rec.sku,
      branchId: rec.branchId,
      donorBranchId: rec.donorBranchId,
      action: rec.action,
      quantity: rec.quantity,
    });
  }
}

function runReplayHook(state: StockRuntimeState, replayCutoffAt?: string): void {
  if (state.onReplayAudit) {
    state.onReplayAudit(replayCutoffAt);
  } else {
    replayApprovedTransfersIntoState(state, replayCutoffAt);
  }
}

export async function syncDecisionsAndAudit(
  state: StockRuntimeState,
  replayCutoffAt?: string,
): Promise<void> {
  const [history, audit] = await Promise.all([state.repo.listActions(), state.repo.listAudit()]);
  applyDecisionHistoryToState(state, history);
  state.audit = audit;
  runReplayHook(state, replayCutoffAt);
}

export async function ensureInitialized(state: StockRuntimeState): Promise<void> {
  if (state.initialized) return;

  if (!state.inflightRefresh) {
    // IMPORTANT: Deduplicate concurrent cold-start loads behind inflightRefresh so parallel initial requests
    // share one dataset read and plan build instead of computing the network plan multiple times.
    state.inflightRefresh = (async () => {
      if (state.initialized) return;

      const tDataset = performance.now();
      const data = await state.repo.loadDataset();
      const datasetMs = Math.round(performance.now() - tDataset);
      console.log(`loading dataset (${datasetMs}ms)`);

      const tPlan = performance.now();
      const currentVersion = await state.repo.getDataVersion();
      const cached = await state.repo.loadCachedPlan(currentVersion);

      let analysis: Analysis;
      if (cached) {
        analysis = cached.plan;
      } else {
        analysis = (await state.repo.loadAnalysis()) ?? computeActivePlan(data);
        try {
          await state.repo.saveCachedPlan(currentVersion, analysis);
        } catch {
          // Fallback to compute-and-serve if plan persistence fails.
        }
      }
      const planMs = Math.round(performance.now() - tPlan);
      console.log(`computing plan (${planMs}ms)`);

      state.data = data;
      state.analysis = analysis;
      state.planVersion = currentVersion;
      state.planComputedAt = cached?.computedAt;
      state.scopedKpiCache.clear();
      const replayCutoff = currentVersion > 1 ? cached?.computedAt : undefined;
      await syncDecisionsAndAudit(state, replayCutoff);
      if (state.onAfterInit) {
        await state.onAfterInit(replayCutoff);
      }
      state.initialized = true;
    })().finally(() => {
      state.inflightRefresh = null;
    });
  }

  await state.inflightRefresh;
}

export function ensureInitializedSyncIfPossible(state: StockRuntimeState): void {
  if (state.initialized) return;
  const syncRepo = state.repo as StockRepository & {
    peekDatasetSync?: () => Dataset;
    peekDataVersionSync?: () => number;
    peekCachedPlanSync?: (v: number) => { plan: Analysis } | null;
    saveCachedPlanSync?: (v: number, plan: Analysis) => void;
    peekActionsSync?: () => ActionMetaRecord[];
    peekAuditSync?: () => ApiAuditEntry[];
  };
  if (typeof syncRepo.peekDatasetSync === "function") {
    const tDataset = performance.now();
    const data = syncRepo.peekDatasetSync();
    const datasetMs = Math.round(performance.now() - tDataset);
    console.log(`loading dataset (${datasetMs}ms)`);

    const tPlan = performance.now();
    const currentVersion = syncRepo.peekDataVersionSync?.() ?? 1;
    const cached = syncRepo.peekCachedPlanSync?.(currentVersion) as
      | { plan: Analysis; computedAt?: string }
      | null
      | undefined;
    const analysis = cached ? cached.plan : computeActivePlan(data);
    if (!cached) {
      syncRepo.saveCachedPlanSync?.(currentVersion, analysis);
    }
    const planMs = Math.round(performance.now() - tPlan);
    console.log(`computing plan (${planMs}ms)`);

    state.data = data;
    state.analysis = analysis;
    state.planVersion = currentVersion;
    state.scopedKpiCache.clear();
    if (typeof syncRepo.peekActionsSync === "function") {
      applyDecisionHistoryToState(state, syncRepo.peekActionsSync());
    }
    if (typeof syncRepo.peekAuditSync === "function") {
      state.audit = syncRepo.peekAuditSync();
    }
    runReplayHook(state, currentVersion > 1 ? cached?.computedAt : undefined);
    state.initialized = true;
  }
}

export async function ensureFreshPlan(
  state: StockRuntimeState,
  options?: { syncDecisions?: boolean; syncAudit?: boolean },
): Promise<void> {
  if (!state.initialized) {
    await ensureInitialized(state);
    return;
  }

  const syncDecisions = options?.syncDecisions ?? true;
  const syncAudit = options?.syncAudit ?? false;

  const [currentVersion, actions, audit] = await Promise.all([
    state.repo.getDataVersion(),
    syncDecisions ? state.repo.listActions() : Promise.resolve(null),
    syncAudit ? state.repo.listAudit() : Promise.resolve(null),
  ]);

  if (actions) applyDecisionHistoryToState(state, actions);
  if (audit) state.audit = audit;
  if (currentVersion === state.planVersion) return;

  if (!state.inflightRefresh) {
    // IMPORTANT: Deduplicate concurrent plan rebuilds behind one promise so parallel API requests
    // after a sales/catalog write (`dataVersion` bump) share a single dataset load and engine run.
    state.inflightRefresh = (async () => {
      if (currentVersion === state.planVersion) return;

      const tDataset = performance.now();
      const [freshData, cached] = await Promise.all([
        state.repo.loadDataset(),
        state.repo.loadCachedPlan(currentVersion),
      ]);
      const datasetMs = Math.round(performance.now() - tDataset);
      console.log(`loading dataset (${datasetMs}ms)`);

      const tPlan = performance.now();
      let nextPlan: Analysis;
      if (cached) {
        nextPlan = cached.plan;
      } else {
        nextPlan = computeActivePlan(freshData);
        try {
          await state.repo.saveCachedPlan(currentVersion, nextPlan);
        } catch {
          // Fallback to compute-and-serve if plan persistence fails.
        }
      }
      const planMs = Math.round(performance.now() - tPlan);
      console.log(`computing plan (${planMs}ms)`);

      state.data = freshData;
      state.analysis = nextPlan;
      state.planVersion = currentVersion;
      state.planComputedAt = cached?.computedAt;
      clearAllCommittedDeltas(state.committedDeltas, state.committedRecommendationIds);
      state.alertAdjustments.clear();
      state.orders.clear();
      state.orderLifecycleMeta.clear();
      state.scopedKpiCache.clear();
      if (!actions) applyDecisionHistoryToState(state, await state.repo.listActions());
      if (!audit) state.audit = await state.repo.listAudit();
      if (state.onAfterInit) {
        await state.onAfterInit(cached?.computedAt);
      }
    })().finally(() => {
      state.inflightRefresh = null;
    });
  }

  await state.inflightRefresh;
}

export async function commitPlanVersion(state: StockRuntimeState): Promise<number> {
  const nextVersion = await state.repo.bumpDataVersion();
  state.planVersion = nextVersion;
  state.planComputedAt = new Date(state.now()).toISOString();
  state.scopedKpiCache.clear();
  try {
    await state.repo.saveCachedPlan(nextVersion, state.analysis);
  } catch {
    // Fallback to compute-and-serve if plan persistence fails.
  }
  return nextVersion;
}

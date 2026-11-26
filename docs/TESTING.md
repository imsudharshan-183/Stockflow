# StockFlow Testing Guide

## Running Tests
- Run all unit, API & Web tests: `pnpm test`
- Run core tests only: `pnpm --filter @stockflow/core test`
- Run API tests only: `pnpm --filter @stockflow/api test`
- Run Web UI tests only: `pnpm --filter @stockflow/web test`
- Run UI & lint guardrails: `pnpm lint`
- Run TypeScript checks: `pnpm typecheck`
- Run production build: `pnpm build`
- Run post-deploy smoke test: `node scripts/smoke.mjs https://<deployment-url>`

## Check the assistant

Run `pnpm --filter @stockflow/api exec vitest run src/__tests__/brief.test.ts src/__tests__/stockChat.test.ts` for role and branch isolation, grounded responses, and provider fallback. These tests use simulated provider responses.

Run `pnpm exec playwright test e2e/stock-assistant.spec.ts` for the three signed-in browser journeys. They cover the welcome, morning brief, role-specific questions, reopening the chat, and links into store inventory and transfer orders.

## Check sales simulation

From the repository root, run these suites for the seed, API, and catalog button respectively.

```sh
pnpm --filter @stockflow/core exec vitest run src/seed/seed.test.ts
pnpm --filter @stockflow/api exec vitest run src/__tests__/simulateNextDay.test.ts
pnpm --filter @stockflow/web exec vitest run src/__tests__/SimulateSales.test.tsx
```

The seed test fingerprints the full original dataset and checks date-based replay. API tests cover permissions, the feature flag, the Bahrain midnight boundary, batch recompute counts, and interrupted runs with a store entry already present. The UI tests cover visibility, pending state, and the displayed counts.

## Test Suites
- **`packages/core`**:
  - `src/engine/engine.test.ts` (9): EWMA velocity, safety stock, classification, greedy matching, net benefit, backtest.
  - `src/engine/engine.prop.test.ts` (1): `fast-check` property-based tests verifying engine mathematical and structural invariants across generated datasets.
  - `src/engine/donorRanking.test.ts` (5): Pure donor-candidate ranking, cluster-first sorting, and ineligibility filtering.
  - `src/engine/projection.test.ts` (3): Pure `projectPosition()` overlay invariants (`reserved`, `inTransit`, `adjustment`).
  - `src/engine/quantityBenefit.test.ts` (2): Exact `computeActionBenefitForQuantity()` agreement with engine recommendation net benefit and quantity edit scaling.
  - `src/orders.test.ts` (4): Finite-state machine `canTransition()` guards and permission/override checks.
  - `src/schemas/auth.test.ts` (4): RBAC `can`, `scopeBranches`, `canManageRole` unit checks.
  - `src/schemas/authTruthTable.test.ts` (3): Exhaustive truth tables for `can`, `canManageRole`, and `scopeBranches`.
  - `src/seed/seed.test.ts` covers deterministic dataset generation, daily simulation, and backtest replay.
- **`apps/api`**:
  - `src/__tests__/dbRoundTripsAndLatency.test.ts` *(dual-repo, `MongoMemoryReplSet`)*: DB round-trip budgets, `dataVersion` invariance on decisions, concurrent overlapping batches (`E11000`), rollback safety, `< 300 ms` latency.
  - `src/__tests__/planConsistency.test.ts` *(dual-repo)*: Serverless consistency across sales entries, catalog archive, `plan_cache` hits, concurrent rebuild dedup.
  - `src/__tests__/vercelRouting.test.ts`: Verifies `vercel.json` SPA fallback covers every `<Route>` in `App.tsx` without colliding with `/api/(.*)`.
  - `src/__tests__/authSecurity.test.ts` *(dual-repo)*: Login parity, cookie security flags, refresh rotation & family revocation, deactivated user blocking, rate limiting.
  - `src/__tests__/rbacAndScoping.test.ts` *(dual-repo)*: RBAC matrix across routes & roles, user hierarchy guards, donor/receiver transfer scoping, KPI cache isolation, IDOR protection.
  - `src/__tests__/stage0Security.test.ts` *(dual-repo)*: Sales entry route authentication/branch scoping and `/api/kpis` financial scope enforcement.
  - `src/__tests__/orders.test.ts`, `orderQuantityEdit.test.ts`, `queueLifecycle.test.ts`, `stockAlertResolution.test.ts`, `stageEDemo.test.ts`: End-to-end governed `ReplenishmentOrder` pipeline, editable `approvedQty` limits/reason codes, read-time lifecycle windows (`3d` active, `3d` snooze, `+/-50%` reopen, `24h` window), linked alert resolution, and demo workflow coverage.
  - `src/__tests__/branches.test.ts` & `branchesCoordinates.test.ts` *(dual-repo)*: Admin branch lifecycle, sequential `BR-0xx`, coordinate bounds/rounding, duplicate `(name, city)` conflict checks, and reversible archiving.
  - `src/__tests__/overviewFreshness.test.ts`, `cacheInvalidation.test.ts`, `recommendationsAndCatalog.test.ts`, `usersValidation.test.ts`: `Asia/Bahrain` freshness/live KPIs, `decisionVersion` cache invalidation, catalog CRUD, and user email/password/branch validation.
  - `src/__tests__/salesEntries.test.ts` & `salesImportLog.test.ts`: Manual entry CRUD, 5MB CSV import, per-row validation, and scoped `/api/sales/imports` log queries.
  - `src/__tests__/platformSecurity.test.ts`: Helmet headers, `1 MiB` body limit, secret redaction, `/api/` prefix invariant, CORS preflight, and immediate `/api/health`.
  - `src/__tests__/api.test.ts`, `routeMatrix.test.ts`, `roleDifferentiation.test.ts`, `transferScope.test.ts`, `catalog.test.ts`, `snapshot.test.ts`, `env.test.ts`, `healthAndStartup.test.ts`, `managerCharts.test.ts`, `multiBranchStaff.test.ts`, `overviewRefinement.test.ts`, `resetDecisions.test.ts`, `stockAlerts.test.ts`, `approvalMutation.test.ts`: Core API flows, chart scoping, multi-branch staff scoping, golden snapshots (`recommendations.json`, `kpis.json`), decision reset safety, `stock_alerts` immutability, and `committedDeltas` `409` surplus protection.
- **`apps/web`**:
  - `AlertTriageAndAudit.test.tsx`, `BranchFormCoordinates.test.tsx`, `DailyEntriesRedesign.test.tsx`, `DataEntryImport.test.tsx`, `OverviewLive.test.tsx`, `QuantityEditAndAudit.test.tsx`, `QueueLifecycle.test.tsx`, `QueuePage.test.tsx`, `ReplenishmentFlow.e2e.test.tsx`, `UiWordingGuard.test.tsx`, `UsersDialogAutofill.test.tsx`: Role-gated flows, coordinate paste/swap/cluster auto-suggest, daily sheet & CSV import UX, live overview freshness, quantity edit benefit preview, queue lifecycle switcher, wording guardrails, and user dialog autofill isolation.

## Test Safety Rules
- Tests never require Atlas credentials; dual-repository suites run against both `InMemoryRepository` and `mongodb-memory-server` (`stockflow_test`).
- Any test connecting to an external MongoDB URI must refuse to run unless the database name ends in `_test`.

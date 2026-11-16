# StockFlow Testing Guide

## Running Tests
- Run all unit & API tests: `pnpm test`
- Run core tests only: `pnpm --filter @stockflow/core test`
- Run API tests only: `pnpm --filter @stockflow/api test`
- Run UI & lint guardrails: `pnpm lint`
- Run TypeScript checks: `pnpm typecheck`
- Run production build: `pnpm build`
- Run post-deploy smoke test: `node scripts/smoke.mjs https://<deployment-url>`

## Test Suites
- **`packages/core` (23 tests)**:
  - `src/engine/engine.test.ts`: EWMA velocity, safety stock, classification, greedy matching, net benefit, backtest.
  - `src/engine/engine.prop.test.ts`: `fast-check` property-based tests verifying engine mathematical and structural invariants across generated datasets.
  - `src/schemas/auth.test.ts`: RBAC `can`, `scopeBranches`, `canManageRole` unit checks.
  - `src/authTruthTable.test.ts`: Exhaustive truth tables for `can`, `canManageRole`, and `scopeBranches`.
  - `src/seed/seed.test.ts`: Deterministic dataset generation and backtest replay invariants.
- **`apps/api` (195 tests)**:
  - `src/dbRoundTripsAndLatency.test.ts` *(dual-repo, `MongoMemoryReplSet` for transactions)*: Instruments repository DB operations per request (`<= 3` DB ops on warm reads, single approve, and `POST /api/recommendations/batch/decide` for 50 items), verifies `dataVersion` invariance on decisions, cross-instance decision overlay propagation, mixed valid/out-of-scope/unknown/already-decided batch results, idempotency on repeat, reject-without-`reasonCode` `400`, concurrent overlapping batches across two instances (unique index `E11000` -> `already_decided`, 1 action + 1 audit per ID), simulated audit-write failure leaving zero orphan actions, and `< 300 ms` in-memory latencies.
  - `src/planConsistency.test.ts` *(dual-repo)*: Two-instance serverless consistency (sales entries, catalog archive, decisions), cold-start `plan_cache` hit skipping `analyze()`, concurrent version-mismatch single compute, and failed-persist fallback.
  - `src/vercelRouting.test.ts`: Verifies `vercel.json` catch-all SPA fallback covers every `<Route>` in `apps/web/src/app/App.tsx` without colliding with `/api/(.*)`.
  - `src/authSecurity.test.ts` *(dual-repo: `InMemoryRepository` + `mongodb-memory-server`)*: Login error parity, no `passwordHash` leakage, cookie security flags, refresh rotation & family-based reuse revocation + audit, logout family isolation, deactivated user blocking, expired/tampered JWTs, login `429` rate limiting.
  - `src/rbacAndScoping.test.ts` *(dual-repo)*: Table-driven RBAC matrix across routes & roles, user hierarchy & escalation guards, donor/receiver transfer scoping, KPI cache isolation, IDOR protection.
  - `src/recommendationsAndCatalog.test.ts` *(dual-repo)*: Approve/reject audit trail, out-of-scope manager `403`, concurrent catalog `POST` (`201` + `409`), negative validation (`400`), archive/restore, permanent delete `409` vs `200`, `onHand=0` sales entry & single-SKU recompute isolation.
  - `src/platformSecurity.test.ts`: `@fastify/helmet` headers, `1 MiB` `bodyLimit` (`413`), production `500` redaction, `/api/` route prefix invariant, `WEB_ORIGIN` CORS & `PATCH`/`DELETE` preflight, cold-start & warm p95 `/api/recommendations` latency, and immediate `/api/health` response before dataset loading completes.
  - `src/api.test.ts`, `src/routeMatrix.test.ts`, `src/roleDifferentiation.test.ts`, `src/transferScope.test.ts`, `src/catalog.test.ts`, `src/salesEntries.test.ts`, `src/snapshot.test.ts`: Core API lifecycle, catalog, sales entries (including 5MB CSV import), and deterministic snapshots.
  - `src/resetDecisions.test.ts` *(dual-repo)*: Verifies `pnpm reset:decisions` `--yes` flag requirement, clears only `actions` and decision `audit` entries (leaving catalog, sales entries, users, refresh tokens, and `dataVersion` intact), and prints only the database name (never the URI).
  - `src/stockAlerts.test.ts` *(dual-repo)*: Verifies staff create-only `stock:flag` branch scoping, manager/admin `stock:flag:decide` scoping, and `409 Conflict` post-decision immutability on `stock_alerts`.
  - `src/approvalMutation.test.ts`: Verifies pure `project()` immutability, donor `surplus` decrease and receiver `inTransit` increase across live API reads after transfer/reorder/markdown approvals, `409 Conflict` against over-allocated donors (including concurrent requests), boot-time ledger replay across service restarts (`memory` & `mongo-memory`), KPI cache invalidation, clearing on sales/catalog refresh, and golden-snapshot preservation. *(Note: the greedy donor decrement in `match.ts` guarantees morning plans never emit conflicting over-allocations on the seeded UI; `409` conflict rejection is therefore verified via integration fixture in `approvalMutation.test.ts` rather than manual UI override.)*

## Test Safety Rules
- Tests never require Atlas credentials; dual-repository suites run against both `InMemoryRepository` and `mongodb-memory-server` (`stockflow_test`).
- Any test connecting to an external MongoDB URI must refuse to run unless the database name ends in `_test`.

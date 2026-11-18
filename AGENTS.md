# StockFlow — Project Rules & Context

## Overview
StockFlow is a morning decision and action queue system for a 15-branch Bahrain retail network (~500 SKUs, 120-day synthetic history). It ranks transfers, reorders, and markdowns by net BHD benefit (`BD`) and generates plain-language buyer explanations.

## Architecture Map
- `packages/core`: Pure TypeScript domain logic and Zod schemas (no I/O or DB drivers).
  - `src/engine/`: EWMA demand forecasting, safety stock, classification, greedy matching, Haversine transfer freight & net benefit, backtest.
  - `src/report/`: DTOs, KPI rollups (including `categoryRisk` and dead-stock surplus subset `deadStockValue <= cashReleasable`), branch & product detail views, plain-language reason formatting.
  - `src/schemas/`: Zod contracts and pure RBAC helpers (`can`, `scopeBranches`, `canManageRole`, `isBranchInScope`).
  - `src/seed/`: Single-source-of-truth Bahrain geography (`BAHRAIN_BRANCHES`), category-tiered 3-decimal BHD catalog, and deterministic 120-day sales history with analytical ROP-calibrated stocking (`~12.29%` network `AT_RISK` instead of `~42%`: 3 hotspot branches `BR-004`/`BR-005`/`BR-009` in `20–30%`, 3 low-risk branches `BR-003`/`BR-010`/`BR-015` in `2–5%`, and 9 standard/excess branches in `~9–12%`).
- `apps/api`: Fastify API server (MongoDB or in-memory repository).
  - `src/config/`: Env validation (`env.ts`) and secret redaction (`redact.ts`).
  - `src/db.ts`: Shared MongoDB connection (`stockflow` DB), `sales_entries` upsert, and `recomputeForSku` hook.
  - `src/repositories/`: Memory and Mongo stores for stock, catalog, `stock_alerts`, audit, users, and refresh tokens.
  - `src/services/`: `createStockServices` composition root (`index.ts`) sharing one `StockRuntimeState` (`runtimeState.ts`) across `KpiService`, `CatalogService`, `StockAlertService`, and `DecisionService`, plus pure `projection.ts` (`projectPosition`), `scope.ts`, `errors.ts`, and `AuthService` (bcryptjs, JWT/refresh rotation).
  - `src/plugins/`: Fastify app setup, auth guards, error handling.
  - `src/routes/`: HTTP endpoints under `/api/*` (`auth`, `stock`, `stockAlerts`, `catalog`, `locations`, `salesEntries`, `users`).
- `apps/web`: React 19 + Vite + Tailwind CSS + Base UI frontend.
  - `src/app/`: `Shell.tsx`, `LocationSidebarParts.tsx` (network-relative location health dots — green `<= median`, amber `<= 1.5x`, red `> 1.5x` sales at risk — with at-risk SKU count tooltips), and `App.tsx` (routes).
  - `src/components/ui/`: Shared primitives (`Button`, `Badge`, `Table`, `Card`, `Dialog`, `Sheet`, `Input`, `Tabs`, `Tooltip`, etc.).
  - `src/components/shared/`: `ChartCard.tsx` and `ChartDetailPopup.tsx` (`targetCard`-scoped inline `ChartDetailStrip` inside the clicked chart card instead of a fixed viewport popover).
  - `src/lib/`: `tokens.ts` (semantic action colors: violet Transfer, blue Reorder, amber Markdown), `format.ts` (`formatMoney` compact `BD 9.4K` for KPI cards/axes; `formatMoneyFull` whole `BD` with separators and 3 decimals only `< BD 1` for tables/details), `labels.ts`, `api.ts`, `utils.ts`.
  - `src/features/`: `overview` (`AdminOverview`, `ManagerOverview`, `Analytics`, `riskChart.ts` scope-aware top-8 locations vs. `At-risk by category`, `NeedsAttentionStrip.tsx`, `ProofOfValuePanel.tsx`), `queue`, `drilldown` (`BranchPage`, `ProductPage` with lead-time horizon forward stock projection chart), `products` (`ProductsPage`, `StaffProductStats`), `data`, `audit`, `users`, `auth`.

## Non-Negotiable Invariants
1. **Engine purity**: Never modify `packages/core/src/engine` without explicit mathematical justification.
2. **Scoping after plan computation**: The morning plan (`analyze(data, DEFAULT_POLICY)`) is loaded/computed lazily on first use (`ensureInitialized()` / `ensureFreshPlan()`) so `/api/health` and port binding never wait on dataset or database initialization, and is cached per process in `StockRuntimeState`. Branch scoping and KPI rollups for non-admins are applied in `KpiService` / `DecisionService` / `CatalogService` *after* the cached plan is built.
   - Transfers are visible if the user's scope includes the donor OR receiver branch.
   - Reorders and markdowns are visible if the user's scope includes the target branch.
3. **Plan versioning (`dataVersion` & `plan_cache`)**: Every analysis-affecting write (sales entry create/update/delete, CSV import once per request, catalog updates/archive/restore/sample-history) must bump `dataVersion` and persist the gzipped plan to `plan_cache`. **Decisions (`approve`/`reject`) are an overlay and must NOT bump `dataVersion`, recompute the plan, or rewrite `plan_cache`**: they write only to `actions` and `audit`, and `ensureFreshPlan()` syncs `actions` alongside `getDataVersion()` in parallel (`<= 3` DB ops on warm reads) so all instances agree. Approved transfers, reorders, and markdowns populate the non-mutating `committedDeltas` ledger (`reserved` / `inTransit` via pure `projectPosition()`, replayed at boot from post-plan `audit` entries) and reject donor over-allocations with `409 Conflict` (`DecisionConflictError`). **One decision per recommendation**: enforced by a unique index on `actions.recommendationId` (and equivalent in-memory uniqueness) with atomic action+audit persistence (`saveDecisionBatch`, `E11000` -> `already_decided`). Currently in `apps/api/src/db.ts`, `recomputeForSku(branchId, sku)` remains a stub hook that only records `{ branchId, sku, at }` in `recomputeCallLog`, while `CatalogService` (`recomputeSingleSku` / `recomputeAnalysisForProduct`) handles single-SKU recomputation and `dataVersion` bumping directly.
4. **Role hierarchy**: `admin > manager > staff`. Users can only create or modify users of strictly lower roles (`admin` manages `manager` and `staff`; `manager` and `staff` cannot manage users). No role escalation, no editing own role, no deactivating self or the last admin.
5. **Server-side authorization**: UI hiding is cosmetic only; all permissions and branch scoping are enforced server-side in `apps/api`.
6. **Frontend guardrails**: Only shared `Button`, `Badge`, and `Table` (`table-auto` inside `table-container` with `min-w-*` scrolling so columns never clip/overlap) primitives; colors only from `index.css` and `lib/tokens.ts`; numbers, money, and dates only via `lib/format.ts`. `scripts/check-ui.mjs` must pass.
7. **Secrets & test isolation**: Never read, print, log, or commit `.env` or any secret. Tests must use the in-memory repo or `mongodb-memory-server`; any test touching a real Mongo URI must refuse to run unless the database name ends in `_test`.

## RBAC Summary
- `admin`: All 15 branches; `dashboard:financial:network`, `dashboard:financial:scoped`, `dashboard:operational:scoped`, `catalog:view`, `products:manage`, `users:manage`, `branches:view_all`, `recommendations:read`, `recommendations:decide`, `audit:read`, `sales:enter`, `stock:flag:decide`.
- `manager`: Assigned `branchIds` only; `dashboard:financial:scoped`, `dashboard:operational:scoped`, `catalog:view`, `recommendations:read`, `recommendations:decide`, `audit:read`, `sales:enter`, `stock:flag:decide`.
- `staff`: Single assigned branch; `catalog:view`, `recommendations:read`, `stock:flag`. Lands on non-financial store inventory (`StaffProductStats` on `/` and `/products`, with categorized `Flag stock` alerts on non-`NEW` rows, `Recent Branch Stock Alerts` review history, and zero `BD` financial metrics); blocked from `/queue`, `/branches/:id`, `/data`, `/audit`, `/users` (and `403` on `/api/kpis`, `/api/locations*`, `/api/branches/:id`).

## Working Agreements
- Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` before finishing any phase or task.
- Never print `.env` or secret values in logs, tests, or responses.
- Never edit `packages/core/src/engine` without mathematical justification.
- Use the shared UI primitives (`Button`, `Badge`, `Table`) and `lib/format.ts` on the frontend.
- Update `AGENTS.md` and the relevant `docs/*.md` whenever an invariant, schema, or endpoint changes.
- Explain *why* in code comments, not *what*, using `DECISION:`, `ASSUMPTION:`, `IMPORTANT:`, or `SCALE:` tags.

## Key Commands
- `pnpm dev` — Run API and web dev servers
- `pnpm lint` — ESLint + `node scripts/check-ui.mjs`
- `pnpm typecheck` — TypeScript check across all packages
- `pnpm test` — Vitest suites across `packages/core` and `apps/api`
- `pnpm build` — Build all workspace packages
- `pnpm seed:mongo` / `pnpm seed:users` — Seed MongoDB stock/catalog and users
- `pnpm reset:decisions --yes` — Clear only decision actions and audit entries without bumping `dataVersion`

## Documentation Pointers
- [DECISIONS.md](DECISIONS.md) — Numbered Architecture Decision Records (`ADR-001` through `ADR-014`)
- [docs/DECISIONS.md](docs/DECISIONS.md) — Engine algorithm, math assumptions, known limitations, scaling path, security summary
- [docs/FRONTEND.md](docs/FRONTEND.md) — Design system, UI guardrails, route table, UX principles
- [docs/API.md](docs/API.md) — HTTP endpoints (auth, stock, stock-alerts, catalog, sales entries, locations, users)
- [docs/TESTING.md](docs/TESTING.md) — Test architecture, suites, and verification matrix

# StockFlow — Project Rules & Context

## Overview
StockFlow is a morning decision and action queue system for a 15-branch Bahrain retail network (~500 SKUs, 120-day synthetic history). It ranks transfers, reorders, and markdowns by net BHD benefit (`BD`) and generates plain-language buyer explanations.

## Architecture Map
- `packages/core`: Pure TypeScript domain logic and Zod schemas (no I/O or DB drivers).
  - `src/engine/`: EWMA demand forecasting, safety stock, classification, greedy matching, net benefit, backtest.
  - `src/report/`: DTOs, KPI rollups, branch & product detail views, plain-language reason formatting.
  - `src/schemas/`: Zod contracts and pure RBAC helpers (`can`, `scopeBranches`, `canManageRole`, `isBranchInScope`).
- `apps/api`: Fastify API server (MongoDB or in-memory repository).
  - `src/config/`: Env validation (`env.ts`) and secret redaction (`redact.ts`).
  - `src/db.ts`: Shared MongoDB connection (`stockflow` DB), `sales_entries` upsert, and `recomputeForSku` hook.
  - `src/repositories/`: Memory and Mongo stores for stock, catalog, audit, users, and refresh tokens.
  - `src/services/`: `StockService` (morning plan cache, scoping, decisions) and `AuthService` (bcryptjs, JWT/refresh rotation).
  - `src/plugins/`: Fastify app setup, auth guards, error handling.
  - `src/routes/`: HTTP endpoints under `/api/*`.
- `apps/web`: React 19 + Vite + Tailwind CSS + Base UI frontend.
  - `src/app/`: `Shell.tsx` (sidebar, top bar, theme/user menus) and `App.tsx` (routes).
  - `src/components/ui/`: Shared primitives (`Button`, `Badge`, `Table`, `Card`, `Dialog`, `Sheet`, `Input`, `Tabs`, `Tooltip`, etc.).
  - `src/lib/`: `tokens.ts`, `format.ts`, `api.ts`, `utils.ts`.
  - `src/features/`: `overview`, `queue`, `drilldown` (`BranchPage`, `ProductPage`), `products`, `audit`, `users`, `auth`.

## Non-Negotiable Invariants
1. **Engine purity**: Never modify `packages/core/src/engine` without explicit mathematical justification.
2. **Scoping after plan computation**: The morning plan (`analyze(data, DEFAULT_POLICY)`) is loaded/computed lazily on first use (`ensureInitialized()` / `ensureFreshPlan()`) so `/api/health` and port binding never wait on dataset or database initialization, and is cached per process. Branch scoping and KPI rollups for non-admins are applied in `StockService` *after* the cached plan is built.
   - Transfers are visible if the user's scope includes the donor OR receiver branch.
   - Reorders and markdowns are visible if the user's scope includes the target branch.
3. **Plan versioning (`dataVersion` & `plan_cache`)**: Every analysis-affecting write (sales entry create/update/delete, CSV import once per request, catalog updates/archive/restore/sample-history) must bump `dataVersion` and persist the gzipped plan to `plan_cache`. **Decisions (`approve`/`reject`) are an overlay and must NOT bump `dataVersion`, recompute the plan, or rewrite `plan_cache`**: they write only to `actions` and `audit`, and `ensureFreshPlan()` syncs `actions` alongside `getDataVersion()` in parallel (`<= 3` DB ops on warm reads) so all instances agree. **One decision per recommendation**: enforced by a unique index on `actions.recommendationId` (and equivalent in-memory uniqueness) with atomic action+audit persistence (`saveDecisionBatch`, `E11000` -> `already_decided`). Currently in `apps/api/src/db.ts`, `recomputeForSku(branchId, sku)` remains a stub hook that only records `{ branchId, sku, at }` in `recomputeCallLog`, while `StockService` handles single-SKU recomputation and `dataVersion` bumping directly.
4. **Role hierarchy**: `admin > manager > staff`. Users can only create or modify users of strictly lower roles (`admin` manages `manager` and `staff`; `manager` and `staff` cannot manage users). No role escalation, no editing own role, no deactivating self or the last admin.
5. **Server-side authorization**: UI hiding is cosmetic only; all permissions and branch scoping are enforced server-side in `apps/api`.
6. **Frontend guardrails**: Only shared `Button`, `Badge`, and `Table` (`table-auto` inside `table-container` with `min-w-*` scrolling so columns never clip/overlap) primitives; colors only from `index.css` and `lib/tokens.ts`; numbers, money, and dates only via `lib/format.ts`. `scripts/check-ui.mjs` must pass.
7. **Secrets & test isolation**: Never read, print, log, or commit `.env` or any secret. Tests must use the in-memory repo or `mongodb-memory-server`; any test touching a real Mongo URI must refuse to run unless the database name ends in `_test`.

## RBAC Summary
- `admin`: All 15 branches; `dashboard:financial:network`, `dashboard:financial:scoped`, `dashboard:operational:scoped`, `catalog:view`, `products:manage`, `users:manage`, `branches:view_all`, `recommendations:decide`, `audit:read`.
- `manager`: Assigned `branchIds` only; `dashboard:financial:scoped`, `dashboard:operational:scoped`, `catalog:view`, `recommendations:decide`, `audit:read`.
- `staff`: Single assigned branch; `catalog:view`, `recommendations:read`. Read-only branch view; blocked from `/queue`, `/data`, `/audit`, `/users`.

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
- [docs/DECISIONS.md](docs/DECISIONS.md) — Engine algorithm, math assumptions, known limitations, scaling path
- [docs/FRONTEND.md](docs/FRONTEND.md) — Design system, UI guardrails, route table, UX principles
- [docs/API.md](docs/API.md) — HTTP endpoints (auth, stock, catalog, sales entries, locations, users)
- [docs/TESTING.md](docs/TESTING.md) — Test architecture, suites, and verification matrix

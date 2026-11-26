# StockFlow — Project Rules & Context

## Overview
StockFlow is a morning decision and replenishment order system for a 15-branch Bahrain retail network (~500 SKUs, 120-day synthetic history). It ranks transfers, reorders, and markdowns by net BHD benefit (`BD`), persists governed order transitions, and explains recommendations in language store teams use.

## Architecture Map
- `packages/core`: Pure TypeScript domain logic, shared utilities, and Zod contracts (no I/O, no `Date.now`, no DB drivers).
  - `src/engine/`: EWMA demand forecasting, safety stock, classification (`DEAD_VELOCITY_PER_DAY = 1/7`), greedy matching, Haversine freight & net benefit, `computeActionBenefitForQuantity`, `rankDonorCandidates`, `projectPosition`, backtest.
  - `src/report/`: DTOs, KPI rollups (`categoryRisk`, `deadStockValue <= cashReleasable`), branch/SKU drilldowns, plain-language reasons.
  - `src/schemas/`: `index.ts` (core DTOs/KPIs), `auth.ts` (RBAC `can`, `scopeBranches`, `canManageRole`, `isBranchInScope`), `lifecycle.ts` (queue lifecycle views, API audit entries, live overview meta).
  - `src/orders.ts`: `ReplenishmentOrder`, immutable `OrderEvent`, finite-state transition table (`canTransition`), `QuantityChangeReason`.
  - `src/bahrainDate.ts` & `src/coordinates.ts`: Pure `Asia/Bahrain` (UTC+3) date helpers (explicit clock arg) and Bahrain coordinate bounds/validators shared by API and Web.
  - `src/seed/`: Bahrain branches (`BAHRAIN_BRANCHES`), category-tiered 3-decimal BHD catalog, deterministic 120-day sales history (`~12.29%` network `AT_RISK`).
- `apps/api`: Fastify API server (MongoDB or in-memory repository).
  - `src/config/`: Env validation (`env.ts`), lifecycle windows (`queueLifecycle.ts`: `3d` active, `3d` snooze, `24h` reopen), secret redaction (`redact.ts`).
  - `src/db.ts`: `sales_entries`, `sales_entry_audits`, `import_log`, and `recomputeForSku` call log.
  - `src/repositories/`: Memory and Mongo stores (`StockRepository`, `UserRepository`, alerts, `orders`, `order_events`, `actions`, `audit`).
  - `src/services/`: `createStockServices` (`index.ts`) sharing one `StockRuntimeState` (`runtimeState.ts`) across `KpiService`, `CatalogService`, `StockAlertService`, `DecisionService`, `OrderService` (`orderSnapshot.ts`), `queueLifecycle.ts`, `projection.ts`, `scope.ts`, `errors.ts`, `AuthService`.
  - `src/plugins/` & `src/routes/`: Fastify app/auth/error plugins and `/api/*` routes (`auth`, `branches`, `catalog`, `helpers`, `locations`, `orders`, `salesEntries`, `stock`, `stockAlerts`, `users`), plus `src/utils/bahrainDate.ts`.
  - StockFlow assistant: `routes/brief.ts`, `services/stockChat.ts`, `services/chatCatalog.ts`, `services/briefFacts.ts`, and `services/modelOutput.ts` implement role-aware read-only chat and briefs.
- `apps/web`: React 19 + Vite + Tailwind CSS + Base UI frontend.
  - `src/app/`: `Shell.tsx`, `LocationSidebarParts.tsx` (network-relative median risk health dots), `App.tsx`.
  - `src/components/ui/`: Shared primitives (`Button`, `Badge`, `Table`, `Card`, `Dialog`, `Sheet`, `Input`, `Tabs`, `Tooltip`, etc.).
  - `src/components/shared/`: `ChartCard`, `ChartDetailPopup`, `FreshnessBanner`, `OrderEventRow`, `DonorPicker`, `OrderStatusBadge`, `PendingStockAlertsCard`, `StockAlertBadges`, `StockDeltaBadges`, `PageHeader`, `CommandPalette`, etc.
  - `src/hooks/`: `queryKeys.ts`, `useLocationScope.ts`, `useBahrainToday.ts`, `staffBranchScope.ts`.
  - `src/lib/`: `tokens.ts`, `format.ts`, `labels.ts`, `api.ts`, `bahrainDate.ts`, `coordinates.ts`, `dailySheetCsv.ts`, `userValidation.ts`, `utils.ts`.
  - `src/features/`: `overview` (`AdminOverview`, `ManagerOverview`, `Analytics`, `riskChart.ts`, `NeedsAttentionStrip`, `ProofOfValuePanel`), `queue` (`QueuePage`, `ApproveQuantityDialog`, `OrderDrawer`, `RecommendationDrawer`, `RequestStockDialog`), `branches` (`BranchPage`, `BranchesManagePage`), `products` (`ProductsPage`, `ProductPage`, `StaffProductStats`), `data` (`DataEntryPage`, `DailyEntryContextPanel`, `DailySheetEditor`, `SkuCombobox`), `audit`, `users`, `auth`.

## Non-Negotiable Invariants
1. **Engine purity**: `@stockflow/core` stays pure (no I/O, no `Date.now`, no randomness). Never alter `engine/*` or golden snapshots (`recommendations.json`, `kpis.json`) without explicit mathematical justification.
2. **Scoping after plan computation**: The morning plan loads/computes lazily (`ensureInitialized()` / `ensureFreshPlan()`) so `/api/health` never blocks. Non-admin branch filtering and KPI slicing run *after* full-network matching: transfers are visible to donor OR receiver branch scope; reorders/markdowns to target branch scope.
3. **`dataVersion` vs `decisionVersion` & governed orders**:
   - Physical mutations (sales entries, CSV import, catalog edits/archive/restore, branch create/update/archive) bump `dataVersion`, recompute/persist `plan_cache`, clear overlays, and zero-mask archived branches while keeping historical drilldowns.
   - Decision/order transitions (`SUGGESTED`, `OPEN_REQUEST`, `AWAITING_DONOR`, `COMMITTED`, `DECLINED`, `CANCELLED`, `RECEIVED`, `REOPEN`) NEVER bump `dataVersion` or rewrite `plan_cache`. Only `bumpDecisionVersion()` increments to bust `scopedKpiCache`.
   - Intent states never mutate `committedDeltas`. Moving into `COMMITTED` reserves donor surplus + receiver `inTransit` and rejects over-allocation with `409 Conflict`; `RECEIVE` decrements only `inTransit` until the next `dataVersion` physical refresh. `engineSnapshot` is read-only; human edits (`approvedQty`, bounded by action rules and reason code) and `comment` go into immutable `OrderEvent` rows written atomically with the order.
   - Queue lifecycle (`pending`, `in_progress`, `decided`) computes read-time views from `APPROVED_ACTIVE_DAYS=3`, `REJECT_SNOOZE_DAYS=3`, `+/-50%` worsened auto-reopen, and the `24h` reopen window.
4. **Role hierarchy & validation**: `admin > manager > staff`. Only admins manage users/lower roles, with strict email validation, >=8 char passwords, >=1 assigned branch for non-admins, and no self-demotion/self-deactivation/last-admin removal.
5. **Server-side RBAC & date/coord rules**: UI hiding is cosmetic. `/api/*` routes enforce `authenticate` / `requirePermission`, `/api/sales/imports` is scoped per caller, overview freshness uses `Asia/Bahrain` (`UTC+3`), and branch coordinates validate Bahrain bounds rounded to 6 decimals with unique `(name, city)`.
6. **Frontend guardrails (`scripts/check-ui.mjs`)**: Only shared `<Button>`, `<Badge>`, `<Table>` primitives; colors strictly via `index.css` / `tokens.ts`; number/money/date formatting in `features/` strictly via `@/lib/format`.
7. **Secrets & test isolation**: Never read, print, log, or commit `.env` or secrets. Tests run against `InMemoryRepository` or `mongodb-memory-server` (`*_test` DB guard for external URIs).
8. **Assistant scope and data access**: Chat intent is a bounded schema, never a generated Mongo query. Derive role and branch scope from the authenticated user, enforce permissions in API services, and only send the model the question plus minimum approved lookup facts. Admin may query active network data, managers only assigned branches, and staff only permitted operational store data. Keep staff financial metrics and management workflows out of chat results. Keep provider secrets in ignored `.env`.

## RBAC Summary
- `admin`: All active branches (+ archived branch admin); `dashboard:financial:network`, `dashboard:financial:scoped`, `dashboard:operational:scoped`, `catalog:view`, `products:manage`, `branches:manage`, `users:manage`, `branches:view_all`, `recommendations:read`, `recommendations:decide`, `orders:receive`, `audit:read`, `sales:enter`, `stock:flag:decide`.
- `manager`: Assigned `branchIds`; `dashboard:financial:scoped`, `dashboard:operational:scoped`, `catalog:view`, `recommendations:read`, `recommendations:decide`, `orders:receive`, `audit:read`, `sales:enter`, `stock:flag:decide`.
- `staff`: Assigned `branchIds` (single or multi-branch switcher on `StaffProductStats`); `catalog:view`, `recommendations:read`, `orders:receive`, `sales:enter`, `stock:flag`. Lands on non-financial store inventory (`StaffProductStats` with `Flag stock` alerts and zero `BD` financials); blocked from `/queue`, `/branches/:id`, `/audit`, `/users`.
- **StockFlow assistant**: Opens with “Hi, I’m StockFlow. What would you like me to do today?” Suggestions adapt by role. It explains StockFlow terms and workflows, and queries supported reports, inventory, and forecasts within the authenticated scope. The API remains the authority for data access.

## Key Commands
- `pnpm dev` — Run API and web dev servers
- `pnpm lint` — ESLint + `node scripts/check-ui.mjs`
- `pnpm typecheck` — TypeScript check across `packages/core`, `apps/api`, `apps/web`
- `pnpm test` — Vitest suites across `packages/core`, `apps/api`, and `apps/web`
- `pnpm build` — Build all workspace packages
- `pnpm seed:mongo` / `pnpm seed:users` / `pnpm reset:decisions --yes` — Mongo seeding and decision reset

## Documentation Pointers
- [docs/ADR.md](docs/ADR.md) — Architecture Decision Records (`ADR-001` through `ADR-017`)
- [docs/ENGINE.md](docs/ENGINE.md) — Engine formulas, constants table, worked example, and extension seams
- [docs/DECISIONS.md](docs/DECISIONS.md) — Assumptions, known limitations, scaling path, and security summary
- [docs/FRONTEND.md](docs/FRONTEND.md) — Design system, UI guardrails, route table, UX principles
- [docs/API.md](docs/API.md) — HTTP endpoints and RBAC contracts

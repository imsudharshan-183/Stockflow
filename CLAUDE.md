# StockFlow — Project Context & Assistant Guidelines

## Overview
StockFlow is a morning decision / action queue system for a 15-branch retail network (~500 SKUs, 120-day synthetic history). It ranks transfers, reorders, and markdowns by net dollar benefit (`$`) and writes plain-language explanations for buyers.

## Architecture & Monorepo Structure
- `packages/core`: Pure TypeScript logic and shared Zod schemas (no I/O, no DB drivers).
  - `src/engine/`: Demand forecasting (EWMA), safety stock, classification, greedy matching, net benefit, backtest. (**INVARIANT**: Never modify this without explicit mathematical justification).
  - `src/report/`: DTOs, KPI rollups, branch & product views.
  - `src/schemas/`: Shared Zod validation contracts and pure auth helpers (`can`, `scopeBranches`, `canManageRole`).
- `apps/api`: Fastify API server with MongoDB or in-memory repository.
  - `src/db.ts`: Shared MongoDB connection (`stockflow` database), `SalesEntryModel` (`sales_entries` collection with unique compound index `{ branchId: 1, sku: 1, date: 1 }`), in-memory fallback store, and `recomputeForSku(branchId, sku)` hook.
  - `src/config/`: Environment variable validation and secret redaction.
  - `src/repositories/`: Memory and MongoDB stores for stock, audit, users, and refresh tokens.
  - `src/services/`: Morning plan cache, authentication service (bcryptjs), authorization & branch scoping.
  - `src/plugins/`: Fastify plugins, error handlers, and JWT/cookie auth decorators.
  - `src/routes/`: HTTP endpoints (`/api/auth/*`, `/api/users/*`, `/api/kpis`, `/api/recommendations`, `/api/sales-entries`, `/api/sales-entries/import`, etc.).
- `apps/web`: React 19 + Vite frontend with Tailwind CSS and Base UI primitives.
  - `src/app/`: Application shell (`Shell.tsx`), route table (`App.tsx`), collapsible left sidebar (240px expanded / 64px rail), slim top bar with breadcrumb, light/dark `ModeToggle`, and User Menu dropdown.
  - `src/features/queue/`: Ranked morning `QueuePage` with `All / Transfers / Reorders / Markdowns` tabs, attached filter toolbar, 60px fixed-layout rows, sticky bottom batch bar, reason-code `RejectConfirmDialog`, and 480px right-hand `RecommendationDrawer`.
  - `src/features/overview/`: Unified hero panel, 4 KPI cards (`KpiCards.tsx`), and `Analytics.tsx` (Action mix, Top at-risk branches, Top SKUs, and 4-band semantic Cover-Days Heatmap).
  - `src/features/audit/`: Searchable/filterable `AuditPage` with reason-code badges and tooltips.
  - `src/features/users/`: Admin-only `UsersPage` with Create User, Edit User (role & branch scope), Reset Password, and Deactivate flows.
  - `src/features/drilldown/`: `BranchPage` (`/branches/:id`) and `ProductPage` (`/products/:sku`).

## Frontend Design System & Guardrails (`apps/web`)
- **Color & Surface Layering (`index.css`, `lib/tokens.ts`)**:
  - Calm Blue primary brand (`#2563EB` light / `#3B82F6` dark), layered slate surfaces (`--bg`, `--surface`, `--table-header`, `--row-hover`, `--row-selected`), and semantic tokens (`gain`, `risk`, `warn`, `info`, `indigo`, `neutral`).
  - Full Light / Dark / System support via `ThemeProvider` (`components/theme-provider.tsx`) and `ModeToggle` (`components/mode-toggle.tsx`), persisted under `stockflow-ui-theme`.
- **Shared Primitives**:
  - `Button` (`components/ui/button.tsx`): Only button implementation allowed across the app. Variants: `default`/`primary`, `secondary`/`outline`, `soft-success`, `soft-danger`, `destructive`, `ghost`, `link`. Supports `loading` spinner and `tooltip` props.
  - `Badge` (`components/ui/badge.tsx`): Rounded pill badges (`rounded-full`, `1px` inset ring, optional `dot`) for actions (`transfer`, `reorder`, `markdown`), statuses (`pending`, `approved`, `rejected`), roles (`admin`, `manager`, `staff`), and inventory health (`risk`, `over`, `ok`, `fresh`). No dollar-priority badge (`priorityOf()` is removed; sort order + `$` amount carry priority).
  - `TableCard` / `TableToolbar` / `Table` (`components/ui/table.tsx`): Fixed-layout data tables with `#F1F5F9` (`--table-header`) 11px uppercase column headers, right-aligned `tabular-nums` numbers, and `TableSkeleton` loading states.
- **Unified Formatting (`lib/format.ts`)**:
  - `formatMoney`: Compact currency (`$37.3K`, `$1.2M`) for headers and KPI cards.
  - `formatMoneyFull`: Whole dollars with separators (`$318`, `$1,240`) for tables and detail views (cents shown only for non-zero values `< $1`).
  - `formatNumber`: Integers with separators (`1,240`), preserving 1 decimal only for fractional rates `< 1`.
  - `formatCover` / `formatCoverCell`: Treats engine's `NO_DEMAND_COVER = 999999` (`>= 9999`) as `"No demand"` / `"—"` and caps `> 90` days at `"90d+"` in heatmap cells.
- **Automated UI Guardrail (`scripts/check-ui.mjs`, wired into `pnpm lint`)**:
  1. Fails if any raw `<button` element is used outside `apps/web/src/components/ui/`.
  2. Fails if any hex color literal (`#...`) appears in `apps/web/src/` outside `index.css` and `lib/tokens.ts`.
  3. Fails if any inline `style={{ ... }}` sets `color`, `background`, `backgroundColor`, or `boxShadow`.
  4. Fails if any file under `apps/web/src/features/` uses inline number/date formatting (`Intl.NumberFormat`, `toLocaleString`, `toFixed`) instead of `@/lib/format`.

## Route Table (`apps/web`)
| Route | Component | Access | Purpose |
|---|---|---|---|
| `/login` | `LoginPage` | Public | Role-assigned sign-in + collapsible demo account selector (`VITE_SHOW_DEMO_ACCOUNTS`) |
| `/` | `OverviewPage` | `admin`, `manager`, `staff` | Network hero, 4 KPI cards, Action Mix, 4-band Cover-Days Heatmap, 90d trends |
| `/queue` | `QueuePage` | `admin`, `manager`, `staff` | Ranked action queue, action tabs, filters, batch bar (`admin`/`manager`), right-hand `RecommendationDrawer` |
| `/branches/:id` | `BranchPage` | `admin`, `manager`, `staff` (scoped) | Branch KPIs, sales & stock chart, actions touching branch |
| `/products/:sku` | `ProductPage` | `admin`, `manager`, `staff` (scoped) | SKU policy breakdown, sales/stock/cover charts, branch position table |
| `/audit` | `AuditPage` | `admin`, `manager` | Searchable decision audit log with reason-code badges |
| `/users` | `UsersPage` | `admin` | Create, edit role/branches, reset password, and deactivate users |

## Authentication & Role Hierarchy (RBAC)
- **Hierarchy:** `admin` > `manager` > `staff`.
  - `admin`: All 15 branches; manage lower-role users; approve/reject all recommendations; view audit log.
  - `manager`: Assigned `branchIds` only; approve/reject recommendations touching assigned branches; view audit log for assigned branches.
  - `staff`: Single assigned branch; read-only access (no approve/reject, no audit log, no user management).
- **Client RBAC vs. Server Enforcement:** Hiding controls in `apps/web` (e.g. hiding Approve/Reject checkboxes & buttons or Audit/Users nav items for `staff`) is cosmetic UX only; all authorization and branch scoping are strictly enforced on the server in `apps/api`.
- **Hierarchy Invariant:** Users may only create/modify users of strictly lower roles (`admin` can manage `manager` and `staff`; `manager` and `staff` cannot manage users).

## Scoping Invariant: Service Layer After Plan Computation
- **Rule:** The morning plan is computed once globally and cached (`analyze(data, DEFAULT_POLICY)`). Branch scoping and KPI rollups for non-admins are applied in the API service layer AFTER the cached plan is built.
- Transfers are visible to a manager/staff member if the user's branch scope includes either the donor OR receiver branch.
- Reorders and markdowns are visible if the user's branch scope includes the target branch.

## Sales Entries Ingestion (`apps/api`)
- `POST /api/sales-entries`: Validates `branchId`, `sku`, `date` (`YYYY-MM-DD`), `unitsSold` (`>= 0`), and `onHand` (`>= 0`) with field-specific `400` messages, upserts on `(branchId, sku, date)` in `sales_entries`, triggers `recomputeForSku(branchId, sku)`, and returns `201`.
- `POST /api/sales-entries/import`: Accepts `multipart/form-data` field `"file"` (max 5MB CSV with header `branchId,sku,date,unitsSold,onHand`), validates each row without failing the whole file on bad rows, upserts valid rows, triggers `recomputeForSku(branchId, sku)` once per distinct `(branchId, sku)` touched, and returns `{ inserted, updated, errors }`.

## Key Commands
- Run dev servers: `pnpm dev`
- Seed Mongo stock & catalog: `pnpm seed:mongo`
- Seed users: `pnpm seed:users`
- Run test suite: `pnpm test`
- Typecheck: `pnpm typecheck`
- Lint (ESLint + `scripts/check-ui.mjs`): `pnpm lint`
- Build all packages: `pnpm build`

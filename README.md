# StockFlow

StockFlow is a morning decision and replenishment order system for a 15-branch Bahrain retail network. It ranks transfer, reorder, and markdown moves by net BHD benefit (`BD`, including Haversine inter-branch freight cost), writes a plain-language reason for each move, and governs cross-branch approvals through an auditable `ReplenishmentOrder` and immutable `OrderEvent` pipeline. All data is synthetic. Access is protected by JWT/cookie role-based authentication (`admin`, `manager`, `staff`).

Why the math looks like this, and what it refuses to do, is in [docs/DECISIONS.md](docs/DECISIONS.md). For the full mathematical walkthrough, worked example, constants table, and strategy seams, see [docs/ENGINE.md](docs/ENGINE.md); for numbered architectural decisions (`ADR-001`–`ADR-021`), see [docs/ADR.md](docs/ADR.md).

## Key capabilities

- **Pure replenishment engine (`@stockflow/core`)**: EWMA demand velocity (stockout-excluded), safety stock (`z = 1.65`), `AT_RISK` / `OVERSTOCK` / `HEALTHY` / `NEW` classification (`DEAD_VELOCITY_PER_DAY = 1/7`), greedy cross-branch matching, Haversine freight pricing, per-quantity benefit recalculation (`computeActionBenefitForQuantity`), and a 45-day counterfactual backtest.
- **Governed replenishment orders**: Unified `ReplenishmentOrder` state machine (`SUGGESTED`, `OPEN_REQUEST`, `AWAITING_DONOR`, `COMMITTED`, `DECLINED`, `CANCELLED`, `RECEIVED`) with atomic immutable `OrderEvent` trails, donor-owned cross-branch send approvals, admin overrides (`force` + comment), and editable commit quantities bounded per action type with mandatory `QuantityChangeReason` codes (`CASE_PACK`, `TRUCK_CAPACITY`, `PROMO_HOLD`, `OTHER`) while keeping `engineSnapshot` read-only.
- **Read-time queue lifecycle**: `Pending` (default), `In progress`, and `Decided` views computed on read without bumping `dataVersion` (`APPROVED_ACTIVE_DAYS=3`, `REJECT_SNOOZE_DAYS=3`, automatic early reopen on `+/-50%` deterioration, and a `24h` reopen window).
- **Live Bahrain freshness**: All "today" cutoffs, stale-data warnings, and `/api/kpis/live` freshness metadata anchor to `Asia/Bahrain` (`UTC+3`), with `scopedKpiCache` keyed by sorted branch IDs, `dataVersion`, and `decisionVersion`.
- **Daily entries & CSV imports**: Single-entry form with live branch/SKU context and sanity warnings, multi-row `Daily Sheet` grid editor, recent-entry CRUD, and 5 MB CSV bulk upload with downloadable error rows and role-scoped `import_log` history (`GET /api/sales/imports`).
- **Branch, catalog, alert & user administration**: Admin branch creation/editing with unified Bahrain coordinate paste parsing (decimal, DMS, Google Maps URLs, swapped-coordinate detection, 6-decimal rounding, duplicate `(name, city)` protection) and reversible archiving; catalog lifecycle with change history; staff floor stock alerts (`POST /api/stock-alerts`) whose resolutions link directly to real replenishment orders; and admin user management with strict email/password/branch validation and role-hierarchy protection.

## Quick start

Requires Node.js 20+ and pnpm.

```bash
pnpm install
cp .env.example .env     # then edit .env; never commit it
pnpm seed:mongo          # needs MONGODB_URI; wipes and rebuilds the "stockflow" database
pnpm seed:users          # creates the demo accounts (listed in docs/DEMO.md)
pnpm dev
```

- Web: http://localhost:5173
- API: http://127.0.0.1:3001

`pnpm dev` starts both. Vite forwards `/api` unchanged to the API.

**No database?** Run in memory mode, which builds the dataset and demo accounts at startup and resets on every restart.

```powershell
$env:STOCKFLOW_REPO = "memory"; pnpm dev      # PowerShell
```

### Environment variables

Copy `.env.example` to a repo-root `.env`. The API loads it from the repository root, not from the working directory.

| Variable | Purpose |
|---|---|
| `MONGODB_URI` | Atlas or local MongoDB connection string (database `stockflow`). Unset means in-memory mode. |
| `AUTH_ENABLED` | Enables authentication (`true`) |
| `JWT_SECRET` | Random secret (32+ characters) used to sign tokens |
| `ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL` | Token lifetimes |
| `ADMIN_PASSWORD` | Initial admin password (see `.env.example`) |
| `PORT`, `HOST` | Local server binding |
| `WEB_ORIGIN` | CORS allow-list. Leave unset when web and API share one origin (Vercel). |
| `APPROVED_ACTIVE_DAYS` | Optional positive integer (default `3`). Days legacy migrated approvals remain in `In progress` before moving to `Decided`. |
| `REJECT_SNOOZE_DAYS` | Optional positive integer (default `3`). Days declined items stay snoozed unless stock risk worsens by `+/-50%`. |

### Database notes

- The API never seeds on startup and connects to MongoDB lazily. A connection problem does not crash the process: `GET /api/health` always answers, and `GET /api/health/db` reports the Mongo error (redacted) and any missing variable names.
- `pnpm seed:mongo` writes the dataset, the `(branchId, sku, date)` index, the initial `data_version`, and the cached plan. It does not print the URI. It wipes decisions, orders, and sales entries, so run it once per database. Restarts and deploys never need it.
- Re-run it after changing seed definitions or product names (see [docs/NAMING.md](docs/NAMING.md)).
- To clear only the demo decisions and their audit entries without bumping `dataVersion`: `pnpm reset:decisions --yes`.

## Tests

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm bench:cold     # cold-start and warm latency of the first plan
```

Vitest runs across all three workspaces (**54 files, 313 tests**; see [docs/TESTING.md](docs/TESTING.md)):

- **`packages/core` (9 files, 38 tests)**: Engine formulas, `fast-check` property invariants, donor ranking, projection overlays, quantity-edit net-benefit math, order state-machine transitions, RBAC truth tables, and deterministic seeding.
- **`apps/api` (34 files, 255 tests)**: Dual-repository (`InMemoryRepository` + `mongodb-memory-server`) suites covering auth security, RBAC/route matrix, sales entry auth and `import_log` scoping, governed replenishment orders and editable quantities, queue lifecycle windows, alert-to-order resolution, branch coordinates and archiving, live Bahrain freshness, `plan_cache` consistency, `committedDeltas` `409` conflicts, user validation, golden snapshots (`recommendations.json`, `kpis.json`), and secret redaction.
- **`apps/web` (11 files, 20 tests)**: React Testing Library suites covering overview freshness, queue lifecycle switching, editable quantity benefit previews, buyer-friendly wording guards, alert triage & audit trails, coordinate paste/swap validation, daily sheet & CSV import UX, user dialog autofill isolation, and end-to-end replenishment flows.

`pnpm lint` runs ESLint plus `scripts/check-ui.mjs` (enforcing shared UI primitives, design tokens, and centralized `@/lib/format` usage). `pnpm build` type-checks all workspaces and writes `apps/web/dist`. Tests never connect to Atlas.

## Architecture

```
browser
  |
  |  http://localhost:5173  (Vercel: one origin, /api routed to the API)
  v
apps/web  -- /api -->  apps/api  -->  services  -->  packages/core
                          |                              |
                          |                              +-- engine (pure)
                          |                              +-- orders (FSM)
                          |                              +-- report (DTOs)
                          |                              +-- schemas, bahrainDate, coordinates
                          v
                    repositories
                     /        \
              memory          MongoDB stockflow
           (no URI)           (URI set)
```

## Folder map

```
packages/core/src
  engine/           Pure forecasting, safety stock, classify, match, recommend, donorRanking,
                    quantityBenefit, projection, backtest, strategies, config
  orders.ts         ReplenishmentOrder & OrderEvent schemas, transition table, canTransition()
  bahrainDate.ts    Pure Asia/Bahrain (UTC+3) calendar/date helpers (explicit clock arg)
  coordinates.ts    Bahrain bounding box, 6-decimal rounding, swap detection & validators
  report/           Recommendations, KPIs, branch/product views, plain-language reasons
  schemas/          Core DTOs (index.ts), RBAC helpers (auth.ts), lifecycle & live KPI contracts (lifecycle.ts)
  seed/             Deterministic 15-branch Bahrain geography, tiered BHD catalog, 120-day history
apps/api/src
  config/           Env validation (env.ts), queue lifecycle windows (queueLifecycle.ts), secret redaction
  db.ts             sales_entries, sales_entry_audits, import_log, and recomputeForSku log
  plugins/          Fastify app setup, auth guards, error handler
  routes/           auth, branches, catalog, helpers, locations, orders, salesEntries, stock, stockAlerts, users
  services/         KpiService, CatalogService, StockAlertService, OrderService (+ orderSnapshot),
                    DecisionService, AuthService, queueLifecycle, projection, runtimeState, scope
  repositories/     Memory, MongoDB, Mongoose models, and repository interfaces
  utils/            bahrainDate wrapper (injectable clock)
  scripts/          seed-mongo, seed-users, resetDecisions, benchCold
  __tests__/, test/ Dual-repository API Vitest suites, test helpers, and golden __fixtures__
apps/web/src
  app/              Shell, sidebar health dots (LocationSidebarParts), and role-guarded routes
  components/ui/    Shared primitives (Button, Badge, Table, Dialog, Sheet, Card, Tabs, Tooltip, ...)
  components/shared/ FreshnessBanner, OrderEventRow, ChartCard, ChartDetailPopup, DonorPicker,
                    OrderStatusBadge, PendingStockAlertsCard, StockDeltaBadges, CommandPalette, states
  features/         overview, queue, branches, products, data, audit, users, auth
  hooks/, lib/      Query keys, location/Bahrain date hooks, API client, tokens, formatters, labels,
                    coordinates parser, dailySheetCsv, userValidation
  __tests__/        Web Vitest + Testing Library component and flow suites
AGENTS.md           Project rules, invariants, and architecture map
docs/               ADR, ENGINE, DECISIONS, API, FRONTEND, TESTING, DEMO, NAMING, PROPOSAL
scripts/            check-ui.mjs, smoke.mjs
```

## Data flow

1. **Lazy plan build & cache (`dataVersion`)**: The repository loads the seeded dataset from MongoDB (or builds it deterministically in memory when `MONGODB_URI` is unset). Stock services (`KpiService`, `CatalogService`, `DecisionService`, `OrderService`, and `StockAlertService` sharing `StockRuntimeState`) compute the morning plan lazily on the first request for the current `dataVersion` and persist it (gzipped) in `plan_cache`. Cold starts and parallel instances reuse the cached plan instead of recomputing. Queue views filter to actionable moves (`netBenefit >= BD 9.500` and `quantity >= 5`).
2. **Post-plan scoping & live projection**: Read endpoints (`/api/kpis`, `/api/kpis/live`, `/api/orders`, `/api/recommendations`, `/api/locations/:id/*`, `/api/branches/:id`, `/api/products/:sku`, `/api/catalog/products`) apply role and branch scoping *after* full-network matching and overlay live `committedDeltas` (donor `reserved`, receiver `inTransit`).
3. **Governed order transitions (`decisionVersion`)**: Intent states (`SUGGESTED`, `OPEN_REQUEST`, `AWAITING_DONOR`) never reserve inventory. Only moving into `COMMITTED` writes donor `reserved` and receiver `inTransit`, enforces the synchronous donor surplus check (`409 Conflict` on over-allocation), and accepts bounded buyer quantity edits with a `QuantityChangeReason`. `RECEIVE` clears only receiver `inTransit` until physical stock updates arrive. Order transitions, legacy approve/reject actions, and 24-hour reopens persist atomic events/audits and bump `decisionVersion` (clearing `scopedKpiCache`) without ever bumping `dataVersion` or rewriting `plan_cache`.
4. **Alerts & physical mutations**: Store `staff` flag `AT_RISK` items via `POST /api/stock-alerts`; scoped `manager` and `admin` users resolve them via `POST /api/stock-alerts/:id/resolve` (linking directly to a `ReplenishmentOrder` or logging an adjustment/acknowledgement/dismissal). Sales entries, CSV imports (logged to `import_log`), catalog updates/archives, and branch create/update/archive mutations bump `dataVersion`, recompute and persist `plan_cache`, and clear overlays.

## Deploy to Vercel

Use one project. In the import settings, set Framework Preset to **Services** (a Beta Vercel feature). The root `vercel.json` builds `apps/web` and `apps/api` together, routes `/api/(.*)` to the API and sends everything else to the web app with an SPA fallback.

1. Push the repository to GitHub and import it in Vercel. Pushes to `main` deploy to production; other branches get previews.
2. Add environment variables in the project settings and mark the secrets **Sensitive**:
   - `MONGODB_URI` (Atlas connection string, Sensitive)
   - `AUTH_ENABLED=true`
   - `JWT_SECRET` (random 32+ characters, Sensitive)
   - `ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL`
   - `ADMIN_PASSWORD` (Sensitive)
   - Optional: `APPROVED_ACTIVE_DAYS=3`, `REJECT_SNOOZE_DAYS=3`
   - Leave `WEB_ORIGIN` unset (single origin).
3. In Atlas, create a dedicated database user with `readWrite` on `stockflow` only. Vercel uses dynamic IP addresses, so Network Access must allow `0.0.0.0/0`; the user's password is then the only barrier, so use a strong generated password.
4. From your machine run `pnpm seed:mongo` and `pnpm seed:users` once. Startup never generates data when `MONGODB_URI` is set.
5. Redeploy after any variable change (it applies to new deployments only), then check:
   ```bash
   curl https://<your-deployment-url>/api/health/db        # expect {"db":"ok",...}
   SMOKE_EMAIL=<demo email> SMOKE_PASSWORD=<password> node scripts/smoke.mjs https://<your-deployment-url>
   ```
6. The login page lists the demo accounts when `VITE_SHOW_DEMO_ACCOUNTS` is `true`. Those credentials are public, so use throwaway passwords or set it to `false`.

## Known limitations

See [docs/DECISIONS.md](docs/DECISIONS.md) and [docs/ENGINE.md](docs/ENGINE.md) for assumptions and limits (demand model, greedy matching, freight model, and operational cadence). The morning plan is recomputed when physical data changes, not continuously on a background schedule.

## Third-party libraries and assets

- **Core:** Zod, Vitest, fast-check, TypeScript
- **API:** Fastify, `@fastify/cors`, `@fastify/cookie`, `@fastify/helmet`, `@fastify/rate-limit`, `bcryptjs`, `@fastify/jwt`, Mongoose, `mongodb-memory-server` (tests), dotenv, tsx, pino (via Fastify), Vitest
- **Web:** React, Vite, Tailwind CSS, Base UI (`@base-ui/react`), class-variance-authority, clsx, tailwind-merge, TanStack Query, Recharts, React Router, Lucide, Sonner, Zod, `@fontsource/inter` (Inter, SIL Open Font License), Vitest, Testing Library, jsdom
- **Tooling:** ESLint, typescript-eslint, Prettier
- No third-party images, datasets or brand assets are used. All data is synthetic.

All engine formulas, seed stories, order workflows, and UI behavior are verified with Vitest and end-to-end checks.

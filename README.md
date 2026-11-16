# StockFlow

StockFlow is a morning action queue for a 15-branch Bahrain retail network. It ranks transfer, reorder, and markdown moves by net BHD benefit (`BD`, incorporating Haversine inter-branch freight cost) and writes a plain-language reason for each one. The dataset is synthetic and protected by JWT/cookie RBAC authentication (`admin`, `manager`, `staff`).

Why the math looks like this, and what it refuses to do, is in [docs/DECISIONS.md](docs/DECISIONS.md).

## Setup

Requires Node.js 20+ and pnpm.

```bash
pnpm install
pnpm dev
```

- Web: http://localhost:5173
- API: http://127.0.0.1:3001

`pnpm dev` starts both. Vite forwards `/api` unchanged to http://localhost:3001.

Copy `.env.example` to a repo-root `.env`. The API loads that file from the repository root, not from the working directory. Do not commit `.env`. With no URI the API uses memory. With `MONGODB_URI` it uses the `stockflow` database. The API does not seed on startup.

```bash
pnpm seed:mongo
```

That writes the dataset and the `(branchId, sku, date)` index. It does not print the URI. A set URI that fails to connect stops the process.

Whenever catalog product names or seed definitions change (see [docs/NAMING.md](docs/NAMING.md)), re-run `pnpm seed:mongo` against your MongoDB instance so the stored `StockflowMeta` catalog and cached `StockflowPlan` recommendations reflect the updated product names. In-memory mode (`MONGODB_URI` unset) regenerates the catalog automatically on startup.

## Tests

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

Vitest covers both `packages/core` (engine math, property invariants, RBAC truth tables, deterministic Bahrain seed) and `apps/api` (dual-repo auth security, RBAC scoping, catalog/sales lifecycle, `plan_cache` consistency, `stock_alerts`, and `committedDeltas` projection / `409` conflict suites; see [docs/TESTING.md](docs/TESTING.md)). `pnpm lint` runs ESLint plus `scripts/check-ui.mjs`, and `pnpm build` compiles TypeScript workspaces and writes `apps/web/dist`.

## Architecture

```
browser
  |
  |  http://localhost:5173
  v
apps/web  -- /api -->  apps/api  -->  services  -->  packages/core
                          |                              |
                          |                              +-- engine (pure)
                          |                              +-- report (DTOs)
                          v
                    repositories
                     /        \
              memory          MongoDB stockflow
           (no URI)           (URI set)
```

## Folder map

```
packages/core/src
  schemas/          Zod contracts & pure RBAC permission helpers shared by API and web
  seed/             Deterministic 15-branch Bahrain geography, tiered BHD catalog, and 120-day history
  engine/           config, forecast, classify, match, recommend, backtest
  report/           Recommendations, KPIs, branch and product views, reason sentences
  round.ts
apps/api/src
  config/           Env loading and secret redaction
  plugins/          Fastify app, auth guards, and error handler
  routes/           HTTP endpoints (auth, stock, stockAlerts, catalog, locations, salesEntries, users)
  services/         StockService (cached morning plan, committedDeltas projection, decisions) & AuthService
  repositories/     Memory, MongoDB, and the repository interface
apps/web/src
  app/              Shell and role-guarded routes
  components/ui     Shared primitives (Button, Badge, Table, Dialog, Card, etc.)
  components/shared Empty/error/loading states, StockDeltaBadges, charts, glossaries
  features/         overview, queue, drilldown, products, data, audit, users, auth
  hooks/            Query keys
  lib/              API client, design tokens, and formatters
```

## Data flow

1. The repository loads the seeded Bahrain dataset from MongoDB (`plan_cache` + `StockflowMeta`, seeded via `pnpm seed:mongo` / `pnpm seed:users`) or builds it deterministically in memory when `MONGODB_URI` is unset.
2. `StockService` computes the morning plan lazily on first request for the current `dataVersion` (`<= BD 9.500` net benefit actions and sub-minimum transfers are suppressed by the service queue).
3. Read endpoints (`GET /api/kpis`, `/api/recommendations`, `/api/locations/:id/*`, `/api/branches/:id`, `/api/products/:sku`, `/api/catalog/products`) apply role/branch scoping post-plan and project live `committedDeltas` (`reserved` donor deductions, `inTransit` receiver receipts) via pure `project()`.
4. `POST /api/recommendations/:id/approve`, `/reject`, and `/batch/decide` record immutable `actions` + `audit` rows without bumping `dataVersion`, overlay `committedDeltas` (replayed from post-plan `audit` entries on startup), and reject donor over-allocations with `409 Conflict`.
5. Store `staff` can escalate `AT_RISK` items via `POST /api/stock-alerts` (`stock:flag`), which scoped `manager`/`admin` users approve or reject once via `/api/stock-alerts/:id/approve|reject`. `GET /api/audit` returns decision audit rows in scope.

## Deploy to Vercel

Use one project. In the import settings, set Framework Preset to **Services**. The root `vercel.json` builds `apps/web` and `apps/api` together, routes `/api/(.*)` to the API, and sends all other routes to `apps/web` with a catch-all `/(.*)` -> `/index.html` SPA fallback.

1. Push this repository to GitHub and import it in Vercel.
2. Add environment variables in the Vercel project settings:
   - `MONGODB_URI` (Atlas connection string; do not commit)
   - `AUTH_ENABLED=true`
   - `JWT_SECRET` (random 32+ char secret)
   - `ADMIN_PASSWORD` (strong initial admin password)
   - `WEB_ORIGIN` (leave unset for single-origin Vercel Services; set only if web and api live on different origins)
3. In Atlas, create a database user and allow the Vercel deployment to connect (Network Access). The API uses the database name `stockflow`.
4. From your machine, run `pnpm seed:mongo` once (and `pnpm seed:users` if seeding auth users separately). That seeds the dataset, initializes `data_version` (`1`), and writes the gzipped initial plan to `plan_cache` so serverless cold starts do not recompute the engine. Startup never generates synthetic data when `MONGODB_URI` is set.
5. Deploy, then verify with `node scripts/smoke.mjs https://<your-deployment-url>`.

## Third-party libraries

- **Core:** Zod, Vitest, TypeScript
- **API:** Fastify, `@fastify/cors`, `@fastify/cookie`, `@fastify/helmet`, `@fastify/rate-limit`, `bcryptjs`, `jose`, Mongoose, `mongodb-memory-server` (tests), dotenv, pino (via Fastify)
- **Web:** React, Vite, Tailwind CSS, Base UI (`@base-ui/react`), class-variance-authority, TanStack Query, Recharts, React Router, Lucide, Zod, `@fontsource/inter`
- **Repo:** ESLint, typescript-eslint, Prettier

## AI tools

Implemented in Cursor with Grok 4.7. The engine formulas, seed stories, and UI behavior were checked with Vitest and by using the running app.

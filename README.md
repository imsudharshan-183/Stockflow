# StockFlow

StockFlow is a morning action queue for a 15-branch retailer. It ranks transfer, reorder, and markdown moves by net dollar benefit and writes a plain-language reason for each one. The data is synthetic. There is no customer data and no authentication.

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

Vitest covers `packages/core` only, including the worked example of a 60-unit transfer. `pnpm build` typechecks the API and writes `apps/web/dist`.

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
  schemas/          Zod contracts shared by the API and the web
  seed/             Deterministic catalog and 120-day history
  engine/           config, forecast, classify, match, recommend, backtest
  report/           Recommendations, KPIs, branch and product views
  round.ts
apps/api/src
  config/           Env loading and secret redaction
  plugins/          Fastify app and error handler
  routes/           HTTP
  services/         Cached morning plan, decisions, materiality screen
  repositories/     Memory, MongoDB, and the repository interface
apps/web/src
  app/              Shell and routes
  components/ui     Shared controls
  components/shared Empty, error, and loading states
  features/         overview, queue, drilldown, audit
  hooks/            Query keys
  lib/              API client and formatters
```

## Data flow

1. The repository builds the seeded dataset, or loads one already stored in MongoDB.
2. The service runs the engine once for the morning after the last seeded day.
3. `GET /api/kpis`, `GET /api/recommendations`, `GET /api/branches/:id`, and `GET /api/products/:sku` read that result. The recommendation list hides actions below BD 9.500 net benefit or below the minimum transfer quantity. Mongo reads the recommendations stored by `pnpm seed:mongo` instead of running the engine again.
4. `POST /api/recommendations/:id/approve` and `/reject` append an action and an audit row. They do not recompute the queue. `GET /api/audit` returns those rows.

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
- **API:** Fastify, `@fastify/cors`, Mongoose, dotenv, pino (via Fastify)
- **Web:** React, Vite, Tailwind CSS, Radix UI, class-variance-authority, TanStack Query, Recharts, React Router, Lucide, Zod, `@fontsource/inter`
- **Repo:** ESLint, typescript-eslint, Prettier

## AI tools

Implemented in Cursor with Grok 4.7. The engine formulas, seed stories, and UI behavior were checked with Vitest and by using the running app.

# StockFlow

StockFlow is a morning action queue for a 15-branch Bahrain retail network. It ranks transfer, reorder, and markdown moves by net BHD benefit (`BD`, including Haversine inter-branch freight cost) and writes a plain-language reason for each one. All data is synthetic. Access is protected by JWT/cookie role-based authentication (`admin`, `manager`, `staff`).

Why the math looks like this, and what it refuses to do, is in [docs/DECISIONS.md](docs/DECISIONS.md); for the reviewer-focused mathematical walkthrough, worked example, constants table, and strategy seams, see [docs/ENGINE.md](docs/ENGINE.md).

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

### Database notes

- The API never seeds on startup and connects to MongoDB lazily. A connection problem does not crash the process: `GET /api/health` always answers, and `GET /api/health/db` reports the Mongo error (redacted) and any missing variable names.
- `pnpm seed:mongo` writes the dataset, the `(branchId, sku, date)` index, the initial `data_version` and the cached plan. It does not print the URI. It wipes decisions and sales entries, so run it once per database. Restarts and deploys never need it.
- Re-run it after changing seed definitions or product names (see [docs/NAMING.md](docs/NAMING.md)).
- To clear only the demo decisions and their audit entries: `pnpm reset:decisions --yes`.

## Tests

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm bench:cold     # cold-start and warm latency of the first plan
```

Vitest covers `packages/core` (engine math, property invariants, RBAC truth tables, deterministic seed) and `apps/api` (dual-repository auth security, RBAC scoping, catalog and sales lifecycle, `plan_cache` consistency, stock alerts, `committedDeltas` projection and `409` conflicts, health and startup, secret redaction); see [docs/TESTING.md](docs/TESTING.md). `pnpm lint` runs ESLint plus `scripts/check-ui.mjs`. `pnpm build` type-checks the workspaces and writes `apps/web/dist`. API suites run against both the in-memory repository and `mongodb-memory-server`, never against Atlas.

## Architecture

```
browser
  |
  |  http://localhost:5173  (Vercel: one origin, /api routed to the API)
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
  schemas/          Zod contracts and pure RBAC helpers shared by API and web
  seed/             Deterministic 15-branch Bahrain geography, tiered BHD catalog, 120-day history
  engine/           config, forecast, classify, match, recommend, backtest
  report/           Recommendations, KPIs, branch and product views, reason sentences
apps/api/src
  config/           Env loading, validation and secret redaction
  plugins/          Fastify app, auth guards, error handler
  routes/           auth, branches, catalog, locations, orders, salesEntries, stock, stockAlerts, users
  services/         KpiService, CatalogService, StockAlertService, OrderService, DecisionService, AuthService
  repositories/     Memory, MongoDB and the repository interface
  scripts/          seed-mongo, seed-users, resetDecisions, benchCold
  __tests__/, test/ Dual-repository API Vitest suites, test helpers, and golden __fixtures__
apps/web/src
  app/              Shell and role-guarded routes
  components/ui     Shared primitives (Button, Badge, Table, Dialog, Card, ...)
  components/shared Empty/error/loading states, theme toggle, charts, glossaries
  features/         overview, queue, branches, products, data, audit, users, auth
  hooks/, lib/      Query keys, API client, design tokens, formatters
docs/               ADR, ENGINE, DECISIONS, API, FRONTEND, TESTING, DEMO, NAMING, PROPOSAL
scripts/            check-ui.mjs, smoke.mjs
```

## Data flow

1. The repository loads the seeded dataset from MongoDB (or builds it deterministically in memory when `MONGODB_URI` is unset).
2. The stock services (`KpiService`, `CatalogService`, `DecisionService`, and `StockAlertService` sharing `StockRuntimeState`) compute the morning plan lazily on the first request for the current `dataVersion` and persist it (gzipped) in `plan_cache`. Other instances and cold starts read the stored plan instead of recomputing. Actions at or below BD 9.500 net benefit and sub-minimum transfers are suppressed by the service queue.
3. Read endpoints (`/api/kpis`, `/api/recommendations`, `/api/locations/:id/*`, `/api/branches/:id`, `/api/products/:sku`, `/api/catalog/products`) apply role and branch scoping after the plan is built and project live `committedDeltas` (reserved donor stock, in-transit receiver stock).
4. Approve, reject and batch-decide write immutable `actions` and `audit` rows without bumping `dataVersion`. They overlay `committedDeltas` and reject donor over-allocation with `409 Conflict`.
5. Store `staff` can flag `AT_RISK` items via `POST /api/stock-alerts`; scoped `manager` and `admin` users approve or reject them once. Sales entries, imports and catalog changes bump `dataVersion` and refresh the plan.

## Deploy to Vercel

Use one project. In the import settings, set Framework Preset to **Services** (a Beta Vercel feature). The root `vercel.json` builds `apps/web` and `apps/api` together, routes `/api/(.*)` to the API and sends everything else to the web app with an SPA fallback.

1. Push the repository to GitHub and import it in Vercel. Pushes to `main` deploy to production; other branches get previews.
2. Add environment variables in the project settings and mark the secrets **Sensitive**:
   - `MONGODB_URI` (Atlas connection string, Sensitive)
   - `AUTH_ENABLED=true`
   - `JWT_SECRET` (random 32+ characters, Sensitive)
   - `ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL`
   - `ADMIN_PASSWORD` (Sensitive)
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

See [docs/DECISIONS.md](docs/DECISIONS.md) for assumptions and limits (demand model, greedy matching, freight model). The morning plan is recomputed when data changes, not continuously.

## Third-party libraries and assets

- **Core:** Zod, Vitest, fast-check, TypeScript
- **API:** Fastify, `@fastify/cors`, `@fastify/cookie`, `@fastify/helmet`, `@fastify/rate-limit`, `bcryptjs`, `jose`, Mongoose, `mongodb-memory-server` (tests), dotenv, tsx, pino (via Fastify)
- **Web:** React, Vite, Tailwind CSS, Base UI (`@base-ui/react`), class-variance-authority, TanStack Query, Recharts, React Router, Lucide, Zod, `@fontsource/inter` (Inter, SIL Open Font License)
- **Tooling:** ESLint, typescript-eslint, Prettier
- No third-party images, datasets or brand assets are used. All data is synthetic.

All engine formulas, seed stories and UI behavior were checked with Vitest and by using the running app, and the author reviewed the code.

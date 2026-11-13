# StockFlow — Project Context & Assistant Guidelines

## Overview
StockFlow is a morning decision / action queue system for a 15-branch retail network (~500 SKUs, 120-day synthetic history). It ranks transfers, reorders, and markdowns by net dollar benefit ($) and writes plain-language explanations for buyers.

## Architecture & Monorepo Structure
- `packages/core`: Pure TypeScript logic and shared Zod schemas (no I/O, no DB drivers).
  - `src/engine/`: Demand forecasting (EWMA), safety stock, classification, greedy matching, net benefit, backtest. (INVARIANT: Never modify this without explicit mathematical justification).
  - `src/report/`: DTOs, KPI rollups, branch & product views.
  - `src/schemas/`: Shared Zod validation contracts and pure auth helpers (`can`, `scopeBranches`, `canManageRole`).
- `apps/api`: Fastify API server with MongoDB or in-memory repository.
  - `src/config/`: Environment variable validation and secret redaction.
  - `src/repositories/`: Memory and MongoDB stores for stock, audit, users, and refresh tokens.
  - `src/services/`: Morning plan cache, authentication service (bcryptjs), authorization & branch scoping.
  - `src/plugins/`: Fastify plugins, error handlers, and JWT/cookie auth decorators.
  - `src/routes/`: HTTP endpoints (`/api/auth/*`, `/api/users/*`, `/api/kpis`, `/api/recommendations`, etc.).
- `apps/web`: React 19 + Vite frontend with Tailwind CSS and Radix UI.
  - `src/features/auth/`: In-memory token management, silent cookie refresh, login UI.
  - `src/features/users/`: Admin-only user management UI (create, role/branch assignment, password reset, deactivation).
  - `src/features/queue/`: Action queue with role-aware action buttons (Approve/Reject hidden for staff).
  - `src/features/overview/`, `audit/`, `drilldown/`: KPIs, audit log, branch and product details.

## Authentication & Role Hierarchy (RBAC)
- **Hierarchy:** `admin` > `manager` > `staff`.
  - `admin`: All 15 branches; manage lower-role users; approve/reject all recommendations; view audit log.
  - `manager`: Assigned branchIds only; approve/reject recommendations touching assigned branches; view audit log for assigned branches.
  - `staff`: Single assigned branch; read-only access (no approve/reject, no audit log, no user management).
- **Hierarchy Invariant:** Users may only create/modify users of strictly lower roles (`admin` can manage `manager` and `staff`; `manager` and `staff` cannot manage users).
- **Tokens & Session Security:**
  - Short-lived JWT access token (15m) kept strictly in memory on the client.
  - Refresh token stored in an `httpOnly`, `SameSite=Lax` cookie rotated on each use.
  - Passwords hashed using bcryptjs (cost factor 10).
  - Generic "Invalid credentials" error message to prevent account enumeration.

## Scoping Invariant: Service Layer After Plan Computation
- **Rule:** The morning plan is computed once globally and cached (`analyze(data, DEFAULT_POLICY)`). Branch scoping and KPI rollups for non-admins are applied in the API service layer AFTER the cached plan is built.
- Scoping does not mutate or recompute the morning plan per user.
- Transfers are visible to a manager/staff member if the user's branch scope includes either the donor OR receiver branch.
- Reorders and markdowns are visible if the user's branch scope includes the target branch.
- KPIs for non-admins are rolled up directly from the scoped positions/actions.

## Environment Variables
- `PORT`: API server port (default `3001`).
- `HOST`: API bind host (default `127.0.0.1`).
- `MONGODB_URI`: MongoDB connection string (empty = In-Memory mode).
- `AUTH_ENABLED`: When `false` (default in dev/test), automatically injects a synthetic admin user so existing workflows and tests remain unchanged. Set to `true` to enforce authentication.
- `JWT_SECRET`: Secret key for JWT signing (required when `AUTH_ENABLED=true`).
- `ACCESS_TOKEN_TTL`: JWT access token lifetime (default `15m`).
- `REFRESH_TOKEN_TTL`: Refresh token expiration (default `7d`).
- `ADMIN_PASSWORD`: Default password for seeded admin account (default `Admin@12345`).

## Key Commands
- Run dev servers: `pnpm dev`
- Seed Mongo stock & catalog: `pnpm seed:mongo`
- Seed users: `pnpm seed:users`
- Run test suite: `pnpm test`
- Typecheck: `pnpm typecheck`
- Lint: `pnpm lint`
- Build all packages: `pnpm build`

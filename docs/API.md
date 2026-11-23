# StockFlow API Reference (`apps/api`)

All endpoints are mounted under `/api`. Protected routes require a valid JWT access token (cookie or `Authorization: Bearer`) unless `AUTH_ENABLED=false` (synthetic admin).

## Health & Auth (`/api/health`, `/api/auth/*`)
- `GET /api/health` — Public health check returning `{ status: "ok", repository: "mongo" | "memory", startupError, missingEnv }` immediately without touching the database or loading the dataset.
- `GET /api/health/db` — Public MongoDB ping check (cached for 30s) returning `200 { db: "ok", missingEnv }` or `503 { db: "error", name, message, missingEnv }` with secrets redacted.
- `POST /api/auth/login` — Authenticates email + password, sets `HttpOnly` access/refresh cookies, rate-limited.
- `POST /api/auth/refresh` — Rotates refresh token; rejects deactivated users and reused tokens.
- `POST /api/auth/logout` — Revokes refresh token and clears auth cookies.
- `GET /api/auth/me` — Returns current authenticated user profile and permissions.

## Stock & Morning Plan (`/api/*`)
- `GET /api/kpis` — Network (admin) or branch-scoped (manager) KPI rollup.
- `GET /api/recommendations` — Paginated, filterable morning action queue (transfers, reorders, markdowns), scoped to caller's branches.
- `GET /api/recommendations/:id` — Single recommendation detail (403/404 if out of scope).
- `POST /api/recommendations/:id/approve` — Approves recommendation, records audit entry (`admin`/`manager` in scope), and overlays live `committedDeltas` (`reserved`/`inTransit`) without bumping `dataVersion`; returns `409 Conflict` (`DecisionConflictError`) if donor surplus is already committed.
- `POST /api/recommendations/:id/reject` — Rejects recommendation with reason code, records audit entry.
- `POST /api/recommendations/batch/decide` — Batch-decides `{ ids: string[] (1..200), decision: "approve" | "reject", reasonCode? }` (`admin`/`manager`). Evaluates RBAC/scope per ID, persists with one bulk action write and one bulk audit write (without bumping `dataVersion`), and returns `{ results: [{ id, status: "ok" | "forbidden" | "not_found" | "already_decided" }] }`.
- `GET /api/branches/:id` — Branch detail DTO with projected `onHand`, `coverDays`, `reserved`, and `inTransit` (`admin`/`manager` in scope via `dashboard:financial:scoped`; `403` for `staff`).
- `GET /api/products/:sku` — Product detail DTO across scoped branches with projected `onHand`, `coverDays`, `reserved`, and `inTransit`.
- `GET /api/audit` — Decision audit log, newest first, scoped to caller's branches (`admin`/`manager`).

## Branches (`/api/branches/*`)
*(Guarded with `branches:manage` — `admin` only; returns `403 Forbidden` for `manager` and `staff`. Note that `BranchSchema` carries `status: "active" | "archived"`, and mutations recompute the active plan, clear `committedDeltas`/`committedRecommendationIds`/`scopedKpiCache`, and bump `dataVersion`.)*
- `GET /api/branches` — Admin branch directory including archived branches (`?status=active|archived`, `?search=`).
- `POST /api/branches` — Create a branch with sequential `BR-0xx` ID (`BR-016+`), pushing cold-start zero-filled `sales`, `onHand`, and `demand` arrays onto every product.
- `PATCH /api/branches/:id` — Edit branch details (`name`, `city`, `region`, `coordinates`) or toggle reversible `status` (`"active"` ⇄ `"archived"`).

## Locations (`/api/locations/*`)
*(Guarded with `dashboard:financial:scoped`; returns `403 Forbidden` for `staff`.)*
- `GET /api/locations` — Scoped active branch list with health summary (`admin`/`manager`; excludes `archived` branches, while historical `/api/locations/:id/trend`, `GET /api/branches/:id`, `kpis.trend`, and `/api/audit` preserve archived branch history).
- `GET /api/locations/:id/summary` — Location-scoped KPIs, needs/gives/markdowns, cover bands, and category×status heatmap (`admin`/`manager` in scope).
- `GET /api/locations/:id/inventory` — Paginated, filtered inventory for a scoped location with projected stock, cover, `reserved`, and `inTransit` (`admin`/`manager` in scope).
- `GET /api/locations/:id/trend` — Sales vs. on-hand time series (`sku` or `category`, `range=7|30|90`, `admin`/`manager` in scope).

## Product Catalog (`/api/catalog/*`)
- `GET /api/catalog/products` — Paginated product listing (`search`, `category`, `status`; includes caller branch position `stats` with `onHand`, `inTransit`, `reserved`, `velocity`, `coverDays`, `status` plus non-financial `branchSummary` metadata/status counts when branch-scoped). Authenticated (`admin`, `manager`, `staff`).
- `GET /api/catalog/products/:sku` — Product record, change history, and `canDeletePermanently` indicator.
- `POST /api/catalog/products` — Admin-only (`products:manage`). Auto-generates `SKU-XXXXX`, validates `price > cost > 0`, integer `leadTimeDays` 1..21, category-level name uniqueness; starts as `awaiting_history`.
- `PATCH /api/catalog/products/:sku` — Admin-only. Edits attributes; recomputes analysis when math fields (`price`, `cost`, `leadTimeDays`) change on active products.
- `PATCH /api/catalog/products/:sku/archive` — Admin-only. Sets `archived`, purges pending recommendations, returns removed count.
- `PATCH /api/catalog/products/:sku/restore` — Admin-only. Restores to `active` or `awaiting_history` and recomputes.
- `DELETE /api/catalog/products/:sku` — Admin-only. Deletes only if zero sales/decisions (`409` otherwise).
- `POST /api/catalog/products/:sku/sample-history` — Admin-only. Generates 30-day sample history across 15 branches, moves to `active`, recomputes.

## Sales Entries (`/api/sales-entries/*`)
- `GET /api/sales-entries` — Paginated sales history filtered by scoped `branchId`, `sku`, and date range (`sales:enter`).
- `GET /api/sales-entries/template.csv` — Downloads CSV template for bulk daily entry uploads.
- `POST /api/sales-entries` — Validates `branchId`, `sku`, `date` (`YYYY-MM-DD`), `unitsSold >= 0`, `onHand >= 0`; upserts on `(branchId, sku, date)`, triggers single-SKU recompute and `dataVersion` bump, returns `201` (`sales:enter`).
- `PATCH /api/sales-entries/:id` / `DELETE /api/sales-entries/:id` — Updates or removes an existing entry in scope and triggers recomputation (`sales:enter`).
- `POST /api/sales-entries/import` — Multipart CSV upload (`file`, max 5MB, header `branchId,sku,date,unitsSold,onHand`); row-level validation, upserts valid rows, recomputes distinct updated SKUs once, returns `{ inserted, updated, errors }` (`sales:enter`).

## Users (`/api/users/*`)
- `GET /api/users`, `POST /api/users`, `PATCH /api/users/:id`, `POST /api/users/:id/reset-password`, `DELETE /api/users/:id` — Admin-only (`users:manage`) with strict hierarchy enforcement (`DELETE` deactivates the account and revokes active refresh tokens).

## Stock Alerts (`/api/stock-alerts/*`)
- `GET /api/stock-alerts` — Scoped list of store stock alerts (`stock:flag` or `stock:flag:decide`; staff sees own branch, manager sees assigned cluster, admin sees network). Supports optional `?branchId=` filter (`403 Forbidden` when out of caller's branch scope).
- `POST /api/stock-alerts` — Staff-only create (`stock:flag`, `branchId` must be in caller scope, `{ branchId, sku, category?, note }` with `category: "CRITICAL_LOW" | "DAMAGED_SHRINKAGE" | "COUNT_MISMATCH" | "OTHER"` defaulting to `"CRITICAL_LOW"`), returns `201`.
- `PATCH /api/stock-alerts/:id/approve` / `reject` — Scoped `manager`/`admin` decision (`stock:flag:decide`, `isBranchInScope`), immutable once decided (`409` on repeat decision).

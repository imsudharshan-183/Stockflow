# StockFlow API Reference (`apps/api`)

All endpoints are mounted under `/api`. Send the access token in the `Authorization: Bearer <token>` header. With sign-in disabled, ordinary demo routes use a synthetic admin identity. The AI routes and network sales simulation require sign-in to be enabled.

## Health & Auth (`/api/health`, `/api/auth/*`)
- `GET /api/health` — Public liveness and configuration check. Returns `status`, `repository`, `startupError`, and `missingEnv` without loading the dataset. The optional `allowSyntheticData: true` capability appears when both sign-in and sales simulation are enabled.
- `GET /api/health/db` — Public MongoDB ping check (cached for 30s) returning `200 { db: "ok", missingEnv }` or `503 { db: "error", name, message, missingEnv }` with secrets redacted.
- `POST /api/auth/login` — Accepts email and password, returns `{ user, token }`, and sets the `HttpOnly` refresh cookie. Limited to five attempts per minute.
- `POST /api/auth/refresh` — Rotates refresh token; rejects deactivated users and reused tokens.
- `POST /api/auth/logout` — Revokes refresh token and clears auth cookies.
- `GET /api/auth/me` — Returns `{ user }` with the current role and branch assignments.

## Stock & Morning Plan (`/api/*`)
- `POST /api/ai/chat` — Signed-in, rate-limited, read-only StockFlow assistant. Accepts `{ question, branchId?, previous? }`. The server derives role and allowed branches from the authenticated session, then routes to fixed catalog, daily sales, inventory, forecast, delivery, transfer, overview, or glossary lookups. Admin queries can span the network; managers are restricted to assigned branches; staff receive permitted operational data for their stores. Never accepts database queries or write actions.
- `POST /api/ai/brief` — Creates a concise explanation from role-scoped overview or transfer records. A configured provider receives the role, date and scoped metric IDs and values, and can select a metric to highlight. The API supplies the explanation and figures.
- `GET /api/kpis` — Network (admin) or branch-scoped (manager) KPI rollup.
- `GET /api/recommendations` — Filterable morning recommendations scoped to the caller’s branches. Staff receive operational fields such as SKU, branch, quantity, and status.
- `GET /api/kpis/live` — Current overview and reporting freshness for admins and managers. Use `?branch=` to select a branch within scope.
- `POST /api/recommendations/:id/reopen` — Reopens an eligible decision within the lifecycle window.
- `POST /api/recommendations/:id/approve` — Approves recommendation, records audit entry (`admin`/`manager` in scope), and overlays live `committedDeltas` (`reserved`/`inTransit`) without bumping `dataVersion`; returns `409 Conflict` (`DecisionConflictError`) if donor surplus is already committed.
- `POST /api/recommendations/:id/reject` — Rejects recommendation with reason code, records audit entry.
- `POST /api/recommendations/batch/decide` — Batch-decides `{ ids: string[] (1..200), decision: "approve" | "reject", reasonCode? }` (`admin`/`manager`). Evaluates RBAC/scope per ID, persists with one bulk action write and one bulk audit write (without bumping `dataVersion`), and returns `{ results: [{ id, status: "ok" | "forbidden" | "not_found" | "already_decided" }] }`.
- `GET /api/branches/:id` — Branch detail DTO with projected `onHand`, `coverDays`, `reserved`, and `inTransit` (`admin`/`manager` in scope via `dashboard:financial:scoped`; `403` for `staff`).
- `GET /api/products/:sku` — Product detail DTO across scoped branches with projected `onHand`, `coverDays`, `reserved`, and `inTransit`.
- `GET /api/audit` — Decision audit log, newest first, scoped to caller's branches (`admin`/`manager`).

## Replenishment orders

| Endpoint | Use |
| --- | --- |
| `GET /api/orders`, `GET /api/orders/:id` | List or inspect orders in scope. Staff receive the operational view. |
| `GET /api/orders/donor-candidates` | Rank candidate sending branches for a SKU, target branch, and quantity. |
| `POST /api/orders` | Create a scoped replenishment request. |
| `POST /api/orders/:id/request`, `POST /api/orders/:id/reroute` | Send a transfer to a donor for review or choose a different donor. |
| `POST /api/orders/:id/commit`, `POST /api/orders/:id/decline` | Record the authorized decision. A transfer commitment reserves the donor quantity and adds it to the receiver’s incoming stock. |
| `POST /api/orders/:id/cancel`, `POST /api/orders/:id/reopen` | Cancel or reopen an eligible order. |
| `POST /api/orders/:id/receive` | Confirm a committed delivery at the receiving branch and clear its incoming quantity. |

Management actions require `recommendations:decide`. Receipt uses `orders:receive`, which also allows staff at the receiving store. The service checks the current order state and which branch the caller represents. [Order transition rules](../packages/core/src/orders.ts)

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
- `GET /api/catalog/products/:sku` — Admin and manager views include product history. Staff receive store-facing product fields for non-archived SKUs.
- `POST /api/catalog/products` — Admin-only (`products:manage`). Auto-generates `SKU-XXXXX`, validates `price > cost > 0`, integer `leadTimeDays` 1..21, category-level name uniqueness; starts as `awaiting_history`.
- `PATCH /api/catalog/products/:sku` — Admin-only. Edits attributes; recomputes analysis when math fields (`price`, `cost`, `leadTimeDays`) change on active products.
- `PATCH /api/catalog/products/:sku/archive` — Admin-only. Sets `archived`, purges pending recommendations, returns removed count.
- `PATCH /api/catalog/products/:sku/restore` — Admin-only. Restores to `active` or `awaiting_history` and recomputes.
- `DELETE /api/catalog/products/:sku` — Admin-only. Deletes only if zero sales/decisions (`409` otherwise).
- `POST /api/catalog/products/:sku/sample-history` — Admin tool to fill up to 30 existing history dates for one SKU across the dataset branches and activate it.

### Simulate the next sales day

Send `POST /api/catalog/simulate-next-day` with an admin bearer token, an empty body, and no query parameters. It uses the same `products:manage` permission as sample history. Set `ALLOW_SYNTHETIC_DATA=true` and `AUTH_ENABLED=true` on the API.

For the unmodified seed, the first response is `{"targetDate":"2026-11-12","branches":15,"rows":7500}`. The date comes from the dataset. The limit resets at midnight in Bahrain. Archived branches and products are skipped. During recovery, `rows` counts only newly inserted entries.

| Status | Meaning |
| --- | --- |
| `400` | The request supplied a body or parameters. |
| `401` / `403` | Sign-in is required, the caller lacks permission, or the feature is disabled. |
| `409` | The dataset lacks a starting date or eligible inventory, or sales already exist for the proposed fresh run. |
| `429` | A run is in progress, the day has been claimed, or the daily limit was reached. |

## Sales Entries (`/api/sales-entries/*`)
- `GET /api/sales-entries` — Paginated sales history filtered by scoped `branch`, `sku`, `from`, and `to` (`sales:enter`).
- `GET /api/sales-entries/template.csv` — Downloads CSV template for bulk daily entry uploads.
- `POST /api/sales-entries` — Validates `branchId`, `sku`, `date` (`YYYY-MM-DD`), `unitsSold >= 0`, `onHand >= 0`; upserts on `(branchId, sku, date)`, triggers single-SKU recompute and `dataVersion` bump, returns `201` (`sales:enter`).
- `PATCH /api/sales-entries/:id` / `DELETE /api/sales-entries/:id` — Updates or removes an existing entry in scope and triggers recomputation (`sales:enter`).
- `POST /api/sales-entries/import` — Upload a multipart CSV in the `file` field with header `branchId,sku,date,unitsSold,onHand`. Use `?preview=1` for counts and row errors before writing. Submission upserts valid, in-scope rows and returns `{ inserted, updated, errors }`. MongoDB can return `202` with `planRefreshPending: true` when the import saved and the plan refresh is pending.
- `GET /api/sales/imports` — Recent import logs. Admins see all runs, including completed synthetic sales batches. Managers and staff see their own uploads.

## Users (`/api/users/*`)
- `GET /api/users`, `POST /api/users`, `PATCH /api/users/:id`, `POST /api/users/:id/reset-password`, `DELETE /api/users/:id` — Admin-only (`users:manage`) with strict hierarchy enforcement (`DELETE` deactivates the account and revokes active refresh tokens).

## Stock Alerts (`/api/stock-alerts/*`)
- `POST /api/stock-alerts/:id/resolve` — Admins and in-scope managers record a structured resolution, which can include an inventory adjustment or a linked replenishment request.
- `GET /api/stock-alerts` — Scoped list of store stock alerts (`stock:flag` or `stock:flag:decide`; staff sees own branch, manager sees assigned cluster, admin sees network). Supports optional `?branchId=` filter (`403 Forbidden` when out of caller's branch scope).
- `POST /api/stock-alerts` — Staff-only create (`stock:flag`, `branchId` must be in caller scope, `{ branchId, sku, category?, note }` with `category: "CRITICAL_LOW" | "DAMAGED_SHRINKAGE" | "COUNT_MISMATCH" | "OTHER"` defaulting to `"CRITICAL_LOW"`), returns `201`.
- `PATCH /api/stock-alerts/:id/approve` / `reject` — Scoped `manager`/`admin` decision (`stock:flag:decide`, `isBranchInScope`), immutable once decided (`409` on repeat decision).

# Decisions

The algorithm notes, modeling assumptions, and operational security summary live here. For the numbered Architecture Decision Records (`ADR-001`+), see [docs/ADR.md](ADR.md); for setup and the folder map, see [README.md](../README.md).

## Problem framing

A buyer opens StockFlow once a morning and needs a ranked list, not a dashboard of ratios. Each row is a transfer, a reorder, or a markdown, with a net BHD benefit (`BD`) and a sentence that names the cover, the reorder point, the freight breakdown (for transfers), and the money. The network is 15 branches across Bahrain and about 500 SKUs. History is 120 synthetic days. The buyer has to be able to argue with the number.

## Algorithm

1. **Velocity.** An exponentially weighted average of daily sales. The span is 28 days, so the weight on the latest in-stock day is `2 / 29`. Days with nothing available to sell are left out of the average and out of sigma. A stockout is not evidence that demand disappeared.
2. **Safety stock.** `z * sigma * sqrt(lead time)` with `z = 1.65`. The reorder point is `velocity * lead time + safety stock`.
3. **Classification.** Cover is on hand divided by velocity. Above 60 days is overstock. Below the reorder point is at risk. Overstock wins if both could apply. No in-stock history means the SKU is new and gets no action. Zero velocity with stock on hand is unlimited cover, not a division by zero.
4. **Matching.** For each SKU, donors can give units above 30 days of cover plus safety stock. Receivers need units to reach 14 days of cover. The greedy pass takes the pair with the highest net benefit, moves the stock, and repeats. Ties break toward the lower branch index so the order does not flicker.
5. **Net benefit.** `lost margin avoided + carrying cost saved - transfer cost`. Lost margin is the margin on units that would be missed over the lead time, capped by the quantity moved. Carrying cost uses a 20% annual rate and the donor's excess cover, capped at a year. Transfer freight uses `TotalTransferCost(Q, D) = BD 1.500 + (BD 0.150 × D_km) + (BD 0.250 × Q)` via Haversine distance across Bahrain's 2–45 km network. If one more unit saves less holding cost than the marginal `BD 0.250` per-unit handling fee, the quantity stops at the lost-sales units. Transfers under 5 units, or with a net benefit of 0 or less, are skipped.
6. **Fallbacks.** A receiver that is still short is a reorder up to the greater of the 14-day target and the reorder point. If the SKU has overstock and nobody is short, the surplus is a markdown at 30% off. The benefit compares clearing now with the full-price margin that would have been earned over the hold window, plus the holding cost avoided.
7. **Ranking.** Sort by net benefit, then SKU, branch, and action. The BD 9.500 materiality screen is applied in the API service, after this ranking, so the engine's golden quantities stay put.

## Why this, not ML or linear programming

A learned demand model and a network LP would both need more history than 120 days, and neither would show its work in one sentence. This version is explainable, deterministic, and covered by a worked example (60 units from branch B to branch A). Pairing inside one SKU is a small loop. Across SKUs the work is independent, so the shape is closer to O(n log n) ranking of the resulting actions than to a single giant program. A solver can replace `greedyMatcher` later without rewriting classification. A forecaster can replace `ewmaForecaster` the same way.

## Assumptions

- Lead time belongs to the product, from 1 to 21 days, not to the lane between branches.
- Service level `z = 1.65`.
- Annual holding cost is 20% of unit cost.
- Markdowns take 30% off the shelf price.
- Transfer freight is `BD 1.500` fixed + `BD 0.150/km` Haversine distance + `BD 0.250/unit` handling (`TotalTransferCost(Q, D)`). There is no truck capacity cap, no case pack, and no expiry date.
- Transfers are available the same morning. Reorders arrive after the lead time.
- Branches do not compete for the same inbound truck.
- Demand during the lead time is treated as roughly normal and independent across branches.
- Prices are tiered in native BHD (`0.500–4.000` Low, `2.000–15.000` Mid, `15.000–120.000` High) using non-round market decimals. Unit cost is 55% to 75% of price.
- The backtest still delivers the receipts implied by history, then adds StockFlow's moves on top. It does not cancel purchase orders the old process already sent.
- **Seed dataset stocking profile (`packages/core/src/seed/generate.ts`)**: Healthy branch-SKU replenishment targets are calibrated above an analytical EWMA reorder bound (`expectedRop = mean * leadTimeDays + 2.1 * sqrt(max(0.05, mean) * leadTimeDays)`, accounting for each SKU's staggered `7–21` day cycle depletion while capping below the `60`-day overstock band), with deterministic under-stocking across three realistic store tiers:
  - **Before tuning** (uniform `mean * 20` refill across `7–21` day cycles): `41.88%` network `AT_RISK` (`3,141 / 7,500`), `4.56%` `OVERSTOCK` (`342`), `1.61%` dead stock (`121`); per-branch `AT_RISK` ranged from `36.6%` (`BR-010`) to `48.4%` (`BR-005`).
  - **After tuning**: `12.29%` network `AT_RISK` (`922 / 7,500`, inside `8%–15%`), `7.61%` `OVERSTOCK` (`571`), `1.71%` dead stock (`128`); three hotspot branches in `20%–30%` (`BR-004: 26.0%`, `BR-005: 26.0%`, `BR-009: 25.8%`), three low-risk branches in `2%–5%` (`BR-003: 4.2%`, `BR-010: 3.2%`, `BR-015: 3.8%`), and remaining 9 branches in `9.4%–11.8%` (`BR-001: 11.4%`, `BR-002: 11.8%`, `BR-006: 10.8%`, `BR-007: 10.8%`, `BR-008: 11.0%`, `BR-011: 9.6%`, `BR-012: 10.6%`, `BR-013: 9.4%`, `BR-014: 10.0%`).
- **Dead stock excess subset**: `deadStockValue` is summed on `position.surplus * product.cost` strictly for `OVERSTOCK` positions with `velocity < DEAD_VELOCITY_PER_DAY` (`< 0.05/day`), guaranteeing `deadStockValue <= cashReleasable` across network, cluster, and branch views.
- **Forward stock projection (`ProductPage`, UI-only read-model derivation)**: For horizon `H = max(21, 2 * leadTimeDays)` days (`t = 0 .. H`), baseline stock follows `S_base(t) = max(0, (onHand - reserved) - velocity * t)`, with projected stockout day `t_stockout = ceil((onHand - reserved) / velocity)` when within `H`. Planned stock follows `S_plan(t) = max(0, (onHand - reserved) + I(t >= 1) * inTransit + I(t >= t_arrival) * Q_rec - v_plan * t)` where `t_arrival = leadTimeDays` (`REORDER`), `min(2, H)` (`TRANSFER`), or `0` (`MARKDOWN`, accelerating clearance velocity by `1.5x`), bounded visually by the horizontal `reorderPoint` threshold and `[D+0, D+leadTimeDays]` shaded lead-time window.

## Known limitations

- Normal demand is a poor fit for intermittent SKUs. A zero-inflated or Croston estimate would change who looks "dead."
- Branches are independent except for the explicit transfer. A promotion in one city does not move the prior of another.
- Transfer cost uses pairwise Haversine distance (`km`) plus fixed dispatch and per-unit handling, though it does not model truck capacity limits or multi-stop milk runs.
- Greedy matching is not a proven optimum. A later pair can be better once an earlier pair is fixed, and we do not search that.
- The morning plan's base recommendations and EWMA demand are computed once per `dataVersion` (`this.analysis` is immutable). Approving a transfer, reorder, or markdown overlays live `committedDeltas` (`reserved` donor stock / `inTransit` inbound stock via pure `project()`) across API reads, blocks donor over-allocation with `409 Conflict`, and replays post-plan `audit` decisions at startup—without bumping `dataVersion` or altering the next sales-driven forecast.
- Actions under BD 9.500 or under the minimum transfer quantity are hidden by the service. They are still produced by the engine.

## Scaling path

At about 100 times the SKU count the per-SKU loop is still the unit of work.

- Run one worker per SKU, or per SKU shard. Classification and matching do not talk across SKUs.
- Recompute a SKU when its sales or a decision for that SKU change, not the whole network on every request.
- Keep daily rollups for the charts. The engine can keep reading the compact series.
- Swap the forecaster for Holt-Winters, Croston, or a model that has enough history. `Forecaster.estimateDemand` is the seam.
- Swap the matcher for min-cost flow or a mixed-integer program when branch count makes the pair loop too coarse. `Matcher.match` is the seam.
- Store facts in a MongoDB time-series collection with a compound shard key of branch, SKU, and date. The unique index is already `(branchId, sku, date)`.
- Move the engine to its own worker when the API process should only serve the last result.

## Security and access decisions

- **Server-side RBAC & role hierarchy**: UI hiding is cosmetic only; all routes enforce `authenticate` and `requirePermission` in `apps/api/src/plugins/auth.ts`. `canManageRole` enforces strict hierarchy (`admin > manager > staff`), preventing self-deactivation, own-role edits, and role escalation. `sales:enter` and `stock:flag:decide` are granted to `admin` and `manager` (assigned branches only) and denied to `staff` (`403`), while `stock:flag` is create-only for `staff` on their assigned branch, with conditional atomic `PENDING` updates ensuring decided `stock_alerts` are immutable (`409 Conflict` on repeat decision).
- **Post-plan branch scoping**: The cached morning plan is built once per `dataVersion` and persisted in `plan_cache`. Branch scoping (`scopeBranches`, `isBranchInScope`) is applied at query/projection time so cached admin state never leaks across manager/staff requests. Transfers are visible if either donor or receiver branch is in scope; reorders and markdowns are scoped by target branch. Out-of-scope `/api/locations/:id/*` requests return `404`.
- **Plan persistence & versioning (`data_version` + `plan_cache`)**: Every analysis-affecting write (sales entry CRUD, CSV import once per request, catalog update/archive/restore/sample-history) increments `data_version` (`_id: "current"`) and upserts the gzipped plan (`planCompressed`, keeping documents well under MongoDB's 16 MiB limit) into `plan_cache` keyed by `dataVersion`. Decisions (`approve`/`reject`) change recommendation status only, not stock or demand, so they are applied as an overlay from the shared `actions`/`audit` stores and **must not** bump `dataVersion`, recompute the plan, or rewrite `plan_cache`. On every plan read, `StockService.ensureFreshPlan()` checks `data_version` and (when needed) `listActions()` in parallel (`<= 3` DB ops on warm reads): if `data_version` matches the in-process `planVersion`, it serves memory with the fresh decision overlay; if `plan_cache` matches, it hydrates without calling `analyze()`; otherwise a single-flight refresh recomputes, persists (falling back to compute-and-serve if persistence fails), and updates memory.
- **Decision uniqueness & atomicity**: `actions.recommendationId` has a unique index in MongoDB (and equivalent enforcement in `InMemoryRepository`). `saveDecisionBatch` uses `ActionModel.insertMany(..., { ordered: false })` and `AuditModel.insertMany(...)` inside a MongoDB replica-set transaction (`session.withTransaction`), treating `E11000` duplicate-key errors as `"already_decided"` and retrying the transaction with only the non-duplicate subset so an action never exists without its audit entry and losing IDs never produce audit rows. If transactions are unavailable (standalone `mongod`), `saveDecisionBatch` falls back to writing audit entries first, then actions, and deleting audit rows for any `E11000` losers (failure mode: a process crash between the two writes on a standalone node can leave an audit entry without an action, but never an orphan action). `POST /api/recommendations/batch/decide` with `decision: "reject"` requires a non-empty `reasonCode` (`400` otherwise); `approve` ignores `reasonCode`.
- **Sessions, cookies, and refresh-token families**: Access tokens are short-lived JWTs; refresh tokens live in an `HttpOnly`, `SameSite=Lax` cookie (`stockflow_refresh`, `Path=/api/auth`, `Secure` in `NODE_ENV=production`) and rotate on every `/api/auth/refresh`. Tokens belong to a `familyId` (`revokedAt` tracks rotated tokens; pre-migration tokens default `familyId = token`). Replaying a rotated token revokes every active token in that family, records a `REFRESH_TOKEN_REUSE` security audit event, and returns `401`, leaving other families and other users unaffected. `logout` revokes only the current family. `/api/auth/login` is rate-limited to 5 attempts per minute (`429`).
- **Platform hardening**: `@fastify/helmet` sets security headers, Fastify enforces a `1 MiB` JSON `bodyLimit` (`413`), production `500` responses hide stack traces, `redactSecrets` strips credentials from error logs, and production CORS emits headers only when `WEB_ORIGIN` is explicitly configured.

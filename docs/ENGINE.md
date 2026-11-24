# StockFlow Mathematical Engine (`@stockflow/core`)

This guide is written for code reviewers reading StockFlow's inventory planning engine. Every calculation in `@stockflow/core` is pure TypeScript: no I/O, no wall-clock `Date.now()`, and no randomness outside explicit deterministic seed generation.

For architectural trade-offs and security/ops decisions, see [docs/DECISIONS.md](DECISIONS.md) and [docs/ADR.md](ADR.md).

---

## 1. End-to-End Pipeline

```
Dataset (500 SKUs x 15 Bahrain branches x 120 daily buckets)
   │
   ▼
[1] Demand Estimation (velocity.ts + safetyStock.ts)
   │   - Keep only in-stock days: endOnHand + salesUnits > 0
   │   - 28-day EWMA velocity (alpha = 2 / 29), unbiased sample sigma
   │   - safetyStock = 1.65 * sigma * sqrt(leadTimeDays)
   │   - reorderPoint = velocity * leadTimeDays + safetyStock
   ▼
[2] Position Classification (classify.ts)
   │   - Precedence: NEW -> OVERSTOCK -> AT_RISK -> HEALTHY
   │   - Donor floor = 30 * v + safetyStock (surplus = floor(onHand - floor))
   │   - Receiver transfer target = 14 * v (need = ceil(target - onHand))
   │   - Lead-time shortage at risk: lostUnits = max(0, v * leadTimeDays - onHand)
   ▼
[3] Per-SKU Matching & Fallbacks (match.ts + recommend.ts)
   │   - Greedy highest-net-benefit pairs (donor -> receiver) using Haversine km
   │   - Freight = BD 1.500 + (BD 0.150 * D_km) + (BD 0.250 * Q), min qty 5
   │   - Residual AT_RISK -> REORDER up to max(14 * v, reorderPoint)
   │   - OVERSTOCK with zero receivers -> MARKDOWN at 30% discount
   ▼
[4] Ranking & Backtest (recommend.ts + backtest.ts)
   │   - Deterministic sort: netBenefit desc -> skuIndex asc -> branchIndex asc -> action asc
   │   - 45-day counterfactual replay on identical recommend() pipeline
   ▼
[5] Report DTOs & Service Materiality (packages/core/src/report/* + apps/api/src/services/scope.ts)
       - Service suppresses netBenefit < BD 9.500 or qty < 5 AFTER core ranking
       - Live CommittedDelta overlays (projection.ts + donorRanking.ts + quantityBenefit.ts)
```

---

## 2. Recommended Reading Order & File Map

Read files in this order to trace a morning plan from raw sales series to API response:

| Order | File | Responsibility |
|---:|---|---|
| 1 | `packages/core/src/engine/config.ts` | Tunable policy defaults (`DEFAULT_POLICY`), `ewmaAlpha`, and `TotalTransferCost(Q, D)` |
| 2 | `packages/core/src/engine/strategies.ts` | Swappable `Forecaster` and `Matcher` strategy interfaces (extension seams) |
| 3 | `packages/core/src/engine/velocity.ts` | In-stock filter (`wasInStock`), `ewma`, `sampleStdev`, `ewmaForecaster` |
| 4 | `packages/core/src/engine/safetyStock.ts` | `safetyStockUnits` and `reorderPointUnits` |
| 5 | `packages/core/src/engine/classify.ts` | `coverDaysOf`, `holdingWindowDays`, `classifyPosition`, `assessNetwork` |
| 6 | `packages/core/src/seed/catalog.ts` | `BAHRAIN_BRANCHES` coordinates and `haversineDistanceKm` |
| 7 | `packages/core/src/engine/match.ts` | `greedyMatcher`, pair quoting, freight-limited marginal cap, tie-breaks |
| 8 | `packages/core/src/engine/recommend.ts` | Per-SKU coordination, `REORDER` / `MARKDOWN` fallbacks, deterministic action ranking |
| 9 | `packages/core/src/engine/backtest.ts` | 45-day counterfactual simulation avoiding recorded stockouts |
| 10 | `packages/core/src/engine/projection.ts` | Post-plan `projectPosition` overlay for `reserved`, `inTransit`, and physical adjustments |
| 11 | `packages/core/src/engine/donorRanking.ts` | Live `rankDonorCandidates` for manual requests, alerts, and reroutes |
| 12 | `packages/core/src/engine/quantityBenefit.ts` | Live `computeActionBenefitForQuantity` for manager-edited approval quantities |
| 13 | `packages/core/src/report/{recommendations,kpis,reason,detail,numbers}.ts` | Human-readable explanations, KPI/category/dead-stock rollups, DTO rounding |
| 14 | `apps/api/src/services/scope.ts` | Post-plan service materiality gate (`BD 9.500`, `5` units) and branch scope filters |

---

## 3. Formulas & Units

Monetary outputs are denominated in **Bahraini Dinars (`BD`)** rounded to `3` decimal places (**fils**, `round3`), cover/lead windows in **days**, rates in **units/day**, distances in **kilometers (`km`, `round2`)**, and inventory quantities in **whole units**.

### 3.1 Forecasting & Buffers (`velocity.ts`, `safetyStock.ts`)
- **In-stock observation mask**: day $t$ enters the demand sample iff `endOnHand[t] + sales[t] > 0`.
- **EWMA smoothing weight**:
  $$\alpha = \frac{2}{\text{ewmaSpanDays} + 1} = \frac{2}{29} \approx 0.068966$$
- **Expected daily demand (`velocity`, units/day)**:
  $$\hat{v}_0 = s_0, \qquad \hat{v}_i = \alpha s_i + (1 - \alpha)\hat{v}_{i-1}$$
- **Dispersion (`sigma`, units/day)**: unbiased sample standard deviation ($n - 1$ denominator) when $n \ge 2$, else $0$.
- **Safety stock & reorder point (units)**:
  $$\text{safetyStock} = z \cdot \sigma \cdot \sqrt{L}, \qquad \text{reorderPoint} = \hat{v} \cdot L + \text{safetyStock} \qquad (z = 1.65)$$

### 3.2 Classification, Floor & Need (`classify.ts`)
- **Cover days (days)**: `onHand / velocity` if `velocity > 0`; `null` (unlimited cover) if `velocity <= 0` and `onHand > 0`; `0` if both are `0`.
- **Status precedence**:
  1. `inStockDays === 0` $\implies$ `NEW`
  2. `coverDays === null && onHand > 0` or `coverDays > 60` $\implies$ `OVERSTOCK`
  3. `onHand < reorderPoint` $\implies$ `AT_RISK`
  4. Otherwise $\implies$ `HEALTHY`
- **Donor floor & surplus (units)**:
  $$\text{floor} = 30 \cdot \hat{v} + \text{safetyStock}, \qquad \text{surplus} = \max(0, \lfloor \text{onHand} - \text{floor} \rfloor) \quad (\text{OVERSTOCK only})$$
- **Receiver target & lead-time risk (units)**:
  $$\text{need} = \max(0, \lceil 14 \cdot \hat{v} - \text{onHand} \rceil), \qquad \text{lostUnits} = \max(0, \hat{v} \cdot L - \text{onHand}) \quad (\text{AT\_RISK only})$$

### 3.3 Transfer Freight & Economics (`config.ts`, `match.ts`, `catalog.ts`)
- **Pairwise route distance (`km`)**: spherical Haversine distance (`R = 6371 km`) rounded to 2 decimals (`0 km` fallback if coordinates are missing).
- **Transfer freight (`BD`)**:
  $$\text{TotalTransferCost}(Q, D) = 1.500 + 0.150 \cdot D_{\text{km}} + 0.250 \cdot Q$$
- **Excess holding window (days)**:
  $$h = \begin{cases} 365 & \text{coverDays} = \text{null or } \hat{v}_{\text{donor}} \le 0 \\ \min(365, \max(0, \text{coverDays}_{\text{donor}} - 30)) & \text{otherwise} \end{cases}$$
- **Carrying cost saved per unit (`BD/unit`)**:
  $$c_{\text{carry}} = \text{unitCost} \cdot 0.20 \cdot \frac{h}{365}$$
- **Marginal quantity cap (units)**: if $c_{\text{carry}} \le 0.250$, transfers beyond `lostUnits` lose money on handling, so $Q = \min(Q_{\max}, \lfloor \text{lostUnits} \rfloor)$; otherwise $Q = Q_{\max} = \min(\text{donor.surplus}, \text{receiver.need})$. Pairs with $Q < 5$ or $\text{netBenefit} \le 0$ are skipped.
- **Transfer net benefit (`BD`)**:
  $$\text{lostMarginAvoided} = \text{round3}(\min(Q, \text{lostUnits}) \cdot (\text{price} - \text{unitCost}))$$
  $$\text{carryingCostSaved} = \text{round3}(Q \cdot c_{\text{carry}})$$
  $$\text{netBenefit} = \text{round3}(\text{lostMarginAvoided} + \text{carryingCostSaved} - \text{TotalTransferCost}(Q, D))$$

### 3.4 Fallbacks & Sorting (`recommend.ts`)
- **Reorder (`REORDER`)** for unmet `AT_RISK` receivers:
  $$Q = \lceil \max(14 \cdot \hat{v}, \text{reorderPoint}) - \text{onHand} \rceil, \qquad \text{netBenefit} = \text{round3}(\min(Q, \text{lostUnits}) \cdot (\text{price} - \text{unitCost}))$$
- **Markdown (`MARKDOWN`)** when a SKU has zero `AT_RISK` receivers across the network:
  $$P_{\text{sale}} = 0.70 \cdot \text{price}, \qquad \Delta_{\text{wait}} = Q(P_{\text{sale}} - \text{unitCost}) - \min(Q, \hat{v} \cdot h)(\text{price} - \text{unitCost})$$
  $$\text{netBenefit} = \text{round3}(\max(0, \Delta_{\text{wait}}) + Q \cdot c_{\text{carry}} - \max(0, -\Delta_{\text{wait}}))$$
- **Action sort key**: `netBenefit` descending, then `skuIndex` ascending, `branchIndex` ascending, `action` lexicographical ascending.

---

## 4. Worked Example (Computed from Live Engine)

### 4.1 Two-Branch Bahrain Transfer Example
Executing `assessPositions`, `planActions`, `buildRecommendations`, and `computeActionBenefitForQuantity` on `SKU-00012` (`price = BD 20.000`, `unitCost = BD 10.000`, `leadTimeDays = 7`) between `BR-005` Muharraq - Hidd (`[26.244, 50.655]`) and `BR-001` Manama - CBD (`[26.2285, 50.586]`):

1. **Haversine Distance**: `haversineDistanceKm([26.244, 50.655], [26.2285, 50.586])` rounds to **`7.09 km`**.
2. **Position Assessment (`assessPositions`)**:
   - **Receiver (`BR-001`, onHand `10`, sales `5/day`)**: `velocity = 5`, `sigma = 0`, `safetyStock = 0`, `reorderPoint = 35`, `coverDays = 2`, `status = "AT_RISK"`, `need = ceil(14*5 - 10) = 60`, `lostUnits = 5*7 - 10 = 25`.
   - **Donor (`BR-005`, onHand `300`, sales `2/day`)**: `velocity = 2`, `sigma = 0`, `reorderPoint = 14`, `coverDays = 150`, `status = "OVERSTOCK"`, donor floor `30*2 + 0 = 60`, `surplus = 240`.
3. **Transfer Quote (`Q = 60` units)**:
   - `lostMarginAvoided = min(60, 25) * (20 - 10)` = **`BD 250.000`**
   - `excessDays = min(365, 150 - 30) = 120 days` $\implies$ `carryingCostSaved = round3(60 * 10 * 0.20 * (120 / 365))` = **`BD 39.452`**
   - `transferCost = 1.500 + (0.150 * 7.09 -> 1.064) + (0.250 * 60 -> 15.000)` = **`BD 17.564`**
   - `netBenefit = round3(250.000 + 39.452 - 17.564)` = **`BD 271.888`**
   - Resulting ID: `2026-11-11_TRANSFER_SKU-00012_BR-001_BR-005`.
4. **Live Manager Quantity Edit (`Q = 25` via `computeActionBenefitForQuantity`)**:
   - `lostMarginAvoided` stays **`BD 250.000`** (`25 >= lostUnits = 25`), `carryingCostSaved` drops to **`BD 16.438`**, `freightCostBhd` drops to **`BD 8.814`**, yielding **`netBenefitBhd = BD 257.624`**.

### 4.2 Full Seeded Network Snapshot (`generateDataset()` as of `2026-11-11`)
Running `analyze(generateDataset(), DEFAULT_POLICY)` produces:
- **Draft counts**: `1,273` raw drafts (`265` `TRANSFER`, `883` `REORDER`, `125` `MARKDOWN`); `658` material actions surfaced after the service's `>= BD 9.500` and `>= 5` unit filter.
- **Rank #1 recommendation**: `2026-11-11_TRANSFER_SKU-00031_BR-009_BR-011` (`Crestwood Plush Stuffed Bear, 8 in`, `19` units from `Budaiya` to `Tubli`, `10.6 km`, `netBenefit = BD 475.819`: lost margin `BD 446.426` + carrying saved `BD 37.233` - freight `BD 7.840`).
- **Network KPIs & 45-day backtest**: `stockoutRate = 0.0543` (`5.4%`), `deadStockValue = BD 68,112.820`, `lostSalesAtRisk = BD 114,247.758`, `cashReleasable = BD 219,788.792`; `backtest` avoids `16,131` of `18,195` baseline stockout days (`engineStockoutDays = 2,064`) and releases `BD 226,318.658` in inventory cost.

---

## 5. Constants Table

| Constant | Value | Unit | Defined In | Rationale |
|---|---:|---|---|---|
| `EWMA_SPAN_DAYS` | `28` | days | `engine/config.ts` | Sets `alpha = 2 / 29`; smooths weekly swings without dragging stale months |
| `EWMA_SMOOTHING_NUMERATOR` | `2` | dimensionless | `engine/config.ts` | Standard EWMA numerator (`2 / (span + 1)`) |
| `SAMPLE_STDEV_MIN_POINTS` | `2` | days | `engine/config.ts` | Minimum in-stock points required for unbiased `(n - 1)` stdev |
| `SERVICE_Z` | `1.65` | dimensionless | `engine/config.ts` | ~95% one-sided normal service level for safety stock |
| `OVERSTOCK_COVER_DAYS` | `60` | days | `engine/config.ts` | Two-month cover boundary above which stock becomes transferable excess |
| `RECEIVER_COVER_DAYS` | `14` | days | `engine/config.ts` | Two-week replenishment target for `AT_RISK` stores |
| `DONOR_COVER_DAYS` | `30` | days | `engine/config.ts` | Protected post-transfer cover floor (`+ safetyStock`) at donor stores |
| `MIN_TRANSFER_QTY` | `5` | units | `engine/config.ts` | Prevents tiny transfers whose margin gets consumed by fixed dispatch cost |
| `MIN_ACTION_UNITS` | `1` | units | `engine/config.ts` | Unit floor for store `REORDER` and `MARKDOWN` fallbacks |
| `TRANSFER_FIXED_COST` | `1.5` | BD | `engine/config.ts` | Fixed dispatch paperwork/loading overhead per transfer (`BD 1.500`) |
| `TRANSFER_COST_PER_KM` | `0.15` | BD/km | `engine/config.ts` | Bahrain road-corridor transport weighting (`BD 0.150/km`) |
| `TRANSFER_COST_PER_UNIT` | `0.25` | BD/unit | `engine/config.ts` | Marginal picking/shelving handling cost (`BD 0.250/unit`) |
| `ANNUAL_HOLDING_RATE` | `0.2` | fraction/yr | `engine/config.ts` | 20% annual cost of capital, shrinkage, and shelf space |
| `MARKDOWN_DISCOUNT` | `0.3` | fraction | `engine/config.ts` | 30% clearance price cut |
| `DEAD_STOCK_HOLD_DAYS` | `365` | days | `engine/config.ts` | One-year cap on holding savings and markdown hold window |
| `DEAD_VELOCITY_PER_DAY` | `1 / 7` | units/day | `engine/config.ts` | Slow-mover ceiling (`< 1 unit/week`) defining dead stock in KPIs |
| `BACKTEST_DAYS` | `45` | days | `engine/config.ts` | Trailing counterfactual replay horizon |
| `STOCKOUT_RATE_DAYS` | `28` | days | `engine/config.ts` | Rolling window for headline `stockoutRate` |
| `MATERIAL_MIN_NET_BENEFIT` | `9.5` | BD | `engine/config.ts` | Service queue materiality gate (`apps/api/src/services/scope.ts`) |

---

## 6. Limitations & Extension Seams

- **Demand normality assumption**: safety stock scales linearly with $\sigma \sqrt{L}$, which over- or under-buffers intermittent low-volume SKUs better modeled by Croston or zero-inflated Poisson estimators.
- **Unconstrained physical transport**: no truck volume/weight limit, shelf case-pack rounding at generation time (managers adjust at approval via `ApproveQuantityDialog`), or product expiry date.
- **Greedy pair selection**: transfers match one SKU at a time in descending pair benefit; no cross-SKU multi-stop consolidation or global LP optimization.
- **Static intraday base plan**: `recommend()` recomputes only when sales/catalog/branch data versions advance; intraday approvals overlay through `committedDeltas` and `projectPosition()`.

### Swapping the Strategy Seams (`packages/core/src/engine/strategies.ts`)
- **`Forecaster`** (`estimateDemand(history, ctx)`): replace `ewmaForecaster` with Holt-Winters, Croston, or a learned time-series model without touching `classify.ts`, `recommend.ts`, or report schemas.
- **`Matcher`** (`match(receivers, donors, costs)`): replace `greedyMatcher` with min-cost flow or MILP branch matching when network branch count grows by 100x; `recommend()` retains `REORDER` and `MARKDOWN` fallback semantics independently.

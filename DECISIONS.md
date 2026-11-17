# StockFlow — Architecture Decision Records (ADRs)

This document records the numbered architectural decisions (`ADR-001`+), trade-offs, and invariants adopted across the StockFlow codebase. For the replenishment algorithm notes, assumptions, scaling path, and security summary, see [docs/DECISIONS.md](docs/DECISIONS.md).

## Index

| ADR | Decision | Summary |
|---|---|---|
| [ADR-001](#adr-001-pure-mathematical-core-engine-in-stockflowcore) | Pure Core Engine | Keep math deterministic, side-effect-free, and snapshot-locked in `@stockflow/core`. |
| [ADR-002](#adr-002-server-side-branch-scoping-post-plan-computation) | Post-Plan Branch Scoping | Compute the global morning plan once and scope donors/receivers per role in the API. |
| [ADR-003](#adr-003-authentication-session-continuity-and-dual-mode-tokens) | Session Continuity & Dual-Mode Tokens | Resolve Bearer tokens even when `AUTH_ENABLED=false`, persist sessionStorage across reloads, and isolate user caches. |
| [ADR-004](#adr-004-immutable-decision-audit-trail-with-dual-branch-attribution) | Immutable Audit & Dual Attribution | Append immutable decision audit entries visible to both receiving and donor branch managers. |
| [ADR-005](#adr-005-professional-category-specific-product-naming) | Category-Specific Product Naming | Enforce unique `<Brand> <Product>, <Variant>` catalog names under 60 characters without embedded SKUs. |
| [ADR-006](#adr-006-ui-primitives--automated-guardrail-verification) | UI Primitives & Lint Guardrails | Require shared `Button`/`Badge`/`Table` components and `@/lib/format` helpers via `check-ui.mjs`. |
| [ADR-007](#adr-007-product-catalog-lifecycle-change-history-and-safe-deletion) | Catalog Lifecycle & Safe Deletion | Track `awaiting_history`/`active`/`archived` SKU states with admin-only edits and safe deletion checks. |
| [ADR-008](#adr-008-product-catalog-management-ui-and-ingestion-workflows) | Catalog Management UI & Ingestion | Support admin SKU CRUD, audit history tabs, and bulk daily sales CSV import workflows. |
| [ADR-009](#adr-009-role-differentiated-dashboards-and-staff-product-view) | Role-Differentiated Dashboards & Staff View | Serve distinct `/` landing screens per role and route staff `/products` to read-only `StaffProductStats`. |
| [ADR-010](#adr-010-bahrain-geographic-localization-native-tiered-bhd-pricing-and-engine-threshold-scaling) | Bahrain Localization & BHD Scaling | Localize all 15 branches to verified Bahrain coordinates, tier prices in 3-decimal BHD, and scale engine cutoffs. |
| [ADR-011](#adr-011-distance-aware-inter-branch-transfer-cost-in-bahrain-totaltransfercostq-d) | Distance-Aware Transfer Freight | Price inter-branch transfers via `C_fixed + (C_km * D) + (C_unit * Q)` using Haversine km in BHD. |
| [ADR-012](#adr-012-critical-stock-escalations-stock_alerts-with-staff-flagging-and-immutable-manager-review) | Critical Stock Escalations (`stock_alerts`) | Split `stock:flag` (staff create) and `stock:flag:decide` (scoped manager/admin immutable approval). |
| [ADR-013](#adr-013-non-mutating-committeddeltas-approval-ledger-pure-project-and-409-over-allocation-conflict-guard) | Non-Mutating `committedDeltas` Ledger & `409` Guard | Project live `reserved`/`inTransit` overlays via pure `project()`, guard donor over-allocation (`409`), and replay on boot. |

---

## ADR-001: Pure Mathematical Core Engine in `@stockflow/core`

### Context
StockFlow's replenishment, transfer, and markdown calculations must be deterministic, auditable, and testable without database or network dependencies.

### Decision
- All statistical formulas (EWMA velocity, standard deviation, safety stock $z \cdot \sigma \cdot \sqrt{L}$, reorder point $d \cdot L + SS$, cover days) and optimization algorithms (greedy transfer matching, net benefit calculation, 45-day counterfactual backtesting) live in `packages/core/src/engine/`.
- **Invariant**: `packages/core/src/engine/` has zero external dependencies outside TypeScript math and Zod contracts. It is frozen and protected by byte-identical golden snapshot tests (`apps/api/src/__fixtures__/recommendations.json` and `kpis.json`).

---

## ADR-002: Server-Side Branch Scoping Post-Plan Computation

### Context
A multi-branch retail network has multiple user roles:
- `admin`: Full network visibility across all 15 branches.
- `manager`: Scoped to a cluster of branches (e.g. Manama: `BR-001` and `BR-002`).
- `staff`: Single branch, read-only.

If planning were executed per-branch, inter-branch transfers would fail to match donors in other regions with receivers in scope.

### Decision
- The morning optimization plan is computed globally network-wide once and cached in `StockService`.
- Branch scoping is strictly applied in the API service layer *after* plan generation:
  - Transfers are visible to a user if *either* the receiving branch OR the donor branch is in their assigned scope (`isTransferInScope`).
  - Reorders and markdowns are visible if the target branch is in scope.
  - KPI summaries, trends, and backtest results are aggregated over `userBranches` with scoped cache keys.

---

## ADR-003: Authentication, Session Continuity, and Dual-Mode Tokens

### Context
In local development, developers may run with `AUTH_ENABLED=false` to bypass login prompts, but test scenarios and multi-role evaluations require signing in as specific managers or staff. In browser sessions, hard page reloads (`F5`) wiped access tokens when stored only in memory.

### Decision
1. In `apps/api/src/plugins/auth.ts`: `authenticate` inspects `Authorization: Bearer <token>`. If a valid token is provided, the authenticated user (`currentUser`) is resolved from the database regardless of `AUTH_ENABLED`. Only if no token is provided and `AUTH_ENABLED=false` does it fall back to `SYNTHETIC_ADMIN`.
2. In `apps/web/src/lib/api.ts`: Tokens are stored in `window.sessionStorage`. On page reloads, the token is restored immediately; on logout, `sessionStorage` and React Query caches are wiped.
3. On user switch (`login`/`logout`), `queryClient.clear()` is called to prevent cross-account query cache leakage.

---

## ADR-004: Immutable Decision Audit Trail with Dual-Branch Attribution

### Context
Every recommendation approval or rejection must be traceable. Store managers need to see transfers touching their stores—even if they were the donor store providing inventory to another branch.

### Decision
- When decisions are made (`POST /api/recommendations/:id/approve` or `reject`), an immutable entry is created in MongoDB (`audits` collection) with `actedBy: { userId, name, role }`, `decision`, `netBenefit`, `reasonCodes`, `branchId`, and `donorBranchId`.
- `/api/audit` filtering includes entries where `userBranches` includes `branchId` OR `donorBranchId`, allowing donor branch managers full governance over outbound inventory movements.

---

## ADR-005: Professional Category-Specific Product Naming

### Context
Legacy seed generators combined arbitrary size strings (`750ml`, `1kg`) across all categories, producing nonsensical artifacts (e.g., `"Classic Building Blocks 750ml SKU-00499"`). Index modulo arithmetic also caused name collisions starting at SKU-120, embedding SKU codes inside product names.

### Decision
- Adopted the standard: **`<Brand/Line> <Product Type>, <Variant>`** ($\le 60$ characters).
- Designed a deterministic generator in `packages/core/src/seed/catalog.ts` with 12 retail categories, 8 items per category, 6 tailored variants, and 4 fictional brands (576 unique combinations, 0 collisions for 500 SKUs).
- Exported `formatProductDisplayName()` and `matchesProductQuery()` for unified presentation and search across all frontend and API layers.

---

## ADR-006: UI Primitives & Automated Guardrail Verification

### Context
Frontend drift (inconsistent buttons, raw HTML tags, conflicting color palettes, unformatted numbers) degrades user experience and demo quality.

### Decision
- Shared UI primitives (`Button`, `Badge`, `TableCard`, `TableToolbar`, `Table`) in `apps/web/src/components/ui/` are the sole permitted controls.
- All numbers and currency must use `@/lib/format` (`formatMoney`, `formatMoneyFull`, `formatNumber`, `formatCover`, `formatReasonSentence`).
- Automated enforcement via `scripts/check-ui.mjs` (wired into `pnpm lint`) fails CI builds if raw `<button>` tags, arbitrary hex codes, or unformatted numbers appear in feature components.

---

## ADR-007: Product Catalog Lifecycle, Change History, and Safe Deletion

### Context
StockFlow's replenishment engine requires product parameters (selling price, unit cost, lead time days) and sales history to generate recommendations. Administrators need to add new products, update catalog parameters, archive discontinued products, and clean up accidental draft entries without corrupting past decision audit trails or running into index misalignment in the pure analytical core.

### Decision
1. **Tri-State Product Lifecycle**:
   - `awaiting_history`: Newly created products (`POST /api/catalog/products`) pending sales data. They generate no morning queue actions until sales are recorded or sample history is generated.
   - `active`: Products with history participating in morning inventory optimization and replenishment planning.
   - `archived`: Discontinued products whose pending actions are immediately purged from the morning queue and whose history is permanently preserved.
2. **Catalog Invariants & Role Protection**:
   - Only `admin` role has `"products:manage"` permission; `manager` and `staff` access returns `403 Forbidden`.
   - Selling price must strictly exceed unit cost (`price > cost > 0`).
   - Lead time is an integer between 1 and 21 days (`1 <= leadTimeDays <= 21`).
   - Product names must be unique within their category (case-insensitive check returns `409 Conflict`).
   - Auto-generated sequential SKU format (`SKU-XXXXX`).
3. **Change History Tracking**:
   - Every product creation, parameter update, archive, and restore operation logs an immutable record to the `product_changes` collection with `actedBy: { userId, name, role }`, `action`, and `{ before, after }` diffs for each modified attribute.
4. **Delete Safety Guarantee**:
   - `DELETE /api/catalog/products/:sku` is strictly blocked (`409 Conflict`) if the SKU has past sales history or decision audit entries. In such cases, archiving is mandated to protect financial and audit integrity. Only mistake entries with zero sales and zero decisions may be permanently deleted.
5. **3D Dataset Matrix Alignment**:
   - To preserve the pure mathematical invariant of `packages/core/src/engine/` without modifying it, `Dataset.sales`, `onHand`, and `demand` 3D tensor dimensions `[skuIndex][branchIndex][dayIndex]` are kept strictly synchronized with `Dataset.products`. Analysis recomputations filter active indices uniformly across products and data tensors.

---

## ADR-008: Product Catalog Management UI and Ingestion Workflows

### Context
Store operators and administrators require an intuitive, accessible interface to manage network catalog products, review change history, configure price/cost parameters, activate draft SKUs, and import daily sales records without leaving the application.

### Decision
1. **Catalog Navigation Integration**:
   - Added `/products` route to `Shell.tsx` under a dedicated `CATALOG` section located between `OPERATIONS` and `GOVERNANCE` in both desktop collapsible sidebar and mobile drawer.
   - Breadcrumbs dynamically reflect section hierarchy (`Catalog / Products` and `Catalog / SKU-XXXXX`).
2. **Unified Data Table Experience**:
   - `ProductsPage.tsx` uses `TableCard`, `TableToolbar`, and `Table` primitives with sticky search, category dropdown filter, status tabs (`All`, `Active`, `Draft`, `Archived`), and 25-row pagination.
   - Displays formatted metrics (`formatMoneyFull`, `formatNumber`, margin percentages) and semantic status badges (`ok` for active, `over` for awaiting history, `staff` for archived).
3. **Interactive Admin Workflows**:
   - **Add Product Dialog**: Real-time validation enforcing `price > cost > 0`, integer lead time 1..21, and 60-character name limit. Creates draft products in `awaiting_history`.
   - **Edit Product Dialog**: Displays a contextual notice warning administrators when edits to price, cost, or lead time on an active product trigger network-wide recommendation recomputation.
   - **One-Click Activation**: For draft products, a "Generate sample history" button creates 30 days of synthetic sales across all 15 branches, promotes status to `active`, and immediately triggers engine analysis.
   - **Change History Dialog**: Pulls chronological audit trail from `/api/catalog/products/:sku`, displaying user attribution, timestamps, and field diffs.
   - **Safe Delete / Archive Flow**: Inspects `canDeletePermanently` from API. If sales or audit entries exist, guides user to archive instead of delete; allows permanent deletion only for zero-history drafts.
   - **CSV Import Modal**: Uploads `.csv` files up to 5MB to `/api/sales-entries/import`, displaying row counts inserted/updated and actionable per-row error listings.

---

## ADR-009: Role-Differentiated Dashboards and Staff Product View

### Context
Previously, all three user roles (`admin`, `manager`, `staff`) saw the exact same dashboard page at `/` and had access to the Action Queue at `/queue`. This created two fundamental problems:
1. **Information Architecture & Safety**: Store-level staff assigned to a single branch do not manage network capital, approve replenishment purchase orders, or balance inter-branch freight. Giving staff network-wide financial aggregates or multi-branch queues caused confusion and represented an authorization leak.
2. **Operational Mismatch**: Store managers responsible for a regional cluster (e.g. Manama) need operational action items—pending approvals in their cluster, backlog net benefit, and at-risk stores—rather than identical copies of network-wide executive metrics.

### Decision
1. **Granular Permissions in `@stockflow/core`**:
   - `dashboard:financial:network`: Granted strictly to `admin`.
   - `dashboard:financial:scoped`: Granted to `admin` and `manager`.
   - `dashboard:operational:scoped`: Granted to `admin` and `manager`.
   - `catalog:view`: Granted to `admin`, `manager`, and `staff`.
   - `staff` has zero dashboard (`dashboard:*`), audit (`audit:read`), user management (`users:manage`), or recommendation decision (`recommendations:decide`) permissions.

2. **Server-Side API Scoping in `apps/api`**:
   - `GET /api/kpis` is guarded with `authGuards.requirePermission("dashboard:financial:scoped")`; requests from `staff` are rejected with `403 Forbidden`.
   - For `admin`, `kpis` returns `this.analysis.kpis` directly, preserving 100% byte-identical parity with the tracked `kpis.json` snapshot fixture.
   - For `manager`, `kpis` computes cluster-scoped financial rollups over `userBranches` and attaches operational rollups (`pendingApprovalsCount`, `backlogValue`, `atRiskBranchCount`) and `scope: string[]`.
   - `GET /api/catalog/products` is guarded with `catalog:view`. For `staff`, it automatically defaults to their single assigned branch (`user.branchIds[0]`) and attaches live position statistics (`stats: { onHand, velocity, coverDays, status }`) from `this.analysis.positions`. Any attempt by staff or manager to query an out-of-scope branch returns `403 Forbidden`.

3. **Frontend Component Specialization in `apps/web`**:
   - **`AdminOverview`**: Network-wide executive dashboard displaying 15-branch rollups, full 15-branch cover grid heatmap, backtest replay validation, and 90-day network trends.
   - **`ManagerOverview`**: Cluster-focused dashboard displaying operational KPI cards (pending approvals count, action backlog net benefit, at-risk cluster branches), cluster excess inventory, and a heatmap filtered exclusively to assigned branches.
   - **`StaffProductStats`**: Minimal read-only store inventory view for the staff member's single assigned branch. Features searchable/filterable product table with on-hand units, daily velocity, stock cover days, and health badges (`Healthy`, `At Risk`, `Overstock`, `New`). Strictly read-only with no approve/reject buttons and no dashboard aggregates.
   - **Routing and Navigation Guards**:
     - `OverviewPage.tsx` dynamically switches between `StaffProductStats`, `ManagerOverview`, and `AdminOverview` based on user role. Staff never triggers the `/api/kpis` query.
     - `/queue` is guarded with `RequireNotStaff` in `App.tsx`, immediately redirecting staff to `/`.
     - `Shell.tsx` hides Operations and Governance sections for staff, presenting a clean "Store" section with a single "Branch Inventory" link.

### Addendum (Location Drilldown Security Tightening)
- During the location-drilldown work (`c7989d5`), `OverviewPage.tsx` temporarily routed `role === "staff"` on `/` to `BranchPage` (exposing branch-level financial `BD` KPI cards such as `Excess stock`, `Rev at risk`, and `Inventory`), `/branches/:id` lacked `RequireNotStaff`, `Shell.tsx` included a sidebar link to `/branches/:id`, and `GET /api/locations`, `GET /api/locations/:id/summary`, and `GET /api/branches/:id` only required `authenticate` (`403` absent for staff).
- Both frontend and backend have been tightened to restore the zero-financial-`BD` invariant for `staff`:
  1. `OverviewPage.tsx` renders `StaffProductStats` on `/` for `staff`, `/branches/:id` is guarded with `RequireNotStaff` in `App.tsx`, and `Shell.tsx` / `CommandPalette.tsx` suppress location/queue/financial links for `staff` while preserving `/products`.
  2. `GET /api/locations`, `GET /api/locations/:id/summary`, `GET /api/locations/:id/inventory`, `GET /api/locations/:id/trend`, and `GET /api/branches/:id` now enforce `authGuards.requirePermission("dashboard:financial:scoped")` (`403 Forbidden` for `staff`), preventing branch financial `BD` aggregates from leaking over the network.
  3. Non-financial branch header metadata (`branch` name, city, region) and store-wide SKU status counts (`totalSkus`, `AT_RISK`, `HEALTHY`, `OVERSTOCK`, `NEW`) are returned cleanly via `ProductBranchSummary` on `GET /api/catalog/products` (`branchSummary`) and displayed in `StaffProductStats` using `Badge` and `formatNumber` with zero `BD` figures.

---

## ADR-010: Bahrain Geographic Localization, Native Tiered BHD Pricing, and Engine Threshold Scaling

### Context
StockFlow's initial synthetic seed data used US cities (`Chicago - Loop`, `Los Angeles - Santa Monica`, etc.), a `Midwest` manager cluster (`manager.midwest@stockflow.dev`), and 2-decimal USD pricing (`$2`–`$150`). Re-localizing the platform for a Bahraini retail network requires real Bahrain geography across all 15 branches, native 3-decimal Bahraini Dinar (`BHD`, subdivided into 1,000 fils) tiered pricing, and proportionally scaled engine cost/materiality thresholds so lower nominal BHD figures (`1 BHD ≈ 2.65 USD`) do not distort transfer matching or get silently filtered out by USD-denominated cutoffs.

### Decision
1. **Single-Source Bahrain Branch Geography (`BAHRAIN_BRANCHES`)**:
   - Preserved branch IDs `BR-001` through `BR-015` and all role/manager scope assignments (`BR-001` & `BR-002` for the primary manager cluster; `BR-005` out-of-scope) so RBAC and scoping invariants remain intact.
   - Replaced branch display names, cities, regions, and verified `[lat, lng]` coordinates across Bahrain: 3 in Manama (`Manama - CBD`, `Manama - Juffair`, `Manama - Seef`), 2 in Muharraq/Hidd (`Muharraq - Central`, `Muharraq - Hidd`), and 10 across `Riffa`, `Isa Town`, `Sitra`, `Tubli`, `A'ali`, `Budaiya`, `Zallaq`, `Jasra`, `Hamad Town`, and `Saar`. All pairwise Haversine inter-branch distances fall within `2–45 km`.
   - Exported `BAHRAIN_BRANCHES` from `@stockflow/core` as the single source of truth imported by `apps/api`.
   - Renamed the primary manager cluster from `Midwest` to `Manama` (`manager.manama@stockflow.dev`).
2. **Strictly-Typed Category Price Tiers (`Record<CatalogCategory, PriceTier>`)**:
   - Defined `CatalogCategory` as a strict union of the 12 catalog categories and mapped every category via `CATEGORY_PRICE_TIER: Record<CatalogCategory, PriceTier>` (no `Record<string, PriceTier>` or fallback default) so any category mismatch fails `pnpm typecheck`:
     - `LOW` (`0.500–4.000 BHD`): `Beverages`, `Snacks`, `Dairy`, `Personal Care`.
     - `MID` (`2.000–15.000 BHD`): `Household`, `Stationery`, `Health & Wellness`, `Pet Supplies`.
     - `HIGH` (`15.000–120.000 BHD`): `Toys`, `Kitchenware`, `Home Decor`, `Accessories`.
   - Prices are intentionally non-round market-style 3-decimal BHD figures (e.g. `0.950`, `3.250`, `7.900`, `24.500`) to avoid synthetic-looking whole numbers, with unit cost at `55%–75%` of price (`price > cost > 0`).
3. **Engine Constant Scaling (`packages/core/src/engine/config.ts`)**:
   - Scaled the two hardcoded USD-magnitude constants in `packages/core/src/engine/config.ts` by `÷ ~2.65` to native BHD:
     - `TRANSFER_COST_PER_UNIT`: `12` (`$12.00`) $\rightarrow$ `4.5` (`BD 4.500`).
     - `MATERIAL_MIN_NET_BENEFIT`: `25` (`$25.00`) $\rightarrow$ `9.5` (`BD 9.500`).
4. **3-Decimal `BD` Formatting & Form Inputs**:
   - Updated `formatMoney` and `formatMoneyFull` in `apps/web/src/lib/format.ts` (and recommendation reason sentences in `packages/core/src/report/reason.ts`) to format 3 decimal places with a `BD` label (`BD 3.250`).
   - Updated Add/Edit Product dialog inputs in `ProductsPage.tsx` to `min="0.005" step="0.005"` with `BD` labels.
   - Updated `MongoRepository.seed()` (`pnpm seed:mongo`) to wipe all dataset, sales entry, audit, product change, action, and plan cache collections before reseeding.

---

## ADR-011: Distance-Aware Inter-Branch Transfer Cost in Bahrain (`TotalTransferCost(Q, D)`)

### Context
Previously, inter-branch transfer freight in `packages/core/src/engine/match.ts` used a flat per-unit constant (`TRANSFER_COST_PER_UNIT = 4.5` BHD/unit after BHD scaling). That model ignored real distance between donor and receiver branches across Bahrain (`2–45 km`) and priced per-unit handling high enough to distort short-distance vs cross-island donor selection while double-counting fixed dispatch cost inside the per-unit rate.

### Decision
1. **Distance-Aware Freight Formula (`TotalTransferCost(Q, D)`)**:
   - Replaced the all-in flat per-unit proxy with a three-part BHD cost model calibrated to Bahrain's `2–45 km` island network in `packages/core/src/engine/config.ts`:
     $$\text{TotalTransferCost}(Q, D) = C_{\text{fixed}} + (C_{\text{km}} \times D) + (C_{\text{unit}} \times Q)$$
   - `TRANSFER_FIXED_COST` ($C_{\text{fixed}}$): `1.500` BD per transfer dispatch.
   - `TRANSFER_COST_PER_KM` ($C_{\text{km}}$): `0.150` BD/km multiplied by `haversineDistanceKm(donor, receiver)` (ranging `0.300–6.750` BD across `2–45 km`; `0` when unit-test branches omit coordinates).
   - `TRANSFER_COST_PER_UNIT` ($C_{\text{unit}}$): reconciled to `0.250` BD/unit for per-unit handling, so unit freight is never double-counted alongside $C_{\text{fixed}}$ and $C_{\text{km}} \times D$. The marginal freight cutoff (`carryPerUnit - transferCostPerUnit <= 0`) remains mathematically exact because $C_{\text{fixed}} + C_{\text{km}} \times D$ is invariant to marginal units $Q$ on an open lane.
   - `MATERIAL_MIN_NET_BENEFIT` (`9.500` BD) remains strictly a post-ranking service-layer materiality filter (`StockService`), never subtracted from `netBenefit`.
2. **Greedy Donor Preference & Rationale Transparency**:
   - `recommend.ts` resolves each branch's `[lat, lng]` coordinates from `Branch.coordinates` (with fallback lookup from `BAHRAIN_BRANCHES`) and passes them through `PartyState` to `greedyMatcher`. Shorter lanes yield lower `transferCost` and higher `netBenefit`, naturally breaking ties toward nearer Bahrain donors.
   - `packages/core/src/report/numbers.ts` and `match.ts`/`recommend.ts`/`kpis.ts`/`detail.ts`/`backtest.ts` round BHD money figures to 3 decimal places (`round3` / fils precision), and `packages/core/src/report/reason.ts` surfaces distance (`km`) and the freight breakdown (`BD base + BD distance + BD handling`) directly in transfer rationales.
   - Deliberately regenerated `apps/api/src/__fixtures__/recommendations.json` and `kpis.json` to match the updated engine output.

---

## ADR-012: Critical Stock Escalations (`stock_alerts`) with Staff Flagging and Immutable Manager Review

### Context
Store floor staff observing physical shelf stockouts or urgent merchandising anomalies needed a lightweight mechanism to escalate `AT_RISK` SKUs to cluster managers for review without granting staff permission to alter inventory positions or decide replenishment actions. Alerts require clear actor attribution, branch-level RBAC scoping, and strict post-decision immutability mirroring ADR-004.

### Decision
1. **Separated RBAC Permissions (`packages/core/src/schemas/auth.ts`)**:
   - Added `"stock:flag"` exclusively to `staff` (create-only; `manager` and `admin` cannot create staff escalations) and `"stock:flag:decide"` exclusively to `manager` and `admin`.
2. **`stock_alerts` Collection & Conditional Immutability**:
   - Defined `StockAlertSchema` and `StockAlertModel` (`stock_alerts` collection) storing `{ id, branchId, branchName, sku, productName, flaggedBy: ActedBy, flaggedAt, note, status: "PENDING" | "APPROVED" | "REJECTED", decidedBy: ActedBy | null, decidedAt: string | null }`.
   - `MongoRepository.decideStockAlert` uses a conditional atomic `findOneAndUpdate({ id, status: "PENDING" }, ...)` so decided alerts are strictly immutable; repeat or conflicting decision attempts return `409 Conflict`.
3. **Scoped API Endpoints (`apps/api/src/routes/stockAlerts.ts`)**:
   - `GET /api/stock-alerts`: Scoped via `isBranchInScope` (`staff` sees own branch, `manager` sees assigned branches, `admin` sees network).
   - `POST /api/stock-alerts`: Requires `stock:flag` and enforces `isBranchInScope(user, branchId)`.
   - `PATCH /api/stock-alerts/:id/approve|reject`: Requires `stock:flag:decide` and enforces `isBranchInScope(user, alert.branchId)`.
4. **Frontend Controls (`StaffProductStats.tsx` & `ManagerOverview.tsx`)**:
   - Added a **Flag critical stock** dialog action on `AT_RISK` rows in `StaffProductStats.tsx` (wired on `/products` for `staff`) and a scoped pending-alerts review table in `ManagerOverview.tsx` using shared UI primitives (`Button`, `Badge`, `Table`, `Dialog`, `Card`, `Input`).

### Addendum (Alert Categories, Weekly Check Section & Admin Alert Visibility)
- Expanded `stock_alerts` with a `category` enum (`"CRITICAL_LOW" | "DAMAGED_SHRINKAGE" | "COUNT_MISMATCH" | "OTHER"`, defaulting to `"CRITICAL_LOW"` in Zod & Mongoose for backward compatibility) and allowed staff to flag any non-`NEW` SKU row (`AT_RISK` defaults to `CRITICAL_LOW`; `HEALTHY`/`OVERSTOCK` default to `COUNT_MISMATCH`), surfacing category pills alongside the note in a shared `PendingStockAlertsCard`.
- **Network-Wide Admin Alert Visibility (`AdminOverview.tsx`, cross-referencing ADR-009)**: Extracted the pending-alerts review table into `apps/web/src/components/shared/PendingStockAlertsCard.tsx` and rendered it on both `ManagerOverview.tsx` (`scope="branch"`, strictly assigned branches, unchanged) and `AdminOverview.tsx` (`scope="network"`, all 15 branches). Because `admin` already holds `stock:flag:decide` and `GET /api/stock-alerts` returns all branches for `admin`, no permission or API changes were needed; each row includes the formatted branch label (`BR-xxx · <Name>`) so network reviewers immediately see which store raised the escalation.
- Tightened `GET /api/stock-alerts` with `authGuards.requireAnyPermission(["stock:flag", "stock:flag:decide"])` and optional `?branchId=` scope verification (`403 Forbidden` if outside caller scope), and grouped `StaffProductStats.tsx`'s flagging table under a **Weekly Stock Check** section above the **Recent Branch Stock Alerts** history table showing SKU, category, note, submitted timestamp, decision status badge, and resolving reviewer name (`decidedBy.name`).

---

## ADR-013: Non-Mutating `committedDeltas` Approval Ledger, Pure `project()`, and `409` Over-Allocation Conflict Guard

### Context
Approving transfers, reorders, and markdowns in `StockService` previously overlaid only recommendation `status` (`PENDING -> APPROVED`) while leaving projected `onHand`, `surplus`, `lostUnits`, and KPIs completely unchanged. As a result, approving a transfer did not reduce a donor branch's available surplus or add `inTransit` stock to the receiving branch, creating a double-allocation risk if multiple transfers pulled from the same depleted donor. At the same time, mutating `this.analysis.positions` or `this.analysis.kpis` in place would corrupt the golden-snapshot baseline (`snapshot.test.ts`).

### Decision
1. **In-Memory `committedDeltas` Ledger & Immutable Plan Snapshot (`apps/api/src/services/stockService.ts`)**:
   - Added an in-memory `committedDeltas` map keyed by `sku::branchId` tracking `{ reserved, inTransit }`, plus `committedAllocations` tracking committed reorder/markdown/transfer quantities until the next catalog/sales refresh (`recomputeSingleSku`, `recomputeAnalysisForProduct`, or `dataVersion` plan refresh).
   - `this.analysis.positions` and `this.analysis.kpis` are never mutated.
2. **Pure `project(rawPosition, deltas)` Function**:
   - Exported a side-effect-free `project()` function in `apps/api/src/services/stockService.ts` that decreases `onHand` and `surplus` by `reserved`, reduces shortfall (`need`, `lostUnits`) by `inTransit`, and re-evaluates `coverDays` and `status` from effective stock.
   - All live position, KPI, location, branch, product detail, and catalog stats reads (`kpis`, `listCatalogProducts`, `product`, `branch`, `listLocations`, `locationSummary`, `locationInventory`) route through `project()`, returning the untouched `this.analysis.kpis` directly when `committedDeltas.size === 0`.
3. **Synchronous Atomic Donor Check & `409 Conflict` Guard**:
   - Before persisting a `TRANSFER` approval, `decide()` synchronously computes `effectiveAvailable = rawSurplus(sku, donorBranchId) - committedReserved(sku, donorBranchId)`. If requested quantity exceeds `effectiveAvailable`, it rejects with `DecisionConflictError` (HTTP `409 Conflict`: `"Donor stock already committed to another approved transfer"`) without mutating the ledger or DB.
   - Valid approvals stage `{ reserved, inTransit }` deltas synchronously before `await this.repo.saveDecisionBatch(...)` (eliminating async check-then-act races) and roll back on failure or duplicate race loss. Both `decide()` and `decideBatch()` invoke `this.scopedKpiCache.clear()` whenever decisions persist.

#### Addendum: Boot-Time Ledger Replay & Double-Allocation UI Verification Resolution
- **Boot-Time Ledger Replay**: During `StockService` startup (`syncDecisionsAndAudit` / `ensureInitializedSyncIfPossible`), `replayApprovedTransfersFromAudit()` reconstructs `committedDeltas` (`reserved` on donor, `inTransit` on receiver) from persisted `APPROVED` transfer records in the `audits` collection (skipping pre-refresh audits when `dataVersion > 1` is older than `plan_cache.computedAt`). API server restarts preserve live reserved/in-transit projections and conflict protection seamlessly without mutating `this.analysis`.
- **Visible UI Indicators**: Surfaced `inTransit` and `reserved` badges via [StockDeltaBadges.tsx](file:///c:/Users/sudha/Desktop/stockflow/apps/web/src/components/shared/StockDeltaBadges.tsx) across [ProductPage.tsx](file:///c:/Users/sudha/Desktop/stockflow/apps/web/src/features/drilldown/ProductPage.tsx) and [BranchPage.tsx](file:///c:/Users/sudha/Desktop/stockflow/apps/web/src/features/drilldown/BranchPage.tsx).
- **Double-Allocation Guard Resolution (Walkthrough Step 3)**: Attempting to trigger a `409 Conflict` via the live morning queue UI alone is intentionally unreachable by design—greedy surplus decrement in `packages/core/src/engine/match.ts` guarantees `analyze()` never emits two transfers whose combined quantity exceeds a donor branch's raw surplus, and managers have no manual transfer creation or quantity-override controls. Forcing a synthetic conflicting transfer into the morning generator or bypassing engine purity to trigger a live click error would violate `ADR-001`; the `409 Conflict` guard is instead verified continuously by [approvalMutation.test.ts](file:///c:/Users/sudha/Desktop/stockflow/apps/api/src/approvalMutation.test.ts).

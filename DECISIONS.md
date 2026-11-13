# StockFlow — Architecture Decision Records (ADRs)

This document records the architectural decisions, trade-offs, and invariants adopted across the StockFlow codebase.

---

## ADR-001: Pure Mathematical Core Engine in `@stockflow/core`

### Context
StockFlow's replenishment, transfer, and markdown calculations must be deterministic, auditable, and testable without database or network dependencies.

### Decision
- All statistical formulas (EWMA velocity, standard deviation, safety stock $z \cdot \sigma \cdot \sqrt{L}$, reorder point $d \cdot L + SS$, cover days) and optimization algorithms (greedy transfer matching, net benefit calculation, 90-day counterfactual backtesting) live in `packages/core/src/engine/`.
- **Invariant**: `packages/core/src/engine/` has zero external dependencies outside TypeScript math and Zod contracts. It is frozen and protected by byte-identical golden snapshot tests (`apps/api/src/__fixtures__/recommendations.json` and `kpis.json`).

---

## ADR-002: Server-Side Branch Scoping Post-Plan Computation

### Context
A multi-branch retail network has multiple user roles:
- `admin`: Full network visibility across all 15 branches.
- `manager`: Scoped to a cluster of branches (e.g. Midwest: `BR-001` through `BR-004`).
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

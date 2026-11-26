# StockFlow Frontend Guide (`apps/web`)

## Design System & Guardrails
- **Color & Surface Layering (`src/index.css`, `src/lib/tokens.ts`)**:
  - Calm Blue primary brand (`#2563EB` light / `#3B82F6` dark), layered slate surfaces (`--bg`, `--surface`, `--table-header`, `--row-hover`, `--row-selected`), and semantic tokens (`gain`, `risk`, `warn`, `info`, `indigo`, `neutral`).
  - Full Light / Dark / System support via `ThemeProvider` (`components/shared/ThemeProvider.tsx`) and `ModeToggle` (`components/shared/ModeToggle.tsx`), persisted under `stockflow-theme`.
- **Shared Primitives (`src/components/ui/`)**:
  - `Button` (`button.tsx`): Only button implementation allowed across the app. Variants: `default`/`primary`, `secondary`/`outline`, `soft-success`, `soft-danger`, `destructive`, `ghost`, `link`. Supports `loading` spinner and `tooltip` props.
  - `Badge` (`badge.tsx`): Rounded pill badges (`rounded-full`, `1px` inset ring, optional `dot`) for actions (`transfer`, `reorder`, `markdown`), statuses (`pending`, `approved`, `rejected`), roles (`admin`, `manager`, `staff`), and inventory health (`risk`, `over`, `ok`, `fresh`). Priority is conveyed by sort order and `BD` amount, not a separate priority badge. `StockDeltaBadges` (`components/shared/StockDeltaBadges.tsx`) surfaces `In transit` and `Reserved` pills with `formatNumber()` on branch and product position tables.
  - `TableCard` / `TableToolbar` / `Table` (`table.tsx`): Uses `table-auto` inside a scrollable `table-container` with `min-w-*` widths so wide columns never collide or clip headers on narrow viewports, with `--table-header` 11px uppercase column headers, right-aligned `tabular-nums` numbers, and `TableSkeleton` loading states.
- **Unified Formatting (`src/lib/format.ts`, `src/lib/bahrainDate.ts`)**:
  - `formatMoney`: Compact Bahraini Dinar (`BD`) format for KPI cards, summary badges, and chart axes (`BD 9.4K`, `BD 155.4K`, `BD 1.2M`; whole `BD` for `1–999`; `3` decimals only `< BD 1`, e.g. `BD 0.750`; `BD 0` for zero).
  - `formatMoneyFull`: Table and detail-panel `BD` format (`BD 1,241`, `BD 186`) using whole `BD` with thousands separators and preserving `3` decimals (`fils`) only below `BD 1` (`BD 0.750`).
  - `formatNumber`: Integers with separators (`1,240`), preserving 1 decimal only for fractional rates `< 1`.
  - `formatCover` / `formatCoverCell`: Treats engine's `NO_DEMAND_COVER = 999999` (`>= 9999`) as `"No demand"` / `"—"` and caps `> 90` days at `"90d+"` in heatmap cells.
  - `formatReasonSentence`: Normalizes uncapped or extreme floating-point cover days in natural-language rationale paragraphs.
- **Overstock & Dead-Stock Card**: Displays surplus above the 30-day donor floor (`cashReleasable`) with `"Includes BD X dead stock (<1 unit/wk)"`, where `deadStockValue` is computed as the low-velocity (`< 1/7` units/day, `~0.1429/day`) subset of `OVERSTOCK` surplus so dead stock never exceeds overstock value.
- **Overview Analytics & Navigation (`AdminOverview`, `ManagerOverview`, `Analytics`, `FreshnessBanner`, `NeedsAttentionStrip`, `LocationSidebarParts`)**:
  - **Live Freshness & `Asia/Bahrain` Dates**: `useBahrainToday` + `FreshnessBanner` display Bahrain today (`UTC+3`), `asOfDataDate`, `Updated HH:mm`, stale-data badge (`> 1` day old -> `/data?tab=import`), and single-request `/api/kpis/live` refresh.
  - **Scope-aware Risk Chart (`riskChart.ts` -> `resolveRiskChart`)**: Network/cluster views display `"Top at-risk locations"` (`top 8` by sales at risk); selecting a single location replaces it with `"At-risk by category"` sorted descending by sales at risk, where clicking any bar filters `/branches/:id?cat=<category>&status=AT_RISK`.
  - **Action Mix Donut**: Center overlay shows total action count and compact estimated gain; slices pair violet (`Transfer`), blue (`Reorder`), and amber (`Markdown`) semantic tokens with non-color symbol prefixes (`⇄`, `＋`, `↓`) and legend count + amount rows.
  - **Top SKUs by Gain**: Sorted top 8 bars showing product name primary text + `SKU-XXXXX` secondary text, end-of-bar value labels, and direct click navigation to `/products/:sku`.
  - **Inline Chart Detail Strip (`ChartDetailPopup.tsx` + `ChartCard.tsx`)**: Replaces viewport-fixed corner overlays with an inline `ChartDetailStrip` inside the clicked `ChartCard` (`targetCard`-scoped) so details never cover adjacent charts.
  - **Sidebar Location Health Dots**: Computed server-side relative to the network median `lostSalesAtRisk` (`<= median` green, `<= 1.5x` amber, `> 1.5x` red), with `<Tooltip>` displaying each store's at-risk SKU count and sales at risk.
  - **Needs Attention Strip & Manager Backtest Panel**: Surfaces three high-leverage pending action cohorts (`Soonest stockout risk`, `Largest transfer opportunity`, `Markdown & overstock clearance`) on both overviews; `ProofOfValuePanel` (45-day counterfactual backtest) remains on `ManagerOverview` after removal from `AdminOverview`.
  - **Product Forward Stock Projection (`ProductPage`)**: Adds a lead-time horizon projection chart (`max(21, 2 * leadTimeDays)`) shading the `[D+0, D+leadTimeDays]` window alongside `reorderPoint`, baseline stockout marker, and recommended action arrival trajectory.
- **Automated UI Guardrail (`scripts/check-ui.mjs`, run via `pnpm lint`)**:
  1. Fails if any raw `<button` element is used outside `apps/web/src/components/ui/`.
  2. Fails if any hex color literal (`#...`) appears in `apps/web/src/` outside `index.css` and `lib/tokens.ts`.
  3. Fails if any inline `style={{ ... }}` sets `color`, `background`, `backgroundColor`, or `boxShadow`.
  4. Fails if any file under `apps/web/src/features/` uses inline number/date formatting (`Intl.NumberFormat`, `toLocaleString`, `toFixed`) instead of `@/lib/format`.

## Route Table
| Route | Component | Access | Purpose |
|---|---|---|---|
| `/login` | `LoginPage` | Public | Role-assigned sign-in + collapsible demo account selector (`VITE_SHOW_DEMO_ACCOUNTS`) |
| `/` | `OverviewPage` | `admin`, `manager`, `staff` | Differentiated view: `AdminOverview` (network `BD` KPIs, 15-branch Bahrain heatmap), `ManagerOverview` (cluster operational & financial KPIs plus pending `stock_alerts` approval table with category pills), `StaffProductStats` (non-financial store inventory, categorized flagging on non-`NEW` rows, and `Recent Branch Stock Alerts` history for `staff`) |
| `/queue` | `QueuePage` | `admin`, `manager` | Lifecycle views (`Pending`, `In progress`, `Decided`), incoming/outgoing tabs (`Requests to Fulfil`, `Sent & Pending`), `ApproveQuantityDialog`, `OrderDrawer` (`OrderEventRow`), `DonorPicker`, `RequestStockDialog`; blocked for `staff` |
| `/branches/manage` | `BranchesManagePage` | `admin` | Add branches (unified coordinates paste/parse for decimals, DMS, or Google Maps URLs, auto-suggested cluster region), edit metadata, search/filter active & archived branches, reversibly archive/unarchive (`403`/redirect for non-admins) |
| `/branches/:id` | `BranchPage` (`features/branches`) | `admin`, `manager` | Branch KPIs, sales & stock chart, projected `In transit` / `Reserved` stock badges, actions touching branch (historical detail preserved even if archived); blocked for `staff` (redirects to `/`) |
| `/products` | `ProductsPage`, `StaffProductStats` | `admin`, `manager`, `staff` (`Store Inventory`) | Role-branched: `admin`/`manager` see network catalog & filters (Add/Edit/Archive/CSV controls admin-only); `staff` render `StaffProductStats` (non-financial store inventory with multi-branch switcher when assigned 2+ branches, `Flag stock` on non-`NEW` rows, and alert decision history) |
| `/products/:sku` | `ProductPage` (`features/products`) | `admin`, `manager`, `staff` (scoped) | SKU policy breakdown, sales/stock/cover charts, branch position table with `StockDeltaBadges` (`In transit` / `Reserved`) |
| `/data` | `DataEntryPage` (`DailyEntryContextPanel`, `DailySheetEditor`, `SkuCombobox`) | `admin`, `manager`, `staff` | Daily sales entry with live branch/SKU context, multi-row Daily Sheet editor, recent entries filter/edit/delete, and CSV import + `Recent imports` history (`/api/sales/imports`) |
| `/audit` | `AuditPage` (`OrderEventRow`) | `admin`, `manager` | Searchable order & decision audit trail showing actor badges, quantity edits, and disposition codes; blocked for `staff` |
| `/users` | `UsersPage` (`UserRoleAndBranchesFields`) | `admin` | Create, edit role/branches, reset password, and deactivate users with browser autofill isolation and email/password validation |

## UX Principles
- **Plain language first**: Surface terms used by store teams and contextual help popovers for inventory metrics.
- **Role-appropriate landing**: Admins see network `BD` risk and cash-release totals; managers see their branch cluster and escalated alerts; staff record sales and shelf counts, flag stock issues and receive deliveries in their assigned store.
- **Linkable URL state**: Location scope, filters, tabs, sorting, and pagination belong in URL query parameters so views survive refresh and sharing.
- **Accessible & non-color-only**: Statuses pair color tokens with text labels or icons; charts provide table fallbacks and keyboard navigation.
- **Role-aware StockFlow assistant**: Signed-in users see a floating chat named StockFlow. The welcome is “Hi, I’m StockFlow. What would you like me to do today?” Suggested questions adapt to admin, manager, and staff. Answers link to the relevant application screen and retain the recent conversation during navigation.

# StockFlow Frontend Guide (`apps/web`)

## Design System & Guardrails
- **Color & Surface Layering (`src/index.css`, `src/lib/tokens.ts`)**:
  - Calm Blue primary brand (`#2563EB` light / `#3B82F6` dark), layered slate surfaces (`--bg`, `--surface`, `--table-header`, `--row-hover`, `--row-selected`), and semantic tokens (`gain`, `risk`, `warn`, `info`, `indigo`, `neutral`).
  - Full Light / Dark / System support via `ThemeProvider` (`components/theme-provider.tsx`) and `ModeToggle` (`components/mode-toggle.tsx`), persisted under `stockflow-theme`.
- **Shared Primitives (`src/components/ui/`)**:
  - `Button` (`button.tsx`): Only button implementation allowed across the app. Variants: `default`/`primary`, `secondary`/`outline`, `soft-success`, `soft-danger`, `destructive`, `ghost`, `link`. Supports `loading` spinner and `tooltip` props.
  - `Badge` (`badge.tsx`): Rounded pill badges (`rounded-full`, `1px` inset ring, optional `dot`) for actions (`transfer`, `reorder`, `markdown`), statuses (`pending`, `approved`, `rejected`), roles (`admin`, `manager`, `staff`), and inventory health (`risk`, `over`, `ok`, `fresh`). Priority is conveyed by sort order and `$` amount, not a separate priority badge.
  - `TableCard` / `TableToolbar` / `Table` (`table.tsx`): Uses `table-auto` inside a scrollable `table-container` with `min-w-*` widths so wide columns never collide or clip headers on narrow viewports, with `--table-header` 11px uppercase column headers, right-aligned `tabular-nums` numbers, and `TableSkeleton` loading states.
- **Unified Formatting (`src/lib/format.ts`)**:
  - `formatMoney`: 3-decimal Bahraini Dinar currency (`BD 3.250`, `BD 14,520.350`) for headers and KPI cards.
  - `formatMoneyFull`: 3-decimal Bahraini Dinar currency (`BD 0.950`, `BD 3.250`, `BD 1,240.500`) for tables and detail views.
  - `formatNumber`: Integers with separators (`1,240`), preserving 1 decimal only for fractional rates `< 1`.
  - `formatCover` / `formatCoverCell`: Treats engine's `NO_DEMAND_COVER = 999999` (`>= 9999`) as `"No demand"` / `"—"` and caps `> 90` days at `"90d+"` in heatmap cells.
  - `formatReasonSentence`: Normalizes uncapped or extreme floating-point cover days in natural-language rationale paragraphs.
- **Automated UI Guardrail (`scripts/check-ui.mjs`, run via `pnpm lint`)**:
  1. Fails if any raw `<button` element is used outside `apps/web/src/components/ui/`.
  2. Fails if any hex color literal (`#...`) appears in `apps/web/src/` outside `index.css` and `lib/tokens.ts`.
  3. Fails if any inline `style={{ ... }}` sets `color`, `background`, `backgroundColor`, or `boxShadow`.
  4. Fails if any file under `apps/web/src/features/` uses inline number/date formatting (`Intl.NumberFormat`, `toLocaleString`, `toFixed`) instead of `@/lib/format`.

## Route Table
| Route | Component | Access | Purpose |
|---|---|---|---|
| `/login` | `LoginPage` | Public | Role-assigned sign-in + collapsible demo account selector (`VITE_SHOW_DEMO_ACCOUNTS`) |
| `/` | `OverviewPage` | `admin`, `manager`, `staff` | Differentiated view: `AdminOverview` (network $ KPIs, 15-branch heatmap), `ManagerOverview` (cluster operational & financial KPIs), `BranchPage` (`forcedBranchId`, `readOnly` for `staff`) |
| `/queue` | `QueuePage` | `admin`, `manager` | Ranked action queue, action tabs, filters, batch bar; blocked for `staff` |
| `/branches/:id` | `BranchPage` | `admin`, `manager`, `staff` (scoped) | Branch KPIs, sales & stock chart, actions touching branch |
| `/products` | `ProductsPage` | `admin`, `manager`, `staff` (view-only) | Network catalog table and filters; Add/Edit modals, Change History, and CSV Import hidden for `staff` |
| `/products/:sku` | `ProductPage` | `admin`, `manager`, `staff` (scoped) | SKU policy breakdown, sales/stock/cover charts, branch position table |
| `/data` | `DataEntryPage` | `admin`, `manager` | Daily sales entry form, recent entries, and bulk CSV import; blocked for `staff` |
| `/audit` | `AuditPage` | `admin`, `manager` | Searchable decision audit log with reason-code badges; blocked for `staff` |
| `/users` | `UsersPage` | `admin` | Create, edit role/branches, reset password, and deactivate users |

## UX Principles
- **Plain language first**: Surface buyer-friendly terms and contextual help popovers for inventory metrics.
- **Role-appropriate landing**: Admins see network dollars and risk; managers see their branch cluster; staff see a read-only view of their assigned store.
- **Linkable URL state**: Location scope, filters, tabs, sorting, and pagination belong in URL query parameters so views survive refresh and sharing.
- **Accessible & non-color-only**: Statuses pair color tokens with text labels or icons; charts provide table fallbacks and keyboard navigation.

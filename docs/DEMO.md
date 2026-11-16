# StockFlow Demo Walkthrough

## Seeded Accounts
- **Admin** (`admin@stockflow.dev`): Full network visibility across all 15 branches, catalog management, user management, decisions, and daily data entry.
- **Manager - Manama** (`manager.manama@stockflow.dev`): Scoped to `BR-001` (`Manama - CBD`) and `BR-002` (`Manama - Juffair`) (decisions, audit, data entry, and scoped KPIs).
- **Staff - Manama CBD** (`staff.manama@stockflow.dev`): Locked to `BR-001` (`Manama - CBD`) with a read-only location view (no decision buttons, no data entry, no financial/audit/user pages).

## Before Each Demo
Reset prior recommendation decisions and decision audit entries without touching the catalog, sales entries, users, refresh tokens, or `dataVersion`:
```bash
pnpm reset:decisions --yes
```

## 5-Minute Walkthrough
1. **Admin Overview & Plain Language (`/`)**:
   - Point out the `PageHeader` orientation cue (`N decisions waiting -> Open queue`), plain-language KPIs (*Days of stock left*, *Overstock value*, *Sales at risk*, *Cash you can free up*), `(i)` `InfoPopover` explanations, and the **Glossary** in the help menu.
   - Interact with the charts (hover tooltips, legend series toggle, `7 / 30 / 90d` range, **View as table** accessibility toggle) and click a bar to jump directly to a location dashboard.
2. **Location Switcher & Location Dashboard (`/branches/BR-001`)**:
   - Use the sidebar **Location switcher** or **Locations** health list (or press `Ctrl+K` / `Cmd+K` for the Command Palette) to open `/branches/BR-001`.
   - Show *What this location needs* (*Needs stock*, *Can give*, *Should mark down*), click a category in the Stock Health heatmap to cross-filter the inventory table, and clear the filter chip.
3. **Daily Entries (`/data`)**:
   - Open **Daily entries**, select a location and SKU, submit a new daily count (`onHand = 0` with demand), and click the toast link to jump to the updated **Action queue**.
   - Switch to **Recent entries** to edit (`PATCH`) or delete (`DELETE`) a record, and show **Import CSV** with template download and row-level error reporting.
4. **Action Queue, Live Inventory Projection & Audit (`/queue`, `/audit`)**:
   - Inspect a transfer's Bahrain distance-aware freight breakdown (`fixed + distance + per-unit`) in the recommendation drawer, approve it, confirm live **Reserved** (donor) / **In transit** (receiver) badges update on `/branches/:id` and `/products/:sku`, and verify the immutable audit trail on `/audit`.
5. **Role Switching & Staff Escalations**:
   - Sign in as `staff.manama@stockflow.dev` (locked to `BR-001`, read-only landing), open `/products` (`Store Inventory`), and click **Flag critical stock** on an `AT_RISK` item.
   - Sign in as `manager.manama@stockflow.dev` (scoped to `BR-001`/`BR-002`, out-of-scope `/branches/BR-005` blocked) and approve or reject the escalated item under **Pending branch critical-stock alerts** on `/`.

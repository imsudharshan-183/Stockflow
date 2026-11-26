# StockFlow Demo Walkthrough

## Walk through the architecture

Run `node demo/server.mjs` from the repository root and open [the local explorer](http://127.0.0.1:4178/). Start with **Morning plan** to see how a shortage becomes a recommendation. In **Stock transfer**, follow who can release stock and who confirms delivery. In **AI assistant**, follow a question through its role and branch checks. Choose a scenario and change a decision to inspect its outcome and code location.

The explorer uses local examples. For a demo with editable store data, start the web app and API using the [README setup](../README.md#run-the-local-demo).

## Seeded Accounts
- **Admin** (`admin@stockflow.dev`): Full network visibility across all 15 branches, catalog management, user management, decisions, and daily data entry.
- **Manager - Manama** (`manager.manama@stockflow.dev`): Scoped to `BR-001` (`Manama - CBD`) and `BR-002` (`Manama - Juffair`) (decisions, audit, data entry, and scoped KPIs).
- **Staff - Manama CBD** (`staff.manama@stockflow.dev`): Locked to `BR-001` (`Manama - CBD`) for store inventory, sales entry, stock alerts and delivery receipts.

## Try the assistant

Open the robot button after signing in. As admin, ask “How many products are over BD 200?” and then “List them”. As a manager, select a store and ask “Show my stock forecast”. As staff, choose “How do I flag a stock issue?” to find the steps on the inventory screen. Open **Show my brief** to see which records support the morning summary.

## Advance the dataset for a demo

1. Enable `AUTH_ENABLED=true` and `ALLOW_SYNTHETIC_DATA=true` on the demo API and restart it.
2. Sign in as admin, open **Products Catalog → Demo tools**, and select **Simulate today's sales**. The result shows the date, branch count, and new row count.
3. On the original seed, expect November 12, 2026, 15 branches, and 7,500 rows. Open **Daily entries** to inspect the new date and **Action queue** to review the refreshed plan.

The next run becomes available on the next Bahrain calendar day. For a demo of **stores reported today**, submit a real daily entry for today in the demo app. Generated rows are marked as sample data.

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
   - Sign in as `staff.manama@stockflow.dev` (locked to `BR-001`, non-financial store inventory), click **Flag stock** on any non-`NEW` SKU row, choose an alert category (`Critical low`, `Damaged / shrinkage`, or `Count mismatch`), enter a note, and submit.
   - Sign in as `manager.manama@stockflow.dev` and open **Pending branch stock alerts** on the overview. Choose **Resolve** and record the appropriate action, such as **Request Replenishment** or **Log Adjustment**. Switch back to the reporting store to see the resolution.

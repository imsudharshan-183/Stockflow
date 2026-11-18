@AGENTS.md

## Recent Overview & Seed Reference
- **Overview Components**: `AdminOverview.tsx` and `ManagerOverview.tsx` compose `NeedsAttentionStrip.tsx` (3 plan-derived queue cards), `Analytics.tsx` + `riskChart.ts` (top-8 `Top at-risk locations` in network/cluster view or sorted `At-risk by category` when a single location is selected), and `ProofOfValuePanel.tsx` (45-day counterfactual day-by-day replay summary). Clicking charts opens an inline `ChartDetailStrip` (`ChartDetailPopup.tsx` + `ChartCard.tsx`, `targetCard`-scoped inside the card, replacing fixed viewport popovers).
- **Formatting & KPIs**: `formatMoney` formats KPI cards/axes compactly (`BD 9.4K`); `formatMoneyFull` formats tables/details in whole `BD` with thousands separators (`3` decimals only `< BD 1`). Overstock `deadStockValue` is the near-zero velocity (`< 0.05/day`) subset of surplus (`deadStockValue <= cashReleasable`).
- **Seed Realism**: Network `AT_RISK` sits at `~12.29%` (down from `~41.88%`) with 3 hotspot branches (`BR-004`, `BR-005`, `BR-009` at `20–30%`), 3 low-risk branches (`BR-003`, `BR-010`, `BR-015` at `2–5%`), and 9 remaining branches at `~9–12%`.


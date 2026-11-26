# StockFlow — Product Proposal: Decision-First Retail Operations Platform

## 1. Problem Worth Solving
A retail chain operating 15 branches and 500 SKUs (7,500 distinct store-product nodes) collects daily sales and stock data, yet good operational decisions fail to follow from raw tables and spreadsheets. Store teams suffer from three recurring failures:
- **Simultaneous Stockouts and Dead Stock:** One branch loses high-margin sales to empty shelves while another branch a few kilometers away sits on 60+ days of unsold overstock of the same SKU.
- **Uneconomical Transfers:** Naive rebalancing ignores shipping distance and handling overhead, wasting margin moving small quantities across the network.
- **Governance & Floor Visibility Gaps:** Store-floor staff spot damaged goods and physical shelf count mismatches first, but lack a structured escalation path — while unrestricted write access risks corrupting inventory baselines.

## 2. Proposed Solution
**StockFlow** replaces passive BI charts with a deterministic, governed **Morning Action Queue** localized for a 15-branch Bahrain retail network (native `BHD` / `BD` 3-decimal fils pricing):
- **Pure Mathematical Optimization Core (`@stockflow/core`):** Computes EWMA daily velocity, dynamic safety stock ($z \cdot \sigma \cdot \sqrt{L}$), reorder points, and stock cover days with zero black-box ML dependencies, validated by a 45-day counterfactual backtest.
- **Distance-Aware Inter-Branch Transfer Matcher:** Calculates real Haversine distances (`2–45 km` across Bahrain) and evaluates a 3-component transfer cost ($\text{Fixed Dispatch} + \text{Distance/km} + \text{Unit Handling}$) so transfers are only recommended when net protected margin exceeds logistics cost.
- **Closed-Loop Approval Ledger (`committedDeltas`):** Approving a transfer, reorder, or markdown immediately projects reserved donor units, in-transit receiver units, and updated KPIs across the UI while enforcing a synchronous `409 Conflict` guard against double-allocating donor surplus.
- **Role-Differentiated Governance (`Admin`, `Cluster Manager`, `Store Staff`):**
  - **Admins** oversee all 15 branches, network financial KPIs, catalog lifecycle (`awaiting_history` / `active` / `archived`), CSV sales ingestion, and immutable decision audits.
  - **Cluster Managers** manage scoped regional branches (e.g., `BR-001` Manama - CBD & `BR-002` Manama - Juffair), triage ranked recommendations individually or in batch, and review floor escalations.
  - **Store Staff** operate a focused, zero-financials branch inventory view (`Weekly Stock Check`) where they report critical low stock, damaged/spoiled goods, or count mismatches and track manager decisions in real time.

The signed-in StockFlow assistant helps employees find those records, explain stock terms and review a morning brief. Its forecast answers use the demand estimates already computed by the engine.

## 3. Production Roadmap (Phase 2)
- **Direct POS Event Streaming:** Add webhook/Kafka POS ingestion as the primary real-time path for sales data, keeping the existing CSV import (`/api/sales-entries/import`) as a manual fallback for branches without POS integration or for backfilling corrections.
- **Distributed Reservation Store & Idempotency:** Move `committedDeltas` from single-process memory to Redis/MongoDB atomic `$inc` guards with `Idempotency-Key` headers for multi-replica horizontal scaling.
- **Server-Side Queue Pagination:** Paginate `/api/recommendations` and `/api/audit` server-side for catalogs exceeding 10,000+ SKUs.

# Decisions

The algorithm notes live here. Setup and the folder map are in the [README](../README.md).

## Problem framing

A buyer opens StockFlow once a morning and needs a ranked list, not a dashboard of ratios. Each row is a transfer, a reorder, or a markdown, with a dollar net benefit and a sentence that names the cover, the reorder point, and the money. The network is 15 branches and about 500 SKUs. History is 120 synthetic days. The buyer has to be able to argue with the number.

## Algorithm

1. **Velocity.** An exponentially weighted average of daily sales. The span is 28 days, so the weight on the latest in-stock day is `2 / 29`. Days with nothing available to sell are left out of the average and out of sigma. A stockout is not evidence that demand disappeared.
2. **Safety stock.** `z * sigma * sqrt(lead time)` with `z = 1.65`. The reorder point is `velocity * lead time + safety stock`.
3. **Classification.** Cover is on hand divided by velocity. Above 60 days is overstock. Below the reorder point is at risk. Overstock wins if both could apply. No in-stock history means the SKU is new and gets no action. Zero velocity with stock on hand is unlimited cover, not a division by zero.
4. **Matching.** For each SKU, donors can give units above 30 days of cover plus safety stock. Receivers need units to reach 14 days of cover. The greedy pass takes the pair with the highest net benefit, moves the stock, and repeats. Ties break toward the lower branch index so the order does not flicker.
5. **Net benefit.** `lost margin avoided + carrying cost saved - transfer cost`. Lost margin is the margin on units that would be missed over the lead time, capped by the quantity moved. Carrying cost uses a 20% annual rate and the donor's excess cover, capped at a year. Transfer cost is a flat $12 per unit. If one more unit saves less holding cost than that $12, the quantity stops at the lost-sales units. Transfers under 5 units, or with a net benefit of 0 or less, are skipped.
6. **Fallbacks.** A receiver that is still short is a reorder up to the greater of the 14-day target and the reorder point. If the SKU has overstock and nobody is short, the surplus is a markdown at 30% off. The benefit compares clearing now with the full-price margin that would have been earned over the hold window, plus the holding cost avoided.
7. **Ranking.** Sort by net benefit, then SKU, branch, and action. The $25 materiality screen is applied in the API service, after this ranking, so the engine's golden quantities stay put.

## Why this, not ML or linear programming

A learned demand model and a network LP would both need more history than 120 days, and neither would show its work in one sentence. This version is explainable, deterministic, and covered by a worked example (60 units from branch B to branch A). Pairing inside one SKU is a small loop. Across SKUs the work is independent, so the shape is closer to O(n log n) ranking of the resulting actions than to a single giant program. A solver can replace `greedyMatcher` later without rewriting classification. A forecaster can replace `ewmaForecaster` the same way.

## Assumptions

- Lead time belongs to the product, from 1 to 21 days, not to the lane between branches.
- Service level `z = 1.65`.
- Annual holding cost is 20% of unit cost.
- Markdowns take 30% off the shelf price.
- Transfer cost is $12 per unit. There is no truck, no case pack, and no expiry date.
- Transfers are available the same morning. Reorders arrive after the lead time.
- Branches do not compete for the same inbound truck.
- Demand during the lead time is treated as roughly normal and independent across branches.
- Prices are $2 to $150. Unit cost is 55% to 75% of price.
- The backtest still delivers the receipts implied by history, then adds StockFlow's moves on top. It does not cancel purchase orders the old process already sent.

## Known limitations

- Normal demand is a poor fit for intermittent SKUs. A zero-inflated or Croston estimate would change who looks "dead."
- Branches are independent except for the explicit transfer. A promotion in one city does not move the prior of another.
- The transfer cost does not depend on distance or on how full the truck is.
- Greedy matching is not a proven optimum. A later pair can be better once an earlier pair is fixed, and we do not search that.
- The morning plan is computed once per process. An approve does not change tomorrow's on-hand.
- Actions under $25 or under the minimum transfer quantity are hidden by the service. They are still produced by the engine.

## Scaling path

At about 100 times the SKU count the per-SKU loop is still the unit of work.

- Run one worker per SKU, or per SKU shard. Classification and matching do not talk across SKUs.
- Recompute a SKU when its sales or a decision for that SKU change, not the whole network on every request.
- Keep daily rollups for the charts. The engine can keep reading the compact series.
- Swap the forecaster for Holt-Winters, Croston, or a model that has enough history. `Forecaster.estimateDemand` is the seam.
- Swap the matcher for min-cost flow or a mixed-integer program when branch count makes the pair loop too coarse. `Matcher.match` is the seam.
- Store facts in a MongoDB time-series collection with a compound shard key of branch, SKU, and date. The unique index is already `(branchId, sku, date)`.
- Move the engine to its own worker when the API process should only serve the last result.

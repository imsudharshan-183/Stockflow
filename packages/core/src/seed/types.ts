import type { Branch, Product } from "../schemas/index.js";

/** Compact history. Index order is sku, then branch, then day. */
export interface Dataset {
  /** Last date in the baseline history, before live submissions. */
  baselineThrough?: string;
  /** Sparse additional business dates. On these dates only the listed branch/SKU pairs reported sales. */
  submissions?: Record<string, Set<string>>;
  seed: number;
  asOf: string;
  dates: string[];
  branches: Branch[];
  products: Product[];
  sales: number[][][];
  /** End-of-day on hand, after sales and receipts. */
  onHand: number[][][];
  /** Units customers wanted, including units missed on stockout days. Backtest only. */
  demand: number[][][];
}

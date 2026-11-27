import { can, matchesProductQuery, type CatalogLookup, type ChatIntent, type User } from "@stockflow/core";
import type { StockRuntimeState } from "./runtimeState.js";
import { projectPositionFor } from "./projection.js";
import type { BriefRecords } from "./briefFacts.js";

const baseQuery: CatalogLookup = { metric: "sku", operator: "any", amount: 0, sort: "sku", view: "count" };
const words = { gt: "over", gte: "at least", lt: "under", lte: "at most", eq: "exactly" } as const;

/** Offline forms for common questions. More complex wording goes through the model's typed lookup. */
export function localCatalogIntent(question: string, previous?: ChatIntent): ChatIntent | undefined {
  const q = question.toLowerCase().trim().replace(/[?!.]+$/, "");
  const prior = previous?.topic === "catalog" ? previous.catalog : undefined;
  const make = (catalog: CatalogLookup, search = ""): ChatIntent => ({ topic: "catalog", search, catalog });
  if (/^(?:see|show)(?: me)? (?:the )?highest[- ]priced products$/.test(q))
    return make({ ...baseQuery, metric: "price", sort: "descending", view: "list" });
  const cutoff = q.match(/^(?:(?:what about|how about|and)\s+)?(?:bh?d\s*)?(\d+(?:\.\d{1,3})?)(?:\s*bh?d)?$/);
  if (prior && prior.operator !== "any" && cutoff && (!/bh?d/.test(q) || prior.metric === "price"))
    return make({ ...prior, amount: Number(cutoff[1]) }, previous!.search);
  if (prior && /^(?:which (?:ones|products)|(?:list|show)(?: me)? (?:them|those|the products))$/.test(q))
    return make({ ...prior, view: "list" }, previous!.search);
  const prefix = /^(how many|count|list|show(?: me)?) (?:active |distinct )?(?:products|skus|items)(?: do (?:i|we) have)?\b/;
  const start = q.match(prefix);
  const follow = prior && /^(?:what about|how about|and)\s+/.exec(q);
  if (!start && !follow) return;
  const rest = q.slice((start || follow)![0].length).trim();
  const view = start ? (/^(?:list|show)/.test(q) ? "list" : "count") : prior!.view;
  if (!rest) return make({ ...baseQuery, view });
  const condition = rest.match(/^(?:(?:are|with|priced|costing|cost|have|stock)\s+)*(over|above|more than|at least|under|below|less than|at most|exactly)\s*(?:(bhd|bd)\s*)?(\d+(?:\.\d{1,3})?)\s*(bhd|bd|units?(?: on hand)?|on hand)?$/);
  if (!condition) return;
  const [, comparison, currency, amount, unit] = condition;
  const metric = currency || unit === "bd" || unit === "bhd" || /priced|costing/.test(rest)
    ? "price" : unit ? "onHand" : prior?.metric;
  if (!metric || metric === "sku") return;
  const operator = { over: "gt", above: "gt", "more than": "gt", "at least": "gte", under: "lt", below: "lt", "less than": "lt", "at most": "lte", exactly: "eq" } as const;
  return make({ ...baseQuery, metric, view, operator: operator[comparison as keyof typeof operator], amount: Number(amount) }, follow ? previous!.search : "");
}

function matches(value: number, query: CatalogLookup) {
  switch (query.operator) {
    case "gt": return value > query.amount;
    case "gte": return value >= query.amount;
    case "lt": return value < query.amount;
    case "lte": return value <= query.amount;
    case "eq": return value === query.amount;
    case "any": return true;
  }
}

export function readChatCatalog(runtime: StockRuntimeState, user: User, storeIds: string[], intent: ChatIntent, today: string): BriefRecords {
  const query = intent.catalog;
  const empty = (summary: string) => ({ summary, facts: [], asOf: today });
  if (!query || (query.metric === "sku" && query.operator !== "any"))
    return empty("Should I count distinct products, compare selling prices in BD, or compare units on hand?");
  if (query.metric === "price" && !can(user.role, "dashboard:financial:scoped"))
    return empty("Your store role can look up product counts and units on hand. Selling prices are available to managers and admins.");
  if (!storeIds.length) return empty("There are no active stores in your selected scope.");
  const { data } = runtime;
  const branches = data.branches.flatMap((b, index) => storeIds.includes(b.id) ? [index] : []);
  const rows = data.products.flatMap((product, productIndex) => {
    if ((product.status ?? "active") !== "active") return [];
    if (!matchesProductQuery(product, intent.search) && !product.category.toLowerCase().includes(intent.search.toLowerCase())) return [];
    const value = query.metric === "onHand"
      ? branches.reduce((sum, branchIndex) => sum + (projectPositionFor(data, runtime.analysis, runtime.committedDeltas, productIndex, branchIndex)?.onHand ?? 0), 0)
      : query.metric === "price" ? product.price : 0;
    return matches(value, query) ? [{ product, value }] : [];
  });
  const bySku = (a: typeof rows[number], b: typeof rows[number]) => a.product.sku.localeCompare(b.product.sku);
  rows.sort((a, b) => (query.sort === "ascending" ? a.value - b.value : query.sort === "descending" ? b.value - a.value : 0) || bySku(a, b));
  const format = (n: number) => query.metric === "price" ? `BD ${n.toFixed(3)}` : `${n} ${n === 1 ? "unit" : "units"}`;
  const condition = query.operator === "any" ? "" : ` ${words[query.operator]} ${format(query.amount)}`;
  const scope = storeIds.length === 1 ? data.branches[branches[0]!]!.name : `the ${branches.length} selected stores`;
  const description = query.metric === "onHand" ? `${condition} on hand across ${scope}` :
    query.metric === "price" && condition ? ` priced${condition} in the shared catalog` : " in the shared catalog";
  const filterLabel = intent.search ? ` matching “${intent.search}”` : "";
  const summary = !rows.length && query.metric === "price" && condition
    ? `No active products${filterLabel} in the shared catalog are priced${condition}.`
    : `${rows.length || "No"} active ${rows.length === 1 ? "product" : "products"}${filterLabel}${description}.`;
  const limit = 10;
  const facts = query.view === "count" ? [] : rows.slice(0, limit).map(({ product, value }) => ({
    id: product.sku, label: product.name, value: query.metric === "sku" ? product.sku : format(value),
    href: `/products/${encodeURIComponent(product.sku)}${storeIds.length === 1 ? "?location=" + encodeURIComponent(storeIds[0]!) : ""}`,
  }));
  const rankedPrices = query.view === "list" && query.metric === "price" && query.sort === "descending" && rows.length > 0;
  return {
    summary: rankedPrices ? `Showing ${facts.length} of ${rows.length} matching products, highest price first.` :
      summary + (facts.length && rows.length > limit ? ` Showing the first ${limit}.` : ""),
    facts, asOf: query.metric === "onHand" ? data.asOf : today,
  };
}

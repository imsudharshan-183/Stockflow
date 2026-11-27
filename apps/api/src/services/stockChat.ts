import {
  ChatIntentSchema,
  ChatTopicSchema,
  getBahrainToday,
  isBranchInScope,
  StoreOrderSchema,
  type ChatIntent,
  type ChatRequest,
  type ChatResponse,
  type User,
} from "@stockflow/core";
import { latestSubmissionDates, reportedDailySales } from "../db.js";
import { BranchNotFoundError, DecisionForbiddenError } from "./errors.js";
import type { StockServices } from "./index.js";
import { collectBriefRecords, type BriefRecords } from "./briefFacts.js";
import { modelProvider, requestStructuredOutput, type ModelConfig } from "./modelOutput.js";
import { localCatalogIntent, readChatCatalog } from "./chatCatalog.js";

function glossaryAnswer(question: string): string {
  const terms: Record<string, string> = {
    sku: "SKU means the unique code used to identify a product.",
    cover: "Stock cover estimates how many days current inventory may last at forecast demand.",
    "at risk": "At risk means projected demand may exceed available stock soon.",
    reorder: "A reorder replenishes a store from its supplier.",
    markdown: "A markdown lowers a product's price to help release slow or excess stock.",
    transfer: "A transfer moves available stock from one store to another.",
    "net benefit": "Net benefit estimates the gain after relevant costs such as freight.",
    forecast: "A forecast estimates future demand from recorded sales history and the stock engine's rules.",
    velocity: "Velocity is the estimated units sold per day.",
    "safety stock": "Safety stock is a buffer held to reduce the chance of running out during demand or supplier delays.",
    bd: "BD is the Bahraini dinar, the currency used for StockFlow financial values.",
    bhd: "BHD is the currency code for the Bahraini dinar.",
  };
  const term = Object.keys(terms).find((item) => question.toLowerCase().includes(item));
  return term ? terms[term]! : "StockFlow helps retail teams record store sales, monitor inventory, review replenishment actions, and coordinate transfers. Ask me about a term such as stock cover, forecast, reorder, transfer, or net benefit.";
}

function localIntent(question: string, previous?: ChatIntent): ChatIntent {
  const result = (topic: ChatIntent["topic"], search = "") => ({ topic, search, catalog: undefined });
  const q = question.trim();
  const catalog = localCatalogIntent(question, previous);
  if (catalog) return catalog;
  if (/^(refresh|again|show (them|those) again|what about now)[?!. ]*$/i.test(q) && previous)
    return previous;
  if (/\b(delete|modify|cancel|approve|update|insert|password|credentials)\b/i.test(q))
    return result("help");
  if (/\b(what is|what does|define|meaning of|explain)\b/i.test(q) && !/SKU-\d+/i.test(q) && /\b(cover|at risk|reorder|markdown|transfer|forecast|safety stock|velocity|net benefit|bd|bhd|sku)\b/i.test(q))
    return result("glossary");
  const sku = q.match(/\bSKU-\d+\b/i);
  if (/\b(forecast|velocity|demand|cover)\b/i.test(q) && sku) return result("forecast", sku[0].toUpperCase());
  if (sku) return result("product", sku[0].toUpperCase());
  const product = q.match(
    /^(?:find|search(?: for)?|look up|stock (?:of|for)|how much stock (?:of|for))\s+(.+)/i,
  );
  if (product)
    return result(
      "product",
      product[1]!
        .replace(/[?!.]+$/, "")
        .trim()
        .slice(0, 100),
    );
  if (/\b(sales|sold)\b/i.test(q))
    return result(
      /\b(yesterday|week|month|year|ago)\b|\d{4}-\d{2}-\d{2}/i.test(q) ? "help" : "sales",
    );
  if (/shortage|low stock|run(?:ning)? (?:out|low)|shelf|at risk/i.test(q))
    return result("shortages");
  if (/forecast|cover|velocity|demand|how fast/i.test(q)) return result("forecast");
  if (/deliver|shipment|receipt/i.test(q)) return result("deliveries");
  if (/transfer|release/i.test(q)) return result("transfers");
  if (/brief|attention|overview|priorit|review|pending/i.test(q)) return result("overview");
  return result("help");
}

async function interpret(input: ChatRequest, model: ModelConfig, user: User, storeNames: string[]) {
  const question = input.question;
  const records = (intent: ChatIntent) => ({ intent, source: "records" as const });
  const help = () => records({ topic: "help", search: "" });
  if (/\b(yesterday|tomorrow|last (?:week|month|quarter|year)|weather|temperature|sports|historical|revenue|profits?|delete|approve|cancel|password|credentials)\b|\d{4}-\d{2}-\d{2}/i.test(question))
    return help();
  if (/^(?:summari[sz]e|show|refresh) (?:my |our )?today[’']?s (?:uploaded |reported )?sales[.!?]*$/i.test(question) ||
      ((input.page === "sales" || input.previous?.topic === "sales") &&
        /^summari[sz]e (?:it|this|the data|the upload|my upload)[.!?]*$/i.test(question)))
    return records({ topic: "sales", search: "" });
  if (input.productSku && /^(?:how much of this product is on hand|show (?:stock|forecast) for this product)[?.!]*$/i.test(question))
    return records({ topic: /forecast/i.test(question) ? "forecast" : "product", search: input.productSku });
  const productCode = question.match(/\bSKU-\d+\b/i)?.[0].toUpperCase();
  if (productCode && /\b(sales|sold)\b/i.test(question)) return help();
  if (productCode && /\b(forecast|velocity|cover|demand)\b/i.test(question))
    return records({ topic: "forecast", search: productCode });
  const catalog = localCatalogIntent(question, input.previous);
  if (catalog) return records(catalog);
  if (/^find a product by sku[?.!]*$/i.test(question)) return records({ topic: "product", search: "" });
  if (/^what should i check today[?.!]*$/i.test(question)) return records({ topic: "overview", search: "" });
  if (/^how (?:do|can) i flag (?:a )?stock (?:issue|alert)[?.!]*$/i.test(question))
    return records({ topic: "guide", search: "" });
  if (/^(refresh|again|show (them|those) again|what about now)[?!. ]*$/i.test(question) && input.previous)
    return records(input.previous);
  const output = await requestStructuredOutput(
    model,
    "stock_lookup",
    `You are StockFlow's assistant for a Bahrain retail inventory and replenishment system. Explain its workflows and glossary in plain language, and answer questions about live business records only through the fixed lookup types below. Signed-in role: ${user.role}. The authorized store names are supplied as data.

Role rules: Admin can ask operational and financial questions across the network and manage/review queues. Manager can ask operational and financial questions only about assigned stores and review their work. Staff can ask simple operational questions for their assigned/selected store, such as product stock, low stock, deliveries to receive, and how to record sales or flag stock. Staff cannot see BD financial metrics, network reports, forecasts across other stores, management release queues, users, or audit details. The server enforces these limits regardless of this interpretation.

Glossary: SKU is a product identifier. Stock cover is estimated days remaining at forecast demand. At risk means stock is projected to run short. Reorder brings stock from a supplier. Transfer moves available stock between stores. Markdown reduces price to release slow or excess stock. Net benefit is estimated gain after relevant costs. Forecast is an estimate based on recorded demand and the system's forecasting rules. A missing sales entry means the store has not reported, not that sales were zero.

Allowed live lookups: sales reports today's reported units only; deliveries are committed incoming shipments; transfers are requests awaiting release; shortages are low stock; forecast returns stock cover and demand velocity in authorized stores; overview is current morning priorities and report status; catalog counts/lists products or compares selling prices in BD for admin/manager, and on-hand units for allowed stores; product finds a product by name or SKU. For catalog provide metric (sku, price, onHand), operator (any, gt, gte, lt, lte, eq), numeric amount, sort (sku, ascending, descending), and view (count or list). Use the prior intent for follow-ups. For glossary select glossary. Guide is only for instructions for flagging a stock issue. If a request asks historical dates, sales revenue/profit not supported by fixed metrics, a mutation, private user/security data, or content outside StockFlow, select help and briefly redirect to supported features. Never generate queries, code, make up figures, or claim an action was performed.`,
    { question: input.question, previous: input.previous, role: user.role, authorizedStores: storeNames },
    {
      type: "object",
      additionalProperties: false,
      required: ["topic", "search", "catalog"],
      properties: {
        topic: { type: "string", enum: ChatTopicSchema.options },
        search: { type: "string" },
        catalog: {
          type: ["object", "null"],
          properties: {
            metric: { type: "string", enum: ["sku", "price", "onHand"] },
            operator: { type: "string", enum: ["any", "gt", "gte", "lt", "lte", "eq"] },
            amount: { type: "number" },
            sort: { type: "string", enum: ["sku", "ascending", "descending"] },
            view: { type: "string", enum: ["count", "list"] },
          },
          required: ["metric", "operator", "amount", "sort", "view"],
          additionalProperties: false,
        },
      },
    },
  );
  const parsed = ChatIntentSchema.safeParse(output);
  const inferred = parsed.success ? parsed.data : localIntent(question, input.previous);
  if (productCode && inferred.topic !== "help") {
    if (inferred.topic !== "forecast" && inferred.topic !== "product") return help();
    inferred.search = productCode;
  }
  const words = question.toLowerCase();
  const refersBack = /\b(it|them|those|that|same|again|what about|how about)\b/i.test(question);
  if (inferred.search && !words.includes(inferred.search.toLowerCase()) && !(refersBack && inferred.search === input.previous?.search)) return help();
  if (inferred.topic === "sales" && (inferred.search || /\b(for|of)\s+(?:product|sku|item)\b/i.test(question) || /\b(week|month|year|ago|margin|BD|BHD)\b/i.test(question))) return help();
  if (inferred.topic === "catalog" && inferred.catalog?.operator === "any" && /\b(over|under|above|below|at least|at most|more than|less than)\b/i.test(question)) return help();
  if (inferred.topic === "catalog" && inferred.catalog?.operator !== "any") {
    const amounts = (question.replace(/\b(?:BR|SKU)-\d+\b/gi, "").match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
    if (!inferred.catalog || !amounts.includes(inferred.catalog.amount)) return help();
  }
  return parsed.success ? { intent: inferred, source: modelProvider(model) } : records(inferred);
}

export async function answerStockQuestion(
  services: StockServices,
  user: User,
  input: ChatRequest,
  model: ModelConfig,
): Promise<ChatResponse> {
  const mentioned = input.question.match(/\bBR-\d+\b/gi)?.map((id) => id.toUpperCase()) ?? [];
  await services.ensureFreshPlan();
  const named = services.runtime.data.branches.filter((store) => input.question.toLowerCase().includes(store.name.toLowerCase()));
  mentioned.push(...named.map((store) => store.id));
  const firstRisk = /^(?:why is the first (?:item|product|one) at risk|explain the first (?:item|product|one))[?!.]*$/i.test(input.question);
  const firstItem = firstRisk && input.previous?.topic === "shortages" ? input.previous.firstItem : undefined;
  const bareAmount = /^(?:bh?d\s*)?\d+(?:\.\d+)?(?:\s*bh?d)?[?!.]*$/i.test(input.question);
  const followUp = firstRisk || bareAmount || /^(?:again|refresh|and\b|what about\b|how about\b|list them|show (?:them|those)|which (?:ones|products)[?!.]*$|see highest-priced|summari[sz]e (?:it|this|the data|the upload)\b)/i.test(input.question);
  const branch =
    input.branchId ?? mentioned[0] ?? (followUp ? input.previous?.branchId : undefined) ?? firstItem?.branchId ?? (user.role === "staff" ? user.branchIds[0] : undefined);
  if (
    (branch && !isBranchInScope(user, branch)) ||
    (firstItem && !isBranchInScope(user, firstItem.branchId)) ||
    mentioned.some((id) => !isBranchInScope(user, id))
  )
    throw new DecisionForbiddenError("Branch outside your assigned stores");
  const stores = services.runtime.data.branches.filter(
    (b) => b.status !== "archived" && isBranchInScope(user, b.id) && (!branch || branch === b.id),
  );
  if (branch && !stores.length) throw new BranchNotFoundError("Store not found");
  const today = getBahrainToday(services.runtime.now()).isoDate;
  if (firstRisk || /^(?:why is (?:it|that|that item) at risk|why that one)[?!.]*$/i.test(input.question)) {
    const store = stores.find((b) => b.id === firstItem?.branchId);
    const item = store && firstItem && services.catalog.locationInventory(store.id, {
      search: firstItem.sku, page: 1, limit: 1, sortBy: "sku", sortDir: "asc",
    }, user)?.items.find((row) => row.sku === firstItem.sku);
    if (!store || !item) return {
      summary: "Which product and store do you mean? Ask for low stock to see the current list.",
      facts: [], asOf: today, context: { topic: "help", search: "", branchId: branch }, source: "records",
    };
    const incoming = item.inTransit ? ` and ${item.inTransit} units on the way` : "";
    const reason = item.status === "AT_RISK"
      ? `This falls below the reorder point of about ${item.reorderPoint} units.`
      : "The latest stock plan no longer flags this item as at risk.";
    const cover = item.coverDays === null ? "" : ` Estimated stock cover is ${item.coverDays.toFixed(1)} days.`;
    return {
      summary: `${store.name} has ${item.onHand} units of ${item.name} on hand${incoming}. ${reason}${cover}`,
      facts: [{ id: item.sku, label: item.name, value: `${item.velocity.toFixed(2)} units sold per day (forecast)`,
        href: `/products/${encodeURIComponent(item.sku)}?location=${encodeURIComponent(store.id)}&branch=${encodeURIComponent(store.id)}` }],
      asOf: services.runtime.data.asOf, context: { topic: "forecast", search: item.sku, branchId: store.id }, source: "records",
    };
  }
  const previous = input.previous && ChatIntentSchema.strip().parse(input.previous);
  const { intent: proposed, source } = await interpret({ ...input, previous }, model, user, stores.map((store) => store.name));
  const intent = { ...proposed, branchId: branch };
  const reply = (
    summary: string,
    facts: BriefRecords["facts"] = [],
    asOf = today,
  ): ChatResponse => ({ summary, facts, asOf, context: intent, source });
  if (mentioned.some((id) => id !== branch))
    return reply("Choose the store in the location selector, then ask about that store.");
  if (intent.topic === "help")
    return reply(
      user.role === "staff" ? "I can check stock, reported units sold today, and incoming deliveries for your store. Which would help?" : "I can count products, filter shared catalog prices, check units on hand, find a product, or look up today’s sales, low stock, and incoming deliveries.",
    );
  if (intent.topic === "guide")
    return reply(user.role === "staff"
      ? "Open Store inventory, find the product and choose Flag stock. Select the issue, describe what you found, then choose Submit alert."
      : "Staff can flag a product in Store inventory. You can review submitted alerts from your overview.");
  if (intent.topic === "glossary")
    return reply(glossaryAnswer(input.question));
  const ids = stores.map((store) => store.id);
  if (intent.topic === "sales") {
    if (!stores.length) return reply("There are no active stores in your selected scope.");
    const totals = await reportedDailySales(ids, today, services.repositoryKind() === "mongo");
    const units = totals.reduce((sum, row) => sum + row.units, 0);
    const reporting = new Set(totals.map((row) => row._id));
    const missing = stores.filter((store) => !reporting.has(store.id));
    if (!totals.length)
      return reply(stores.length === 1 ? `${stores[0]!.name} hasn’t submitted any sales entries today.` :
        `No sales entries have been submitted today by the ${stores.length} stores in your scope.`);
    const facts = totals
      .sort((a, b) => b.units - a.units || a._id.localeCompare(b._id))
      .map((row) => ({
        id: row._id,
        label: stores.find((store) => store.id === row._id)!.name,
        value: `${row.units} ${row.units === 1 ? "unit" : "units"} · ${row.entries} ${row.entries === 1 ? "entry" : "entries"}`,
      }));
    if (missing.length) facts.push({
      id: "awaiting_reports", label: "Still to report", value: missing.map((store) => store.name).join(", "),
    });
    const sold = `${units} ${units === 1 ? "unit" : "units"} sold today`;
    return reply(stores.length === 1 ? `${stores[0]!.name} reported ${sold}.` :
      `${sold}, based on entries from ${totals.length} of ${stores.length} stores.`, facts);
  }
  if (intent.topic === "catalog")
    return { ...readChatCatalog(services.runtime, user, ids, intent, today), context: intent, source };
  if (intent.topic === "forecast") {
    const items = stores.flatMap((store) =>
      (services.catalog.locationInventory(
        store.id,
        { search: intent.search, page: 1, limit: 4, sortBy: "coverDays", sortDir: "asc" },
        user,
      )?.items ?? []).slice(0, 4).map((item) => ({
        id: `${store.id}:${item.sku}`,
        label: `${item.name} · ${store.name}`,
        value: `${item.velocity.toFixed(2)} units/day · ${item.velocity === 0 || item.coverDays === null ? "cover unavailable" : `${item.coverDays.toFixed(1)} days cover`}`,
        href: `/products/${encodeURIComponent(item.sku)}?branch=${encodeURIComponent(store.id)}`,
      })),
    ).slice(0, 10);
    return reply(items.length ? "Here are up to ten matching store listings with estimated daily demand and days of stock cover." : "I couldn’t find matching forecast records in these stores.", items, services.runtime.data.asOf);
  }
  if (intent.topic === "product") {
    if (!intent.search) return reply("Which product name or SKU should I look up?");
    const dates = await latestSubmissionDates(ids, services.repositoryKind() === "mongo");
    const asOf = [
      services.runtime.data.baselineThrough ?? services.runtime.data.asOf,
      ...dates.values(),
    ]
      .sort()
      .at(-1)!;
    const items = stores.flatMap((store) => {
      const result = services.catalog.locationInventory(
        store.id,
        { search: intent.search, page: 1, limit: 3, sortBy: "sku", sortDir: "asc" },
        user,
      );
      return (result?.items ?? []).map((item) => ({
        id: store.id + ":" + item.sku,
        label: `${item.name} · ${store.name}`,
        value: `${item.onHand} units on hand`,
        href: `/products/${encodeURIComponent(item.sku)}?branch=${encodeURIComponent(store.id)}&location=${encodeURIComponent(store.id)}`,
      }));
    });
    return reply(
      items.length
        ? `Stock matches for “${intent.search}” (up to six store listings).`
        : `No stock records matched “${intent.search}” in this scope.`,
      items.slice(0, 6),
      asOf,
    );
  }
  if (intent.topic === "deliveries") {
    const results = services.runtime.repo.listStoreDeliveries
      ? (await Promise.all(ids.map((id) => services.runtime.repo.listStoreDeliveries!(id)))).flat()
      : (await services.orders.list({ status: "COMMITTED", queue: "outgoing", branch }, user))
          .orders;
    const deliveries = StoreOrderSchema.array()
      .parse(results)
      .filter((o) => ids.includes(o.targetBranchId) && o.type !== "MARKDOWN");
    return reply(
      deliveries.length
        ? `${deliveries.length} deliveries await receipt. Here are the first ${Math.min(5, deliveries.length)}.`
        : "There are no incoming deliveries awaiting receipt in this scope.",
      deliveries.slice(0, 5).map((o) => ({
        id: o.id,
        label: `${o.productName} · ${o.targetBranchName}`,
        value: `${o.quantity} units`,
        href:
          user.role === "staff"
            ? `/?location=${encodeURIComponent(o.targetBranchId)}#store-deliveries`
            : `/queue?tab=outgoing&order=${encodeURIComponent(o.id)}`,
      })),
    );
  }
  if (intent.topic === "transfers" && user.role === "staff")
    return reply(
      "Managers review release requests. Ask about incoming deliveries to see the shipments your store can receive.",
    );
  const records = await collectBriefRecords(services, user, { branchId: branch });
  if (intent.topic === "overview") return { ...records, source, context: intent };
  const facts = records.facts.filter((f) =>
    intent.topic === "shortages"
      ? /^(shortage_|shelf_check_)/.test(f.id)
      : f.id === "transfer_awaiting_release",
  );
  const answer = reply(
    intent.topic === "shortages"
      ? facts.length
        ? "These products have the shortest stock cover in this scope."
        : "No imminent shortages are listed in this scope."
      : facts.length
        ? "This transfer is awaiting release."
        : "No transfers are currently awaiting release in this scope.",
    facts,
    records.asOf,
  );
  if (intent.topic === "shortages") answer.context.firstItem = facts[0]?.position;
  return answer;
}

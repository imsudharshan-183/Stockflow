import { z } from "zod";

export const BriefRequestSchema = z.union([
  z.strictObject({ branchId: z.string().min(1).max(100).optional() }),
  z.strictObject({ orderId: z.string().min(1).max(250) }),
]);
export const BriefResponseSchema = z.object({
  source: z.enum(["records", "openai", "gemini"]),
  asOf: z.iso.date(),
  summary: z.string(),
  facts: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      value: z.string(),
      href: z.string().optional(),
    }),
  ),
});
export type BriefRequest = z.infer<typeof BriefRequestSchema>;
export type BriefResponse = z.infer<typeof BriefResponseSchema>;

export const ChatTopicSchema = z.enum([
  "overview",
  "shortages",
  "forecast",
  "sales",
  "product",
  "catalog",
  "glossary",
  "guide",
  "deliveries",
  "transfers",
  "help",
]);
export const CatalogLookupSchema = z.strictObject({
  metric: z.enum(["sku", "price", "onHand"]),
  operator: z.enum(["any", "gt", "gte", "lt", "lte", "eq"]),
  amount: z.number().nonnegative(),
  sort: z.enum(["sku", "ascending", "descending"]),
  view: z.enum(["count", "list"]),
});
export type CatalogLookup = z.infer<typeof CatalogLookupSchema>;
export const ChatIntentSchema = z.strictObject({
  topic: ChatTopicSchema,
  branchId: z.string().min(1).max(100).optional(),
  search: z.string().trim().max(100),
  catalog: CatalogLookupSchema.nullish(),
});
const ChatContextSchema = ChatIntentSchema.extend({
  firstItem: z.strictObject({
    sku: z.string().min(1).max(100),
    branchId: z.string().min(1).max(100),
  }).optional(),
});
export const ChatRequestSchema = z.strictObject({
  question: z.string().trim().min(1).max(500),
  branchId: z.string().min(1).max(100).optional(),
  productSku: z.string().trim().min(1).max(100).optional(),
  page: z.literal("sales").optional(),
  previous: ChatContextSchema.optional(),
});
export const ChatResponseSchema = BriefResponseSchema.extend({ context: ChatContextSchema });
export type ChatRequest = z.infer<typeof ChatRequestSchema>;
export type ChatIntent = z.infer<typeof ChatIntentSchema>;
export type ChatResponse = z.infer<typeof ChatResponseSchema>;

import {
  BriefResponseSchema,
  ChatResponseSchema,
  type ChatRequest,
  type BriefRequest,
  ApiAuditListSchema,
  BatchDecideResponseSchema,
  BranchDetailSchema,
  BranchListResponseSchema,
  BranchSchema,
  CreateBranchSchema,
  CreateProductSchema,
  CreateUserSchema,
  DonorCandidatesResponseSchema,
  ErrorBodySchema,
  HealthSchema,
  KpiSummarySchema,
  LifecycleOrderListResponseSchema,
  LifecycleOrderSchema,
  LifecycleRecommendationListSchema,
  LifecycleRecommendationSchema,
  LiveOverviewResponseSchema,
  LocationInventoryResponseSchema,
  LocationListResponseSchema,
  LocationSummaryResponseSchema,
  LocationTrendResponseSchema,
  LoginResponseSchema,
  ProductDetailSchema,
  ProductDetailWithHistorySchema,
  ProductListResponseSchema,
  StoreProductListSchema,
  StoreOrderSchema,
  StoreProductDetailSchema,
  ProductSchema,
  RecommendationSchema,
  ReplenishmentOrderSchema,
  ResolveStockAlertResponseSchema,
  StockAlertListSchema,
  StockAlertSchema,
  UpdateBranchSchema,
  UpdateProductSchema,
  UpdateUserSchema,
  UserListSchema,
  UserSchema,
  type ApiAuditList,
  type Branch,
  type BranchDetail,
  type BranchListQuery,
  type BranchListResponse,
  type CreateBranch,
  type CreateOrderRequest,
  type CreateProduct,
  type CreateStockAlert,
  type CreateUser,
  type DonorCandidatesResponse,
  type KpiSummary,
  type LifecycleOrder,
  type LifecycleOrderListResponse,
  type LifecycleRecommendation,
  type LifecycleRecommendationList,
  type LiveOverviewResponse,
  type LocationInventoryQuery,
  type LocationInventoryResponse,
  type LocationListResponse,
  type LocationSummaryResponse,
  type LocationTrendQuery,
  type LocationTrendResponse,
  type LoginRequest,
  type LoginResponse,
  type OrderCancelBody,
  type OrderCommitBody,
  type OrderDeclineBody,
  type OrderListQuery,
  type OrderReceiveBody,
  type OrderRequestTransferBody,
  type OrderRerouteBody,
  type Product,
  type ProductDetail,
  type ProductDetailWithHistory,
  type ProductListQuery,
  type ProductListResponse,
  type QueueLifecycleView,
  type Recommendation,
  type RecommendationQuery,
  type ReplenishmentOrder,
  type ResolveStockAlert,
  type ResolveStockAlertResponse,
  type StockAlert,
  type StockAlertList,
  type UpdateBranch,
  type UpdateProduct,
  type UpdateUser,
  type User,
  type UserList,
} from "@stockflow/core";
import { z, type ZodType } from "zod";

export type { LifecycleOrder, LiveOverviewResponse, QueueLifecycleView };

const TOKEN_STORAGE_KEY = "stockflow_access_token";

let inMemoryAccessToken: string | null = (() => {
  try {
    return window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
})();

let onAuthFailedCallback: (() => void) | null = null;

export function setAccessToken(token: string | null): void {
  inMemoryAccessToken = token;
  try {
    if (token) {
      window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    } else {
      window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    // Ignore storage quota or privacy mode errors
  }
}

export function setOnAuthFailed(callback: () => void): void {
  onAuthFailedCallback = callback;
}

async function request<T>(
  path: string,
  schema: ZodType<T>,
  init: RequestInit = {},
  isRetry = false,
): Promise<T> {
  const headers = new Headers(init.headers || {});
  if (inMemoryAccessToken && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${inMemoryAccessToken}`);
  }

  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "include",
  });

  if (response.status === 401 && !isRetry && !path.includes("/api/auth/login") && !path.includes("/api/auth/refresh")) {
    // Attempt silent refresh
    try {
      const refreshRes = await fetch("/api/auth/refresh", {
        method: "POST",
        credentials: "include",
      });
      if (refreshRes.ok) {
        const refreshData = LoginResponseSchema.parse(await refreshRes.json());
        setAccessToken(refreshData.token);
        return request(path, schema, init, true);
      }
    } catch {
      // Refresh failed
    }

    setAccessToken(null);
    if (onAuthFailedCallback) {
      onAuthFailedCallback();
    }
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = ErrorBodySchema.safeParse(body);
    throw new Error(parsed.success ? parsed.data.error : `Request failed (${response.status})`);
  }
  return schema.parse(body);
}

function withQuery(path: string, query: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  }
  const text = params.toString();
  return text.length > 0 ? `${path}?${text}` : path;
}

export const api = {
  health: () => request("/api/health", HealthSchema),
  simulateNextDay: () => request("/api/catalog/simulate-next-day", z.object({
    targetDate: z.string(), branches: z.number().int(), rows: z.number().int(),
  }), { method: "POST" }),
  chat: (input: ChatRequest) => request("/api/ai/chat", ChatResponseSchema, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  }),
  brief: (input: BriefRequest) => request("/api/ai/brief", BriefResponseSchema, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  }),
  // Auth
  login: (credentials: LoginRequest): Promise<LoginResponse> =>
    request("/api/auth/login", LoginResponseSchema, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(credentials),
    }),
  refresh: (): Promise<LoginResponse> =>
    request("/api/auth/refresh", LoginResponseSchema, {
      method: "POST",
    }),
  logout: (): Promise<{ ok: boolean }> =>
    request("/api/auth/logout", z.object({ ok: z.boolean() }), {
      method: "POST",
    }),
  me: (): Promise<{ user: User }> =>
    request("/api/auth/me", z.object({ user: UserSchema })),

  // Users Admin
  listUsers: (): Promise<UserList> => request("/api/users", UserListSchema),
  createUser: (data: CreateUser): Promise<User> =>
    request("/api/users", UserSchema, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(CreateUserSchema.parse(data)),
    }),
  updateUser: (id: string, data: UpdateUser): Promise<User> =>
    request(`/api/users/${encodeURIComponent(id)}`, UserSchema, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(UpdateUserSchema.parse(data)),
    }),
  resetPassword: (id: string, password: string): Promise<{ ok: boolean }> =>
    request(`/api/users/${encodeURIComponent(id)}/reset-password`, z.object({ ok: z.boolean() }), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    }),
  deactivateUser: (id: string): Promise<{ ok: boolean }> =>
    request(`/api/users/${encodeURIComponent(id)}`, z.object({ ok: z.boolean() }), {
      method: "DELETE",
    }),

  // Stock
  kpis: (branch?: string): Promise<KpiSummary> =>
    request(withQuery("/api/kpis", branch ? { branch } : {}), KpiSummarySchema),
  kpisLive: (branch?: string): Promise<LiveOverviewResponse> =>
    request(withQuery("/api/kpis/live", branch ? { branch } : {}), LiveOverviewResponseSchema),
  audit: (branch?: string): Promise<ApiAuditList> =>
    request(withQuery("/api/audit", branch ? { branch } : {}), ApiAuditListSchema),
  recommendations: (
    query: RecommendationQuery & { view?: QueueLifecycleView },
  ): Promise<LifecycleRecommendationList> =>
    request(
      withQuery("/api/recommendations", query as Record<string, unknown>),
      LifecycleRecommendationListSchema,
    ),
  reopenRecommendation: (id: string, comment?: string): Promise<LifecycleRecommendation> =>
    request(`/api/recommendations/${encodeURIComponent(id)}/reopen`, LifecycleRecommendationSchema, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(comment ? { comment } : {}),
    }),
  branch: (id: string): Promise<BranchDetail> =>
    request(`/api/branches/${encodeURIComponent(id)}`, BranchDetailSchema),
  locations: (): Promise<LocationListResponse> =>
    request("/api/locations", LocationListResponseSchema),
  locationSummary: (id: string): Promise<LocationSummaryResponse> =>
    request(`/api/locations/${encodeURIComponent(id)}/summary`, LocationSummaryResponseSchema),
  locationInventory: (id: string, query?: Partial<LocationInventoryQuery>): Promise<LocationInventoryResponse> =>
    request(
      withQuery(`/api/locations/${encodeURIComponent(id)}/inventory`, (query ?? {}) as Record<string, unknown>),
      LocationInventoryResponseSchema,
    ),
  locationTrend: (id: string, query?: Partial<LocationTrendQuery>): Promise<LocationTrendResponse> =>
    request(
      withQuery(`/api/locations/${encodeURIComponent(id)}/trend`, (query ?? {}) as Record<string, unknown>),
      LocationTrendResponseSchema,
    ),
  product: (sku: string): Promise<ProductDetail> =>
    request(`/api/products/${encodeURIComponent(sku)}`, ProductDetailSchema),
  decide: (id: string, decision: "approve" | "reject"): Promise<Recommendation> =>
    request(`/api/recommendations/${encodeURIComponent(id)}/${decision}`, RecommendationSchema, {
      method: "POST",
    }),
  decideBatch: (
    ids: readonly string[],
    decision: "approve" | "reject",
    reasonCode?: string,
  ): Promise<{ results: Array<{ id: string; status: "ok" | "forbidden" | "not_found" | "already_decided" }> }> =>
    request("/api/recommendations/batch/decide", BatchDecideResponseSchema, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [...ids], decision, ...(reasonCode ? { reasonCode } : {}) }),
    }),

  // Branches Admin
  listBranches: (query?: Partial<BranchListQuery>): Promise<BranchListResponse> =>
    request(withQuery("/api/branches", (query ?? {}) as Record<string, unknown>), BranchListResponseSchema),
  createBranch: (data: CreateBranch): Promise<Branch> =>
    request("/api/branches", BranchSchema, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(CreateBranchSchema.parse(data)),
    }),
  updateBranch: (id: string, data: UpdateBranch): Promise<Branch> =>
    request(`/api/branches/${encodeURIComponent(id)}`, BranchSchema, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(UpdateBranchSchema.parse(data)),
    }),

  storeProducts: (query: ProductListQuery) =>
    request(withQuery("/api/catalog/products", query), StoreProductListSchema),
  storeProduct: (sku: string) =>
    request(`/api/products/${encodeURIComponent(sku)}`, StoreProductDetailSchema),
  // Catalog Products
  listCatalogProducts: (query?: ProductListQuery): Promise<ProductListResponse> =>
    request(withQuery("/api/catalog/products", (query ?? {}) as Record<string, unknown>), ProductListResponseSchema),
  getCatalogProduct: (sku: string): Promise<ProductDetailWithHistory> =>
    request(`/api/catalog/products/${encodeURIComponent(sku)}`, ProductDetailWithHistorySchema),
  createCatalogProduct: (data: CreateProduct): Promise<Product> =>
    request("/api/catalog/products", ProductSchema, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(CreateProductSchema.parse(data)),
    }),
  updateCatalogProduct: (sku: string, data: UpdateProduct): Promise<Product> =>
    request(`/api/catalog/products/${encodeURIComponent(sku)}`, ProductSchema, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(UpdateProductSchema.parse(data)),
    }),
  archiveCatalogProduct: (sku: string): Promise<{ product: Product; removedPendingActionsCount: number }> =>
    request(
      `/api/catalog/products/${encodeURIComponent(sku)}/archive`,
      z.object({ product: ProductSchema, removedPendingActionsCount: z.number() }),
      { method: "PATCH" },
    ),
  restoreCatalogProduct: (sku: string): Promise<Product> =>
    request(`/api/catalog/products/${encodeURIComponent(sku)}/restore`, ProductSchema, {
      method: "PATCH",
    }),
  deleteCatalogProduct: (sku: string): Promise<{ ok: boolean }> =>
    request(`/api/catalog/products/${encodeURIComponent(sku)}`, z.object({ ok: z.boolean() }), {
      method: "DELETE",
    }),
  generateSampleHistory: (sku: string): Promise<{ salesEntriesCount: number }> =>
    request(
      `/api/catalog/products/${encodeURIComponent(sku)}/sample-history`,
      z.object({ salesEntriesCount: z.number() }),
      { method: "POST" },
    ),

  // Sales entries
  listSalesEntries: (query?: {
    branch?: string;
    sku?: string;
    from?: string;
    to?: string;
    page?: number;
    limit?: number;
  }) =>
    request(
      withQuery("/api/sales-entries", (query ?? {}) as Record<string, unknown>),
      z.object({
        entries: z.array(
          z.object({
            id: z.string(),
            branchId: z.string(),
            sku: z.string(),
            date: z.string(),
            unitsSold: z.number(),
            onHand: z.number(),
            updatedAt: z.string(),
          }),
        ),
        total: z.number(),
        page: z.number(),
        limit: z.number(),
        totalPages: z.number(),
      }),
    ),
  createSalesEntry: (data: { branchId: string; sku: string; date: string; unitsSold: number; onHand: number }): Promise<unknown> =>
    request("/api/sales-entries", z.unknown(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
  updateSalesEntry: (id: string, data: { unitsSold: number; onHand: number }): Promise<unknown> =>
    request(`/api/sales-entries/${encodeURIComponent(id)}`, z.unknown(), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
  deleteSalesEntry: (id: string): Promise<{ ok: boolean }> =>
    request(`/api/sales-entries/${encodeURIComponent(id)}`, z.object({ ok: z.boolean() }), {
      method: "DELETE",
    }),
  importSalesCsv: (file: File, preview = false): Promise<{ planRefreshPending?: boolean; inserted: number; updated: number; errors: Array<{ row: number; message: string }> }> => {
    const formData = new FormData();
    formData.append("file", file);
    return request(
      preview ? "/api/sales-entries/import?preview=1" : "/api/sales-entries/import",
      z.object({
        planRefreshPending: z.boolean().optional(),
        inserted: z.number(),
        updated: z.number(),
        errors: z.array(z.object({ row: z.number(), message: z.string() })),
      }),
      {
        method: "POST",
        body: formData,
      },
    );
  },
  listSalesImports: (
    limit = 10,
  ): Promise<{
    imports: Array<{
      id: string;
      importedAt: string;
      fileName: string;
      user: { userId: string; name: string; role: "admin" | "manager" | "staff" };
      inserted: number;
      updated: number;
      errorCount: number;
      minDate: string | null;
      maxDate: string | null;
      branchIds: string[];
    }>;
  }> =>
    request(
      withQuery("/api/sales/imports", { limit }),
      z.object({
        imports: z.array(
          z.object({
            id: z.string(),
            importedAt: z.string(),
            fileName: z.string(),
            user: z.object({
              userId: z.string(),
              name: z.string(),
              role: z.enum(["admin", "manager", "staff"]),
            }),
            inserted: z.number(),
            updated: z.number(),
            errorCount: z.number(),
            minDate: z.string().nullable(),
            maxDate: z.string().nullable(),
            branchIds: z.array(z.string()),
          }),
        ),
      }),
    ),

  // Stock alerts
  listStockAlerts: (branchId?: string): Promise<StockAlertList> =>
    request(withQuery("/api/stock-alerts", branchId ? { branchId } : {}), StockAlertListSchema),
  createStockAlert: (payload: CreateStockAlert): Promise<StockAlert> =>
    request("/api/stock-alerts", StockAlertSchema, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  resolveStockAlert: (
    id: string,
    payload: ResolveStockAlert,
  ): Promise<ResolveStockAlertResponse> =>
    request(`/api/stock-alerts/${encodeURIComponent(id)}/resolve`, ResolveStockAlertResponseSchema, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  approveStockAlert: (id: string): Promise<StockAlert> =>
    request(`/api/stock-alerts/${encodeURIComponent(id)}/approve`, StockAlertSchema, {
      method: "PATCH",
    }),
  rejectStockAlert: (id: string): Promise<StockAlert> =>
    request(`/api/stock-alerts/${encodeURIComponent(id)}/reject`, StockAlertSchema, {
      method: "PATCH",
    }),

  storeDeliveries: (branch: string) => request(withQuery("/api/orders", {
    queue: "outgoing", status: "COMMITTED", branch,
  }), z.object({ orders: z.array(StoreOrderSchema), total: z.number() })),
  receiveDelivery: (id: string, body: OrderReceiveBody) => request(
    `/api/orders/${encodeURIComponent(id)}/receive`, StoreOrderSchema,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  ),
  // Replenishment Orders
  listOrders: (
    query: OrderListQuery & { view?: QueueLifecycleView } = {},
  ): Promise<LifecycleOrderListResponse> =>
    request(
      withQuery("/api/orders", query as Record<string, unknown>),
      LifecycleOrderListResponseSchema,
    ),
  reopenOrder: (id: string, comment?: string): Promise<LifecycleOrder> =>
    request(`/api/orders/${encodeURIComponent(id)}/reopen`, LifecycleOrderSchema, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(comment ? { comment } : {}),
    }),
  getOrder: (id: string): Promise<ReplenishmentOrder> =>
    request(`/api/orders/${encodeURIComponent(id)}`, ReplenishmentOrderSchema),
  createOrder: (payload: CreateOrderRequest): Promise<ReplenishmentOrder> =>
    request("/api/orders", ReplenishmentOrderSchema, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  requestOrderTransfer: (
    id: string,
    body: OrderRequestTransferBody = {},
  ): Promise<ReplenishmentOrder> =>
    request(`/api/orders/${encodeURIComponent(id)}/request`, ReplenishmentOrderSchema, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  commitOrder: (id: string, body: OrderCommitBody = {}): Promise<ReplenishmentOrder> =>
    request(`/api/orders/${encodeURIComponent(id)}/commit`, ReplenishmentOrderSchema, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  declineOrder: (id: string, body: OrderDeclineBody): Promise<ReplenishmentOrder> =>
    request(`/api/orders/${encodeURIComponent(id)}/decline`, ReplenishmentOrderSchema, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  rerouteOrder: (id: string, body: OrderRerouteBody): Promise<ReplenishmentOrder> =>
    request(`/api/orders/${encodeURIComponent(id)}/reroute`, ReplenishmentOrderSchema, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  cancelOrder: (id: string, body: OrderCancelBody = {}): Promise<ReplenishmentOrder> =>
    request(`/api/orders/${encodeURIComponent(id)}/cancel`, ReplenishmentOrderSchema, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  receiveOrder: (id: string, body: OrderReceiveBody = {}): Promise<ReplenishmentOrder> =>
    request(`/api/orders/${encodeURIComponent(id)}/receive`, ReplenishmentOrderSchema, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  donorCandidates: (params: {
    sku: string;
    target: string;
    qty: number;
    includeIneligible?: boolean;
    limit?: number;
  }): Promise<DonorCandidatesResponse> =>
    request(
      withQuery("/api/orders/donor-candidates", params as Record<string, unknown>),
      DonorCandidatesResponseSchema,
    ),
};

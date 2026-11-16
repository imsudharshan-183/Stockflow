import {
  AuditListSchema,
  BatchDecideResponseSchema,
  BranchDetailSchema,
  CreateProductSchema,
  CreateUserSchema,
  ErrorBodySchema,
  KpiSummarySchema,
  LocationInventoryResponseSchema,
  LocationListResponseSchema,
  LocationSummaryResponseSchema,
  LocationTrendResponseSchema,
  LoginResponseSchema,
  ProductDetailSchema,
  ProductDetailWithHistorySchema,
  ProductListResponseSchema,
  ProductSchema,
  RecommendationListSchema,
  RecommendationSchema,
  StockAlertListSchema,
  StockAlertSchema,
  UpdateProductSchema,
  UpdateUserSchema,
  UserListSchema,
  UserSchema,
  type AuditList,
  type BranchDetail,
  type CreateProduct,
  type CreateStockAlert,
  type CreateUser,
  type KpiSummary,
  type LocationInventoryQuery,
  type LocationInventoryResponse,
  type LocationListResponse,
  type LocationSummaryResponse,
  type LocationTrendQuery,
  type LocationTrendResponse,
  type LoginRequest,
  type LoginResponse,
  type Product,
  type ProductDetail,
  type ProductDetailWithHistory,
  type ProductListQuery,
  type ProductListResponse,
  type Recommendation,
  type RecommendationList,
  type RecommendationQuery,
  type StockAlert,
  type StockAlertList,
  type UpdateProduct,
  type UpdateUser,
  type User,
  type UserList,
} from "@stockflow/core";
import { z, type ZodType } from "zod";

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

export function getAccessToken(): string | null {
  return inMemoryAccessToken;
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
  audit: (branch?: string): Promise<AuditList> =>
    request(withQuery("/api/audit", branch ? { branch } : {}), AuditListSchema),
  recommendations: (query: RecommendationQuery): Promise<RecommendationList> =>
    request(withQuery("/api/recommendations", query as Record<string, unknown>), RecommendationListSchema),
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
  importSalesCsv: (file: File): Promise<{ inserted: number; updated: number; errors: Array<{ row: number; message: string }> }> => {
    const formData = new FormData();
    formData.append("file", file);
    return request(
      "/api/sales-entries/import",
      z.object({
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

  // Stock alerts
  listStockAlerts: (): Promise<StockAlertList> =>
    request("/api/stock-alerts", StockAlertListSchema),
  createStockAlert: (payload: CreateStockAlert): Promise<StockAlert> =>
    request("/api/stock-alerts", StockAlertSchema, {
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
};

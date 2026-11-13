import {
  AuditListSchema,
  BranchDetailSchema,
  CreateUserSchema,
  ErrorBodySchema,
  KpiSummarySchema,
  LoginResponseSchema,
  ProductDetailSchema,
  RecommendationListSchema,
  RecommendationSchema,
  UpdateUserSchema,
  UserListSchema,
  UserSchema,
  type AuditList,
  type BranchDetail,
  type CreateUser,
  type KpiSummary,
  type LoginRequest,
  type LoginResponse,
  type ProductDetail,
  type Recommendation,
  type RecommendationList,
  type RecommendationQuery,
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

function withQuery(path: string, query: RecommendationQuery): string {
  const params = new URLSearchParams();
  if (query.branch) params.set("branch", query.branch);
  if (query.category) params.set("category", query.category);
  if (query.action) params.set("action", query.action);
  if (query.status) params.set("status", query.status);
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
  kpis: (): Promise<KpiSummary> => request("/api/kpis", KpiSummarySchema),
  audit: (): Promise<AuditList> => request("/api/audit", AuditListSchema),
  recommendations: (query: RecommendationQuery): Promise<RecommendationList> =>
    request(withQuery("/api/recommendations", query), RecommendationListSchema),
  branch: (id: string): Promise<BranchDetail> =>
    request(`/api/branches/${encodeURIComponent(id)}`, BranchDetailSchema),
  product: (sku: string): Promise<ProductDetail> =>
    request(`/api/products/${encodeURIComponent(sku)}`, ProductDetailSchema),
  decide: (id: string, decision: "approve" | "reject"): Promise<Recommendation> =>
    request(`/api/recommendations/${encodeURIComponent(id)}/${decision}`, RecommendationSchema, {
      method: "POST",
    }),
};

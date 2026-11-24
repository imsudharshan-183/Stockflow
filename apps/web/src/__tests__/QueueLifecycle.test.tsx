import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueuePage } from "@/features/queue/QueuePage";
import type { LifecycleOrder } from "@/lib/api";
import type { KpiSummary, LocationListResponse, OrderListQuery, ProductListResponse, User } from "@stockflow/core";

const mockAuthState: { user: User } = {
  user: {
    id: "usr_admin",
    name: "Network Admin",
    email: "admin@stockflow.dev",
    role: "admin",
    branchIds: [],
    isActive: true,
    createdAt: "2026-10-01T00:00:00.000Z",
  },
};

vi.mock("@/features/auth/AuthContext", () => ({
  useAuth: () => ({
    user: mockAuthState.user,
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
    refreshUser: vi.fn(),
  }),
}));

const apiMocks = vi.hoisted(() => ({
  kpis: vi.fn(),
  locations: vi.fn(),
  listCatalogProducts: vi.fn(),
  listOrders: vi.fn(),
  donorCandidates: vi.fn(),
  createOrder: vi.fn(),
  commitOrder: vi.fn(),
  requestOrderTransfer: vi.fn(),
  declineOrder: vi.fn(),
  rerouteOrder: vi.fn(),
  cancelOrder: vi.fn(),
  receiveOrder: vi.fn(),
  reopenOrder: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: apiMocks,
}));

const baseOrder: LifecycleOrder = {
  id: "ord_worsen_1",
  origin: "ENGINE",
  type: "REORDER",
  status: "REJECTED",
  sku: "SKU-00010",
  productName: "Artisanal Olive Oil 500ml",
  category: "Pantry",
  targetBranchId: "BR-001",
  targetBranchName: "Manama - CBD",
  sourceBranchId: null,
  sourceBranchName: null,
  quantity: 12,
  requestedBy: null,
  linkedAlertId: null,
  engineSnapshot: {
    recommendationId: "ord_worsen_1",
    netBenefitBhd: 45,
    reasonCodes: ["BELOW_REORDER_POINT"],
    reason: "Demand spiked.",
  },
  createdAt: "2026-11-20T00:00:00.000Z",
  updatedAt: "2026-11-21T00:00:00.000Z",
  awaitingDonorSince: null,
  escalatedAt: null,
  committedAt: null,
  receivedAt: null,
  events: [],
  isVirtual: false,
  lifecycleState: "pending",
  reopenBadge: { kind: "worsened", label: "Situation worsened" },
  canReopen: false,
  decidedAt: "2026-11-21T00:00:00.000Z",
  rejectedUntil: "2026-11-24T00:00:00.000Z",
};

const snoozeExpiredOrder: LifecycleOrder = {
  ...baseOrder,
  id: "ord_snooze_2",
  sku: "SKU-00011",
  productName: "Spring Water Pack",
  engineSnapshot: { ...baseOrder.engineSnapshot, recommendationId: "ord_snooze_2", netBenefitBhd: 15 },
  reopenBadge: {
    kind: "snooze_expired",
    daysAgo: 4,
    reason: "Overstocked aisle",
    label: "Rejected 4 days ago: Overstocked aisle",
  },
};

const inProgressOrder: LifecycleOrder = {
  ...baseOrder,
  id: "ord_prog_1",
  sku: "SKU-00020",
  productName: "Roasted Almonds",
  status: "COMMITTED",
  lifecycleState: "in_progress",
  reopenBadge: null,
  canReopen: true,
  engineSnapshot: { ...baseOrder.engineSnapshot, recommendationId: "ord_prog_1", netBenefitBhd: 90 },
};

const decidedOrder: LifecycleOrder = {
  ...baseOrder,
  id: "ord_dec_1",
  sku: "SKU-00030",
  productName: "Dates Gift Box",
  status: "REJECTED",
  lifecycleState: "decided",
  reopenBadge: null,
  canReopen: true,
  engineSnapshot: { ...baseOrder.engineSnapshot, recommendationId: "ord_dec_1", netBenefitBhd: 30 },
};

function renderQueue(initialPath = "/queue") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialPath]}>
        <TooltipProvider>
          <QueuePage />
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("QueuePage lifecycle switcher, badges, header totals, and Reopen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.kpis.mockResolvedValue({
      branches: [{ id: "BR-001", name: "Manama - CBD", city: "Manama", region: "Capital", status: "active" }],
      categories: ["Pantry"],
    } as unknown as KpiSummary);
    apiMocks.locations.mockResolvedValue({ locations: [] } as unknown as LocationListResponse);
    apiMocks.listCatalogProducts.mockResolvedValue({ products: [], total: 0, page: 1, limit: 100 } as unknown as ProductListResponse);
    apiMocks.reopenOrder.mockResolvedValue({ ...decidedOrder, status: "SUGGESTED", lifecycleState: "pending", canReopen: false });

    apiMocks.listOrders.mockImplementation((query: OrderListQuery & { view?: string }) => {
      if (query.queue === "incoming") return Promise.resolve({ orders: [], total: 0 });
      if (query.view === "in_progress") {
        return Promise.resolve({
          orders: [inProgressOrder],
          total: 1,
          totalNetBenefit: 90,
          view: "in_progress",
        });
      }
      if (query.view === "decided") {
        return Promise.resolve({
          orders: [decidedOrder],
          total: 1,
          totalNetBenefit: 30,
          view: "decided",
        });
      }
      return Promise.resolve({
        orders: [baseOrder, snoozeExpiredOrder],
        total: 2,
        totalNetBenefit: 60,
        view: "pending",
      });
    });
  });

  it("defaults to Pending view, renders reopen badges & header total for active view only, and supports Reopen", async () => {
    const user = userEvent.setup();
    renderQueue("/queue");

    await screen.findByText("SKU-00010");
    expect(screen.getByText(/2 pending orders in view · BD 60 estimated gain/i)).toBeInTheDocument();
    expect(screen.getByText("Situation worsened")).toBeInTheDocument();
    expect(screen.getByText("Rejected 4 days ago: Overstocked aisle")).toBeInTheDocument();
    // Snoozed/worsened rows in Pending still offer Approve action
    expect(screen.getAllByRole("button", { name: /^Approve$/i })).toHaveLength(2);

    // Switch to In progress -> header count and estimated gain update strictly to that view
    await user.click(screen.getByRole("button", { name: /^In progress$/i }));
    await screen.findByText("SKU-00020");
    expect(screen.getByText(/1 in progress orders in view · BD 90 estimated gain/i)).toBeInTheDocument();

    // Switch to Decided and click Reopen
    await user.click(screen.getByRole("button", { name: /^Decided$/i }));
    await screen.findByText("SKU-00030");
    expect(screen.getByText(/1 decided orders in view · BD 30 estimated gain/i)).toBeInTheDocument();

    const reopenBtn = screen.getByRole("button", { name: /^Reopen$/i });
    await user.click(reopenBtn);
    await waitFor(() => expect(apiMocks.reopenOrder).toHaveBeenCalledWith("ord_dec_1", undefined));
  });
});

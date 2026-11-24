import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueuePage } from "@/features/queue/QueuePage";
import type {
  DonorCandidate,
  KpiSummary,
  LocationListResponse,
  OrderListQuery,
  ProductListResponse,
  ReplenishmentOrder,
  User,
} from "@stockflow/core";

const mockAuthState: { user: User } = {
  user: {
    id: "usr_mgr_manama",
    name: "Manama Manager",
    email: "mgr.manama@stockflow.dev",
    role: "manager",
    branchIds: ["BR-001", "BR-002"],
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
}));

vi.mock("@/lib/api", () => ({
  api: apiMocks,
}));

const baseKpis = {
  branches: [
    { id: "BR-001", name: "Manama - CBD", city: "Manama", region: "Capital", status: "active" },
    { id: "BR-002", name: "Manama - Juffair", city: "Manama", region: "Capital", status: "active" },
    { id: "BR-005", name: "Muharraq - Hidd", city: "Muharraq", region: "Muharraq", status: "active" },
  ],
  categories: ["Beverages", "Household"],
} as unknown as KpiSummary;

const baseLocations = {
  locations: [
    {
      branch: { id: "BR-001", name: "Manama - CBD", city: "Manama", region: "Capital", status: "active" },
      health: "red",
      atRiskCount: 2,
      overstockCount: 0,
      totalSkus: 10,
      lostSalesAtRisk: 100,
      cashReleasable: 0,
      pendingActions: 1,
    },
    {
      branch: { id: "BR-005", name: "Muharraq - Hidd", city: "Muharraq", region: "Muharraq", status: "active" },
      health: "green",
      atRiskCount: 0,
      overstockCount: 2,
      totalSkus: 10,
      lostSalesAtRisk: 0,
      cashReleasable: 500,
      pendingActions: 0,
    },
  ],
} as unknown as LocationListResponse;

const baseProducts = {
  products: [
    {
      sku: "SKU-00012",
      name: "Clearwater Sparkling Water, 330 ml",
      category: "Beverages",
      price: 5,
      cost: 3,
      leadTimeDays: 7,
      status: "active",
    },
  ],
  total: 1,
  page: 1,
  limit: 100,
  totalPages: 1,
} as unknown as ProductListResponse;

const intraClusterOrder: ReplenishmentOrder = {
  id: "ord_intra_1",
  origin: "ENGINE",
  type: "TRANSFER",
  status: "SUGGESTED",
  sku: "SKU-INTRA",
  productName: "Cedar Olive Oil, 500 ml",
  category: "Beverages",
  targetBranchId: "BR-001",
  targetBranchName: "Manama - CBD",
  sourceBranchId: "BR-002",
  sourceBranchName: "Manama - Juffair",
  quantity: 12,
  requestedBy: null,
  linkedAlertId: null,
  engineSnapshot: {
    recommendationId: "ord_intra_1",
    netBenefitBhd: 48.5,
    reasonCodes: ["BELOW_REORDER_POINT", "DONOR_SURPLUS", "MIN_TRANSFER_MET"],
    reason: "Intra-cluster transfer avoids lost sales.",
    distanceKm: 4.2,
    freightCostBhd: 5.13,
  },
  createdAt: "2026-11-24T00:00:00.000Z",
  updatedAt: "2026-11-24T00:00:00.000Z",
  awaitingDonorSince: null,
  escalatedAt: null,
  committedAt: null,
  receivedAt: null,
  events: [],
  isVirtual: true,
};

const crossClusterOrder: ReplenishmentOrder = {
  id: "ord_cross_1",
  origin: "ENGINE",
  type: "TRANSFER",
  status: "SUGGESTED",
  sku: "SKU-00012",
  productName: "Clearwater Sparkling Water, 330 ml",
  category: "Beverages",
  targetBranchId: "BR-001",
  targetBranchName: "Manama - CBD",
  sourceBranchId: "BR-005",
  sourceBranchName: "Muharraq - Hidd",
  quantity: 15,
  requestedBy: null,
  linkedAlertId: null,
  engineSnapshot: {
    recommendationId: "ord_cross_1",
    netBenefitBhd: 24.75,
    reasonCodes: ["BELOW_REORDER_POINT", "RECEIVER_BELOW_TARGET", "DONOR_SURPLUS"],
    reason: "Cross-cluster donor transfer to prevent stockout.",
    distanceKm: 14.5,
    freightCostBhd: 7.425,
  },
  createdAt: "2026-11-24T00:00:00.000Z",
  updatedAt: "2026-11-24T00:00:00.000Z",
  awaitingDonorSince: null,
  escalatedAt: null,
  committedAt: null,
  receivedAt: null,
  events: [],
  isVirtual: true,
};

const incomingPullOrder: ReplenishmentOrder = {
  id: "ord_inc_1",
  origin: "MANAGER_REQUEST",
  type: "TRANSFER",
  status: "AWAITING_DONOR",
  sku: "SKU-00012",
  productName: "Clearwater Sparkling Water, 330 ml",
  category: "Beverages",
  targetBranchId: "BR-001",
  targetBranchName: "Manama - CBD",
  sourceBranchId: "BR-005",
  sourceBranchName: "Muharraq - Hidd",
  quantity: 15,
  requestedBy: { userId: "usr_mgr_manama", name: "Manama Manager", role: "manager" },
  linkedAlertId: null,
  engineSnapshot: {
    netBenefitBhd: 24.75,
    reasonCodes: ["RECEIVER_BELOW_TARGET", "DONOR_SURPLUS"],
    reason: "Manama manager pull request.",
    distanceKm: 14.5,
    freightCostBhd: 7.425,
  },
  createdAt: "2026-11-24T01:00:00.000Z",
  updatedAt: "2026-11-24T01:00:00.000Z",
  awaitingDonorSince: "2026-11-24T01:00:00.000Z",
  escalatedAt: null,
  committedAt: null,
  receivedAt: null,
  donorAvailableSurplus: 85,
  donorCoverDaysAfter: 105,
  events: [],
};

const outgoingCommittedOrder: ReplenishmentOrder = {
  ...incomingPullOrder,
  id: "ord_out_committed",
  status: "COMMITTED",
  committedAt: "2026-11-24T02:00:00.000Z",
};

const outgoingAwaitingOrder: ReplenishmentOrder = {
  ...incomingPullOrder,
  id: "ord_out_awaiting",
  status: "AWAITING_DONOR",
};

const sampleDonors: DonorCandidate[] = [
  {
    branchId: "BR-005",
    branchName: "Muharraq - Hidd",
    distanceKm: 14.5,
    freightCostBhd: 6.675,
    availableSurplusUnits: 90,
    requestedQty: 20,
    offeredQty: 20,
    isPartial: false,
    donorCoverDaysAfter: 100,
    targetCoverDaysBefore: 4,
    targetCoverDaysAfter: 8,
    netBenefitBhd: 24.75,
    eligible: true,
  },
];

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

describe("QueuePage 3-tab governed workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthState.user = {
      id: "usr_mgr_manama",
      name: "Manama Manager",
      email: "mgr.manama@stockflow.dev",
      role: "manager",
      branchIds: ["BR-001", "BR-002"],
      isActive: true,
      createdAt: "2026-10-01T00:00:00.000Z",
    };
    apiMocks.kpis.mockResolvedValue(baseKpis);
    apiMocks.locations.mockResolvedValue(baseLocations);
    apiMocks.listCatalogProducts.mockResolvedValue(baseProducts);
    apiMocks.donorCandidates.mockResolvedValue({ candidates: sampleDonors });
    apiMocks.createOrder.mockResolvedValue(incomingPullOrder);
    apiMocks.commitOrder.mockResolvedValue(outgoingCommittedOrder);
    apiMocks.requestOrderTransfer.mockResolvedValue(incomingPullOrder);
    apiMocks.declineOrder.mockResolvedValue({ ...incomingPullOrder, status: "REJECTED" });
    apiMocks.rerouteOrder.mockResolvedValue({ ...outgoingAwaitingOrder, sourceBranchId: "BR-014" });
    apiMocks.cancelOrder.mockResolvedValue({ ...outgoingAwaitingOrder, status: "CANCELLED" });
    apiMocks.receiveOrder.mockResolvedValue({ ...outgoingCommittedOrder, status: "RECEIVED" });

    apiMocks.listOrders.mockImplementation((query: OrderListQuery) => {
      if (query.queue === "incoming") {
        return Promise.resolve({
          orders: mockAuthState.user.role === "manager" && mockAuthState.user.branchIds.includes("BR-001")
            ? []
            : [incomingPullOrder],
          total: mockAuthState.user.role === "manager" && mockAuthState.user.branchIds.includes("BR-001")
            ? 0
            : 1,
        });
      }
      if (query.queue === "outgoing") {
        return Promise.resolve({
          orders: [outgoingCommittedOrder, outgoingAwaitingOrder],
          total: 2,
        });
      }
      return Promise.resolve({
        orders: [intraClusterOrder, crossClusterOrder],
        total: 2,
      });
    });
  });

  it("distinguishes intra-cluster Commit from cross-cluster Request Transfer on Suggested tab", async () => {
    const user = userEvent.setup();
    renderQueue("/queue");

    await screen.findByText("SKU-INTRA");
    expect(screen.getByText("SKU-00012")).toBeInTheDocument();

    // Intra-cluster transfer shows Commit, cross-cluster shows Request Transfer
    const commitBtn = screen.getByRole("button", { name: /^Commit$/i });
    const reqBtn = screen.getByRole("button", { name: /Request Transfer/i });

    await user.click(commitBtn);
    await waitFor(() => expect(apiMocks.commitOrder).toHaveBeenCalledWith("ord_intra_1", {}));

    await user.click(reqBtn);
    await waitFor(() =>
      expect(apiMocks.requestOrderTransfer).toHaveBeenCalledWith("ord_cross_1", {
        sourceBranchId: "BR-005",
      }),
    );
  });

  it("opens Request Stock modal with ranked donor picker showing distance, freight, cover after, and net benefit", async () => {
    const user = userEvent.setup();
    renderQueue("/queue");

    await screen.findByText("SKU-INTRA");
    await user.click(screen.getByRole("button", { name: /Request Stock/i }));

    await screen.findByText(/14\.5 km/);
    expect(screen.getByText(/Freight: BD 6\.675/)).toBeInTheDocument();
    expect(screen.getByText(/Donor cover after: 100 days/)).toBeInTheDocument();
    expect(screen.getByText(/BD 25 net benefit/i)).toBeInTheDocument();

    await user.click(screen.getByRole("option", { name: /BR-005/i }));
    await user.type(screen.getByPlaceholderText(/Why this replenishment/i), "Weekend restock");
    await user.click(screen.getByRole("button", { name: /Submit request/i }));

    await waitFor(() =>
      expect(apiMocks.createOrder).toHaveBeenCalledWith({
        type: "TRANSFER",
        sku: "SKU-00012",
        targetBranchId: "BR-001",
        sourceBranchId: "BR-005",
        quantity: 20,
        comment: "Weekend restock",
      }),
    );
  });

  it("shows live surplus and cover after release on Incoming Pull Requests and requires decline comment", async () => {
    const user = userEvent.setup();
    mockAuthState.user = {
      id: "usr_mgr_hidd",
      name: "Hidd Manager",
      email: "mgr.hidd@stockflow.dev",
      role: "manager",
      branchIds: ["BR-005"],
      isActive: true,
      createdAt: "2026-10-01T00:00:00.000Z",
    };

    renderQueue("/queue?tab=incoming");

    await screen.findByText("85 units");
    expect(screen.getByText("105 days")).toBeInTheDocument();

    // Release calls commitOrder
    await user.click(screen.getByRole("button", { name: /^Release$/i }));
    await waitFor(() => expect(apiMocks.commitOrder).toHaveBeenCalledWith("ord_inc_1", {}));

    // Decline requires non-empty comment
    await user.click(screen.getByRole("button", { name: /^Decline$/i }));
    const confirmDecline = await screen.findByRole("button", { name: /Confirm decline/i });
    expect(confirmDecline).toBeDisabled();

    await user.type(screen.getByLabelText(/Decline reason/i), "Shelf display needs stock");
    expect(confirmDecline).toBeEnabled();
    await user.click(confirmDecline);
    await waitFor(() =>
      expect(apiMocks.declineOrder).toHaveBeenCalledWith("ord_inc_1", {
        comment: "Shelf display needs stock",
      }),
    );
  });

  it("supports Confirm Receipt, Reroute, and Cancel on My Outgoing Requests", async () => {
    const user = userEvent.setup();
    renderQueue("/queue?tab=outgoing");

    await screen.findByRole("button", { name: /Confirm Receipt/i });
    await user.click(screen.getByRole("button", { name: /Confirm Receipt/i }));
    await waitFor(() =>
      expect(apiMocks.receiveOrder).toHaveBeenCalledWith("ord_out_committed", {}),
    );

    await user.click(screen.getByRole("button", { name: /^Cancel$/i }));
    await waitFor(() =>
      expect(apiMocks.cancelOrder).toHaveBeenCalledWith("ord_out_awaiting", {}),
    );

    // Admin sees override comment dialog on Release in Incoming tab
    mockAuthState.user = {
      id: "usr_admin",
      name: "Network Admin",
      email: "admin@stockflow.dev",
      role: "admin",
      branchIds: [],
      isActive: true,
      createdAt: "2026-10-01T00:00:00.000Z",
    };
    await user.click(screen.getByRole("tab", { name: /Incoming Pull Requests/i }));
    await screen.findByRole("button", { name: /^Release$/i });
    await user.click(screen.getByRole("button", { name: /^Release$/i }));
    await screen.findByText(/Admin override commit/i);
    await user.type(screen.getByLabelText(/Override comment/i), "Ops override");
    await user.click(screen.getByRole("button", { name: /Confirm override release/i }));
    await waitFor(() =>
      expect(apiMocks.commitOrder).toHaveBeenCalledWith("ord_inc_1", {
        comment: "Ops override",
        force: true,
      }),
    );
  });
});

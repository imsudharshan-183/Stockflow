import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PendingStockAlertsCard } from "@/components/shared/PendingStockAlertsCard";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuditPage } from "@/features/audit/AuditPage";
import { StaffProductStats } from "@/features/products/StaffProductStats";
import type {
  DonorCandidate,
  OrderListResponse,
  ProductListResponse,
  ReplenishmentOrder,
  StockAlert,
  User,
} from "@stockflow/core";

const mockAuthState: { user: User } = {
  user: {
    id: "usr_stf_1",
    name: "Manama Staff",
    email: "staff.manama@stockflow.dev",
    role: "staff",
    branchIds: ["BR-001"],
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
  listStockAlerts: vi.fn(),
  createStockAlert: vi.fn(),
  resolveStockAlert: vi.fn(),
  listCatalogProducts: vi.fn(),
  listOrders: vi.fn(),
  receiveOrder: vi.fn(),
  donorCandidates: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: apiMocks,
}));

const pendingAlert: StockAlert = {
  id: "alt_101",
  branchId: "BR-001",
  branchName: "Manama - CBD",
  sku: "SKU-00012",
  productName: "Clearwater Sparkling Water, 330 ml",
  category: "CRITICAL_LOW",
  reportedQty: 4,
  flaggedBy: { userId: "usr_stf_1", name: "Manama Staff", role: "staff" },
  flaggedAt: "2026-11-24T00:10:00.000Z",
  note: "Only 4 bottles left on shelf",
  status: "PENDING",
  decidedBy: null,
  decidedAt: null,
  resolution: null,
};

const resolvedAlert: StockAlert = {
  ...pendingAlert,
  id: "alt_102",
  sku: "SKU-00015",
  status: "RESOLVED",
  decidedBy: { userId: "usr_mgr_1", name: "Manama Manager", role: "manager" },
  decidedAt: "2026-11-24T01:00:00.000Z",
  resolution: {
    action: "CONVERTED_TO_REQUEST",
    linkedOrderId: "ord_from_alt",
    comment: "Escalated to Hidd branch for same-day transfer",
    decidedBy: { userId: "usr_mgr_1", name: "Manama Manager", role: "manager" },
    decidedAt: "2026-11-24T01:00:00.000Z",
  },
  linkedOrderStatus: "COMMITTED",
};

const staffDeliveryOrder: ReplenishmentOrder = {
  id: "ord_from_alt",
  origin: "ALERT_ESCALATION",
  type: "TRANSFER",
  status: "COMMITTED",
  sku: "SKU-00012",
  productName: "Clearwater Sparkling Water, 330 ml",
  category: "Beverages",
  targetBranchId: "BR-001",
  targetBranchName: "Manama - CBD",
  sourceBranchId: "BR-005",
  sourceBranchName: "Muharraq - Hidd",
  quantity: 15,
  requestedBy: { userId: "usr_mgr_1", name: "Manama Manager", role: "manager" },
  linkedAlertId: "alt_101",
  engineSnapshot: {
    netBenefitBhd: 24.75,
    reasonCodes: ["BELOW_REORDER_POINT", "RECEIVER_BELOW_TARGET", "DONOR_SURPLUS"],
    reason: "15 units transfer covers 7-day lead-time deficit.",
    distanceKm: 14.5,
    freightCostBhd: 7.425,
  },
  createdAt: "2026-11-24T01:00:00.000Z",
  updatedAt: "2026-11-24T02:00:00.000Z",
  awaitingDonorSince: "2026-11-24T01:00:00.000Z",
  escalatedAt: null,
  committedAt: "2026-11-24T02:00:00.000Z",
  receivedAt: null,
  events: [
    {
      id: "evt_1",
      orderId: "ord_from_alt",
      at: "2026-11-24T01:00:00.000Z",
      actor: { userId: "usr_mgr_1", name: "Manama Manager", role: "manager" },
      action: "CREATED",
      fromStatus: null,
      toStatus: "AWAITING_DONOR",
      comment: "Escalated from shelf alert",
    },
    {
      id: "evt_2",
      orderId: "ord_from_alt",
      at: "2026-11-24T02:00:00.000Z",
      actor: { userId: "usr_mgr_hidd", name: "Hidd Manager", role: "manager" },
      action: "COMMIT",
      fromStatus: "AWAITING_DONOR",
      toStatus: "COMMITTED",
      comment: "Dispatched morning van",
    },
  ],
};

const donorList: DonorCandidate[] = [
  {
    branchId: "BR-005",
    branchName: "Muharraq - Hidd",
    distanceKm: 14.5,
    freightCostBhd: 7.425,
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

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TooltipProvider>{ui}</TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Alert Triage, Staff Receipt, and Order-Threaded Audit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.listStockAlerts.mockResolvedValue({ alerts: [pendingAlert, resolvedAlert] });
    apiMocks.createStockAlert.mockResolvedValue(pendingAlert);
    apiMocks.resolveStockAlert.mockResolvedValue({ alert: resolvedAlert, order: staffDeliveryOrder });
    apiMocks.donorCandidates.mockResolvedValue({ candidates: donorList });
    apiMocks.receiveOrder.mockResolvedValue({ ...staffDeliveryOrder, status: "RECEIVED" });
    apiMocks.listOrders.mockResolvedValue({
      orders: [staffDeliveryOrder],
      total: 1,
    } satisfies OrderListResponse);
    apiMocks.listCatalogProducts.mockResolvedValue({
      products: [
        {
          sku: "SKU-00012",
          name: "Clearwater Sparkling Water, 330 ml",
          category: "Beverages",
          price: 5,
          cost: 3,
          leadTimeDays: 7,
          status: "active",
          stats: {
            onHand: 4,
            velocity: 5,
            coverDays: 0.8,
            status: "AT_RISK",
          },
        },
      ],
      total: 1,
      page: 1,
      limit: 25,
      totalPages: 1,
      branchSummary: {
        branch: {
          id: "BR-001",
          name: "Manama - CBD",
          city: "Manama",
          region: "Capital",
          status: "active",
        },
        totalSkus: 1,
        statusCounts: { AT_RISK: 1, HEALTHY: 0, OVERSTOCK: 0, NEW: 0 },
      },
    } satisfies ProductListResponse);
  });

  it("replaces Approve with Resolve dialog supporting Request Replenishment, Log Adjustment, Acknowledge, and Dismiss", async () => {
    const user = userEvent.setup();
    mockAuthState.user = {
      id: "usr_mgr_1",
      name: "Manama Manager",
      email: "mgr.manama@stockflow.dev",
      role: "manager",
      branchIds: ["BR-001"],
      isActive: true,
      createdAt: "2026-10-01T00:00:00.000Z",
    };

    wrap(<PendingStockAlertsCard scope="branch" branchId="BR-001" />);

    await screen.findByText("SKU-00012");
    expect(screen.queryByRole("button", { name: /^Approve$/i })).not.toBeInTheDocument();

    // Open Resolve -> Request Replenishment with ranked donor picker
    await user.click(screen.getByRole("button", { name: /^Resolve$/i }));
    await screen.findByText(/Reported physical count: 4 units/i);
    await user.click(await screen.findByRole("option", { name: /BR-005/i }));
    await user.type(screen.getByLabelText(/Resolution comment/i), "Pull from Hidd");
    await user.click(screen.getByRole("button", { name: /Confirm resolution/i }));

    await waitFor(() =>
      expect(apiMocks.resolveStockAlert).toHaveBeenCalledWith("alt_101", {
        action: "CONVERTED_TO_REQUEST",
        orderType: "TRANSFER",
        quantity: 20,
        sourceBranchId: "BR-005",
        comment: "Pull from Hidd",
      }),
    );

    // Dismiss enforces required comment
    await user.click(screen.getByRole("button", { name: /^Resolve$/i }));
    await user.click(screen.getByRole("button", { name: /^Dismiss$/i }));
    const confirmBtn = screen.getByRole("button", { name: /Confirm resolution/i });
    expect(confirmBtn).toBeDisabled();
    await user.type(screen.getByLabelText(/Dismissal reason/i), "False alarm");
    expect(confirmBtn).toBeEnabled();
    await user.click(confirmBtn);
    await waitFor(() =>
      expect(apiMocks.resolveStockAlert).toHaveBeenLastCalledWith("alt_101", {
        action: "DISMISSED",
        comment: "False alarm",
      }),
    );

    // Log Adjustment pre-fills reportedQty
    await user.click(screen.getByRole("button", { name: /^Resolve$/i }));
    await user.click(screen.getByRole("button", { name: /Log Adjustment/i }));
    expect(screen.getByLabelText(/Physical on-hand count/i)).toHaveValue(4);
    await user.click(screen.getByRole("button", { name: /Confirm resolution/i }));
    await waitFor(() =>
      expect(apiMocks.resolveStockAlert).toHaveBeenLastCalledWith("alt_101", {
        action: "LOGGED_ADJUSTMENT",
        adjustedOnHand: 4,
      }),
    );
  });

  it("lets staff flag with reportedQty, inspect linked status + comment, and confirm receipt without exposing BD currency", async () => {
    const user = userEvent.setup();
    apiMocks.listStockAlerts.mockResolvedValue({ alerts: [resolvedAlert] });
    mockAuthState.user = {
      id: "usr_stf_1",
      name: "Manama Staff",
      email: "staff.manama@stockflow.dev",
      role: "staff",
      branchIds: ["BR-001"],
      isActive: true,
      createdAt: "2026-10-01T00:00:00.000Z",
    };

    const { container } = wrap(<StaffProductStats />);

    // Resolution comment & linked order status appear in Recent Branch Stock Alerts
    await screen.findByText(/Escalated to Hidd branch for same-day transfer/i);
    expect(screen.getByText("Requested Replenishment")).toBeInTheDocument();

    // Staff Incoming Deliveries shows Confirm Receipt
    await user.click(screen.getByRole("button", { name: /Confirm Receipt/i }));
    await waitFor(() =>
      expect(apiMocks.receiveOrder).toHaveBeenCalledWith("ord_from_alt", {
        comment: "Confirmed received on store floor",
      }),
    );

    // Staff flags with optional reportedQty
    await user.click(screen.getByRole("button", { name: /Flag stock/i }));
    await user.type(screen.getByLabelText(/Physical shelf count/i), "4");
    await user.type(screen.getByLabelText(/Floor observation note/i), "Shelf nearly empty");
    await user.click(screen.getByRole("button", { name: /Submit alert/i }));
    await waitFor(() =>
      expect(apiMocks.createStockAlert).toHaveBeenCalledWith({
        branchId: "BR-001",
        sku: "SKU-00012",
        category: "CRITICAL_LOW",
        reportedQty: 4,
        note: "Shelf nearly empty",
      }),
    );

    // ADR-009 zero-financial-BD invariant check
    expect(container.textContent).not.toMatch(/\bBD\s+\d/);
  });

  it("renders AuditPage with one thread per order, grey system chips, human comment quote, and event chain", async () => {
    mockAuthState.user = {
      id: "usr_admin",
      name: "Network Admin",
      email: "admin@stockflow.dev",
      role: "admin",
      branchIds: [],
      isActive: true,
      createdAt: "2026-10-01T00:00:00.000Z",
    };

    const { container } = wrap(<AuditPage />);

    await screen.findByText("ord_from_alt");
    expect(screen.getByText("BELOW_REORDER_POINT")).toBeInTheDocument();
    expect(screen.getByText("DONOR_SURPLUS")).toBeInTheDocument();
    expect(screen.getByText("Alert alt_101")).toBeInTheDocument();

    const quotes = Array.from(container.querySelectorAll("blockquote")).map((el) => el.textContent);
    expect(quotes).toEqual(["Escalated from shelf alert", "Dispatched morning van"]);

    expect(screen.getByText("Manama Manager")).toBeInTheDocument();
    expect(screen.getByText("Hidd Manager")).toBeInTheDocument();
  });
});

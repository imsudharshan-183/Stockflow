import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DonorPicker } from "@/components/shared/DonorPicker";
import { PendingStockAlertsCard } from "@/components/shared/PendingStockAlertsCard";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuditPage } from "@/features/audit/AuditPage";
import { StaffProductStats } from "@/features/products/StaffProductStats";
import { OrderDrawer } from "@/features/queue/OrderDrawer";
import { QueuePage } from "@/features/queue/QueuePage";
import { RequestStockDialog } from "@/features/queue/RequestStockDialog";
import {
  ORDER_ACTION_LABELS,
  ORDER_STATUS_LABELS,
  QUEUE_TAB_LABELS,
} from "@/lib/labels";
import type {
  DonorCandidate,
  KpiSummary,
  LocationListResponse,
  OrderListQuery,
  ProductListResponse,
  ReplenishmentOrder,
  StockAlert,
  User,
} from "@stockflow/core";

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
  storeProducts: vi.fn(),
  listOrders: vi.fn(),
  donorCandidates: vi.fn(),
  listStockAlerts: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: { ...apiMocks, listCatalogProducts: apiMocks.storeProducts, storeDeliveries: apiMocks.listOrders },
}));

const sampleOrder: ReplenishmentOrder = {
  id: "ord_wording_1",
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
  requestedBy: { userId: "usr_mgr", name: "Manama Manager", role: "manager" },
  linkedAlertId: null,
  engineSnapshot: {
    netBenefitBhd: 24.75,
    reasonCodes: ["BELOW_REORDER_POINT", "RECEIVER_BELOW_TARGET", "DONOR_SURPLUS"],
    reason: "Cross-branch replenishment suggestion.",
    distanceKm: 14.5,
    freightCostBhd: 7.425,
  },
  createdAt: "2026-11-24T00:00:00.000Z",
  updatedAt: "2026-11-24T01:00:00.000Z",
  awaitingDonorSince: "2026-11-24T01:00:00.000Z",
  escalatedAt: null,
  committedAt: null,
  receivedAt: null,
  donorAvailableSurplus: 85,
  donorCoverDaysAfter: 105,
  events: [
    {
      id: "evt_1",
      orderId: "ord_wording_1",
      at: "2026-11-24T01:00:00.000Z",
      actor: { userId: "usr_mgr", name: "Manama Manager", role: "manager" },
      action: "REQUEST_TRANSFER",
      fromStatus: "SUGGESTED",
      toStatus: "AWAITING_DONOR",
    },
  ],
};

const sampleAlert: StockAlert = {
  id: "alt_wording_1",
  branchId: "BR-001",
  branchName: "Manama - CBD",
  sku: "SKU-00012",
  productName: "Clearwater Sparkling Water, 330 ml",
  category: "CRITICAL_LOW",
  reportedQty: 3,
  flaggedBy: { userId: "usr_stf", name: "Staff", role: "staff" },
  flaggedAt: "2026-11-24T00:05:00.000Z",
  note: "Low shelf",
  status: "PENDING",
  decidedBy: null,
  decidedAt: null,
  resolution: null,
};

const sampleCandidate: DonorCandidate = {
  branchId: "BR-005",
  branchName: "Muharraq - Hidd",
  distanceKm: 14.5,
  freightCostBhd: 6.675,
  availableSurplusUnits: 90,
  requestedQty: 15,
  offeredQty: 15,
  isPartial: false,
  donorCoverDaysAfter: 100,
  targetCoverDaysBefore: 4,
  targetCoverDaysAfter: 8,
  netBenefitBhd: 24.75,
  eligible: true,
};

function assertCleanWording(text: string | null) {
  const value = text ?? "";
  expect(value).not.toMatch(/pull request/i);
  expect(value).not.toMatch(/(^|[^_])\bdonors?\b([^_]|$)/i);
  expect(value).not.toMatch(/(^|[^_])\breceivers?\b([^_]|$)/i);
}

function wrap(ui: React.ReactElement, initialPath = "/queue") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <TooltipProvider>{ui}</TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Workstream 1: Centralized UI wording guard (no Pull Request / donor / receiver jargon)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthState.user = {
      id: "usr_admin",
      name: "Network Admin",
      email: "admin@stockflow.dev",
      role: "admin",
      branchIds: [],
      isActive: true,
      createdAt: "2026-10-01T00:00:00.000Z",
    };
    apiMocks.kpis.mockResolvedValue({
      branches: [
        { id: "BR-001", name: "Manama - CBD", city: "Manama", region: "Capital", status: "active" },
        { id: "BR-005", name: "Muharraq - Hidd", city: "Muharraq", region: "Muharraq", status: "active" },
      ],
      categories: ["Beverages"],
    } as unknown as KpiSummary);
    apiMocks.locations.mockResolvedValue({
      locations: [
        {
          branch: { id: "BR-001", name: "Manama - CBD", city: "Manama", region: "Capital", status: "active" },
          health: "red",
          atRiskCount: 1,
          overstockCount: 0,
          totalSkus: 5,
          lostSalesAtRisk: 100,
          cashReleasable: 0,
          pendingActions: 1,
        },
      ],
    } as unknown as LocationListResponse);
    apiMocks.storeProducts.mockResolvedValue({
      products: [
        {
          sku: "SKU-00012",
          name: "Clearwater Sparkling Water, 330 ml",
          category: "Beverages",
          price: 5,
          cost: 3,
          leadTimeDays: 5,
          status: "active",
          onHandTotal: 50,
          atRiskBranches: 1,
          overstockBranches: 1,
          hasRecommendation: true,
        },
      ],
      total: 1,
      page: 1,
      limit: 100,
      totalPages: 1,
    } as unknown as ProductListResponse);
    apiMocks.listOrders.mockImplementation((q: OrderListQuery) =>
      Promise.resolve({
        orders: q.queue === "incoming" ? [sampleOrder] : [{ ...sampleOrder, status: "COMMITTED" }],
        total: 1,
      }),
    );
    apiMocks.donorCandidates.mockResolvedValue({ candidates: [sampleCandidate] });
    apiMocks.listStockAlerts.mockResolvedValue({ alerts: [sampleAlert] });
  });

  it("renders QueuePage tabs, statuses, buttons, AuditPage, OrderDrawer, RequestStockDialog, DonorPicker, Alerts, and Staff view without legacy terms", async () => {
    const q1 = wrap(<QueuePage />, "/queue");
    await screen.findByText("SKU-00012");
    expect(screen.getByRole("tab", { name: QUEUE_TAB_LABELS.suggested })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: new RegExp(QUEUE_TAB_LABELS.incoming) })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: QUEUE_TAB_LABELS.outgoing })).toBeInTheDocument();
    expect(screen.getByText(ORDER_STATUS_LABELS.COMMITTED)).toBeInTheDocument();
    assertCleanWording(q1.container.textContent);
    q1.unmount();

    const q2 = wrap(<QueuePage />, "/queue?tab=incoming");
    await screen.findByRole("button", { name: ORDER_ACTION_LABELS.sendStock });
    assertCleanWording(q2.container.textContent);
    q2.unmount();

    const auditView = wrap(<AuditPage />, "/audit");
    await screen.findByText("ord_wording_1");
    assertCleanWording(auditView.container.textContent);
    auditView.unmount();

    const drawerView = wrap(
      <OrderDrawer
        order={sampleOrder}
        open
        onOpenChange={() => {}}
        capabilities={{
          canCommit: false,
          canRequestTransfer: false,
          canRelease: true,
          canDecline: true,
          canReroute: false,
          canCancel: false,
          canReceive: false,
        }}
        isBusy={false}
        onCommit={() => {}}
        onRequestTransfer={() => {}}
        onDecline={() => {}}
        onReroute={() => {}}
        onCancel={() => {}}
        onReceive={() => {}}
      />,
    );
    await screen.findByText(ORDER_ACTION_LABELS.sendStock);
    assertCleanWording(drawerView.baseElement.textContent);
    drawerView.unmount();

    const pickerView = wrap(
      <DonorPicker
        sku="SKU-00012"
        targetBranchId="BR-001"
        quantity={15}
        selectedDonorId={null}
        onSelectDonor={() => {}}
        allowUnassigned
      />,
    );
    await screen.findByText(/Muharraq - Hidd/);
    assertCleanWording(pickerView.container.textContent);
    pickerView.unmount();

    const dialogView = wrap(<RequestStockDialog open onOpenChange={() => {}} />);
    await screen.findByText(/Submit an inter-branch transfer request/i);
    assertCleanWording(dialogView.baseElement.textContent);
    dialogView.unmount();

    const alertsView = wrap(<PendingStockAlertsCard scope="network" />);
    await screen.findByText("Low shelf");
    assertCleanWording(alertsView.container.textContent);
    alertsView.unmount();

    mockAuthState.user = {
      id: "usr_stf",
      name: "Staff",
      email: "staff@stockflow.dev",
      role: "staff",
      branchIds: ["BR-001"],
      isActive: true,
      createdAt: "2026-10-01T00:00:00.000Z",
    };
    const staffView = wrap(<StaffProductStats />);
    await screen.findByRole("button", { name: ORDER_ACTION_LABELS.markReceived });
    assertCleanWording(staffView.container.textContent);
    staffView.unmount();
  });
});

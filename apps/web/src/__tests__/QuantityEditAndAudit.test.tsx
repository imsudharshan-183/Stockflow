import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuditPage } from "@/features/audit/AuditPage";
import { QueuePage } from "@/features/queue/QueuePage";
import type { LifecycleOrder } from "@/lib/api";
import { formatMoneyFull } from "@/lib/format";
import { computeActionBenefitForQuantity, type User } from "@stockflow/core";

const apiMocks = vi.hoisted(() => ({
  kpis: vi.fn(),
  locations: vi.fn(),
  listCatalogProducts: vi.fn(),
  listOrders: vi.fn(),
  commitOrder: vi.fn(),
  requestOrderTransfer: vi.fn(),
  declineOrder: vi.fn(),
  rerouteOrder: vi.fn(),
  cancelOrder: vi.fn(),
  receiveOrder: vi.fn(),
  reopenOrder: vi.fn(),
  donorCandidates: vi.fn(),
}));

const authState = vi.hoisted((): { user: User } => ({
  user: {
    id: "usr_mgr_manama",
    name: "Manama Manager",
    email: "mgr.manama@stockflow.dev",
    role: "manager",
    branchIds: ["BR-001", "BR-002"],
    isActive: true,
    createdAt: "2026-10-01T00:00:00.000Z",
  },
}));

vi.mock("@/lib/api", () => ({
  api: apiMocks,
}));

vi.mock("@/features/auth/AuthContext", () => ({
  useAuth: () => ({ user: authState.user }),
}));

vi.mock("@/hooks/useLocationScope", () => ({
  useLocationScope: () => ({ selectedLocation: null, setSelectedLocation: vi.fn() }),
}));

const initialTransferEconomics = computeActionBenefitForQuantity({
  type: "TRANSFER",
  quantity: 19,
  unitPrice: 22,
  unitCost: 10,
  distanceKm: 10,
  targetLostUnits: 15,
  donorCoverDays: 95,
  donorVelocity: 2,
});

const editedTransferEconomics = computeActionBenefitForQuantity({
  type: "TRANSFER",
  quantity: 12,
  unitPrice: 22,
  unitCost: 10,
  distanceKm: 10,
  targetLostUnits: 15,
  donorCoverDays: 95,
  donorVelocity: 2,
});

const transferOrder: LifecycleOrder = {
  id: "ord_qty_t1",
  origin: "ENGINE",
  type: "TRANSFER",
  status: "SUGGESTED",
  sku: "SKU-QTY-T1",
  productName: "Cedar Olive Oil, 500 ml",
  category: "Beverages",
  targetBranchId: "BR-001",
  targetBranchName: "Manama - CBD",
  sourceBranchId: "BR-002",
  sourceBranchName: "Manama - Juffair",
  quantity: 19,
  qty: 19,
  requestedBy: null,
  linkedAlertId: null,
  engineSnapshot: {
    recommendationId: "ord_qty_t1",
    qty: 19,
    netBenefitBhd: initialTransferEconomics.netBenefitBhd,
    reasonCodes: ["BELOW_REORDER_POINT", "DONOR_SURPLUS"],
    reason: "Intra-cluster transfer.",
    distanceKm: 10,
    freightCostBhd: initialTransferEconomics.freightCostBhd,
    unitPrice: 22,
    unitCost: 10,
    donorVelocity: 2,
    metrics: {
      onHand: 4,
      velocity: 3,
      sigmaDemand: 0.8,
      coverDays: 1.3,
      safetyStock: 5,
      reorderPoint: 12,
      lostMarginAvoided: initialTransferEconomics.lostMarginAvoided,
      carryingCostSaved: initialTransferEconomics.carryingCostSaved,
      transferCost: initialTransferEconomics.freightCostBhd,
      markdownCost: 0,
      donorOnHand: 220,
      donorCoverDays: 95,
      lostUnits: 15,
    },
  },
  createdAt: "2026-11-24T00:00:00.000Z",
  updatedAt: "2026-11-24T00:00:00.000Z",
  awaitingDonorSince: null,
  escalatedAt: null,
  committedAt: null,
  receivedAt: null,
  donorAvailableSurplus: 40,
  donorCoverDaysAfter: 85,
  events: [],
  isVirtual: true,
  lifecycleState: "pending",
  reopenBadge: null,
  canReopen: false,
  decidedAt: null,
  rejectedUntil: null,
};

const reorderOrder: LifecycleOrder = {
  id: "ord_qty_r1",
  origin: "ENGINE",
  type: "REORDER",
  status: "SUGGESTED",
  sku: "SKU-QTY-R1",
  productName: "Velo Espresso Beans",
  category: "Beverages",
  targetBranchId: "BR-001",
  targetBranchName: "Manama - CBD",
  sourceBranchId: null,
  sourceBranchName: null,
  quantity: 10,
  qty: 10,
  requestedBy: null,
  linkedAlertId: null,
  engineSnapshot: {
    recommendationId: "ord_qty_r1",
    qty: 10,
    netBenefitBhd: 120,
    reasonCodes: ["BELOW_REORDER_POINT", "REORDER_TO_TARGET", "NO_DONOR"],
    reason: "Reorder to target.",
    distanceKm: null,
    freightCostBhd: 0,
    unitPrice: 24,
    unitCost: 12,
    metrics: {
      onHand: 3,
      velocity: 2,
      sigmaDemand: 0.5,
      coverDays: 1.5,
      safetyStock: 4,
      reorderPoint: 10,
      lostMarginAvoided: 120,
      carryingCostSaved: 0,
      transferCost: 0,
      markdownCost: 0,
      donorOnHand: null,
      donorCoverDays: null,
      lostUnits: 10,
    },
  },
  createdAt: "2026-11-24T00:00:00.000Z",
  updatedAt: "2026-11-24T00:00:00.000Z",
  awaitingDonorSince: null,
  escalatedAt: null,
  committedAt: null,
  receivedAt: null,
  events: [],
  isVirtual: true,
  lifecycleState: "pending",
  reopenBadge: null,
  canReopen: false,
  decidedAt: null,
  rejectedUntil: null,
};

function renderWithProviders(ui: React.ReactElement) {
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

describe("Workstream 2: ApproveQuantityDialog live gain, limits, and AuditPage diff display", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.kpis.mockResolvedValue({
      branches: [
        { id: "BR-001", name: "Manama - CBD", city: "Manama", region: "Capital", status: "active" },
        { id: "BR-002", name: "Manama - Juffair", city: "Manama", region: "Capital", status: "active" },
      ],
      categories: ["Beverages"],
    });
    apiMocks.locations.mockResolvedValue({ locations: [] });
    apiMocks.listCatalogProducts.mockResolvedValue({ products: [], total: 0, page: 1, limit: 100 });
    apiMocks.commitOrder.mockResolvedValue({
      ...transferOrder,
      status: "COMMITTED",
      quantity: 12,
      qty: 12,
      approvedNetBenefitBhd: editedTransferEconomics.netBenefitBhd,
      approvedFreightCostBhd: editedTransferEconomics.freightCostBhd,
    });
  });

  it("prefills engine quantity, recomputes gain live on edit, enforces reason/comment rules, and renders Audit diff", async () => {
    const user = userEvent.setup();
    apiMocks.listOrders.mockImplementation((q: { queue?: string }) => {
      if (q.queue === "incoming") return Promise.resolve({ orders: [], total: 0 });
      return Promise.resolve({
        orders: [transferOrder, reorderOrder],
        total: 2,
        totalNetBenefit: transferOrder.engineSnapshot.netBenefitBhd + reorderOrder.engineSnapshot.netBenefitBhd,
        view: "pending",
      });
    });

    const queueRender = renderWithProviders(<QueuePage />);
    await screen.findByText("SKU-QTY-T1");

    // 1. Open Approve dialog for TRANSFER (engineSuggested = 19)
    const approveButtons = screen.getAllByRole("button", { name: /^Approve$/i });
    await user.click(approveButtons[0]!);

    expect(await screen.findByText(/Engine suggested: 19/i)).toBeInTheDocument();
    const qtyInput = screen.getByLabelText(/Approved quantity/i) as HTMLInputElement;
    expect(qtyInput.value).toBe("19");

    // 2. Edit down to 12 -> recomputed gain shown & reason required before Confirm unlocks
    await user.clear(qtyInput);
    await user.type(qtyInput, "12");
    expect(
      screen.getByText(formatMoneyFull(editedTransferEconomics.netBenefitBhd)),
    ).toBeInTheDocument();

    const confirmBtn = screen.getByRole("button", { name: /^Confirm Approve$/i });
    expect(confirmBtn).toBeDisabled();

    await user.selectOptions(screen.getByLabelText(/Quantity change reason/i), "CASE_PACK");
    expect(confirmBtn).toBeEnabled();
    await user.click(confirmBtn);

    await waitFor(() =>
      expect(apiMocks.commitOrder).toHaveBeenCalledWith("ord_qty_t1", {
        approvedQty: 12,
        dispositionCode: "CASE_PACK",
      }),
    );

    // 3. Reopen Approve dialog on REORDER -> >1x shows warning & requires comment
    await user.click(approveButtons[1]!);
    expect(await screen.findByText(/Engine suggested: 10/i)).toBeInTheDocument();
    const reorderInput = screen.getByLabelText(/Approved quantity/i) as HTMLInputElement;
    await user.clear(reorderInput);
    await user.type(reorderInput, "15");
    expect(
      screen.getByText(/Approving more than the engine suggested reorder quantity/i),
    ).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText(/Quantity change reason/i), "PROMO_HOLD");
    const confirmReorderBtn = screen.getByRole("button", { name: /^Confirm Approve$/i });
    expect(confirmReorderBtn).toBeDisabled();

    await user.type(screen.getByLabelText(/Comment \(required/i), "Weekend promo");
    expect(confirmReorderBtn).toBeEnabled();
    await user.click(confirmReorderBtn);

    await waitFor(() =>
      expect(apiMocks.commitOrder).toHaveBeenCalledWith("ord_qty_r1", {
        approvedQty: 15,
        dispositionCode: "PROMO_HOLD",
        comment: "Weekend promo",
      }),
    );
    queueRender.unmount();

    // 4. AuditPage shows "Engine: 19 -> Approved: 12 (Case pack)"
    apiMocks.listOrders.mockResolvedValue({
      orders: [
        {
          ...transferOrder,
          status: "COMMITTED",
          quantity: 12,
          qty: 12,
          approvedNetBenefitBhd: editedTransferEconomics.netBenefitBhd,
          isVirtual: false,
          committedAt: "2026-11-24T04:00:00.000Z",
          events: [
            {
              id: "evt_qty_1",
              orderId: transferOrder.id,
              at: "2026-11-24T04:00:00.000Z",
              actor: { userId: "usr_mgr_manama", name: "Manama Manager", role: "manager" },
              action: "COMMIT",
              fromStatus: "SUGGESTED",
              toStatus: "COMMITTED",
              dispositionCode: "CASE_PACK",
              quantity: 12,
              engineQty: 19,
              approvedQty: 12,
            },
          ],
        },
      ],
      total: 1,
    });

    renderWithProviders(<AuditPage />);
    expect(await screen.findByText("Engine: 19 -> Approved: 12 (Case pack)")).toBeInTheDocument();
  });
});

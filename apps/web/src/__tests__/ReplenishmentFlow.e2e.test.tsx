import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PendingStockAlertsCard } from "@/components/shared/PendingStockAlertsCard";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuditPage } from "@/features/audit/AuditPage";
import { StaffProductStats } from "@/features/products/StaffProductStats";
import { QueuePage } from "@/features/queue/QueuePage";
import {
  canTransition,
  type CreateStockAlert,
  type OrderListQuery,
  type ReplenishmentOrder,
  type ResolveStockAlert,
  type StockAlert,
  type User,
} from "@stockflow/core";

const USERS: Record<"staff" | "manama" | "hidd" | "admin", User> = {
  staff: {
    id: "usr_stf_1",
    name: "Amina Floor Staff",
    email: "staff.manama@stockflow.dev",
    role: "staff",
    branchIds: ["BR-001"],
    isActive: true,
    createdAt: "2026-10-01T00:00:00.000Z",
  },
  manama: {
    id: "usr_mgr_manama",
    name: "Tariq Manama Manager",
    email: "mgr.manama@stockflow.dev",
    role: "manager",
    branchIds: ["BR-001", "BR-002"],
    isActive: true,
    createdAt: "2026-10-01T00:00:00.000Z",
  },
  hidd: {
    id: "usr_mgr_hidd",
    name: "Nadia Hidd Manager",
    email: "mgr.hidd@stockflow.dev",
    role: "manager",
    branchIds: ["BR-005"],
    isActive: true,
    createdAt: "2026-10-01T00:00:00.000Z",
  },
  admin: {
    id: "usr_admin",
    name: "Admin Ops",
    email: "admin@stockflow.dev",
    role: "admin",
    branchIds: [],
    isActive: true,
    createdAt: "2026-10-01T00:00:00.000Z",
  },
};

const activeAuth: { user: User } = { user: USERS.staff };

vi.mock("@/features/auth/AuthContext", () => ({
  useAuth: () => ({
    user: activeAuth.user,
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
    refreshUser: vi.fn(),
  }),
}));

const state = {
  alerts: [] as StockAlert[],
  orders: [] as ReplenishmentOrder[],
};

vi.mock("@/lib/api", () => ({
  api: {
    kpis: async () => ({
      branches: [
        { id: "BR-001", name: "Manama - CBD", city: "Manama", region: "Capital", status: "active" },
        { id: "BR-005", name: "Muharraq - Hidd", city: "Muharraq", region: "Muharraq", status: "active" },
      ],
      categories: ["Beverages"],
    }),
    locations: async () => ({ locations: [] }),
    listCatalogProducts: async () => ({
      products: [
        {
          sku: "SKU-00012",
          name: "Clearwater Sparkling Water, 330 ml",
          category: "Beverages",
          price: 5,
          cost: 3,
          leadTimeDays: 7,
          status: "active",
          stats: { onHand: 20, velocity: 5, coverDays: 4, status: "AT_RISK" },
        },
      ],
      total: 1,
      page: 1,
      limit: 25,
      totalPages: 1,
      branchSummary: {
        branch: { id: "BR-001", name: "Manama - CBD", city: "Manama", region: "Capital", status: "active" },
        totalSkus: 1,
        statusCounts: { AT_RISK: 1, HEALTHY: 0, OVERSTOCK: 0, NEW: 0 },
      },
    }),
    listStockAlerts: async (branchId?: string) => ({
      alerts: state.alerts
        .filter((a) => (!branchId || a.branchId === branchId))
        .map((a) => ({
          ...a,
          linkedOrderStatus: a.resolution?.linkedOrderId
            ? state.orders.find((o) => o.id === a.resolution?.linkedOrderId)?.status ?? null
            : null,
        })),
    }),
    createStockAlert: async (payload: CreateStockAlert) => {
      const alert: StockAlert = {
        id: "alt_e2e_1",
        branchId: payload.branchId,
        branchName: "Manama - CBD",
        sku: payload.sku,
        productName: "Clearwater Sparkling Water, 330 ml",
        category: payload.category ?? "CRITICAL_LOW",
        reportedQty: payload.reportedQty,
        flaggedBy: { userId: activeAuth.user.id, name: activeAuth.user.name, role: activeAuth.user.role },
        flaggedAt: "2026-11-24T00:05:00.000Z",
        note: payload.note,
        status: "PENDING",
        decidedBy: null,
        decidedAt: null,
        resolution: null,
      };
      state.alerts.push(alert);
      return alert;
    },
    donorCandidates: async () => ({
      candidates: [
        {
          branchId: "BR-005",
          branchName: "Muharraq - Hidd",
          distanceKm: 14.5,
          freightCostBhd: 7.425,
          availableSurplusUnits: 90,
          requestedQty: 15,
          offeredQty: 15,
          isPartial: false,
          donorCoverDaysAfter: 105,
          targetCoverDaysBefore: 4,
          targetCoverDaysAfter: 7,
          netBenefitBhd: 24.75,
          eligible: true,
        },
      ],
    }),
    resolveStockAlert: async (id: string, payload: ResolveStockAlert) => {
      const idx = state.alerts.findIndex((a) => a.id === id);
      const alert = state.alerts[idx]!;
      const decidedAt = "2026-11-24T01:00:00.000Z";
      const actor = { userId: activeAuth.user.id, name: activeAuth.user.name, role: activeAuth.user.role };

      const order: ReplenishmentOrder = {
        id: "ord_e2e_1",
        origin: "ALERT_ESCALATION",
        type: "TRANSFER",
        status: payload.sourceBranchId ? "AWAITING_DONOR" : "OPEN_REQUEST",
        sku: alert.sku,
        productName: alert.productName ?? alert.sku,
        category: "Beverages",
        targetBranchId: alert.branchId,
        targetBranchName: "Manama - CBD",
        sourceBranchId: payload.sourceBranchId ?? null,
        sourceBranchName: payload.sourceBranchId === "BR-005" ? "Muharraq - Hidd" : null,
        quantity: payload.quantity ?? 15,
        requestedBy: actor,
        linkedAlertId: alert.id,
        engineSnapshot: {
          netBenefitBhd: 24.75,
          reasonCodes: ["BELOW_REORDER_POINT", "RECEIVER_BELOW_TARGET", "DONOR_SURPLUS"],
          reason: "Escalated from shelf alert.",
          distanceKm: 14.5,
          freightCostBhd: 7.425,
        },
        createdAt: decidedAt,
        updatedAt: decidedAt,
        awaitingDonorSince: payload.sourceBranchId ? decidedAt : null,
        escalatedAt: null,
        committedAt: null,
        receivedAt: null,
        donorAvailableSurplus: 90,
        donorCoverDaysAfter: 105,
        events: [
          {
            id: "evt_e2e_1",
            orderId: "ord_e2e_1",
            at: decidedAt,
            actor,
            action: "CREATED",
            fromStatus: null,
            toStatus: payload.sourceBranchId ? "AWAITING_DONOR" : "OPEN_REQUEST",
            comment: payload.comment,
          },
        ],
      };
      state.orders.push(order);
      const updatedAlert: StockAlert = {
        ...alert,
        status: "RESOLVED",
        decidedBy: actor,
        decidedAt,
        resolution: {
          action: payload.action,
          linkedOrderId: order.id,
          comment: payload.comment,
          decidedBy: actor,
          decidedAt,
        },
        linkedOrderStatus: order.status,
      };
      state.alerts[idx] = updatedAlert;
      return { alert: updatedAlert, order };
    },
    listOrders: async (query: OrderListQuery = {}) => {
      const orders = state.orders.filter((o) => {
        if (query.queue === "incoming") return o.status === "AWAITING_DONOR";
        if (query.queue === "outgoing") {
          return (
            activeAuth.user.role === "admin" || activeAuth.user.branchIds.includes(o.targetBranchId)
          );
        }
        return true;
      }).filter((o) => (!query.status || o.status === query.status));
      return { orders, total: orders.length };
    },
    commitOrder: async (id: string, body: { comment?: string } = {}) => {
      const order = state.orders.find((o) => o.id === id)!;
      const decision = canTransition(order, activeAuth.user, "COMMIT", {
        ownsTarget: activeAuth.user.branchIds.includes(order.targetBranchId),
        ownsSource: Boolean(order.sourceBranchId && activeAuth.user.branchIds.includes(order.sourceBranchId)),
        intraCluster: false,
        isRequester: false,
      });
      if (!decision.allowed) throw new Error(decision.reason);
      const at = "2026-11-24T02:00:00.000Z";
      const actor = { userId: activeAuth.user.id, name: activeAuth.user.name, role: activeAuth.user.role };
      order.status = decision.nextStatus;
      order.committedAt = at;
      order.updatedAt = at;
      order.events.push({
        id: "evt_e2e_2",
        orderId: order.id,
        at,
        actor,
        action: "COMMIT",
        fromStatus: "AWAITING_DONOR",
        toStatus: "COMMITTED",
        comment: body.comment,
      });
      return order;
    },
    receiveOrder: async (id: string, body: { comment?: string } = {}) => {
      const order = state.orders.find((o) => o.id === id)!;
      const decision = canTransition(order, activeAuth.user, "RECEIVE", {
        ownsTarget: activeAuth.user.branchIds.includes(order.targetBranchId),
        ownsSource: false,
        intraCluster: false,
        isRequester: false,
      });
      if (!decision.allowed) throw new Error(decision.reason);
      const at = "2026-11-24T03:00:00.000Z";
      const actor = { userId: activeAuth.user.id, name: activeAuth.user.name, role: activeAuth.user.role };
      order.status = decision.nextStatus;
      order.receivedAt = at;
      order.updatedAt = at;
      order.events.push({
        id: "evt_e2e_3",
        orderId: order.id,
        at,
        actor,
        action: "RECEIVE",
        fromStatus: "COMMITTED",
        toStatus: "RECEIVED",
        comment: body.comment,
      });
      return order;
    },
  },
}));

function renderStep(ui: React.ReactElement, initialPath = "/") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialPath]}>
        <TooltipProvider>{ui}</TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Stage D Happy-Path E2E: staff alert -> manager request -> donor release -> receive -> audit thread", () => {
  beforeEach(() => {
    state.alerts = [];
    state.orders = [];
    activeAuth.user = USERS.staff;
  });

  it("walks an escalated stock alert from floor flag through donor release, receipt, and threaded audit", async () => {
    const user = userEvent.setup();

    // Step 1: Staff flags SKU-00012 at BR-001
    activeAuth.user = USERS.staff;
    const step1 = renderStep(<StaffProductStats />);
    await screen.findByText("SKU-00012");
    await user.click(screen.getByRole("button", { name: /Flag stock/i }));
    await user.type(screen.getByLabelText(/Physical shelf count/i), "20");
    await user.type(screen.getByLabelText(/Floor observation note/i), "Low shelf stock ahead of rush");
    await user.click(screen.getByRole("button", { name: /Submit alert/i }));
    await waitFor(() => expect(state.alerts).toHaveLength(1));
    step1.unmount();

    // Step 2: Manama Manager resolves alert -> Request Replenishment & selects Hidd donor BR-005
    activeAuth.user = USERS.manama;
    const step2 = renderStep(<PendingStockAlertsCard scope="branch" branchId="BR-001" />);
    await screen.findByText("Low shelf stock ahead of rush");
    await user.click(screen.getByRole("button", { name: /^Resolve$/i }));
    const qtyInput = await screen.findByLabelText(/Quantity/i);
    await user.clear(qtyInput);
    await user.type(qtyInput, "15");
    await user.click(await screen.findByRole("option", { name: /BR-005/i }));
    await user.type(screen.getByLabelText(/Resolution comment/i), "Need 15 units from Hidd surplus");
    await user.click(screen.getByRole("button", { name: /Confirm resolution/i }));
    await waitFor(() => expect(state.orders[0]?.status).toBe("AWAITING_DONOR"));
    step2.unmount();

    // Step 3: Hidd Sending Manager sees Requests to Fulfil & clicks Send Stock
    activeAuth.user = USERS.hidd;
    const step3 = renderStep(<QueuePage />, "/queue?tab=incoming");
    await screen.findByText("90 units");
    await user.click(screen.getByRole("button", { name: /^Send Stock$/i }));
    await user.click(await screen.findByRole("button", { name: /^Confirm Send Stock$/i }));
    await waitFor(() => expect(state.orders[0]?.status).toBe("COMMITTED"));
    step3.unmount();

    // Step 4: Staff sees COMMITTED delivery & marks as received -> RECEIVED
    activeAuth.user = USERS.staff;
    const step4 = renderStep(<StaffProductStats />);
    await screen.findByText("Need 15 units from Hidd surplus");
    await user.click(screen.getByRole("button", { name: /Mark as Received/i }));
    await waitFor(() => expect(state.orders[0]?.status).toBe("RECEIVED"));
    await screen.findByText("Received");
    step4.unmount();

    // Step 5: Admin reviews AuditPage -> one thread with grey chips, quote comment, and 3-event chain
    activeAuth.user = USERS.admin;
    const step5 = renderStep(<AuditPage />, "/audit");
    await screen.findByText("ord_e2e_1");
    expect(screen.getByText("Alert alt_e2e_1")).toBeInTheDocument();
    expect(screen.getByText("BELOW_REORDER_POINT")).toBeInTheDocument();
    expect(screen.getByText("DONOR_SURPLUS")).toBeInTheDocument();
    expect(screen.getByText("Need 15 units from Hidd surplus")).toBeInTheDocument();
    expect(screen.getByText("Tariq Manama Manager")).toBeInTheDocument();
    expect(screen.getByText("Nadia Hidd Manager")).toBeInTheDocument();
    expect(screen.getByText("Amina Floor Staff")).toBeInTheDocument();
    step5.unmount();
  });
});

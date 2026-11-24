import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChartDetailProvider } from "@/components/shared/ChartDetailPopup";
import { TooltipProvider } from "@/components/ui/tooltip";
import { OverviewPage } from "@/features/overview/OverviewPage";
import type { LiveOverviewResponse } from "@/lib/api";
import { DEFAULT_POLICY, type User } from "@stockflow/core";

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

vi.mock("@/hooks/useLocationScope", () => ({
  useLocationScope: () => ({
    selectedLocation: null,
    setSelectedLocation: vi.fn(),
  }),
}));

vi.mock("@/hooks/useBahrainToday", () => ({
  useBahrainToday: () => ({
    isoDate: "2026-11-24",
    displayDate: "Tue, 24 Nov 2026",
  }),
}));

const apiMocks = vi.hoisted(() => ({
  kpisLive: vi.fn(),
  kpis: vi.fn(),
  recommendations: vi.fn(),
  listStockAlerts: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: apiMocks,
}));

function buildLiveFixture(overrides?: {
  asOfDataDate?: string;
  staleDataDays?: number;
  pendingCount?: number;
  pendingGain?: number;
}): LiveOverviewResponse {
  const asOfDataDate = overrides?.asOfDataDate ?? "2026-11-20";
  const staleDataDays = overrides?.staleDataDays ?? 4;
  const pendingCount = overrides?.pendingCount ?? 3;
  const pendingGain = overrides?.pendingGain ?? 420;
  const env = (value: number) => ({
    value,
    computedAt: "2026-11-24T07:30:00.000Z", // 10:30 Asia/Bahrain
    dataVersion: 2,
    decisionVersion: 4,
  });

  return {
    report: {
      asOf: asOfDataDate,
      policy: DEFAULT_POLICY,
      branches: [
        { id: "BR-001", name: "Manama - CBD", city: "Manama", region: "Capital", status: "active" },
      ],
      categories: ["Beverages"],
      stockoutRate: 0.08,
      deadStockValue: 500,
      lostSalesAtRisk: 1200,
      cashReleasable: 3100,
      branchRisk: [
        { branchId: "BR-001", branchName: "Manama - CBD", stockoutRate: 0.08, revenueAtRisk: 1200 },
      ],
      categoryRisk: [{ category: "Beverages", atRiskCount: 2, revenueAtRisk: 1200 }],
      coverGrid: [
        {
          branchId: "BR-001",
          branchName: "Manama - CBD",
          category: "Beverages",
          coverDays: 5,
        },
      ],
      trend: [
        { date: "2026-11-18", stockoutRate: 0.1, salesValue: 500, inventoryValue: 2000 },
        { date: "2026-11-19", stockoutRate: 0.09, salesValue: 550, inventoryValue: 2100 },
        { date: asOfDataDate, stockoutRate: 0.08, salesValue: 600, inventoryValue: 2200 },
      ],
      backtest: {
        windowDays: 28,
        baselineStockoutDays: 10,
        engineStockoutDays: 3,
        stockoutDaysAvoided: 7,
        cashReleased: 1000,
      },
      operational: {
        pendingApprovalsCount: pendingCount,
        backlogValue: pendingGain,
        atRiskBranchCount: 1,
      },
    },
    meta: {
      computedAt: "2026-11-24T07:30:00.000Z",
      dataVersion: 2,
      decisionVersion: 4,
      todayBahrain: "2026-11-24",
      asOfDataDate,
      staleDataDays,
    },
    metrics: {
      stockoutRate: env(0.08),
      stockoutRateDelta28d: env(-0.02),
      overstockValue: env(3100),
      deadStockValue: env(500),
      salesAtRisk: env(1200),
      pendingActionsCount: env(pendingCount),
      pendingEstimatedGain: env(pendingGain),
    },
    stockoutSparkline: [0.1, 0.09, 0.08],
    pendingRecommendations: [],
  };
}

function renderOverview() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ChartDetailProvider>
          <TooltipProvider>
            <OverviewPage />
          </TooltipProvider>
        </ChartDetailProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("OverviewPage live Bahrain dates, stale data banner, and refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.listStockAlerts.mockResolvedValue({ alerts: [] });
  });

  it("renders Bahrain Today date, Data through date, Updated HH:mm, stale warning linking to /data?tab=import, and supports manual Refresh via single kpisLive query", async () => {
    const user = userEvent.setup();
    apiMocks.kpisLive
      .mockResolvedValueOnce(buildLiveFixture({ asOfDataDate: "2026-11-20", staleDataDays: 4 }))
      .mockResolvedValueOnce(buildLiveFixture({ asOfDataDate: "2026-11-24", staleDataDays: 0, pendingCount: 5, pendingGain: 800 }));

    renderOverview();

    await screen.findByText(/Today: Tue, 24 Nov 2026/i);
    expect(screen.getAllByText(/Data through/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Updated 10:30/i)).toBeInTheDocument();
    expect(screen.getByText(/3 ranked actions worth BD 420 in estimated gain/i)).toBeInTheDocument();

    // Static replay copy must be absent
    expect(screen.queryByText(/Backtest verified/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/replay window/i)).not.toBeInTheDocument();

    // Stale data warning (> 1 day old) links to /data?tab=import
    const staleLink = screen.getByRole("link", {
      name: /Data is 4 days old - import latest sales/i,
    });
    expect(staleLink).toHaveAttribute("href", "/data?tab=import");

    // Only kpisLive was fetched (no separate kpis / recommendations calls)
    expect(apiMocks.kpisLive).toHaveBeenCalledTimes(1);
    expect(apiMocks.kpis).not.toHaveBeenCalled();
    expect(apiMocks.recommendations).not.toHaveBeenCalled();

    // Click Refresh -> fetches fresh live data and clears stale warning
    await user.click(screen.getByRole("button", { name: /Refresh/i }));

    await waitFor(() => {
      expect(apiMocks.kpisLive).toHaveBeenCalledTimes(2);
    });
    expect(
      screen.queryByRole("link", { name: /Data is .* old - import latest sales/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/5 ranked actions worth BD 800 in estimated gain/i),
    ).toBeInTheDocument();
  });
});

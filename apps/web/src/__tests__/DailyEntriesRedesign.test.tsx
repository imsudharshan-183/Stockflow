import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DataEntryPage } from "@/features/data/DataEntryPage";
import { getBahrainTodayIso } from "@/lib/format";
import type { Product, User } from "@stockflow/core";

const apiMocks = vi.hoisted(() => ({
  locations: vi.fn(),
  listCatalogProducts: vi.fn(),
  listSalesEntries: vi.fn(),
  listSalesImports: vi.fn(),
  importSalesCsv: vi.fn(),
  createSalesEntry: vi.fn(),
  updateSalesEntry: vi.fn(),
  deleteSalesEntry: vi.fn(),
  locationInventory: vi.fn(),
}));

const authState = vi.hoisted((): { user: User } => ({
  user: {
    id: "usr_admin_1",
    name: "Network Admin",
    email: "admin@stockflow.dev",
    role: "admin",
    branchIds: [],
    isActive: true,
    createdAt: "2026-10-01T00:00:00.000Z",
  },
}));

vi.mock("@/lib/api", () => ({
  api: apiMocks,
}));

vi.mock("@/features/auth/AuthContext", () => ({
  useAuth: () => ({ user: authState.user }),
  useOptionalAuth: () => ({ user: authState.user }),
}));

vi.mock("@/hooks/useLocationScope", () => ({
  useLocationScope: () => ({
    selectedLocation: null,
    setSelectedLocation: vi.fn(),
  }),
}));

const sampleProducts: Product[] = [
  {
    sku: "SKU-00001",
    name: "Clearwater Sparkling Water, 330 ml",
    category: "Beverages",
    price: 0.45,
    cost: 0.2,
    leadTimeDays: 5,
    status: "active",
  },
  {
    sku: "SKU-00002",
    name: "Cedar Olive Oil, 500 ml",
    category: "Pantry",
    price: 3.25,
    cost: 1.9,
    leadTimeDays: 7,
    status: "active",
  },
];

function renderDataEntry(initialUrl = "/data") {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialUrl]}>
        <Routes>
          <Route path="/data" element={<DataEntryPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Workstream 3: Daily entries page redesign", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    authState.user = {
      id: "usr_admin_1",
      name: "Network Admin",
      email: "admin@stockflow.dev",
      role: "admin",
      branchIds: [],
      isActive: true,
      createdAt: "2026-10-01T00:00:00.000Z",
    };

    apiMocks.locations.mockResolvedValue({
      locations: [
        {
          branch: {
            id: "BR-001",
            name: "Manama - CBD",
            city: "Manama",
            region: "Capital",
            status: "active",
          },
          kpis: {},
        },
        {
          branch: {
            id: "BR-002",
            name: "Manama - Juffair",
            city: "Manama",
            region: "Capital",
            status: "active",
          },
          kpis: {},
        },
      ],
    });
    apiMocks.listCatalogProducts.mockResolvedValue({
      products: sampleProducts,
      total: sampleProducts.length,
      page: 1,
      limit: 200,
    });
    apiMocks.listSalesImports.mockResolvedValue({ imports: [] });
    apiMocks.createSalesEntry.mockResolvedValue({ id: "ent_new_1" });
    apiMocks.locationInventory.mockResolvedValue({
      items: [
        {
          sku: "SKU-00001",
          name: "Clearwater Sparkling Water, 330 ml",
          category: "Beverages",
          onHand: 18,
          velocity: 4,
          coverDays: 4.5,
          reorderPoint: 24,
          status: "AT_RISK",
          surplus: 0,
          reserved: 0,
          inTransit: 0,
          recommendedAction: "REORDER",
          recommendationId: "rec_1",
          netBenefit: 25,
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
    });
    apiMocks.listSalesEntries.mockImplementation((query?: { from?: string; to?: string; sku?: string }) => {
      if (query?.from && query?.to && query.sku === "SKU-00002") {
        return Promise.resolve({
          entries: [
            {
              id: "ent_existing_2",
              branchId: "BR-001",
              sku: "SKU-00002",
              date: query.from,
              unitsSold: 3,
              onHand: 15,
              updatedAt: "2026-11-24T05:00:00.000Z",
            },
          ],
          total: 1,
          page: 1,
          limit: 1,
          totalPages: 1,
        });
      }
      if (query?.from && query?.to && query.sku === "SKU-00001") {
        return Promise.resolve({ entries: [], total: 0, page: 1, limit: 1, totalPages: 1 });
      }
      return Promise.resolve({
        entries: [
          {
            id: "ent_hist_1",
            branchId: "BR-001",
            sku: "SKU-00001",
            date: "2026-11-23",
            unitsSold: 4,
            onHand: 20,
            updatedAt: "2026-11-23T05:00:00.000Z",
          },
          {
            id: "ent_hist_2",
            branchId: "BR-001",
            sku: "SKU-00001",
            date: "2026-11-22",
            unitsSold: 5,
            onHand: 24,
            updatedAt: "2026-11-22T05:00:00.000Z",
          },
        ],
        total: 2,
        page: 1,
        limit: 10,
        totalPages: 1,
      });
    });
  });

  it("renders Context panel empty/populated, New vs Updating banner, soft warnings with confirm checkbox, and Save & add another", async () => {
    const user = userEvent.setup();
    renderDataEntry("/data");

    // Context help prompt before SKU selected + End-of-day stock label + recent last-10 heading
    expect(await screen.findByText(/No SKU selected yet/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/End-of-day stock \(on hand\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Recent entries \(last 10\)/i)).toBeInTheDocument();

    // Search and select SKU-00001 -> "New entry" banner & populated Context panel
    const skuCombo = screen.getByRole("combobox", { name: /Select SKU/i });
    await user.click(skuCombo);
    await user.click(await screen.findByRole("option", { name: /SKU-00001/i }));

    expect(await screen.findByText(/^New entry$/i)).toBeInTheDocument();
    expect(await screen.findByText(/At risk/i)).toBeInTheDocument();
    expect(screen.getByText(/Last 7 days sales/i)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /7-day unit sales sparkline/i })).toBeInTheDocument();

    // Switching to SKU-00002 shows "Updating existing entry (...)" banner
    await user.click(screen.getByRole("button", { name: /Clear SKU selection/i }));
    await user.click(await screen.findByRole("option", { name: /SKU-00002/i }));
    expect(await screen.findByText(/Updating existing entry/i)).toBeInTheDocument();

    // Switch back to SKU-00001 and trigger soft warnings (high unitsSold & sharp onHand jump)
    await user.click(screen.getByRole("button", { name: /Clear SKU selection/i }));
    await user.click(await screen.findByRole("option", { name: /SKU-00001/i }));

    const soldInput = screen.getByLabelText(/Units sold/i);
    const onHandInput = screen.getByLabelText(/End-of-day stock \(on hand\)/i);
    await user.clear(soldInput);
    await user.type(soldInput, "40");
    await user.clear(onHandInput);
    await user.type(onHandInput, "150");

    expect(await screen.findByText(/Review unusual figures before saving/i)).toBeInTheDocument();
    const saveAndAnotherBtn = screen.getByRole("button", { name: /Save & add another/i });
    expect(saveAndAnotherBtn).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: /Confirm these figures are accurate/i }));
    expect(saveAndAnotherBtn).toBeEnabled();
    await user.click(saveAndAnotherBtn);

    const todayIso = getBahrainTodayIso();
    await waitFor(() =>
      expect(apiMocks.createSalesEntry).toHaveBeenCalledWith({
        branchId: "BR-001",
        sku: "SKU-00001",
        date: todayIso,
        unitsSold: 40,
        onHand: 150,
      }),
    );

    // Save & add another preserves branch + date and clears SKU & numbers
    await waitFor(() => {
      expect((screen.getByLabelText(/Location/i) as HTMLSelectElement).value).toBe("BR-001");
      expect((screen.getByLabelText(/^Date$/i) as HTMLInputElement).value).toBe(todayIso);
      expect((screen.getByLabelText(/Units sold/i) as HTMLInputElement).value).toBe("0");
      expect((screen.getByLabelText(/End-of-day stock \(on hand\)/i) as HTMLInputElement).value).toBe("0");
    });
  });

  it("supports Daily sheet submission with browser-built CSV and shows per-row server errors", async () => {
    const user = userEvent.setup();
    apiMocks.importSalesCsv
      .mockResolvedValueOnce({
        inserted: 0,
        updated: 0,
        errors: [{ row: 2, message: "Stock count anomaly rejected" }],
      })
      .mockResolvedValueOnce({
        inserted: 1,
        updated: 0,
        errors: [],
      });

    renderDataEntry("/data");
    await screen.findByLabelText(/Location/i);

    await user.click(screen.getByRole("button", { name: /^Daily sheet$/i }));
    await user.click(await screen.findByRole("button", { name: /Paste from Excel/i }));
    const pasteBox = screen.getByLabelText(/Paste spreadsheet rows/i);
    await user.type(pasteBox, "SKU-00001\t6\t22");
    await user.click(screen.getByRole("button", { name: /Add pasted rows/i }));

    await user.click(screen.getByRole("button", { name: /Submit daily sheet/i }));
    expect(await screen.findByText(/Stock count anomaly rejected/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Submit daily sheet/i }));
    await waitFor(() => expect(apiMocks.importSalesCsv).toHaveBeenCalledTimes(2));
    const uploadedFile = apiMocks.importSalesCsv.mock.calls[1]![0] as File;
    expect(uploadedFile.name).toMatch(/^daily-sheet-BR-001-/);
  });

  it("scopes the Location dropdown to the manager's or staff member's assigned branches", async () => {
    authState.user = {
      id: "usr_mgr_juffair",
      name: "Juffair Manager",
      email: "mgr.juffair@stockflow.dev",
      role: "manager",
      branchIds: ["BR-002"],
      isActive: true,
      createdAt: "2026-10-01T00:00:00.000Z",
    };

    renderDataEntry("/data");

    const select = (await screen.findByLabelText(/Location/i)) as HTMLSelectElement;
    await waitFor(() => {
      const values = Array.from(select.options).map((opt) => opt.value);
      expect(values).toEqual(["BR-002"]);
    });
  });
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DataEntryPage } from "@/features/data/DataEntryPage";

const apiMocks = vi.hoisted(() => ({
  locations: vi.fn(),
  listCatalogProducts: vi.fn(),
  listSalesEntries: vi.fn(),
  listSalesImports: vi.fn(),
  importSalesCsv: vi.fn(),
  createSalesEntry: vi.fn(),
  updateSalesEntry: vi.fn(),
  deleteSalesEntry: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: apiMocks,
}));

vi.mock("@/hooks/useLocationScope", () => ({
  useLocationScope: () => ({
    selectedLocation: null,
    setSelectedLocation: vi.fn(),
  }),
}));

function renderImportPage(initialUrl = "/data?tab=import") {
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

describe("DataEntryPage Import CSV UX", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      ],
    });
    apiMocks.listCatalogProducts.mockResolvedValue({
      products: [],
      total: 0,
      page: 1,
      limit: 25,
    });
    apiMocks.listSalesEntries.mockResolvedValue({
      entries: [],
      total: 0,
      page: 1,
      limit: 20,
    });
    apiMocks.listSalesImports.mockResolvedValue({
      imports: [],
    });
  });

  it("clears the file input on 0-error import, shows success banner, refreshes Recent imports, and filters Recent entries on button click", async () => {
    const user = userEvent.setup();
    apiMocks.importSalesCsv.mockResolvedValue({
      inserted: 28,
      updated: 56,
      errors: [],
    });
    apiMocks.listSalesImports
      .mockResolvedValueOnce({ imports: [] })
      .mockResolvedValue({
        imports: [
          {
            id: "imp_1",
            importedAt: "2026-11-24T05:15:00.000Z",
            fileName: "daily-sales.csv",
            user: { userId: "usr_mgr_1", name: "Manama Manager", role: "manager" },
            inserted: 28,
            updated: 56,
            errorCount: 0,
            minDate: "2026-11-20",
            maxDate: "2026-11-24",
            branchIds: ["BR-001"],
          },
        ],
      });

    renderImportPage();

    const fileInput = screen.getByLabelText("CSV file") as HTMLInputElement;
    const csvContent = [
      "branchId,sku,date,unitsSold,onHand",
      "BR-001,SKU-00001,2026-11-20,5,20",
      "BR-001,SKU-00002,2026-11-24,3,18",
    ].join("\n");
    const file = new File([csvContent], "daily-sales.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", {
      value: async () => csvContent,
    });

    await user.upload(fileInput, file);
    expect(screen.getByText(/Selected:/i)).toBeInTheDocument();
    expect(screen.getByText("daily-sales.csv")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Upload & import/i }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "Import complete: 28 inserted, 56 updated, 0 errors",
      );
    });

    expect(fileInput.value).toBe("");
    expect(screen.queryByText(/Selected:/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Upload & import/i })).toBeDisabled();

    await waitFor(() => {
      expect(screen.getByText("Manama Manager")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /View in Recent entries/i }));

    await waitFor(() => {
      expect(apiMocks.listSalesEntries).toHaveBeenCalledWith(
        expect.objectContaining({
          from: "2026-11-20",
          to: "2026-11-24",
          page: 1,
          limit: 20,
        }),
      );
    });
  });

  it("keeps the file selected when rows have errors and supports downloading error rows as CSV", async () => {
    const user = userEvent.setup();
    apiMocks.importSalesCsv.mockResolvedValue({
      inserted: 1,
      updated: 0,
      errors: [{ row: 2, message: "Unknown sku INVALID-SKU" }],
    });

    let capturedBlob: Blob | undefined;
    const createObjectURLSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockImplementation((obj: Blob | MediaSource) => {
        capturedBlob = obj as Blob;
        return "blob:error-rows";
      });
    const revokeObjectURLSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const anchorClickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    try {
      renderImportPage();

      const fileInput = screen.getByLabelText("CSV file") as HTMLInputElement;
      const csvContent = [
        "branchId,sku,date,unitsSold,onHand",
        "BR-001,SKU-00001,2026-11-24,4,10",
        "BR-001,INVALID-SKU,2026-11-24,2,5",
      ].join("\n");
      const file = new File([csvContent], "bad-batch.csv", { type: "text/csv" });
      Object.defineProperty(file, "text", {
        value: async () => csvContent,
      });

      await user.upload(fileInput, file);
      fireEvent.click(screen.getByRole("button", { name: /Upload & import/i }));

      await waitFor(() => {
        expect(screen.getByText(/Import finished with 1 error\(s\)/i)).toBeInTheDocument();
      });

      expect(screen.getByText(/Row 2:/i)).toBeInTheDocument();
      expect(screen.getByText(/Unknown sku INVALID-SKU/i)).toBeInTheDocument();
      expect(screen.getByText(/Selected:/i)).toBeInTheDocument();
      expect(screen.getAllByText("bad-batch.csv").length).toBeGreaterThanOrEqual(2);

      const downloadBtn = screen.getByRole("button", { name: /Download error rows as CSV/i });
      await user.click(downloadBtn);

      expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
      expect(anchorClickSpy).toHaveBeenCalledTimes(1);
      expect(revokeObjectURLSpy).toHaveBeenCalledWith("blob:error-rows");
      expect(capturedBlob).toBeDefined();
      const errorCsvText = await capturedBlob!.text();
      expect(errorCsvText).toContain("branchId,sku,date,unitsSold,onHand,error");
      expect(errorCsvText).toContain('BR-001,INVALID-SKU,2026-11-24,2,5,"Unknown sku INVALID-SKU"');
    } finally {
      createObjectURLSpy.mockRestore();
      revokeObjectURLSpy.mockRestore();
      anchorClickSpy.mockRestore();
    }
  });
});

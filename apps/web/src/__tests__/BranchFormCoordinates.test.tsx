import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BranchesManagePage } from "@/features/branches/BranchesManagePage";

const apiMocks = vi.hoisted(() => ({
  listBranches: vi.fn(),
  createBranch: vi.fn(),
  updateBranch: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: apiMocks,
}));

function renderManageBranches() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <BranchesManagePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("BranchesManagePage unified coordinate parser and cluster select", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.listBranches.mockResolvedValue({ branches: [], total: 0 });
    apiMocks.createBranch.mockResolvedValue({
      id: "BR-016",
      name: "Amwaj Lagoon",
      city: "Amwaj",
      region: "Muharraq",
      coordinates: [26.2285, 50.586],
      status: "active",
    });
  });

  it("parses Google Maps URLs, space-separated coords, DMS, detects swapped coords with fix button, gates outside Bahrain, and auto-suggests region", async () => {
    const user = userEvent.setup();
    renderManageBranches();

    const coordsInput = (await screen.findByLabelText(
      /Coordinates \(paste from Google Maps\)/i,
    )) as HTMLInputElement;
    expect(coordsInput.value).toBe("");

    // 1. Space-separated decimals on blur
    await user.type(coordsInput, "26.2285 50.5860");
    fireEvent.blur(coordsInput);
    expect(screen.getByText("Latitude 26.2285, Longitude 50.5860")).toBeInTheDocument();
    const mapLink = screen.getByRole("link", { name: /Open in map/i });
    expect(mapLink).toHaveAttribute("href", "https://www.google.com/maps?q=26.2285,50.586");

    // 2. Google Maps @lat,lng and !3dlat!4dlng on paste
    fireEvent.change(coordsInput, { target: { value: "" } });
    fireEvent.paste(coordsInput, {
      clipboardData: {
        getData: () => "https://www.google.com/maps/place/Test/@26.2845,50.6612,15z",
      },
    });
    expect(screen.getByText("Latitude 26.2845, Longitude 50.6612")).toBeInTheDocument();

    fireEvent.change(coordsInput, { target: { value: "" } });
    fireEvent.paste(coordsInput, {
      clipboardData: {
        getData: () => "https://www.google.com/maps/place/!3d26.2151!4d50.5919",
      },
    });
    expect(screen.getByText("Latitude 26.2151, Longitude 50.5919")).toBeInTheDocument();

    // 3. DMS notation
    fireEvent.change(coordsInput, { target: { value: "" } });
    fireEvent.paste(coordsInput, {
      clipboardData: {
        getData: () => '26°13\'42.6"N 50°35\'09.6"E',
      },
    });
    expect(screen.getByText("Latitude 26.2285, Longitude 50.5860")).toBeInTheDocument();

    // 4. Outside Bahrain warning requires confirmation before submit
    await user.type(screen.getByLabelText(/Branch name/i), "Dubai Concept");
    await user.type(screen.getByLabelText(/^City$/i), "Dubai");
    fireEvent.change(coordsInput, { target: { value: "" } });
    fireEvent.paste(coordsInput, {
      clipboardData: { getData: () => "25.2048, 55.2708" },
    });
    expect(screen.getByText(/Coordinates are outside Bahrain/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Add branch/i }));
    expect(apiMocks.createBranch).not.toHaveBeenCalled();

    // 5. Swapped coordinates trigger error + one-click swap button
    fireEvent.change(coordsInput, { target: { value: "" } });
    fireEvent.paste(coordsInput, {
      clipboardData: { getData: () => "50.5860, 26.2285" },
    });
    expect(screen.getByText(/Coordinates appear swapped/i)).toBeInTheDocument();

    const swapBtn = screen.getByRole("button", {
      name: /Swap to Latitude 26\.2285, Longitude 50\.5860/i,
    });
    await user.click(swapBtn);
    expect(screen.getByText("Latitude 26.2285, Longitude 50.5860")).toBeInTheDocument();

    // 6. City auto-suggests Cluster / Region and submits numeric coordinates
    const cityInput = screen.getByLabelText(/^City$/i) as HTMLInputElement;
    const regionSelect = screen.getByLabelText(/Cluster \/ Region/i) as HTMLSelectElement;
    await user.clear(cityInput);
    await user.type(cityInput, "Amwaj");
    expect(regionSelect.value).toBe("Muharraq");

    const nameInput = screen.getByLabelText(/Branch name/i) as HTMLInputElement;
    await user.clear(nameInput);
    await user.type(nameInput, "Amwaj Lagoon");

    await user.click(screen.getByRole("button", { name: /Add branch/i }));

    await waitFor(() => {
      expect(apiMocks.createBranch).toHaveBeenCalledWith({
        name: "Amwaj Lagoon",
        city: "Amwaj",
        region: "Muharraq",
        coordinates: [26.2285, 50.586],
      });
    });
  });
});

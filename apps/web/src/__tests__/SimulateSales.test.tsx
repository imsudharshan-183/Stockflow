import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { ProductsPage } from "@/features/products/ProductsPage";
import { DailySalesSimulation } from "@/components/shared/DailySalesSimulation";

const mocks = vi.hoisted(() => ({
  health: vi.fn(), simulationStatus: vi.fn(), simulateToday: vi.fn(), simulateNextDay: vi.fn(), listCatalogProducts: vi.fn(), role: "admin",
}));
vi.mock("@/lib/api", () => ({ api: mocks }));
vi.mock("@/features/auth/AuthContext", () => ({ useAuth: () => ({ user: { role: mocks.role } }) }));

function renderCatalog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter><ProductsPage /></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = "admin";
  mocks.simulationStatus.mockResolvedValue({ day: "2026-11-27", result: null });
  mocks.listCatalogProducts.mockResolvedValue({ products: [], total: 0, totalPages: 1 });
});

it("disables the button while sales are being written and displays the batch counts", async () => {
  mocks.health.mockResolvedValue({ allowSyntheticData: true });
  let finish!: (value: { rows: number; branches: number; targetDate: string }) => void;
  mocks.simulateNextDay.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  renderCatalog();
  const button = await screen.findByRole("button", { name: "Simulate next dataset day" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await waitFor(() => expect(button).toBeDisabled());
  fireEvent.click(button);
  expect(mocks.simulateNextDay).toHaveBeenCalledTimes(1);
  finish({ rows: 7500, branches: 15, targetDate: "2026-11-12" });
  expect(await screen.findByText(/7,500 sales rows across 15 branches/)).toBeInTheDocument();
  expect(button).toBeDisabled();
});

it("keeps the dashboard action disabled after a completed run and reload", async () => {
  mocks.health.mockResolvedValue({ allowSyntheticData: true });
  const result = { rows: 8, branches: 3, targetDate: "2026-11-27" };
  mocks.simulateToday.mockResolvedValue(result);
  const mount = () => render(<QueryClientProvider client={new QueryClient()}><DailySalesSimulation /></QueryClientProvider>);
  const first = mount();
  const button = await screen.findByRole("button", { name: "Generate today's sales" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  expect(await screen.findByText(/Daily run complete/)).toBeInTheDocument();
  expect(button).toBeDisabled();
  first.unmount();
  mocks.simulationStatus.mockResolvedValue({ day: result.targetDate, result });
  mount();
  expect(await screen.findByText(/Daily run complete/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Generate today's sales" })).toBeDisabled();
  expect(mocks.simulateToday).toHaveBeenCalledTimes(1);
});

it.each([["admin", false], ["manager", true]] as const)("hides demo tools for role %s with flag %s", async (role, flag) => {
  mocks.role = role;
  mocks.health.mockResolvedValue({ allowSyntheticData: flag });
  renderCatalog();
  await waitFor(() => expect(mocks.listCatalogProducts).toHaveBeenCalled());
  expect(screen.queryByRole("region", { name: "Demo tools" })).not.toBeInTheDocument();
});

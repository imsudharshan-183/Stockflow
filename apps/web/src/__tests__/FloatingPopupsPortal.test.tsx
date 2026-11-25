import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocationSwitcher } from "@/app/LocationSidebarParts";
import { InfoPopover } from "@/components/shared/InfoPopover";
import { ModeToggle } from "@/components/shared/ModeToggle";
import { ThemeProvider } from "@/components/shared/ThemeProvider";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SkuCombobox } from "@/features/data/SkuCombobox";
import type { LocationSummaryItem, Product } from "@stockflow/core";

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

const sampleLocations: LocationSummaryItem[] = [
  {
    branch: {
      id: "BR-001",
      name: "Manama - CBD",
      city: "Manama",
      region: "Capital",
      status: "active",
    },
    health: "red",
    atRiskCount: 12,
    overstockCount: 3,
    totalSkus: 400,
    pendingCount: 8,
    stockoutRate: 0.03,
    lostSalesAtRisk: 420,
    cashReleasable: 900,
  },
  {
    branch: {
      id: "BR-002",
      name: "Manama - Juffair",
      city: "Manama",
      region: "Capital",
      status: "active",
    },
    health: "green",
    atRiskCount: 2,
    overstockCount: 1,
    totalSkus: 400,
    pendingCount: 2,
    stockoutRate: 0.005,
    lostSalesAtRisk: 45,
    cashReleasable: 150,
  },
];

describe("Floating popups portal outside clipping containers", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.document.documentElement.classList.remove("light", "dark");
  });

  it("portals InfoPopover outside an overflow-hidden Card and stops click propagation", async () => {
    const user = userEvent.setup();
    const onParentClick = vi.fn();

    render(
      <div onClick={onParentClick}>
        <Card data-testid="kpi-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-1">
              <span>Stockout rate</span>
              <InfoPopover labelKey="stockoutRate" />
            </CardTitle>
          </CardHeader>
          <CardContent>0.5%</CardContent>
        </Card>
      </div>,
    );

    const card = screen.getByTestId("kpi-card");
    const trigger = screen.getByRole("button", { name: /About Stockout rate/i });

    await user.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: /Stockout rate/i });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveTextContent(/How it's calculated/i);
    expect(dialog).toHaveTextContent(/What to do/i);
    expect(card.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);

    await user.click(dialog);
    expect(onParentClick).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: /Stockout rate/i })).not.toBeInTheDocument();
    });
  });

  it("portals SkuCombobox listbox outside an overflow-hidden Card and scrollable table wrapper", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <div>
        <div data-testid="outside-area">Outside target</div>
        <Card data-testid="sheet-card">
          <CardContent>
            <div className="overflow-x-auto">
              <SkuCombobox products={sampleProducts} value="" onChange={onChange} />
            </div>
          </CardContent>
        </Card>
      </div>,
    );

    const card = screen.getByTestId("sheet-card");
    const combobox = screen.getByRole("combobox", { name: /Select SKU/i });

    await user.click(combobox);

    const listbox = await screen.findByRole("listbox", { name: /Matching products/i });
    expect(listbox).toBeInTheDocument();
    expect(card.contains(listbox)).toBe(false);
    expect(document.body.contains(listbox)).toBe(true);

    const oliveOption = screen.getByRole("option", { name: /SKU-00002/i });
    await user.click(oliveOption);
    expect(onChange).toHaveBeenCalledWith("SKU-00002");
    await waitFor(() => {
      expect(screen.queryByRole("listbox", { name: /Matching products/i })).not.toBeInTheDocument();
    });

    await user.click(combobox);
    expect(await screen.findByRole("listbox", { name: /Matching products/i })).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByTestId("outside-area"));
    await waitFor(() => {
      expect(screen.queryByRole("listbox", { name: /Matching products/i })).not.toBeInTheDocument();
    });
  });

  it("portals LocationSwitcher outside an overflow-hidden sidebar wrapper and supports filtering", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    render(
      <div data-testid="sidebar-clip" className="overflow-hidden">
        <LocationSwitcher
          locations={sampleLocations}
          selectedLocation={null}
          onSelect={onSelect}
          isLocked={false}
          isAdmin={true}
        />
      </div>,
    );

    const wrapper = screen.getByTestId("sidebar-clip");
    await user.click(screen.getByRole("button", { name: /Switch location scope/i }));

    const listbox = await screen.findByRole("listbox", { name: /Locations/i });
    expect(wrapper.contains(listbox)).toBe(false);
    expect(document.body.contains(listbox)).toBe(true);

    const filterInput = screen.getByLabelText(/Filter locations/i);
    await user.type(filterInput, "Juffair");

    expect(screen.queryByRole("button", { name: /Manama - CBD/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Manama - Juffair/i }));

    expect(onSelect).toHaveBeenCalledWith("BR-002");
    await waitFor(() => {
      expect(screen.queryByRole("listbox", { name: /Locations/i })).not.toBeInTheDocument();
    });
  });

  it("portals ModeToggle menu outside an overflow-hidden header wrapper and updates theme", async () => {
    const user = userEvent.setup();

    render(
      <ThemeProvider defaultTheme="light" storageKey="test-theme">
        <TooltipProvider delay={0}>
          <div data-testid="header-clip" className="overflow-hidden">
            <ModeToggle />
          </div>
        </TooltipProvider>
      </ThemeProvider>,
    );

    const wrapper = screen.getByTestId("header-clip");
    await user.click(screen.getByRole("button", { name: /Toggle theme/i }));

    const menu = await screen.findByRole("menu", { name: /Theme options/i });
    expect(wrapper.contains(menu)).toBe(false);
    expect(document.body.contains(menu)).toBe(true);

    await user.click(screen.getByRole("menuitem", { name: /^Dark$/i }));
    expect(window.document.documentElement.classList.contains("dark")).toBe(true);
    await waitFor(() => {
      expect(screen.queryByRole("menu", { name: /Theme options/i })).not.toBeInTheDocument();
    });
  });
});

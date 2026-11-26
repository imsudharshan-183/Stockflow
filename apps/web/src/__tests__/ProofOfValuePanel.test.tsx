import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProofOfValuePanel } from "@/features/overview/ProofOfValuePanel";

describe("ProofOfValuePanel", () => {
  it("displays daily product stockout rates alongside 45-day SKU-day totals without misleading calendar-day labels", () => {
    render(
      <TooltipProvider>
        <ProofOfValuePanel
          backtest={{
            windowDays: 45,
            baselineStockoutDays: 1819,
            engineStockoutDays: 299,
            stockoutDaysAvoided: 1520,
            cashReleased: 10780,
          }}
          scopeLabel="Cluster"
          branchCount={2}
        />
      </TooltipProvider>,
    );

    expect(screen.getByText(/^40 products\/day$/i)).toBeInTheDocument();
    expect(screen.getByText(/^7 products\/day$/i)).toBeInTheDocument();
    expect(screen.getByText(/40 → 7 products\/day/i)).toBeInTheDocument();
    expect(screen.getByText(/\(1,819 SKU-days\)/i)).toBeInTheDocument();
    expect(screen.getByText(/\(299 SKU-days\)/i)).toBeInTheDocument();
    expect(screen.getByText("83.6%")).toBeInTheDocument();
    expect(screen.getByText(/1,520 SKU-days avoided/i)).toBeInTheDocument();
    expect(screen.getByText("BD 10.8K")).toBeInTheDocument();
    expect(screen.getByText(/BD 10,780 from transfers & markdowns/i)).toBeInTheDocument();
    expect(screen.getByText(/across 2 stores/i)).toBeInTheDocument();

    expect(screen.queryByText(/1,819 days/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/299 days/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/docs\/DECISIONS\.md/i)).not.toBeInTheDocument();
  });

  it("handles zero baseline stockouts cleanly without NaN", () => {
    render(
      <TooltipProvider>
        <ProofOfValuePanel
          backtest={{
            windowDays: 45,
            baselineStockoutDays: 0,
            engineStockoutDays: 0,
            stockoutDaysAvoided: 0,
            cashReleased: 0,
          }}
          scopeLabel="Store"
          branchCount={1}
        />
      </TooltipProvider>,
    );

    expect(screen.getAllByText(/^0 products\/day$/i)).toHaveLength(2);
    expect(screen.getByText(/0 → 0 products\/day/i)).toBeInTheDocument();
    expect(screen.getByText("0.0%")).toBeInTheDocument();
    expect(screen.getByText("BD 0")).toBeInTheDocument();
    expect(screen.getByText(/at 1 store/i)).toBeInTheDocument();
    expect(screen.queryByText(/NaN/i)).not.toBeInTheDocument();
  });
});

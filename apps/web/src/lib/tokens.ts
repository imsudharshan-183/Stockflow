export const TOKENS = {
  surface: {
    bg: "var(--bg)",
    card: "var(--surface)",
    tableHeader: "var(--table-header)",
    rowHover: "var(--row-hover)",
    border: "var(--line)",
  },
  text: {
    ink: "var(--ink)",
    muted: "var(--muted)",
    disabled: "var(--disabled)",
  },
  brand: {
    primary: "var(--primary)",
    primaryHover: "var(--primary-hover)",
    primarySoft: "var(--primary-soft)",
  },
  status: {
    gain: "var(--gain)",
    risk: "var(--risk)",
    warn: "var(--warn)",
    info: "var(--info)",
  },
  chart: {
    grid: "var(--input)",
    axis: "var(--muted-foreground)",
    transfer: "var(--chart-transfer)",
    reorder: "var(--primary)",
    markdown: "var(--chart-markdown)",
    stockoutRate: "var(--risk)",
    inventoryValue: "var(--primary)",
    excessInventory: "var(--chart-markdown)",
    revenueAtRisk: "#D92D20",
    healthy: "var(--gain)",
    neutral: "var(--disabled)",
    netBenefit: "var(--gain)",
  },
} as const;

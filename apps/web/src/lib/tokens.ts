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
    primary: "#2563EB",
    primaryHover: "#1D4ED8",
    primarySoft: "#EFF6FF",
  },
  status: {
    gain: "#047857",
    risk: "#BE123C",
    warn: "#B45309",
    info: "#0284C7",
  },
  chart: {
    grid: "#CBD5E1",
    axis: "#64748B",
    transfer: "#2563EB",
    reorder: "#0284C7",
    markdown: "#B45309",
    stockoutRate: "#BE123C",
    inventoryValue: "#2563EB",
    excessInventory: "#B45309",
    revenueAtRisk: "#0284C7",
    netBenefit: "#047857",
  },
} as const;

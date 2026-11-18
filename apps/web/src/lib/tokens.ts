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
    transfer: "#7C3AED",
    reorder: "#2563EB",
    markdown: "#D97706",
    stockoutRate: "#BE123C",
    inventoryValue: "#2563EB",
    excessInventory: "#D97706",
    revenueAtRisk: "#D92D20",
    healthy: "#15803D",
    neutral: "#9CA3AF",
    netBenefit: "#047857",
  },
} as const;

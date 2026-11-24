import type {
  OrderEvent,
  OrderEventAction,
  OrderOrigin,
  OrderQueueTab,
  OrderStatus,
  ReasonCode,
} from "@stockflow/core";

export interface LabelEntry {
  key: string;
  label: string;
  shortHelp: string;
  longHelp: string;
  formula: string;
  whatToDo: string;
}

export const QUEUE_TAB_LABELS: Record<OrderQueueTab, string> = {
  suggested: "Suggested",
  incoming: "Requests to Fulfil",
  outgoing: "My Stock Requests",
};

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  SUGGESTED: "Suggested",
  OPEN_REQUEST: "Request Open",
  AWAITING_DONOR: "Waiting for Sender",
  COMMITTED: "Approved / On the way",
  RECEIVED: "Received",
  REJECTED: "Declined",
  CANCELLED: "Cancelled",
};

export const ORDER_ACTION_LABELS = {
  approve: "Approve",
  sendStock: "Send Stock",
  decline: "Decline",
  markReceived: "Mark as Received",
  requestTransfer: "Request Transfer",
  reroute: "Reroute",
  chooseSender: "Choose Sending Branch",
  cancel: "Cancel",
  reopen: "Reopen",
} as const;

export const ORDER_ORIGIN_LABELS: Record<OrderOrigin, string> = {
  ENGINE: "Suggested",
  MANAGER_REQUEST: "Store Request",
  ALERT_ESCALATION: "Alert Escalation",
};

const ORDER_EVENT_ACTION_LABELS: Record<OrderEventAction, string> = {
  CREATED: "Created",
  REQUEST_TRANSFER: "Requested transfer",
  COMMIT: "Approved",
  DECLINE: "Declined",
  REROUTE: "Rerouted",
  CANCEL: "Cancelled",
  RECEIVE: "Marked as Received",
  ESCALATE: "Escalated",
  MIGRATED: "Migrated",
};

export const QUANTITY_REASON_LABELS = {
  CASE_PACK: "Case pack",
  TRUCK_CAPACITY: "Truck capacity",
  PROMO_HOLD: "Promo hold",
  OTHER: "Other",
} as const;

type QuantityReasonCode = keyof typeof QUANTITY_REASON_LABELS;

export function quantityReasonLabel(code?: string): string {
  if (!code) return "Quantity adjusted";
  return QUANTITY_REASON_LABELS[code as QuantityReasonCode] ?? code;
}

export function getOrderEventDisplayLabel(
  event: Pick<OrderEvent, "action" | "fromStatus" | "dispositionCode">,
): string {
  if (event.dispositionCode === "REOPENED") return "Reopened";
  if (event.action === "COMMIT" && event.fromStatus === "AWAITING_DONOR") {
    return "Sent Stock";
  }
  return ORDER_EVENT_ACTION_LABELS[event.action];
}

export const REASON_DISPLAY_LABELS: Record<ReasonCode, string> = {
  BELOW_REORDER_POINT: "On hand is below the reorder point",
  OVERSTOCK_COVER: "Cover is above 60 days",
  RECEIVER_BELOW_TARGET: "Receiving branch is under the 14-day target",
  DONOR_SURPLUS: "Sending branch holds more than 30 days of cover plus safety stock",
  NO_DONOR: "No sending branch has surplus to cover the gap",
  NO_RECEIVER: "No receiving branch is short of this SKU",
  LOST_SALES_AT_RISK: "Sales may be lost over the lead time",
  CARRYING_COST: "Holding cost of the surplus units",
  FREIGHT_LIMITS_QTY: "Freight cost limits how many units are worth moving",
  ZERO_VELOCITY: "No demand on days that had stock",
  REORDER_TO_TARGET: "Buy up to the cover target",
  MARKDOWN_CLEARANCE: "Clear surplus that nobody else needs",
  MIN_TRANSFER_MET: "Quantity meets the minimum transfer",
};

export const LABELS = {
  coverDays: {
    key: "coverDays",
    label: "Days of stock left",
    shortHelp: "Estimated days current on-hand stock will last at recent sales pace.",
    longHelp:
      "Shows how many days of demand your current shelf and backroom inventory can cover before hitting zero.",
    formula: "On-hand units ÷ average daily sales (EWMA over 28 in-stock days).",
    whatToDo:
      "If below Reorder level, transfer from an overstocked branch or place a reorder. Above 60 days signals overstock.",
  },
  reorderPoint: {
    key: "reorderPoint",
    label: "Reorder level",
    shortHelp: "Minimum stock threshold before a location risks running out during lead time.",
    longHelp:
      "The unit count needed to cover expected sales while waiting for a supplier delivery plus a safety buffer.",
    formula: "(Daily sales pace × lead time days) + safety stock (1.65 × demand std dev × √lead time).",
    whatToDo:
      "When on-hand drops below this level, approve an incoming transfer or a supplier reorder.",
  },
  netBenefit: {
    key: "netBenefit",
    label: "Estimated gain",
    shortHelp: "Expected net BHD benefit of taking this action after transfer or markdown costs.",
    longHelp:
      "Ranks morning decisions by real financial impact so buyers tackle the highest-value moves first.",
    formula: "Lost margin avoided + holding cost saved − transfer or markdown cost.",
    whatToDo:
      "Prioritize pending items with the highest Estimated gain first in the Action queue.",
  },
  cashReleasable: {
    key: "cashReleasable",
    label: "Cash you can free up",
    shortHelp: "Cost value of surplus units sitting above healthy stock levels.",
    longHelp:
      "Working capital tied up in overstocked items that can be transferred to needy stores or cleared via markdowns.",
    formula: "Sum of (surplus units × unit cost) across overstocked SKUs.",
    whatToDo:
      "Review Can give transfers and Should mark down items to convert excess stock back into cash.",
  },
  overstockValue: {
    key: "overstockValue",
    label: "Overstock value",
    shortHelp: "Total cost value of inventory with more than 60 days of stock left.",
    longHelp:
      "Capital sitting in slow-moving or over-ordered items that tie up shelf space and cash.",
    formula: "Sum of (on-hand units × unit cost) for SKUs classified as Overstock.",
    whatToDo:
      "Move surplus to branches that need stock or approve recommended markdowns.",
  },
  lostSalesAtRisk: {
    key: "lostSalesAtRisk",
    label: "Sales at risk",
    shortHelp: "Projected lost retail revenue if at-risk SKUs are not replenished in time.",
    longHelp:
      "Estimated customer demand that will go unfulfilled during supplier lead time unless stock is added.",
    formula: "Projected lost units × shelf price across At-risk SKUs.",
    whatToDo:
      "Approve incoming transfers (same-day) or reorders for the top at-risk SKUs immediately.",
  },
  stockoutRate: {
    key: "stockoutRate",
    label: "Stockout rate",
    shortHelp: "Share of SKU-days where demand existed but on-hand stock hit zero.",
    longHelp:
      "Measures how often customers could not buy an item because the shelf was empty.",
    formula: "Stockout SKU-days ÷ total active SKU-days in the window.",
    whatToDo:
      "Target locations above 10% first and check their Needs stock list.",
  },
  skusAtRisk: {
    key: "skusAtRisk",
    label: "SKUs at risk",
    shortHelp: "Number of active products currently below their Reorder level.",
    longHelp:
      "Count of items in this location that are likely to stock out before a standard reorder arrives.",
    formula: "Count of active SKUs with status At risk.",
    whatToDo:
      "Open the Needs stock panel or filter the inventory table by At risk.",
  },
  pendingDecisions: {
    key: "pendingDecisions",
    label: "Pending decisions",
    shortHelp: "Recommended transfers, reorders, and markdowns awaiting buyer review.",
    longHelp:
      "Morning recommendations that have not yet been approved or rejected.",
    formula: "Count of material recommendations with status Pending.",
    whatToDo:
      "Open the Action queue to approve or reject pending moves.",
  },
  deadStockValue: {
    key: "deadStockValue",
    label: "Dead stock value",
    shortHelp: "Excess capital in overstocked items with virtually no recent sales.",
    longHelp:
      "Subset of overstock surplus above the 30-day sending branch floor with near-zero daily velocity (< 0.05 units/day) that will not clear organically without intervention.",
    formula: "Sum of (surplus units × unit cost) where status is Overstock and velocity < 0.05/day.",
    whatToDo:
      "Approve markdowns to clear shelf space and recover cash.",
  },
  markdown: {
    key: "markdown",
    label: "Markdown",
    shortHelp: "Planned retail price reduction to clear excess or slow-moving stock.",
    longHelp:
      "A targeted price cut used to clear overstock and recover working capital at the same branch when transferring surplus to another store isn't needed or cost-effective.",
    formula: "Holding cost saved + cash recovered from discounted sales − price discount cost.",
    whatToDo:
      "Approve recommended markdowns in the Action queue to free shelf space and cash on slow-moving surplus.",
  },
  actionMix: {
    key: "actionMix",
    label: "Action mix",
    shortHelp: "Breakdown of morning recommendations by Transfers, Reorders, and Markdowns.",
    longHelp:
      "Shows whether the network's biggest opportunity today is rebalancing stock, buying from suppliers, or clearing excess.",
    formula: "Count and Estimated gain grouped by action type.",
    whatToDo:
      "Click a slice or bar to jump straight to the Action queue filtered to that action.",
  },
  topRiskBranches: {
    key: "topRiskBranches",
    label: "Top at-risk locations",
    shortHelp: "Branches with the highest Sales at risk and stockout exposure.",
    longHelp:
      "Highlights which stores need buyer attention first.",
    formula: "Top 8 branches ranked by Sales at risk (BD).",
    whatToDo:
      "Click any branch bar to open its Location dashboard.",
  },
  atRiskByCategory: {
    key: "atRiskByCategory",
    label: "At-risk by category",
    shortHelp: "Categories at this location ranked by projected 7-day Sales at risk.",
    longHelp:
      "Shows which product departments at the selected store account for the highest shortage exposure.",
    formula: "Sum of Sales at risk (BD) grouped by product category for At-risk SKUs.",
    whatToDo:
      "Click any category bar to open this branch's inventory table filtered to that category.",
  },
  coverHeatmap: {
    key: "coverHeatmap",
    label: "Stock cover heatmap",
    shortHelp: "Days of stock left across categories and locations or statuses.",
    longHelp:
      "Spot pockets of shortage (red) or overstock (amber/indigo) at a glance.",
    formula: "Median or count of Days of stock left per cell.",
    whatToDo:
      "Click any cell to filter the inventory or drill down into that slice.",
  },
  topSkus: {
    key: "topSkus",
    label: "Top SKUs by gain",
    shortHelp: "Products generating the largest Estimated gain across pending and decided actions.",
    longHelp:
      "Identifies the individual items where buyer decisions matter most today.",
    formula: "Sum of Estimated gain (BD) per SKU.",
    whatToDo:
      "Click a SKU bar to open its Product detail page.",
  },
  locationTrend: {
    key: "locationTrend",
    label: "Sales vs. on-hand trend",
    shortHelp: "Daily units sold compared against ending on-hand inventory.",
    longHelp:
      "Reveals whether stock is keeping up with demand or building up into overstock.",
    formula: "Daily sum of units sold and on-hand units over the selected 7/30/90-day window.",
    whatToDo:
      "Use the range buttons and brush to zoom into recent spikes or stockouts.",
  },
  stockProjection: {
    key: "stockProjection",
    label: "Stock projection",
    shortHelp: "Forward inventory trajectory over the supplier lead-time horizon.",
    longHelp:
      "Projects current available stock down at daily EWMA velocity versus the planned trajectory after incoming transit and recommended action arrival.",
    formula: "S_base(t) = max(0, (onHand - reserved) - velocity * t) over max(21, 2 * leadTimeDays).",
    whatToDo:
      "Approve reorders or inbound transfers when the baseline curve crosses below the Reorder level before replenishment arrives.",
  },
} as const satisfies Record<string, LabelEntry>;

export type LabelKey = keyof typeof LABELS;

export const GLOSSARY_LIST: LabelEntry[] = Object.values(LABELS);

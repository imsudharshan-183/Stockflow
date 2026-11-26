import {
  getBahrainToday,
  isBranchInScope,
  LocationInventoryItemSchema,
  StoreOrderSchema,
  type BriefRequest,
  type BriefResponse,
  type User,
} from "@stockflow/core";
import { latestSubmissionDates } from "../db.js";
import { BranchNotFoundError, DecisionForbiddenError, OrderNotFoundError } from "./errors.js";
import type { StockServices } from "./index.js";

export type BriefRecords = Omit<BriefResponse, "source">;
const currency = (value: number) => `BD ${value.toFixed(3)}`;
const shelfCheck = LocationInventoryItemSchema.pick({ sku: true, name: true, onHand: true });

async function transferRecords(
  services: StockServices,
  user: User,
  orderId: string,
): Promise<BriefRecords> {
  if (user.role === "staff")
    throw new DecisionForbiddenError("Transfer explanations require a manager or admin");
  const order = await services.orders.get(orderId, user);
  if (order.type !== "TRANSFER") throw new OrderNotFoundError("Transfer not found");
  const snapshot = order.engineSnapshot;
  const facts: BriefRecords["facts"] = [
    {
      id: "quantity",
      label: `${order.productName} to ${order.targetBranchName}`,
      value: `${order.quantity} units`,
    },
    {
      id: "status",
      label: "Transfer status",
      value: order.status.replaceAll("_", " ").toLowerCase(),
    },
  ];
  const freight = order.approvedFreightCostBhd ?? snapshot.freightCostBhd;
  if (freight !== undefined)
    facts.push({ id: "freight", label: "Estimated freight", value: currency(freight) });
  if (order.origin === "ENGINE" || order.approvedNetBenefitBhd !== undefined) {
    facts.push({
      id: "estimated_gain",
      label: "Estimated net gain",
      value: currency(order.approvedNetBenefitBhd ?? snapshot.netBenefitBhd),
    });
  }
  const cover = snapshot.metrics?.coverDays;
  if (cover != null)
    facts.push({
      id: "original_receiving_cover",
      label: "Receiving store cover when suggested",
      value: `${cover.toFixed(1)} days`,
    });
  return {
    asOf: getBahrainToday(Date.parse(order.updatedAt)).isoDate,
    facts,
    summary: order.sourceBranchName
      ? `This order is for a transfer from ${order.sourceBranchName} to ${order.targetBranchName}.`
      : `This transfer requests stock for ${order.targetBranchName}. A sending store has yet to be assigned.`,
  };
}

async function storeRecords(
  services: StockServices,
  user: User,
  branch: string,
): Promise<BriefRecords> {
  const inventory = services.catalog.locationInventory(
    branch,
    { page: 1, limit: 2, sortBy: "coverDays", sortDir: "asc", status: "AT_RISK" },
    user,
  );
  if (!inventory) throw new BranchNotFoundError("Store not found");
  const checks = shelfCheck.array().parse(inventory.items);
  const [deliveries, alerts, submissions] = await Promise.all([
    services.runtime.repo.listStoreDeliveries
      ? services.runtime.repo.listStoreDeliveries(branch)
      : services.orders
          .list({ branch, queue: "outgoing", status: "COMMITTED" }, user)
          .then((result) => result.orders),
    services.stockAlerts.listStockAlerts(user, branch),
    latestSubmissionDates([branch], services.repositoryKind() === "mongo"),
  ]);
  const incoming = StoreOrderSchema.array()
    .parse(deliveries)
    .filter((order) => order.targetBranchId === branch && order.type !== "MARKDOWN");
  const pending = alerts.alerts.filter(
    (alert) => alert.branchId === branch && alert.status === "PENDING",
  );
  const lastEntry = submissions.get(branch);
  const baseline = services.runtime.data.baselineThrough ?? services.runtime.data.asOf;
  return {
    asOf: lastEntry && lastEntry > baseline ? lastEntry : baseline,
    summary: incoming.length
      ? "Check incoming deliveries against the stock received on the floor."
      : "Start with shelf counts and follow up on open stock flags.",
    facts: [
      {
        id: "at_risk_products",
        label: "Products at risk",
        value: String(inventory.total),
        href: "#weekly-stock-check-title",
      },
      ...checks.map((item, index) => ({
        id: `shelf_check_${index + 1}`,
        label: `Check ${item.name}`,
        value: `${item.onHand} units on hand`,
        href: `/products/${encodeURIComponent(item.sku)}?location=${encodeURIComponent(branch)}`,
      })),
      {
        id: "incoming_deliveries",
        label: "Deliveries awaiting receipt",
        value: String(incoming.length),
        href: "#store-deliveries",
      },
      {
        id: "pending_flags",
        label: "Open stock flags",
        value: String(pending.length),
        href: "#store-alerts",
      },
    ],
  };
}

export async function collectBriefRecords(
  services: StockServices,
  user: User,
  input: BriefRequest,
): Promise<BriefRecords> {
  if ("orderId" in input) return transferRecords(services, user, input.orderId);
  const branch = input.branchId ?? (user.role === "staff" ? user.branchIds[0] : undefined);
  if ((branch && !isBranchInScope(user, branch)) || (user.role === "staff" && !branch)) {
    throw new DecisionForbiddenError("Branch outside your assigned stores");
  }
  await services.ensureFreshPlan();
  if (user.role === "staff" && branch) return storeRecords(services, user, branch);
  const live = await services.kpi.liveOverview(user, branch);
  const reporting = live.meta.reportingBranches ?? [];
  const missing = reporting.filter((row) => row.lastSubmitted !== live.meta.todayBahrain);
  const storeNames = missing
    .slice(0, 3)
    .map(
      (row) =>
        live.report.branches.find((store) => store.id === row.branchId)?.name ?? row.branchId,
    );
  const facts: BriefRecords["facts"] = [
    {
      id: "pending_actions",
      label: "Actions awaiting review",
      value: String(live.metrics.pendingActionsCount.value),
      href: branch ? `/queue?location=${encodeURIComponent(branch)}` : "/queue",
    },
    {
      id: "stores_without_entries_today",
      label: storeNames.length
        ? `Stores yet to report today · ${storeNames.join(", ")}${missing.length > storeNames.length ? "…" : ""}`
        : "Stores yet to report today",
      value: String(missing.length),
      href: branch ? `/data?location=${encodeURIComponent(branch)}` : "/data",
    },
  ];
  for (const [index, item] of (live.shortages ?? []).slice(0, 2).entries()) {
    facts.push({
      id: `shortage_${index + 1}`,
      label: `${item.name} · ${item.branchName}`,
      value: `${item.coverDays.toFixed(1)} days of cover`,
      href: `/products/${encodeURIComponent(item.sku)}?branch=${encodeURIComponent(item.branchId)}`,
    });
  }
  const handoff = live.handoffs?.[0];
  if (handoff)
    facts.push({
      id: "transfer_awaiting_release",
      label: `${handoff.productName} · ${handoff.source} → ${handoff.destination}`,
      value: `${handoff.units} units`,
      href: `/queue?tab=${handoff.needsRelease ? "incoming" : "outgoing"}&order=${encodeURIComponent(handoff.id)}`,
    });
  return {
    asOf: live.meta.asOfDataDate,
    facts,
    summary: live.shortages?.length
      ? "Review the shortest stock cover first, then check outstanding transfers and store reports."
      : "Check the action queue and follow up on outstanding store reports.",
  };
}

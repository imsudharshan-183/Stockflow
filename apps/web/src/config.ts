import { MATERIAL_MIN_NET_BENEFIT } from "@stockflow/core";

export const QUEUE_PAGE_SIZE = 50;
export const HIGH_NET_BENEFIT = 100;

export function priorityOf(netBenefit: number): "high" | "med" | "low" {
  if (netBenefit >= HIGH_NET_BENEFIT) return "high";
  if (netBenefit >= MATERIAL_MIN_NET_BENEFIT) return "med";
  return "low";
}

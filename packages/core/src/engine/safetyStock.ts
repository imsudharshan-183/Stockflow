/**
 * Lead-time buffer.
 * Inputs: demand sigma, lead time, service z. Output: units of safety stock and the reorder point.
 * Formula: z * sigma * sqrt(lead); reorder point = velocity * lead + safety stock.
 */
// ASSUMPTION: z = 1.65 treats lead-time demand as normal at about 95%. A different service level only changes this input.
export function safetyStockUnits(sigma: number, leadTimeDays: number, serviceZ: number): number {
  return serviceZ * sigma * Math.sqrt(leadTimeDays);
}

export function reorderPointUnits(velocity: number, leadTimeDays: number, safetyStock: number): number {
  return velocity * leadTimeDays + safetyStock;
}

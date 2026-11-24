/**
 * Lead-time demand buffer and reorder-point math for a single branch-SKU position.
 * Inputs: demand standard deviation sigma (units/day), supplier leadTimeDays (days), serviceZ (dimensionless), and velocity (units/day).
 * Outputs: safetyStock (units) and reorderPoint (units).
 * Formula: safetyStock = z * sigma * sqrt(leadTimeDays); reorderPoint = velocity * leadTimeDays + safetyStock.
 * Units: units, days, units/day (no BD currency involved).
 * Where used: velocity.ts (ewmaForecaster).
 */

/**
 * Computes safety stock units under the independent daily demand variance approximation.
 * Formula: z * sigma * sqrt(leadTimeDays).
 * Example: sigma = 2/day, leadTimeDays = 4, serviceZ = 1.65 -> 1.65 * 2 * 2 = 6.6 units.
 */
// ASSUMPTION: z = 1.65 treats lead-time demand as i.i.d. normal at ~95% one-sided service level; raising service level only requires passing a larger policy.serviceZ.
export function safetyStockUnits(sigma: number, leadTimeDays: number, serviceZ: number): number {
  return serviceZ * sigma * Math.sqrt(leadTimeDays);
}

/**
 * Computes the reorder trigger level covering expected lead-time demand plus safety buffer.
 * Formula: velocity * leadTimeDays + safetyStock.
 * Example: velocity = 5/day, leadTimeDays = 7, safetyStock = 6.6 -> 35 + 6.6 = 41.6 units.
 */
export function reorderPointUnits(velocity: number, leadTimeDays: number, safetyStock: number): number {
  return velocity * leadTimeDays + safetyStock;
}

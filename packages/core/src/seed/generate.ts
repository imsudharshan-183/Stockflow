import type { Product } from "../schemas/index.js";
import { diffCalendarDays } from "../bahrainDate.js";
import { round3 } from "../round.js";
import {
  BAHRAIN_BRANCHES,
  BHD_PRICE_TIERS,
  CATEGORIES,
  CATEGORY_PRICE_TIER,
  DAY_COUNT,
  END_DATE,
  PRODUCT_COUNT,
  PROMO_DAY_END,
  PROMO_DAY_START,
  PROMO_MULTIPLIER,
  PROMO_SKU,
  SEED,
  categoryFor,
  isChronicBranch,
  isExcessBranch,
  isFailedSku,
  isFastSku,
  isLowRiskBranch,
  productName,
  skuCode,
} from "./catalog.js";
import { poisson, mulberry32 } from "./rng.js";
import type { Dataset } from "./types.js";

const WEEKDAY_FACTOR = [1.05, 0.9, 0.92, 0.95, 1.0, 1.2, 1.35] as const;

export function dateRangeEnding(endIso: string, days: number): string[] {
  const end = new Date(`${endIso}T00:00:00Z`);
  const dates: string[] = [];
  for (let offset = days - 1; offset >= 0; offset--) {
    const date = new Date(end);
    date.setUTCDate(date.getUTCDate() - offset);
    const iso = date.toISOString().slice(0, 10);
    dates.push(iso);
  }
  return dates;
}

export function generateDataset(seed = SEED): Dataset {
  const rng = mulberry32(seed);
  const dates = dateRangeEnding(END_DATE, DAY_COUNT);
  const branches = BAHRAIN_BRANCHES.map((branch) => ({
    ...branch,
    ...(branch.coordinates ? { coordinates: [...branch.coordinates] as [number, number] } : {}),
  }));
  const products = buildProducts();

  const sales: number[][][] = [];
  const onHand: number[][][] = [];
  const demand: number[][][] = [];

  const planned = products.map((_, skuIndex) =>
    branches.map((branch, branchIndex) => plannedMean(skuIndex, branchIndex, branch.id)),
  );

  for (let skuIndex = 0; skuIndex < products.length; skuIndex++) {
    const branchSales: number[][] = [];
    const branchStock: number[][] = [];
    const branchDemand: number[][] = [];
    for (let branchIndex = 0; branchIndex < branches.length; branchIndex++) {
      const branch = branches[branchIndex];
      if (!branch) throw new Error("branch missing");
      const mean = planned[skuIndex]?.[branchIndex] ?? 0;
      const product = products[skuIndex];
      if (!product) throw new Error("product missing");
      const path = simulateBranchSku(
        rng,
        dates,
        mean,
        product.leadTimeDays,
        skuIndex,
        branchIndex,
        branch.id,
        product.sku === PROMO_SKU,
      );
      branchSales.push(path.sales);
      branchStock.push(path.onHand);
      branchDemand.push(path.demand);
    }
    sales.push(branchSales);
    onHand.push(branchStock);
    demand.push(branchDemand);
  }

  return {
    seed,
    asOf: dates[dates.length - 1] ?? END_DATE,
    dates,
    branches,
    products,
    sales,
    onHand,
    demand,
  };
}

export function simulateNextDay(dataset: Dataset, targetDate: string) {
  const timestamp = Date.parse(`${targetDate}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== targetDate) {
    throw new Error("Simulation needs a valid ISO calendar date");
  }
  const firstDate = dataset.dates[0];
  if (!firstDate || targetDate <= firstDate) throw new Error("Simulation needs a preceding stock day");
  const nextIndex = dataset.dates.findIndex((date) => date >= targetDate);
  const openingIndex = (nextIndex < 0 ? dataset.dates.length : nextIndex) - 1;
  const dayOffset = diffCalendarDays(targetDate, firstDate);
  let seed = 0;
  for (const char of targetDate) seed = (Math.imul(seed, 31) + char.charCodeAt(0)) >>> 0;
  const rng = mulberry32(seed);
  return dataset.products.flatMap((product, s) => dataset.branches.map((branch, b) => {
    const opening = dataset.onHand[s]?.[b]?.[openingIndex];
    if (opening === undefined) throw new Error(`Missing opening stock for ${product.sku} at ${branch.id}`);
    const path = simulateBranchSku(
      rng, [targetDate], plannedMean(s, b, branch.id), product.leadTimeDays,
      s, b, branch.id, product.sku === PROMO_SKU, opening, dayOffset,
    );
    return {
      sku: product.sku, branchId: branch.id, date: targetDate,
      sales: path.sales[0]!, onHand: path.onHand[0]!, demand: path.demand[0]!,
    };
  }));
}

function buildProducts(): Product[] {
  const products: Product[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < PRODUCT_COUNT; index++) {
    const category = categoryFor(index);
    const tier = CATEGORY_PRICE_TIER[category.name];
    const tierRange = BHD_PRICE_TIERS[tier];
    const slot = Math.floor(index / CATEGORIES.length);
    const pointIndex = (slot * 3 + (index % CATEGORIES.length)) % tierRange.pricePoints.length;
    const rawPrice = tierRange.pricePoints[pointIndex] ?? category.basePrice;
    const price = round3(Math.min(tierRange.max, Math.max(tierRange.min, rawPrice)));
    const costShare = 0.55 + (index % 5) * 0.05;
    let cost =
      costShare === 0.55
        ? Math.ceil((price * 0.55 - 1e-9) * 1000) / 1000
        : costShare === 0.75
          ? Math.floor((price * 0.75 + 1e-9) * 1000) / 1000
          : round3(price * costShare);
    if (cost >= price) cost = round3(price * 0.55);
    if (cost <= 0) cost = 0.005;
    const leadJitter = (index % 3) - 1;
    const leadTimeDays = Math.min(21, Math.max(1, category.leadTimeDays + leadJitter));
    const name = productName(index);
    if (seen.has(name)) {
      throw new Error(`Duplicate product name generated at index ${index}: ${name}`);
    }
    seen.add(name);
    products.push({
      sku: skuCode(index),
      name,
      category: category.name,
      price,
      cost,
      leadTimeDays,
    });
  }
  return products;
}

/** Base daily demand before weekday, season, and the promo, in units. */
function plannedMean(skuIndex: number, branchIndex: number, branchId: string): number {
  if (isFailedSku(skuIndex)) return 0.02;
  const category = categoryFor(skuIndex);
  const skuScale = 0.75 + (skuIndex % 8) * 0.08;
  const branchScale = 0.9 + (branchIndex % 5) * 0.05;
  let mean = category.meanDemand * skuScale * branchScale;
  if (isFastSku(skuIndex) && isChronicBranch(branchId)) mean *= 1.35;
  return mean;
}

interface StockProfile {
  opening: number;
  target: number | null;
}

// ASSUMPTION: analytical ROP-aware stocking targets keep network AT_RISK in a realistic 8-15% band,
// with 3 hotspot branches (20-30%), 3 low-risk branches (2-5%), 4 excess branches, 8 slow/failed SKUs, and 1 promo spike.
function branchSkuStockProfile(
  mean: number,
  leadTimeDays: number,
  cycle: number,
  skuIndex: number,
  branchIndex: number,
  branchId: string,
): StockProfile {
  if (isFailedSku(skuIndex)) {
    return { opening: 140, target: null };
  }
  if (isFastSku(skuIndex) && isExcessBranch(branchId)) {
    const excessTarget = Math.max(1, Math.round(mean * 85));
    return { opening: excessTarget, target: excessTarget };
  }

  const isShort = isChronicBranch(branchId);
  const isLowRisk = isLowRiskBranch(branchId);
  const riskRoll = (skuIndex * 31 + branchIndex * 13) % 100;
  const isShortPosition = isShort
    ? isFastSku(skuIndex) || riskRoll < 15
    : isLowRisk
      ? riskRoll < 3
      : riskRoll < 10;

  if (isShortPosition) {
    return {
      opening: Math.max(1, Math.round(mean * (isShort ? 2.5 : 3.2))),
      target: Math.max(1, Math.round(mean * (isShort ? 3 : 4))),
    };
  }

  // Analytical upper bound on EWMA reorderPoint (velocity * L + z * sigma * sqrt(L))
  // plus cycle depletion buffer so healthy positions stay above ROP yet below the 60-day overstock threshold.
  const expectedRop =
    mean * leadTimeDays + 2.1 * Math.sqrt(Math.max(0.05, mean) * leadTimeDays);
  const reorderFloor = Math.ceil(expectedRop + mean * 2 + 2);
  const healthyTarget = Math.min(
    Math.round(mean * 52),
    Math.max(reorderFloor + 2, Math.round(reorderFloor + mean * (cycle * 0.9 + 3))),
  );
  return { opening: healthyTarget, target: healthyTarget };
}

// DECISION: each branch-SKU refills on its own 7–21 day cadence so the network chart is not one shared sawtooth. A single weekday refill was rejected for that reason.
function replenishmentSchedule(skuIndex: number, branchIndex: number): { cycle: number; phase: number } {
  const cycle = 7 + ((skuIndex * 17 + branchIndex * 3) % 15);
  const phase = (skuIndex * 5 + branchIndex) % cycle;
  return { cycle, phase };
}

function simulateBranchSku(
  rng: () => number,
  dates: readonly string[],
  mean: number,
  leadTimeDays: number,
  skuIndex: number,
  branchIndex: number,
  branchId: string,
  promo: boolean,
  openingOverride?: number,
  dayOffset = 0,
): { sales: number[]; onHand: number[]; demand: number[] } {
  const sales: number[] = [];
  const onHandSeries: number[] = [];
  const demandSeries: number[] = [];
  const schedule = replenishmentSchedule(skuIndex, branchIndex);
  const profile = branchSkuStockProfile(
    mean,
    leadTimeDays,
    schedule.cycle,
    skuIndex,
    branchIndex,
    branchId,
  );
  let onHand = openingOverride ?? profile.opening;
  const fillRate = isFastSku(skuIndex) && isChronicBranch(branchId) ? 0.5 : 1;

  for (let day = 0; day < dates.length; day++) {
    const dayIndex = dayOffset + day;
    if (dayIndex % schedule.cycle === schedule.phase) {
      const target = profile.target;
      if (target !== null && onHand < target) {
        onHand += Math.round((target - onHand) * fillRate);
      }
    }
    const date = dates[day] ?? END_DATE;
    const wanted = poisson(rng, dailyMean(mean, date, dayIndex, promo));
    const sold = Math.min(onHand, wanted);
    onHand -= sold;
    sales.push(sold);
    onHandSeries.push(onHand);
    demandSeries.push(wanted);
  }

  return { sales, onHand: onHandSeries, demand: demandSeries };
}

function dailyMean(mean: number, date: string, dayIndex: number, promo: boolean): number {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  const dow = WEEKDAY_FACTOR[weekday] ?? 1;
  const season = 1 + 0.12 * Math.sin((2 * Math.PI * dayIndex) / DAY_COUNT);
  const spike = promo && dayIndex >= PROMO_DAY_START && dayIndex <= PROMO_DAY_END ? PROMO_MULTIPLIER : 1;
  return mean * dow * season * spike;
}

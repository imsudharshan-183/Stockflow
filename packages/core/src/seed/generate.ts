import type { Product } from "../schemas/index.js";
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
      const path = simulateBranchSku(
        rng,
        dates,
        mean,
        skuIndex,
        branchIndex,
        branch.id,
        products[skuIndex]?.sku === PROMO_SKU,
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

function openingUnits(mean: number, skuIndex: number, branchId: string): number {
  if (isFailedSku(skuIndex)) return 140;
  if (isFastSku(skuIndex) && isExcessBranch(branchId)) return Math.max(1, Math.round(mean * 85));
  if (isFastSku(skuIndex) && isChronicBranch(branchId)) return Math.max(0, Math.round(mean * 3));
  return Math.max(0, Math.round(mean * 20));
}

function replenishTarget(mean: number, skuIndex: number, branchId: string): number | null {
  if (isFailedSku(skuIndex)) return null;
  if (isFastSku(skuIndex) && isExcessBranch(branchId)) return Math.round(mean * 85);
  if (isFastSku(skuIndex) && isChronicBranch(branchId)) return Math.round(mean * 3);
  return Math.round(mean * 20);
}

// ASSUMPTION: three branches are kept short, four are kept long, eight SKUs barely sell, and one SKU has a five-times spike. Those stories are the regression cases.
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
  skuIndex: number,
  branchIndex: number,
  branchId: string,
  promo: boolean,
): { sales: number[]; onHand: number[]; demand: number[] } {
  const sales: number[] = [];
  const onHandSeries: number[] = [];
  const demandSeries: number[] = [];
  let onHand = openingUnits(mean, skuIndex, branchId);
  const fillRate = isFastSku(skuIndex) && isChronicBranch(branchId) ? 0.5 : 1;
  const schedule = replenishmentSchedule(skuIndex, branchIndex);

  for (let day = 0; day < dates.length; day++) {
    if (day % schedule.cycle === schedule.phase) {
      const target = replenishTarget(mean, skuIndex, branchId);
      if (target !== null && onHand < target) {
        onHand += Math.round((target - onHand) * fillRate);
      }
    }
    const date = dates[day] ?? END_DATE;
    const wanted = poisson(rng, dailyMean(mean, date, day, promo));
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

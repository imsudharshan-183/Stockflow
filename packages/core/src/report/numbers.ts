import { round3, round4 } from "../round.js";

export function money(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} is not finite`);
  return round3(value);
}

export function stat(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} is not finite`);
  return round4(value);
}

export function roundRate(values: readonly number[]): number {
  const total = values.reduce((sum, rate) => sum + rate, 0);
  return stat(total / values.length, "rate");
}

export function coverOf(value: number | null): number | null {
  if (value === null) return null;
  return stat(value, "coverDays");
}

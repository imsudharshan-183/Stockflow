export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function round4(value: number): number {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

export function at<T>(items: readonly T[], index: number, label: string): T {
  const value = items[index];
  if (value === undefined) {
    throw new Error(`${label} index ${index} is out of range`);
  }
  return value;
}

/**
 * Pure Kingdom of Bahrain coordinate bounds, rounding, swap detection, and validation
 * shared between API branch routes and Web branch forms.
 */
export interface CoordinateBounds {
  readonly minLat: number;
  readonly maxLat: number;
  readonly minLng: number;
  readonly maxLng: number;
}

export const BAHRAIN_BOUNDS: CoordinateBounds = {
  minLat: 25.5,
  maxLat: 26.45,
  minLng: 50.25,
  maxLng: 50.9,
};

export type CoordinateValidationErrorCode =
  | "invalid"
  | "swapped"
  | "outside_bahrain"
  | "out_of_range";

export type CoordinateValidationResult =
  | { ok: true; lat: number; lng: number }
  | {
      ok: false;
      code: CoordinateValidationErrorCode;
      error: string;
      suggestedSwap?: [number, number];
    };

export function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

export function looksSwappedBahrain(
  lat: number,
  lng: number,
  bounds: CoordinateBounds = BAHRAIN_BOUNDS,
): boolean {
  return (
    lat >= bounds.minLng &&
    lat <= bounds.maxLng &&
    lng >= bounds.minLat &&
    lng <= bounds.maxLat
  );
}

export function isWithinBahrain(
  lat: number,
  lng: number,
  bounds: CoordinateBounds = BAHRAIN_BOUNDS,
): boolean {
  return (
    lat >= bounds.minLat &&
    lat <= bounds.maxLat &&
    lng >= bounds.minLng &&
    lng <= bounds.maxLng
  );
}

export function validateCoordinates(lat: number, lng: number): CoordinateValidationResult {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return {
      ok: false,
      code: "invalid",
      error: "Latitude and longitude must be finite numbers.",
    };
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return {
      ok: false,
      code: "out_of_range",
      error: "Coordinates must be within [-90, 90] latitude and [-180, 180] longitude.",
    };
  }
  if (looksSwappedBahrain(lat, lng)) {
    const swappedLat = round6(lng);
    const swappedLng = round6(lat);
    return {
      ok: false,
      code: "swapped",
      error: `Looks swapped (lng, lat). Bahrain latitude should be around 25.5–26.45 and longitude 50.25–50.90. Did you mean ${swappedLat}, ${swappedLng}?`,
      suggestedSwap: [swappedLat, swappedLng],
    };
  }
  if (!isWithinBahrain(lat, lng)) {
    return {
      ok: false,
      code: "outside_bahrain",
      error: `Coordinates (${round6(lat)}, ${round6(lng)}) appear outside Bahrain (${BAHRAIN_BOUNDS.minLat}–${BAHRAIN_BOUNDS.maxLat}, ${BAHRAIN_BOUNDS.minLng}–${BAHRAIN_BOUNDS.maxLng}).`,
    };
  }
  return {
    ok: true,
    lat: round6(lat),
    lng: round6(lng),
  };
}

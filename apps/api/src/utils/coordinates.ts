export const BAHRAIN_BOUNDS = {
  minLat: 25.5,
  maxLat: 26.4,
  minLng: 50.3,
  maxLng: 50.9,
} as const;

export type CoordinateValidationErrorCode =
  | "non_finite"
  | "out_of_range"
  | "swapped";

export type CoordinateValidationResult =
  | {
      ok: true;
      lat: number;
      lng: number;
      outsideBahrain: boolean;
    }
  | {
      ok: false;
      code: CoordinateValidationErrorCode;
      error: string;
    };

export function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function looksSwappedBahrain(lat: number, lng: number): boolean {
  return (
    lat >= BAHRAIN_BOUNDS.minLng &&
    lat <= BAHRAIN_BOUNDS.maxLng &&
    lng >= BAHRAIN_BOUNDS.minLat &&
    lng <= BAHRAIN_BOUNDS.maxLat
  );
}

export function isWithinBahrain(lat: number, lng: number): boolean {
  return (
    lat >= BAHRAIN_BOUNDS.minLat &&
    lat <= BAHRAIN_BOUNDS.maxLat &&
    lng >= BAHRAIN_BOUNDS.minLng &&
    lng <= BAHRAIN_BOUNDS.maxLng
  );
}

export function validateCoordinates(lat: number, lng: number): CoordinateValidationResult {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return {
      ok: false,
      code: "non_finite",
      error: "Latitude and longitude must be finite numbers",
    };
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return {
      ok: false,
      code: "out_of_range",
      error: "Latitude must be between -90 and 90, and longitude between -180 and 180",
    };
  }
  const rLat = round6(lat);
  const rLng = round6(lng);
  if (looksSwappedBahrain(rLat, rLng)) {
    return {
      ok: false,
      code: "swapped",
      error:
        "Coordinates appear swapped (longitude before latitude). Expected Bahrain latitude 25.5-26.4 and longitude 50.3-50.9.",
    };
  }
  return {
    ok: true,
    lat: rLat,
    lng: rLng,
    outsideBahrain: !isWithinBahrain(rLat, rLng),
  };
}

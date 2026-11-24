export const BAHRAIN_BOUNDS = {
  minLat: 25.5,
  maxLat: 26.4,
  minLng: 50.3,
  maxLng: 50.9,
} as const;

export const CLUSTER_REGIONS = ["Capital", "Muharraq", "Northern", "Southern"] as const;
export type ClusterRegion = (typeof CLUSTER_REGIONS)[number];

export type CoordinateValidationErrorCode =
  | "empty"
  | "unparseable"
  | "non_finite"
  | "out_of_range"
  | "swapped";

export type CoordinateValidationResult =
  | {
      ok: true;
      lat: number;
      lng: number;
      outsideBahrain: boolean;
      warning?: string;
    }
  | {
      ok: false;
      code: CoordinateValidationErrorCode;
      error: string;
      suggestedSwap?: readonly [number, number];
    };

export function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function isWithinBahrain(lat: number, lng: number): boolean {
  return (
    lat >= BAHRAIN_BOUNDS.minLat &&
    lat <= BAHRAIN_BOUNDS.maxLat &&
    lng >= BAHRAIN_BOUNDS.minLng &&
    lng <= BAHRAIN_BOUNDS.maxLng
  );
}

export function looksSwappedBahrain(lat: number, lng: number): boolean {
  return (
    lat >= BAHRAIN_BOUNDS.minLng &&
    lat <= BAHRAIN_BOUNDS.maxLng &&
    lng >= BAHRAIN_BOUNDS.minLat &&
    lng <= BAHRAIN_BOUNDS.maxLat
  );
}

export function validateCoordinates(lat: number, lng: number): CoordinateValidationResult {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return {
      ok: false,
      code: "non_finite",
      error: "Latitude and longitude must be finite numbers.",
    };
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return {
      ok: false,
      code: "out_of_range",
      error: "Latitude must be between -90 and 90, and longitude between -180 and 180.",
    };
  }

  const roundedLat = round6(lat);
  const roundedLng = round6(lng);

  if (looksSwappedBahrain(roundedLat, roundedLng)) {
    return {
      ok: false,
      code: "swapped",
      error:
        "Coordinates appear swapped (longitude entered before latitude). Expected Bahrain latitude 25.5–26.4 and longitude 50.3–50.9.",
      suggestedSwap: [roundedLng, roundedLat],
    };
  }

  if (!isWithinBahrain(roundedLat, roundedLng)) {
    return {
      ok: true,
      lat: roundedLat,
      lng: roundedLng,
      outsideBahrain: true,
      warning:
        "Coordinates are outside Bahrain (lat 25.5–26.4, lng 50.3–50.9). Please confirm before saving.",
    };
  }

  return {
    ok: true,
    lat: roundedLat,
    lng: roundedLng,
    outsideBahrain: false,
  };
}

export function parseCoordinatesInput(raw: string): CoordinateValidationResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      ok: false,
      code: "empty",
      error: "Coordinates are required.",
    };
  }

  // 1. Google Maps exact pin format: !3d<lat>!4d<lng>
  const mapsPinMatch = /!3d([+-]?\d+(?:\.\d+)?)!4d([+-]?\d+(?:\.\d+)?)/.exec(trimmed);
  if (mapsPinMatch) {
    return validateCoordinates(Number(mapsPinMatch[1]), Number(mapsPinMatch[2]));
  }

  // 2. Google Maps viewport (@lat,lng) or query param (q=lat,lng / ll=lat,lng)
  const mapsAtMatch = /@([+-]?\d+(?:\.\d+)?),\s*([+-]?\d+(?:\.\d+)?)/.exec(trimmed);
  if (mapsAtMatch) {
    return validateCoordinates(Number(mapsAtMatch[1]), Number(mapsAtMatch[2]));
  }

  const queryCoordMatch = /(?:[?&](?:q|ll|query|center)=)([+-]?\d+(?:\.\d+)?)[,\s]+([+-]?\d+(?:\.\d+)?)/i.exec(
    trimmed,
  );
  if (queryCoordMatch) {
    return validateCoordinates(Number(queryCoordMatch[1]), Number(queryCoordMatch[2]));
  }

  // 3. Degrees-minutes-seconds e.g. 26°13'42.6"N 50°35'09.6"E
  if (trimmed.includes("°")) {
    const dmsMatches = [
      ...trimmed.matchAll(
        /([+-]?\d+(?:\.\d+)?)\s*°\s*(?:(\d+(?:\.\d+)?)\s*['′’]\s*(?:(\d+(?:\.\d+)?)\s*(?:["″”]|''))?)?\s*([NSEW])?/gi,
      ),
    ];
    if (dmsMatches.length === 2) {
      const convert = (m: RegExpMatchArray): number | null => {
        const deg = Number(m[1]);
        const min = m[2] !== undefined ? Number(m[2]) : 0;
        const sec = m[3] !== undefined ? Number(m[3]) : 0;
        if (!Number.isFinite(deg) || !Number.isFinite(min) || !Number.isFinite(sec)) {
          return null;
        }
        if (min >= 60 || sec >= 60 || min < 0 || sec < 0) return null;
        const abs = Math.abs(deg) + min / 60 + sec / 3600;
        const hemi = m[4]?.toUpperCase();
        const negative = hemi === "S" || hemi === "W" || deg < 0;
        return negative ? -abs : abs;
      };
      const first = convert(dmsMatches[0]!);
      const second = convert(dmsMatches[1]!);
      if (first !== null && second !== null) {
        return validateCoordinates(first, second);
      }
    }
  }

  // 4. Plain decimal pairs: "26.2285, 50.5860", "26.2285 50.5860", "(26.2285, 50.5860)"
  const stripped = trimmed.replace(/[()[\]]/g, " ").trim();
  const decimalMatch =
    /^([+-]?\d+(?:\.\d+)?)\s*([NS])?[\s,;]+([+-]?\d+(?:\.\d+)?)\s*([EW])?$/i.exec(stripped);
  if (decimalMatch) {
    let lat = Number(decimalMatch[1]);
    let lng = Number(decimalMatch[3]);
    if (decimalMatch[2]?.toUpperCase() === "S") lat = -Math.abs(lat);
    if (decimalMatch[4]?.toUpperCase() === "W") lng = -Math.abs(lng);
    return validateCoordinates(lat, lng);
  }

  return {
    ok: false,
    code: "unparseable",
    error:
      'Could not parse coordinates. Paste "26.2285, 50.5860", DMS, or a Google Maps URL.',
  };
}

export function formatParsedCoordinates(lat: number, lng: number): string {
  return `Latitude ${lat.toFixed(4)}, Longitude ${lng.toFixed(4)}`;
}

export function googleMapsPinUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

export function suggestRegionForCity(city: string): ClusterRegion {
  const c = city.trim().toLowerCase();
  if (!c) return "Capital";
  if (
    c.includes("muharraq") ||
    c.includes("hidd") ||
    c.includes("amwaj") ||
    c.includes("busaiteen") ||
    c.includes("diyar") ||
    c.includes("marassi") ||
    c.includes("arad")
  ) {
    return "Muharraq";
  }
  if (
    c.includes("riffa") ||
    c.includes("isa town") ||
    c.includes("zallaq") ||
    c.includes("durrat") ||
    c.includes("awali") ||
    c.includes("askar") ||
    c.includes("southern")
  ) {
    return "Southern";
  }
  if (
    c.includes("budaiya") ||
    c.includes("a'ali") ||
    c.includes("aali") ||
    c.includes("saar") ||
    c.includes("hamad") ||
    c.includes("jasra") ||
    c.includes("janabiya") ||
    c.includes("barbar") ||
    c.includes("diraz") ||
    c.includes("northern")
  ) {
    return "Northern";
  }
  return "Capital";
}

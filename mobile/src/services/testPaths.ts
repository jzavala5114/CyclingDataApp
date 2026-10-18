import type { Direction, PathEnd, PathPiece, PathResponse, PathRule, PathSource, PathSpan, SlopeBand } from "../types";

// Test fixtures, imported only by *.test.ts: synthetic GET /segments/path
// answers built the way the server builds them (pathResponse.ts): spans of at
// most 15m tiling each piece, heights summed from the slopes, geometry in
// travel order. Pieces run east along one street at latitude 38.83, so a
// distance along the path is a distance east.

/** The server's band table (SLOPE_STOPS in backend/src/services/gradientBuilder.ts). */
export const BANDS: SlopeBand[] = [
  { maxSlopePct: -8, color: "#7c3aed" },
  { maxSlopePct: -3, color: "#2563eb" },
  { maxSlopePct: 0, color: "#22c55e" },
  { maxSlopePct: 3, color: "#eab308" },
  { maxSlopePct: 6, color: "#f97316" },
  { maxSlopePct: 9, color: "#dc2626" },
  { maxSlopePct: 12, color: "#881337" },
  { maxSlopePct: null, color: "#450a0a" },
];

export const colorFor = (slopePct: number) => BANDS.find((b) => b.maxSlopePct === null || slopePct <= b.maxSlopePct)!.color;

export const ORIGIN: [number, number] = [-104.82, 38.83];
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((ORIGIN[1] * Math.PI) / 180);

/** The point `eastM` metres east of the origin and `northM` north. */
export const east = (eastM: number, northM = 0): [number, number] => [
  ORIGIN[0] + eastM / M_PER_DEG_LON,
  ORIGIN[1] + northM / M_PER_DEG_LAT,
];

export interface PieceSpec {
  segmentId: number;
  lengthM: number;
  /** One slope per span; spans are 15m, the last one shorter. A single slope covers the whole piece. */
  slopes: number[];
  direction?: Direction;
  source?: PathSource;
  rule?: PathRule | null;
  streetName?: string | null;
  rides?: number;
  lastRiddenAt?: string | null;
  /** Travel metres along the segment where the piece starts. */
  fromM?: number;
}

// An answer whose pieces follow one another east from `startEastM`, `northM`
// north of the origin (each direction of a street sits on its own side).
export function makePath(
  specs: PieceSpec[],
  stop: { reason?: PathEnd; aheadM?: number } = {},
  startEastM = 0,
  northM = 0,
): PathResponse {
  const pieces: PathPiece[] = [];
  const spans: PathSpan[] = [];
  let atM = 0;
  let heightM = 0;
  specs.forEach((spec, index) => {
    const fromM = spec.fromM ?? 0;
    const source = spec.source ?? "line";
    pieces.push({
      segmentId: spec.segmentId,
      direction: spec.direction ?? "forward",
      streetName: spec.streetName === undefined ? "Test Street" : spec.streetName,
      fromM,
      toM: fromM + spec.lengthM,
      atM,
      lengthM: spec.lengthM,
      source,
      rule: spec.rule === undefined ? (index === 0 ? "start" : "only") : spec.rule,
      geometry: { type: "LineString", coordinates: [east(startEastM + atM, northM), east(startEastM + atM + spec.lengthM, northM)] },
      rides: source === "none" ? 0 : spec.rides ?? 3,
      lastRiddenAt: source === "none" ? null : spec.lastRiddenAt ?? "2026-10-08T23:41:39.415Z",
    });
    const count = spec.slopes.length === 1 ? 1 : Math.ceil(spec.lengthM / 15);
    for (let k = 0; k < count; k++) {
      const spanAt = spec.slopes.length === 1 ? 0 : k * 15;
      const lengthM = spec.slopes.length === 1 ? spec.lengthM : Math.min(15, spec.lengthM - spanAt);
      const slopePct = spec.slopes[Math.min(k, spec.slopes.length - 1)]!;
      const riseM = (slopePct * lengthM) / 100;
      spans.push({
        atM: atM + spanAt,
        lengthM,
        slopePct,
        color: colorFor(slopePct),
        source,
        piece: index,
        heightM,
        riseM,
        rides: pieces[index]!.rides,
      });
      heightM += riseM;
    }
    atM += spec.lengthM;
  });
  return {
    pieces,
    spans,
    lengthM: atM,
    stop: { reason: stop.reason ?? "end", atM, aheadM: stop.aheadM ?? 0, branches: [] },
    bands: BANDS,
  };
}

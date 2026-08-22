import type { PoolClient } from "pg";
import type { Direction } from "../types/index.js";

// Terrain elevation sampled from a public digital elevation model along
// segment centrelines, used as an absolute reference to anchor each ride.
//
// A phone barometer measures *change* in altitude very well and absolute
// altitude not at all, so every ride is anchored to the GPS altitude of its
// own first fix -- one reading carrying 10-20m of vertical error. Measured
// against USGS 3DEP, sessions 11-14 sat at -13.20, -13.35, -14.85 and -16.54m:
// a 3.3m spread between rides of the same streets. Where two rides meet on
// adjacent buckets the running mean welds together profiles that disagree by
// metres, putting an invented step in the road exactly at the seam.
//
// The DEM is the opposite trade: no per-ride drift, but coarser detail. Using
// it only to fit one offset per session takes the strength of each -- the
// barometer keeps the shape, the DEM fixes the level.
//
// Only OSM centreline coordinates are sent to the API, never ride traces, and
// every point is cached permanently because terrain does not move.

export interface DemPosition {
  segmentId: number;
  direction: Direction;
  distanceM: number;
}

export function demKey(p: DemPosition): string {
  return `${p.segmentId}|${p.direction}|${p.distanceM}`;
}

// OpenTopoData's public instance serving USGS NED 10m. 10m resolution is
// coarser than the 1m 3DEP lidar also available for Colorado Springs, but the
// offset is fit across hundreds of points at once, so the per-point sampling
// error averages down to a few centimetres -- while 1m would cost one HTTP
// request per point instead of a hundred.
const DEM_API_URL = process.env.DEM_API_URL ?? "https://api.opentopodata.org/v1/ned10m";
const BATCH_SIZE = 100;
// Bounds the work a single ride can trigger. A ride covers ~50 segments, so a
// cold cache is ~4 batches; the cap stops a pathological session stalling the
// upload behind a slow third party.
const MAX_BATCHES = 8;
const REQUEST_TIMEOUT_MS = 15000;
const INTER_BATCH_DELAY_MS = 1100; // the public instance allows ~1 call/second

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface PendingPoint extends DemPosition {
  lat: number;
  lon: number;
}

// Returns DEM elevation for as many of `positions` as are known, filling the
// cache from the API for any that are missing.
//
// Never throws: a DEM outage degrades to an unanchored ride, which is what the
// model did before this existed, rather than failing the upload.
export async function ensureDemElevations(
  client: PoolClient,
  positions: DemPosition[],
): Promise<Map<string, number>> {
  const wanted = new Map<string, DemPosition>();
  for (const p of positions) wanted.set(demKey(p), p);
  if (wanted.size === 0) return new Map();

  const unique = [...wanted.values()];
  const { rows: cached } = await client.query<{
    segment_id: string;
    direction: Direction;
    distance_m: number;
    elevation_m: number;
  }>(
    `select segment_id, direction, distance_m, elevation_m
       from segment_dem_elevations
      where (segment_id, direction, distance_m) in (
        select * from unnest($1::bigint[], $2::text[], $3::int[])
      )`,
    [
      unique.map((p) => p.segmentId),
      unique.map((p) => p.direction),
      unique.map((p) => p.distanceM),
    ],
  );

  const known = new Map<string, number>();
  for (const row of cached) {
    known.set(
      demKey({
        segmentId: Number(row.segment_id),
        direction: row.direction,
        distanceM: row.distance_m,
      }),
      row.elevation_m,
    );
  }

  const missing = unique.filter((p) => !known.has(demKey(p)));
  if (missing.length === 0) return known;

  // Bucket distances are measured along the direction of travel, so a backward
  // bucket has to be flipped back to a distance from the segment's start
  // before it can be turned into a coordinate.
  const { rows: points } = await client.query<{
    segment_id: string;
    direction: Direction;
    distance_m: number;
    lat: number;
    lon: number;
  }>(
    `select p.segment_id, p.direction, p.distance_m,
            ST_Y(ST_LineInterpolatePoint(s.geom, f.fraction)) as lat,
            ST_X(ST_LineInterpolatePoint(s.geom, f.fraction)) as lon
       from unnest($1::bigint[], $2::text[], $3::int[]) as p(segment_id, direction, distance_m)
       join segments s on s.id = p.segment_id
       cross join lateral (
         select greatest(0, least(1,
           (case when p.direction = 'forward' then p.distance_m
                 else s.length_m - p.distance_m end) / s.length_m)) as fraction
       ) f`,
    [
      missing.map((p) => p.segmentId),
      missing.map((p) => p.direction),
      missing.map((p) => p.distanceM),
    ],
  );

  const pending: PendingPoint[] = points.map((row) => ({
    segmentId: Number(row.segment_id),
    direction: row.direction,
    distanceM: row.distance_m,
    lat: row.lat,
    lon: row.lon,
  }));

  for (let i = 0; i < pending.length && i < MAX_BATCHES * BATCH_SIZE; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    let elevations: Array<number | null>;
    try {
      elevations = await fetchDem(batch);
    } catch (err) {
      console.warn("DEM lookup failed, continuing unanchored", err);
      break;
    }

    // Written in one statement per batch. Individually, a ride over new ground
    // added hundreds of round trips to an upload the phone was already timing
    // out on. Keys are unique here because `wanted` deduplicated the positions.
    const cacheValues: unknown[] = [];
    const cacheTuples: string[] = [];
    for (let j = 0; j < batch.length; j++) {
      const elevation = elevations[j];
      if (elevation == null || !Number.isFinite(elevation)) continue;
      known.set(demKey(batch[j]), elevation);
      cacheValues.push(batch[j].segmentId, batch[j].direction, batch[j].distanceM, elevation);
      const n = (cacheTuples.length) * 4;
      cacheTuples.push(`($${n + 1}, $${n + 2}, $${n + 3}, $${n + 4})`);
    }
    if (cacheTuples.length > 0) {
      await client.query(
        `insert into segment_dem_elevations (segment_id, direction, distance_m, elevation_m)
         values ${cacheTuples.join(", ")}
         on conflict (segment_id, direction, distance_m) do nothing`,
        cacheValues,
      );
    }

    if (i + BATCH_SIZE < pending.length) await sleep(INTER_BATCH_DELAY_MS);
  }

  return known;
}

async function fetchDem(batch: PendingPoint[]): Promise<Array<number | null>> {
  const locations = batch.map((p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`).join("|");
  const response = await fetch(DEM_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ locations }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`DEM ${response.status} ${await response.text()}`);

  const json = (await response.json()) as {
    status: string;
    results?: Array<{ elevation: number | null }>;
  };
  if (json.status !== "OK" || !json.results) throw new Error(`DEM status ${json.status}`);
  return json.results.map((r) => r.elevation);
}

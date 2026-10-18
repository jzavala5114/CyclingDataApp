import * as turf from "@turf/turf";
import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { asyncRoute } from "./asyncRoute.js";
import { segmentsWithLines } from "../services/segmentsResponse.js";
import {
  boxAround,
  insideBox,
  loadExtents,
  loadLineData,
  loadPathSegments,
  loadTransitions,
} from "../services/pathData.js";
import {
  buildPathGraph,
  connectPath,
  growPath,
  lineKey,
  type Candidate,
  type PathGraph,
  type PathPiece,
  type PathPoint,
} from "../services/pathGrowth.js";
import { pathResponse, type PathEnd } from "../services/pathResponse.js";
import type { Direction, ElevationBucket, PassBucket, Segment, SegmentCoverage } from "../types/index.js";

export const segmentsRouter = Router();

const bboxSchema = z.object({
  minLon: z.coerce.number(),
  minLat: z.coerce.number(),
  maxLon: z.coerce.number(),
  maxLat: z.coerce.number(),
});

// Returns the segments in the viewport that have recorded elevation data,
// each with its directional gradient lines.
//
// Segments with no data render nothing, and the network spans a whole city,
// so returning all of them would ship tens of thousands of unusable rows per
// viewport. Filtering here keeps the response proportional to how much has
// actually been ridden rather than how much map is loaded.
segmentsRouter.get("/", asyncRoute(async (req, res) => {
  const { minLon, minLat, maxLon, maxLat } = bboxSchema.parse(req.query);

  const { rows: segmentRows } = await pool.query<Segment>(
    `select id, osm_way_id as "osmWayId", kind, street_name as "streetName",
            start_node_id as "startNodeId", end_node_id as "endNodeId",
            piece_index as "pieceIndex",
            ST_AsGeoJSON(geom)::json as geom, length_m as "lengthM", bearing_deg as "bearingDeg"
       from segments s
      where s.geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
        and s.canonical_segment_id is null
        and exists (select 1 from segment_elevation_buckets b where b.segment_id = s.id)`,
    [minLon, minLat, maxLon, maxLat],
  );

  if (segmentRows.length === 0) return res.json({ segments: [] });

  // The three below need only the segments' ids, so they go out together.
  // Each is a round trip to the database, and one after another they added up:
  // the fourth, the pass rows, would otherwise have made every map request a
  // round trip slower than before it existed.
  const ids = segmentRows.map((s) => s.id);
  const [{ rows: bucketRows }, { rows: coverageRows }, { rows: passRows }] = await Promise.all([
    pool.query<ElevationBucket>(
      `select segment_id as "segmentId", direction, distance_m as "distanceM",
              elevation_m as "elevationM", sample_count as "sampleCount"
         from segment_elevation_buckets
        where segment_id = any($1)`,
      [ids],
    ),
    pool.query<SegmentCoverage>(
      `select segment_id as "segmentId", direction,
              covered_from_m as "coveredFromM", covered_to_m as "coveredToM"
         from segment_coverage
        where segment_id = any($1)`,
      [ids],
    ),
    // Each pass's own heights, which the slopes are fitted to wherever every
    // pass behind a window is on file (services/gradientBuilder.ts). Found
    // through the match rows, which carry the segment and direction.
    pool.query<PassBucket>(
      `select m.segment_id as "segmentId", m.direction, p.match_id as "matchId",
              p.distance_m as "distanceM", p.elevation_m as "elevationM"
         from segment_pass_buckets p
         join session_segment_matches m on m.id = p.match_id
        where m.segment_id = any($1)`,
      [ids],
    ),
  ]);

  // Joined in services/segmentsResponse.ts, which says why that join is fragile.
  res.json({ segments: segmentsWithLines(segmentRows, bucketRows, coverageRows, passRows) });
}));

// GET /segments/path: the path a press-and-hold selection grows along. The
// design is context/session.md, "Press and hold on a segment, designed 2026-10-17";
// services/pathGrowth.ts grows it, and
// services/pathResponse.ts says what each field means.
//
// Three requests, by what they name:
//   a press:          the pressed line and point. Grows from there.
//   hold past the end: the selection's end (with atM) and toSegmentId..toLat,
//                     the line held. Connects to it, then grows from it.
//   hold behind it:   the line held, toSegmentId..toAtM the selection's start,
//                     grow=false. Connects to the start and stops there.
// `avoid` lists the selection's segments, so growth stops (`loop`) rather than
// run back into it.
//
// The network is loaded for PATH_BOX_M around the point or points, near drawn
// lines only (loadPathSegments). Growth stops with `limit` at a junction within
// PATH_EDGE_M of that box's edge, where a branch may not have been loaded, and
// the phone asks again from the tip.
//
// Two stated limits. The network and each line's data are read in separate
// statements, not one snapshot, so a ride merged between them can leave a
// piece the extents call drawn with no line data yet; it is then estimated like
// ground with no data, and the next request has it. And `avoid` takes at most
// MAX_AVOID ids: past that the phone sends the segments nearest the end.
const PATH_BOX_M = 2000;
const PATH_EDGE_M = 100;
const MAX_AVOID = 500;

const directionSchema = z.enum(["forward", "backward"]);
const pathQuerySchema = z
  .object({
    segmentId: z.coerce.number().int().positive(),
    direction: directionSchema,
    lon: z.coerce.number().min(-180).max(180),
    lat: z.coerce.number().min(-90).max(90),
    atM: z.coerce.number().min(0).optional(),
    toSegmentId: z.coerce.number().int().positive().optional(),
    toDirection: directionSchema.optional(),
    toLon: z.coerce.number().min(-180).max(180).optional(),
    toLat: z.coerce.number().min(-90).max(90).optional(),
    toAtM: z.coerce.number().min(0).optional(),
    grow: z.enum(["true", "false"]).default("true"),
    avoid: z
      .string()
      .regex(/^\d+(,\d+)*$/, "a comma-separated list of segment ids")
      .refine((ids) => ids.split(",").length <= MAX_AVOID, `at most ${MAX_AVOID} ids`)
      .optional(),
  })
  .refine(
    (q) => [q.toSegmentId, q.toDirection, q.toLon, q.toLat].every((v) => v === undefined) ||
      [q.toSegmentId, q.toDirection, q.toLon, q.toLat].every((v) => v !== undefined),
    "toSegmentId, toDirection, toLon and toLat go together",
  )
  .refine((q) => q.grow === "true" || q.toSegmentId !== undefined, "grow=false needs a point to reach");

// Metres along `direction` to the point of the segment nearest `lonLat`. turf
// measures along the geometry, which can differ slightly from the stored
// length every other distance uses, so it is rescaled onto that.
function travelMAt(segment: Segment, direction: Direction, lonLat: [number, number]): number {
  const line = turf.lineString(segment.geom.coordinates);
  const geometryM = turf.length(line, { units: "meters" });
  const nearest = turf.nearestPointOnLine(line, lonLat, { units: "meters" });
  const forwardM = nearest.properties.totalDistance * (geometryM > 0 ? segment.lengthM / geometryM : 1);
  return direction === "forward" ? forwardM : segment.lengthM - forwardM;
}

// A request's point on the loaded network, or null when its segment is not
// there. A pressed point (no atM) is moved onto its line's drawn stretch: the
// phone only draws that stretch, and a finger lands beside it.
function locate(
  graph: PathGraph,
  point: { segmentId: number; direction: Direction; lon: number; lat: number; atM?: number },
): PathPoint | null {
  const segment = graph.segments.get(point.segmentId);
  if (!segment) return null;
  let atM = point.atM ?? travelMAt(segment, point.direction, [point.lon, point.lat]);
  atM = Math.max(0, Math.min(segment.lengthM, atM));
  const extent = graph.extents.get(lineKey(point));
  if (point.atM === undefined && extent) atM = Math.max(extent.fromM, Math.min(extent.toM, atM));
  return { segmentId: point.segmentId, direction: point.direction, atM };
}

segmentsRouter.get("/path", asyncRoute(async (req, res) => {
  const parsed = pathQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error: parsed.error.issues.map((issue) => `${issue.path.join(".") || "query"}: ${issue.message}`).join("; "),
    });
  }
  const q = parsed.data;
  const target =
    q.toSegmentId === undefined
      ? null
      : { segmentId: q.toSegmentId, direction: q.toDirection!, lon: q.toLon!, lat: q.toLat!, atM: q.toAtM };
  const points: Array<[number, number]> = [[q.lon, q.lat]];
  if (target) points.push([target.lon, target.lat]);
  const box = boxAround(points, PATH_BOX_M);

  // The network and the ride order go out together; the extents need the
  // network's ids.
  const [segments, transitions] = await Promise.all([loadPathSegments(pool, box), loadTransitions(pool)]);
  const extents = await loadExtents(pool, segments);
  const graph = buildPathGraph({ segments, extents, transitions, decidable: insideBox(box, PATH_EDGE_M) });

  const from = locate(graph, q);
  const to = target && locate(graph, target);
  if (!from || (target && !to)) {
    const missing = from ? target!.segmentId : q.segmentId;
    return res.status(404).json({ error: `segment ${missing} is not near a drawn line there` });
  }

  const avoid = q.avoid ? q.avoid.split(",").map(Number) : [];
  let pieces: PathPiece[] = [];
  let stop: { reason: PathEnd; branches: readonly Candidate[]; aheadM: number } = {
    reason: "unreachable",
    branches: [],
    aheadM: 0,
  };
  if (!to) {
    const grown = growPath(graph, from, { avoid });
    ({ pieces, stop } = grown);
  } else {
    const connector = connectPath(graph, from, to);
    if (connector === null) {
      stop = { reason: "unreachable", branches: [], aheadM: 0 };
    } else if (q.grow === "false") {
      pieces = connector;
      stop = { reason: "joined", branches: [], aheadM: 0 };
    } else {
      // On from the held point, the connection's own segments counting as
      // already selected; its first piece carries no rule, its segment having
      // joined as the connection's last.
      const last = connector[connector.length - 1];
      const connectorM = last ? last.atM + (last.toM - last.fromM) : 0;
      const grown = growPath(graph, to, { avoid: [...avoid, ...connector.map((p) => p.segmentId)], startRule: null });
      pieces = [...connector, ...grown.pieces.map((p) => ({ ...p, atM: p.atM + connectorM }))];
      ({ stop } = grown);
    }
  }

  const { lines, rides } =
    pieces.length > 0
      ? await loadLineData(pool, graph.segments, pieces.map((p) => p.segmentId))
      : { lines: new Map(), rides: new Map() };
  res.json(pathResponse(graph, pieces, stop, lines, rides));
}));

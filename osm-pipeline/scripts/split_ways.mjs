import fs from "node:fs";
import path from "node:path";
import * as turf from "@turf/turf";

// Splits OSM ways into block-scale segments for the `segments` table (see
// backend/src/db/schema.sql).
//
// Only ways a rider can actually be logged on are kept. Everything else is
// dropped outright, which does two jobs at once:
//
//  1. Data quality -- a detour up an alley or through a parking lot matches
//     nothing, so it's discarded instead of polluting a street's gradient.
//  2. De-fragmentation -- driveways and parking aisles used to share nodes
//     with the sidewalks they cross, and every shared node became a segment
//     boundary. Dropping them cut this neighborhood from 2795 segments to
//     ~950 without losing a single real intersection.
const ROAD_HIGHWAYS = new Set([
  "residential",
  "tertiary",
  "tertiary_link",
  "secondary",
  "secondary_link",
  "primary",
  "primary_link",
  "trunk",
  "trunk_link",
  "unclassified",
  "living_street",
  "road",
]);

const EXCLUDED_HIGHWAYS = new Set([
  "motorway",
  "motorway_link",
  "construction",
  "proposed",
  "abandoned",
  "steps",
  "service", // alleys, driveways, parking aisles
  "bus_guideway",
  "raceway",
  "escape",
  "corridor",
  "elevator",
]);

// OSM access is layered: a mode-specific tag overrides the general one, so
// `access=no` + `bicycle=yes` means "closed in general, open to bikes". Only
// these values grant access; `dismount`, `destination` and the rest do not.
const BICYCLE_ALLOWED = new Set(["yes", "designated", "permissive"]);

const bikesAllowed = (tags) => BICYCLE_ALLOWED.has(tags.bicycle);

// Segments shorter than this are dominated by GPS noise and produce stub
// lines on the map rather than a usable gradient.
const MIN_SEGMENT_M = 8;
// Separately-mapped sidewalks often run for hundreds of metres without
// sharing a node with anything, so intersection topology alone can't bound
// segment length. Capping it keeps every segment block-scale.
const MAX_SEGMENT_M = 150;

function classify(tags = {}) {
  const highway = tags.highway;
  if (!highway) return null;

  // `highway=track` covers two unrelated things. Of the 234 in this extract,
  // 203 are farm roads and driveways -- Cedar Heights Drive, Amber Valley
  // Drive, unpaved and access=private -- and 31 are real trails, among them
  // Ridgeway Trail, Rim Trail and Red Rock Rim Trail. Excluding the tag
  // wholesale took the trails with the driveways: Ridgeway Trail is mapped as
  // two ways, and only the `path` half was reaching the database, so half of
  // it could never draw a gradient however often it was ridden.
  //
  // Admit only what OSM explicitly opens to bikes. Never infer it from the
  // name or the surface. The kind matters downstream: link_canonical.mjs
  // folds footway/cycleway into parent roads but treats `road` as a *parent*,
  // so calling a track a road would let it absorb the trails beside it.
  if (highway === "track") {
    if (!bikesAllowed(tags)) return null;
    return tags.bicycle === "designated" ? "cycleway" : "footway";
  }

  if (EXCLUDED_HIGHWAYS.has(highway)) return null;
  // A blanket access test discarded 42 ways that OSM marks bike-legal,
  // including three pieces of the New Santa Fe Regional Trail and a whole
  // named singletrack network (Thriller, Shreadzilla, Rattlerocks, Pinball) --
  // all `bicycle=designated`, which is to say *designated bike routes*.
  if ((tags.access === "private" || tags.access === "no") && !bikesAllowed(tags)) return null;
  // Crossings are short, run perpendicular to travel, and would only add
  // chop; they carry no useful gradient of their own.
  if (highway === "footway" && tags.footway === "crossing") return null;
  if (ROAD_HIGHWAYS.has(highway)) return "road";
  if (highway === "cycleway" || (highway === "path" && tags.bicycle === "designated")) return "cycleway";
  if (highway === "footway" || highway === "pedestrian" || highway === "path") return "footway";
  return null;
}

const inPath = path.resolve(process.argv[2] ?? "data/extract.json");
const outPath = path.resolve(process.argv[3] ?? "data/segments.geojson");

const raw = JSON.parse(fs.readFileSync(inPath, "utf8"));

const nodesById = new Map();
for (const el of raw.elements) {
  if (el.type === "node") nodesById.set(el.id, [el.lon, el.lat]);
}

const ways = [];
for (const el of raw.elements) {
  if (el.type !== "way" || !el.tags?.highway) continue;
  const kind = classify(el.tags);
  if (kind) ways.push({ way: el, kind });
}

// A node shared by more than one kept way is an intersection.
const nodeWayCount = new Map();
for (const { way } of ways) {
  for (const nodeId of way.nodes) {
    nodeWayCount.set(nodeId, (nodeWayCount.get(nodeId) ?? 0) + 1);
  }
}

const features = [];

for (const { way, kind } of ways) {
  const nodeIds = way.nodes;
  let chunkStart = 0;

  for (let i = 1; i < nodeIds.length; i++) {
    const isLast = i === nodeIds.length - 1;
    if (!isLast && (nodeWayCount.get(nodeIds[i]) ?? 0) <= 1) continue;

    const chunkNodeIds = nodeIds.slice(chunkStart, i + 1);
    chunkStart = i;

    const coords = chunkNodeIds.map((id) => nodesById.get(id)).filter(Boolean);
    if (coords.length < 2) continue;

    const line = turf.lineString(coords);
    const totalM = turf.length(line, { units: "meters" });
    if (totalM < MIN_SEGMENT_M) continue;

    // `pieceIndex` distinguishes the parts of an over-long run, which all
    // share the same pair of OSM end nodes.
    const pieces = Math.max(1, Math.ceil(totalM / MAX_SEGMENT_M));
    const pieceM = totalM / pieces;

    for (let piece = 0; piece < pieces; piece++) {
      const sliced =
        pieces === 1
          ? line
          : turf.lineSliceAlong(line, piece * pieceM, (piece + 1) * pieceM, { units: "meters" });
      const sliceCoords = sliced.geometry.coordinates;
      const lengthM = turf.length(sliced, { units: "meters" });
      if (lengthM < 1) continue;

      const bearingDeg =
        (turf.bearing(sliceCoords[0], sliceCoords[sliceCoords.length - 1]) + 360) % 360;

      features.push(
        turf.feature(sliced.geometry, {
          osmWayId: way.id,
          kind,
          // OSM marks pavements alongside a street explicitly, which is a far
          // sharper signal than "runs near a road and roughly parallel to
          // it" -- that geometric test also swallowed the stretches where a
          // real trail happens to run beside a road, chopping trails in half.
          isSidewalk: way.tags?.footway === "sidewalk",
          streetName: way.tags?.name ?? null,
          startNodeId: chunkNodeIds[0],
          endNodeId: chunkNodeIds[chunkNodeIds.length - 1],
          pieceIndex: piece,
          lengthM,
          bearingDeg,
        }),
      );
    }
  }
}

const byKind = features.reduce((acc, f) => {
  acc[f.properties.kind] = (acc[f.properties.kind] ?? 0) + 1;
  return acc;
}, {});

fs.writeFileSync(outPath, JSON.stringify(turf.featureCollection(features), null, 2));
console.log(`${ways.length} rideable ways -> ${features.length} segments`, byKind);
console.log(`wrote ${outPath}`);

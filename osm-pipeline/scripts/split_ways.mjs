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
  "track",
  "bus_guideway",
  "raceway",
  "escape",
  "corridor",
  "elevator",
]);

// Segments shorter than this are dominated by GPS noise and produce stub
// lines on the map rather than a usable gradient.
const MIN_SEGMENT_M = 8;
// Separately-mapped sidewalks often run for hundreds of metres without
// sharing a node with anything, so intersection topology alone can't bound
// segment length. Capping it keeps every segment block-scale.
const MAX_SEGMENT_M = 150;

function classify(tags = {}) {
  const highway = tags.highway;
  if (!highway || EXCLUDED_HIGHWAYS.has(highway)) return null;
  if (tags.access === "private" || tags.access === "no") return null;
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

import fs from "node:fs";
import path from "node:path";
import * as turf from "@turf/turf";

// Splits every OSM way into segments at "intersection nodes" -- any node
// shared by more than one way, plus each way's own endpoints -- so a
// segment always runs from one cross street to the next. This is the
// dataset backend/src/db/schema.sql's `segments` table expects.
//
// Rideable-road heuristic: keep anything tagged highway=* except a small
// exclusion list of non-cycling ways. Good enough for a prototype; revisit
// with proper cycling-suitability filtering (e.g. exclude motorway) later.
const EXCLUDED_HIGHWAY_VALUES = new Set([
  "motorway",
  "motorway_link",
  "construction",
  "proposed",
  "abandoned",
  "steps",
]);

const inPath = path.resolve(process.argv[2] ?? "data/extract.json");
const outPath = path.resolve(process.argv[3] ?? "data/segments.geojson");

const raw = JSON.parse(fs.readFileSync(inPath, "utf8"));
const elements = raw.elements;

const nodesById = new Map();
for (const el of elements) {
  if (el.type === "node") nodesById.set(el.id, [el.lon, el.lat]);
}

const ways = elements.filter(
  (el) => el.type === "way" && el.tags?.highway && !EXCLUDED_HIGHWAY_VALUES.has(el.tags.highway),
);

const nodeWayCount = new Map();
for (const way of ways) {
  for (const nodeId of way.nodes) {
    nodeWayCount.set(nodeId, (nodeWayCount.get(nodeId) ?? 0) + 1);
  }
}

function isIntersection(nodeId) {
  return (nodeWayCount.get(nodeId) ?? 0) > 1;
}

const features = [];

for (const way of ways) {
  const nodeIds = way.nodes;
  let chunkStart = 0;

  for (let i = 1; i < nodeIds.length; i++) {
    const isLast = i === nodeIds.length - 1;
    if (!isLast && !isIntersection(nodeIds[i])) continue;

    const chunkNodeIds = nodeIds.slice(chunkStart, i + 1);
    if (chunkNodeIds.length < 2) {
      chunkStart = i;
      continue;
    }

    const coords = chunkNodeIds.map((id) => nodesById.get(id)).filter(Boolean);
    if (coords.length < 2) {
      chunkStart = i;
      continue;
    }

    const line = turf.lineString(coords);
    const lengthM = turf.length(line, { units: "meters" });
    if (lengthM < 1) {
      chunkStart = i;
      continue;
    }
    const bearingDeg = (turf.bearing(coords[0], coords[coords.length - 1]) + 360) % 360;

    features.push(
      turf.feature(line.geometry, {
        osmWayId: way.id,
        streetName: way.tags?.name ?? null,
        startNodeId: chunkNodeIds[0],
        endNodeId: chunkNodeIds[chunkNodeIds.length - 1],
        lengthM,
        bearingDeg,
      }),
    );

    chunkStart = i;
  }
}

fs.writeFileSync(outPath, JSON.stringify(turf.featureCollection(features), null, 2));
console.log(`${ways.length} ways -> ${features.length} segments -> ${outPath}`);

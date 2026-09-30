import fs from "node:fs";
import path from "node:path";
import * as turf from "@turf/turf";
import { classify, isTunnel } from "./lib/tags.mjs";

// Splits OSM ways into block-scale segments for the `segments` table (see
// backend/src/db/schema.sql).
//
// What each tag means -- which ways are rideable, and which have a structure
// over them -- lives in lib/tags.mjs, which has the tests. This file is the
// geometry: chunk at intersections, cap the length, measure, write.

// Segments shorter than this are dominated by GPS noise and produce stub
// lines on the map rather than a usable gradient.
const MIN_SEGMENT_M = 8;
// Separately-mapped sidewalks often run for hundreds of metres without
// sharing a node with anything, so intersection topology alone can't bound
// segment length. Capping it keeps every segment block-scale.
const MAX_SEGMENT_M = 150;

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
          // A structure overhead, so no GPS fix is possible here and an
          // unpainted stretch is physics rather than a defect. Way-level in
          // OSM and therefore way-level here: every chunk of a tunnel way
          // inherits it. That is the right granularity because OSM maps the
          // covered stretch as its own way and its mouths are shared nodes,
          // which makes them segment boundaries -- so the flag lands on the
          // covered piece and not on the open road either side.
          isTunnel: isTunnel(way.tags ?? {}),
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

const tunnels = features.filter((f) => f.properties.isTunnel).length;

fs.writeFileSync(outPath, JSON.stringify(turf.featureCollection(features), null, 2));
console.log(`${ways.length} rideable ways -> ${features.length} segments`, byKind);
// Printed because a count of zero here means the flag is broken rather than
// the city being tunnel-free, and that is otherwise invisible until something
// downstream quietly reports every hole as a defect.
console.log(`${tunnels} segments under a structure (tunnel/covered)`);
console.log(`wrote ${outPath}`);

import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as turf from "@turf/turf";
import {
  START_SPEED_PT_PER_S,
  TOP_SPEED_PT_PER_S,
  drawnTravelRange,
  growthSpeedPtPerS,
  hitFromFeatures,
  heldTravelM,
  metresPerPoint,
  nearestLine,
  previewSelection,
  SELECTION_HIT_LAYERS,
  SELECTION_LAYER,
  travelMAt,
} from "./holdGesture.js";
import { fromResponse, growingFeature, selectionFeatures } from "./pathSelection.js";
import { east, makePath } from "./testPaths.js";
import type { DirectionalGradientLine } from "../types";

// Which line a finger means, where along it, and what grows before the
// server answers. The pick is the one thing the rider cannot see go wrong
// until the selection runs the wrong way, so the two-line street is the case.

const close = (actual: number, expected: number, tolerance: number, what = "value") =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: expected ${expected}, got ${actual}`);

// A street running 200m east. Its two lines sit 4m either side of the
// centreline: forward (eastbound) on the south side, the right of its travel.
const centreline = { type: "LineString" as const, coordinates: [east(0), east(200)] };
const forwardLine = { type: "LineString" as const, coordinates: [east(0, -4), east(200, -4)] };
const backwardLine = { type: "LineString" as const, coordinates: [east(0, 4), east(200, 4)] };
const segment = { id: 7, streetName: "East Cimarron Street", geom: centreline, lengthM: 200 };

test("the line nearer the finger wins, so the finger picks its side of the street", () => {
  const lines = [
    { segmentId: 7, direction: "forward" as const, geometry: forwardLine },
    { segmentId: 7, direction: "backward" as const, geometry: backwardLine },
  ];
  assert.equal(nearestLine(lines, east(50, -2))!.direction, "forward");
  assert.equal(nearestLine(lines, east(50, 3))!.direction, "backward");
  close(nearestLine(lines, east(50, 3))!.distanceM, 1, 0.01, "distance to the backward line");
  assert.equal(nearestLine([], east(0)), null);
});

test("travel metres match the server: measured from the start of travel, rescaled onto the stored length", () => {
  // The stored length is 2% over turf's: the server rescales, and so must this.
  const stored = { geom: centreline, lengthM: 204 };
  const geometryM = turf.length(turf.lineString(centreline.coordinates), { units: "meters" });
  const scale = 204 / geometryM;
  close(travelMAt(stored, "forward", east(50, 3)), 50 * (geometryM / 200) * scale, 0.01, "forward");
  close(travelMAt(stored, "backward", east(50, 3)), 204 - 50 * (geometryM / 200) * scale, 0.01, "backward");
  assert.equal(travelMAt(stored, "forward", east(-30)), 0);
  close(travelMAt(stored, "forward", east(260)), 204, 1e-9, "past the end clamps");
});

test("a held point is moved onto the stretch the map draws, as the server moves a press", () => {
  // Drawn only from 40m to 160m east.
  const partial = { direction: "forward" as const, geometry: { type: "LineString" as const, coordinates: [east(40, -4), east(160, -4)] } };
  const range = drawnTravelRange(segment, partial);
  close(range.fromM, 40, 0.2, "drawn from");
  close(range.toM, 160, 0.2, "drawn to");
  close(heldTravelM(segment, partial, east(10, -4)), 40, 0.2, "before the drawn stretch");
  close(heldTravelM(segment, partial, east(100, -4)), 100, 0.2, "inside it");
  const backward = { direction: "backward" as const, geometry: { type: "LineString" as const, coordinates: [east(40, 4), east(160, 4)] } };
  close(heldTravelM(segment, backward, east(190, 4)), 40, 0.2, "backward travel starts at the east end");
});

test("the preview runs ahead of the finger in the line's direction of travel, coloured as drawn", () => {
  const drawing: DirectionalGradientLine = {
    direction: "forward",
    geometry: forwardLine,
    colorStops: [
      { distanceFraction: 0, color: "#22c55e" },
      { distanceFraction: 0.5, color: "#f97316" },
    ],
  };
  const preview = previewSelection(segment, drawing, east(50, -4))!;
  close(preview.lengthM, 150, 0.5, "from the finger to the end");
  const [startLon] = preview.pieces[0]!.geometry.coordinates[0]!;
  close(startLon!, east(50)[0], 1e-6, "starts at the finger");
  assert.deepEqual(preview.spans.map((s) => s.color), ["#22c55e", "#f97316"]);
  close(preview.spans[0]!.lengthM, 50, 0.5, "green from 50m to 100m");
});

test("a backward line's preview runs west, its colours read in the order travelled", () => {
  // The geometry and the stops count forward, east, whichever way the line runs.
  const drawing: DirectionalGradientLine = {
    direction: "backward",
    geometry: backwardLine,
    colorStops: [
      { distanceFraction: 0, color: "#2563eb" },
      { distanceFraction: 0.25, color: "#eab308" },
    ],
  };
  const preview = previewSelection(segment, drawing, east(150, 4))!;
  close(preview.lengthM, 150, 0.5, "from the finger west to the start");
  const coordinates = preview.pieces[0]!.geometry.coordinates;
  assert.ok(coordinates[0]![0]! > coordinates[coordinates.length - 1]![0]!, "runs west");
  // West from 150m: yellow down to 50m, then blue to 0.
  assert.deepEqual(preview.spans.map((s) => s.color), ["#eab308", "#2563eb"]);
  close(preview.spans[0]!.lengthM, 100, 0.5, "yellow from 150m to 50m");
  assert.equal(previewSelection(segment, drawing, east(0, 4)), null, "at the end of travel there is nothing ahead");
});

test("growth starts at 120 points a second and reaches 400 after 2 seconds", () => {
  assert.equal(growthSpeedPtPerS(0), START_SPEED_PT_PER_S);
  assert.equal(growthSpeedPtPerS(1), (START_SPEED_PT_PER_S + TOP_SPEED_PT_PER_S) / 2);
  assert.equal(growthSpeedPtPerS(2), TOP_SPEED_PT_PER_S);
  assert.equal(growthSpeedPtPerS(30), TOP_SPEED_PT_PER_S);
});

test("a point is about 0.47m of ground at zoom 17 here, and twice that at zoom 16", () => {
  close(metresPerPoint(17, 38.83), 0.4652, 0.0005, "zoom 17");
  close(metresPerPoint(16, 38.83), 2 * metresPerPoint(17, 38.83), 1e-12, "zoom 16");
});

test("a touch means the selection over the line beneath it, a branch over a line, else the nearest line", () => {
  const street = {
    id: 7,
    streetName: "East Cimarron Street",
    geom: centreline,
    lengthM: 200,
    directionalLines: [
      { direction: "forward" as const, geometry: forwardLine, colorStops: [{ distanceFraction: 0, color: "#eab308" }] },
      { direction: "backward" as const, geometry: backwardLine, colorStops: [{ distanceFraction: 0, color: "#22c55e" }] },
    ],
  };
  const segments = new Map([[7, street]]);
  const base = (direction: "forward" | "backward", geometry: typeof forwardLine) => ({
    geometry,
    properties: { color: "#eab308", streetName: "East Cimarron Street", segmentId: 7, direction },
  });
  const selected = { geometry: forwardLine, properties: { kind: "selection", piece: 3 } };
  const branchStub = { type: "LineString" as const, coordinates: [east(100, 12), east(100, 40)] };
  const branch = { geometry: branchStub, properties: { kind: "branch", index: 0 } };
  const branches = [{ segmentId: 8, direction: "forward" as const, streetName: null, source: "line" as const, geometry: branchStub }];
  const hit = (features: object[], at: [number, number]) =>
    hitFromFeatures(features as never, at, 17, segments, (i) => branches[i]);

  // On the selection: the base line under it is the same line, and loses the tie.
  assert.equal(hit([base("forward", forwardLine), selected], east(50, -4)).piece, 3);
  // Across the street from the selection, the other line is nearer.
  const across = hit([base("backward", backwardLine), selected], east(50, 4));
  assert.equal(across.piece, null);
  assert.equal(across.line!.drawing.direction, "backward");
  // A branch stub beats a line further off.
  assert.equal(hit([base("backward", backwardLine), branch], east(100, 20)).branch!.segmentId, 8);
  // A line whose segment the phone has not loaded is no line at all.
  assert.equal(hit([{ ...base("forward", forwardLine), properties: { segmentId: 99, direction: "forward" } }], east(50, -4)).line, null);
  assert.deepEqual(hit([], east(0)), { lonLat: east(0), zoom: 17, line: null, piece: null, branch: null });
});

test("let go mid-run, the run still growing is the selection to a touch, and the screen queries its layers", () => {
  const street = {
    id: 7,
    streetName: "East Cimarron Street",
    geom: centreline,
    lengthM: 200,
    directionalLines: [{ direction: "forward" as const, geometry: forwardLine, colorStops: [{ distanceFraction: 0, color: "#eab308" }] }],
  };
  // 150m grown of a 200m selection: the map draws the last run, part grown,
  // from the growing source alone.
  const selection = fromResponse(makePath([{ segmentId: 7, lengthM: 200, slopes: [3] }], { reason: "end" }, 0, -4));
  const growing = growingFeature(selectionFeatures(selection), 150)!;
  const base = { geometry: forwardLine, properties: { segmentId: 7, direction: "forward" } };
  const atTip = hitFromFeatures([base, growing] as never, east(147, -4), 17, new Map([[7, street]]), () => undefined);
  assert.equal(atTip.piece, 0, "the tip the rider sees is the selection");
  for (const id of Object.values(SELECTION_LAYER)) assert.ok(SELECTION_HIT_LAYERS.includes(id), `${id} is hit-tested`);
  assert.ok(SELECTION_HIT_LAYERS.includes("selection-growing-line") && SELECTION_HIT_LAYERS.includes("selection-growing-gap"));
});

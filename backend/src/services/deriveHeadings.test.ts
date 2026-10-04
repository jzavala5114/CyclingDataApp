import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveHeadings, matchSamplesToSegments, MIN_DERIVE_M } from "./segmentMatcher.js";
import type { SessionSample } from "../types/index.js";

// If this is wrong, the arm it feeds looks worse than the device heading for a
// reason that has nothing to do with the device, and the hypothesis gets
// cleared on a bug. A bearing convention is exactly the kind of thing that is
// wrong by 90 or 180 degrees and still produces plausible numbers.

const M_PER_DEG = 111320;
const at = (lat: number, lon: number, i = 0): SessionSample =>
  ({
    id: i,
    recordedAt: new Date(i * 1000).toISOString(),
    lat,
    lon,
    elevationM: 1800,
    headingDeg: 999, // deliberately absurd: nothing here may read it
    speedMps: 5,
    accuracyM: 4,
  }) as SessionSample;

/** Points `m` metres apart on a line running at `bearing` degrees from 38.82N. */
const track = (bearingDeg: number, m: number, n: number): SessionSample[] => {
  const rad = (bearingDeg * Math.PI) / 180;
  const cosLat = Math.cos((38.82 * Math.PI) / 180);
  return Array.from({ length: n }, (_, i) =>
    at(
      38.82 + (i * m * Math.cos(rad)) / M_PER_DEG,
      -104.82 + (i * m * Math.sin(rad)) / (M_PER_DEG * cosLat),
      i,
    ),
  );
};

const near = (actual: number | null, expected: number, within = 1.5) => {
  assert.ok(actual != null, "expected a heading, got null");
  const d = Math.abs(((actual - expected + 540) % 360) - 180);
  assert.ok(d <= within, `expected ~${expected}, got ${actual.toFixed(1)}`);
};

test("north is 0, east is 90: the compass convention, not the maths one", () => {
  // THE CONVENTION. atan2(y, x) would give 0 for east and count anticlockwise,
  // which is 90 degrees out and mirrored. Both would still produce headings
  // that look like headings.
  near(deriveHeadings(track(0, 20, 3))[1], 0);
  near(deriveHeadings(track(90, 20, 3))[1], 90);
  near(deriveHeadings(track(180, 20, 3))[1], 180);
  near(deriveHeadings(track(270, 20, 3))[1], 270);
  near(deriveHeadings(track(45, 20, 3))[1], 45);
});

test("every heading is in [0, 360)", () => {
  for (const b of [0, 45, 90, 135, 180, 225, 270, 315, 359]) {
    for (const h of deriveHeadings(track(b, 20, 5))) {
      if (h == null) continue;
      assert.ok(h >= 0 && h < 360, `${h} out of range for a ${b} degree track`);
    }
  }
});

test("the device heading is never read", () => {
  // The fixtures carry headingDeg 999. If any of it leaked through, the values
  // below would be 999 rather than a bearing.
  for (const h of deriveHeadings(track(123, 20, 5))) {
    if (h == null) continue;
    assert.notEqual(h, 999);
  }
});

test("CENTRAL difference, not forward: a corner reports the corner", () => {
  // A forward difference reports where the rider is going NEXT, which at a
  // right-angle turn is already the new street -- so the fix ON the corner
  // would be matched to the street it has not reached yet. The central
  // difference splits the turn, which is what a rider on a corner is doing.
  const corner = [
    at(38.82, -104.82, 0),
    at(38.82 + 20 / M_PER_DEG, -104.82, 1), // 20m north
    at(38.82 + 20 / M_PER_DEG, -104.82 + 20 / (M_PER_DEG * Math.cos((38.82 * Math.PI) / 180)), 2), // then 20m east
  ];
  const h = deriveHeadings(corner);
  near(h[1], 45, 2); // the mean of north and east, as a central difference gives
});

test("the ends fall back to the one-sided difference they have", () => {
  const h = deriveHeadings(track(90, 20, 3));
  near(h[0], 90);
  near(h[2], 90);
});

test("BOUNDARY: a rider who has not moved has no direction", () => {
  assert.equal(MIN_DERIVE_M, 6);
  // 2m across the whole window is jitter, and its bearing is the bearing of
  // the jitter. Null is what the device reports when stationary too, and the
  // matcher skips both the same way.
  assert.equal(deriveHeadings(track(90, 1, 3))[1], null, "2m span is not a direction");
  assert.ok(deriveHeadings(track(90, 4, 3))[1] != null, "8m span is");
});

test("a stationary burst in the middle of a ride is null, not the last heading", () => {
  const samples = [
    ...track(90, 20, 2),
    at(38.82, -104.8195, 2),
    at(38.82, -104.8195, 3),
    at(38.82, -104.8195, 4),
  ];
  assert.equal(deriveHeadings(samples)[3], null);
});

test("degenerate inputs do not throw", () => {
  assert.deepEqual(deriveHeadings([]), []);
  assert.deepEqual(deriveHeadings([at(38.82, -104.82)]), [null], "one fix has no neighbour");
  assert.deepEqual(deriveHeadings([at(38.82, -104.82, 0), at(38.82, -104.82, 1)]), [null, null]);
});

test("a non-finite coordinate yields null rather than NaN", () => {
  const samples = [at(38.82, -104.82, 0), at(NaN, -104.82, 1), at(38.821, -104.82, 2)];
  const h = deriveHeadings(samples);
  assert.equal(h[0], null, "its window reaches the bad fix");
  assert.equal(h[2], null);
  for (const v of h) assert.ok(v == null || Number.isFinite(v));
});

test("the minimum is overridable, so a sweep runs through this code", () => {
  assert.equal(deriveHeadings(track(90, 2, 3), 10)[1], null);
  assert.ok(deriveHeadings(track(90, 2, 3), 1)[1] != null);
});

test("one heading per sample, in order", () => {
  const samples = track(90, 20, 7);
  const h = deriveHeadings(samples);
  assert.equal(h.length, samples.length);
});

test("THE DEFAULT is the derived heading, and this is what pins it", () => {
  // Flipping `headingSource`'s default rewrites every height on the map, and
  // when it was flipped from "device" to "derived" on 2026-10-01 all 204 tests
  // stayed green. Nothing watched the single most consequential constant in the
  // matcher. This is that watch: it does not re-test what derived means, it
  // asserts which one you get when you ask for nothing.
  const M_PER_DEG = 111320;
  const cosLat = Math.cos((38.82 * Math.PI) / 180);
  const seg = {
    id: 1, osmWayId: "w1", kind: "road", streetName: "Pinned Street",
    startNodeId: "n1", endNodeId: "n2", pieceIndex: 0, bearingDeg: 90, lengthM: 200,
    geom: {
      type: "LineString" as const,
      coordinates: [[-104.82, 38.82], [-104.82 + 200 / (M_PER_DEG * cosLat), 38.82]],
    },
  } as unknown as Parameters<typeof matchSamplesToSegments>[1][number];

  // Riding due east while the device insists it is heading north. Derived reads
  // the movement and matches; device reads 0 and is rejected by the bearing
  // test, so the two arms cannot be confused for one another here.
  const samples = [0, 1, 2, 3, 4].map((i) =>
    at(38.82, -104.82 + (i * 25) / (M_PER_DEG * cosLat), i),
  ).map((s) => ({ ...s, headingDeg: 0 }) as SessionSample);

  const count = (runs: ReturnType<typeof matchSamplesToSegments>) =>
    runs.reduce((n, r) => n + r.samples.length, 0);
  const byDefault = count(matchSamplesToSegments(samples, [seg]));
  const asDerived = count(matchSamplesToSegments(samples, [seg], { headingSource: "derived" }));
  const asDevice = count(matchSamplesToSegments(samples, [seg], { headingSource: "device" }));

  assert.equal(byDefault, asDerived, "the default must be the derived heading");
  assert.notEqual(asDerived, asDevice, "or this fixture proves nothing about the default");
});

// -- maxBearingDeltaDeg -------------------------------------------------------
//
// The tolerance the bearing test applies, parameterised 2026-10-04 because it
// had never been swept while the tangent window, disconnect penalty, heading
// source and spike filter all had. Held with `headingSource: "device"` so the
// heading is whatever the fixture says and only the threshold is under test --
// a derived heading would have to leave the 25m corridor to point 60 degrees
// off a straight segment, which would change two things at once.

/** A 200m segment running due east from 38.82N, so its tangent is 90 degrees. */
const eastwardSegment = () => {
  const cosLat = Math.cos((38.82 * Math.PI) / 180);
  return {
    id: 1, osmWayId: "w1", kind: "road", streetName: "Tolerance Street",
    startNodeId: "n1", endNodeId: "n2", pieceIndex: 0, bearingDeg: 90, lengthM: 200,
    geom: {
      type: "LineString" as const,
      coordinates: [[-104.82, 38.82], [-104.82 + 200 / (M_PER_DEG * cosLat), 38.82]],
    },
  } as unknown as Parameters<typeof matchSamplesToSegments>[1][number];
};

/** Fixes sitting ON the eastward segment, each reporting `headingDeg`. */
const onSegmentHeading = (headingDeg: number): SessionSample[] => {
  const cosLat = Math.cos((38.82 * Math.PI) / 180);
  return [0, 1, 2, 3, 4].map(
    (i) => ({ ...at(38.82, -104.82 + (i * 25) / (M_PER_DEG * cosLat), i), headingDeg }) as SessionSample,
  );
};

const matchedFixes = (headingDeg: number, maxBearingDeltaDeg?: number) =>
  matchSamplesToSegments(onSegmentHeading(headingDeg), [eastwardSegment()], {
    headingSource: "device",
    ...(maxBearingDeltaDeg == null ? {} : { maxBearingDeltaDeg }),
  }).reduce((n, r) => n + r.samples.length, 0);

test("THE CASE FOR SWEEPING IT: a heading 60deg off the tangent is rejected at 45 and matched at 65", () => {
  // 60 degrees off east is outside the 45-degree window in BOTH senses -- 60
  // from the tangent and 120 from its reverse -- so the segment is not a
  // candidate at all and the run never starts. That is the mechanism behind
  // the 720m of wrong-dir where the heading agrees with travel along the line:
  // when the right edge fails this test, a reversed edge elsewhere can win.
  assert.equal(matchedFixes(150), 0, "rejected at the shipped 45");
  assert.equal(matchedFixes(150, 65), 5, "matched once the window admits 60");
});

test("BOUNDARY: the tolerance bites, bracketed either side of a 60deg offset", () => {
  // Bracketed with a 2-degree margin rather than asserted exactly AT 60, and
  // the reason is worth keeping. This segment is two points on the same
  // parallel, and the great-circle bearing between those is not exactly 90
  // degrees -- it bulges poleward, so the tangent is 89.999-something. A
  // nominal 60-degree offset therefore measures a shade OVER 60, and a
  // tolerance of exactly 60 correctly rejects it. The first version of this
  // test asserted the exact boundary and failed on that, measuring its own
  // fixture rather than the threshold.
  //
  // Pinned against literals as well as against the constant, because a test
  // that reads its threshold back out of the constant moves with it.
  assert.equal(matchedFixes(150, 62), 5, "60 off, tolerance 62: admitted");
  assert.equal(matchedFixes(150, 58), 0, "60 off, tolerance 58: rejected");
  assert.equal(matchedFixes(135, 47), 5, "45 off, tolerance 47: admitted");
  assert.equal(matchedFixes(135, 43), 0, "45 off, tolerance 43: rejected");
});

test("THE DEFAULT is 45, and widening does not silently flip a direction label", () => {
  // The default must stay put: changing it rewrites every height on the map.
  assert.equal(matchedFixes(150), matchedFixes(150, 45), "the default is 45");
  // And a wider window must not turn a forward pass backward. A rider heading
  // east on an eastward segment is forward at every tolerance.
  for (const tol of [45, 55, 65, 75]) {
    const runs = matchSamplesToSegments(onSegmentHeading(90), [eastwardSegment()], {
      headingSource: "device",
      maxBearingDeltaDeg: tol,
    });
    assert.equal(runs.length, 1, `one run at tolerance ${tol}`);
    assert.equal(runs[0]!.direction, "forward", `still forward at tolerance ${tol}`);
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveHeadings, MIN_DERIVE_M } from "./segmentMatcher.js";
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

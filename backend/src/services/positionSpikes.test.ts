import { test } from "node:test";
import assert from "node:assert/strict";
import {
  measurePositionSpikes,
  isSpike,
  quantiles,
  MIN_CHORD_M,
  type SpikeMeasure,
} from "./positionSpikes.js";
import type { SessionSample } from "../types/index.js";

// If the geometry here is wrong, the decision about whether to build a position
// filter at all is made on a wrong number -- and a cross-track distance is
// exactly the kind of quantity that comes out plausible while being the along
// track, or scaled by cos(lat) in the wrong direction, or positive when it
// should be signed.
//
// Two things carry the weight:
//   - cross track is PERPENDICULAR to the chord, not distance to a neighbour.
//   - `isSpike` needs BOTH conditions. Deviation alone is a corner.

const M_PER_DEG = 111_320;
const LAT = 38.82;
const COS_LAT = Math.cos((LAT * Math.PI) / 180);

/** A fix `eastM` east and `northM` north of a fixed origin, at second `t`. */
const at = (eastM: number, northM: number, t: number, over: Partial<SessionSample> = {}): SessionSample =>
  ({
    id: t,
    sessionId: 1,
    recordedAt: new Date(t * 1000).toISOString(),
    lat: LAT + northM / M_PER_DEG,
    lon: -104.82 + eastM / (M_PER_DEG * COS_LAT),
    elevationM: 1800,
    elevationSource: null,
    altitudeAccuracyM: null,
    headingDeg: 90,
    speedMps: 5,
    accuracyM: 8,
    ...over,
  }) as SessionSample;

const near = (actual: number, expected: number, within = 0.15) =>
  assert.ok(
    Math.abs(actual - expected) <= within,
    `expected ~${expected}, got ${actual.toFixed(3)}`,
  );

// --------------------------------------------------------- the geometry

test("a fix on the straight line between its neighbours has no cross track", () => {
  const m = measurePositionSpikes([at(0, 0, 0), at(10, 0, 1), at(20, 0, 2)]);
  assert.equal(m.length, 1, "only the middle fix has two neighbours");
  near(m[0]!.crossTrackM, 0);
  near(m[0]!.alongTrackM, 10);
  near(m[0]!.chordM, 20);
});

test("CROSS TRACK IS PERPENDICULAR, not the distance to a neighbour", () => {
  // The fix is 10m east and 15m north of `before`. Its distance to `before` is
  // 18.0m; its perpendicular distance from the due-east chord is 15m. A
  // measurement that reported 18.0 would look entirely reasonable.
  const m = measurePositionSpikes([at(0, 0, 0), at(10, 15, 1), at(20, 0, 2)]);
  near(m[0]!.crossTrackM, 15);
  near(m[0]!.alongTrackM, 10);
  assert.ok(m[0]!.crossTrackM < 18, "18.0m would be the distance to the neighbour");
});

test("cross track is unsigned: a spike either side of the road is a spike", () => {
  const north = measurePositionSpikes([at(0, 0, 0), at(10, 12, 1), at(20, 0, 2)]);
  const south = measurePositionSpikes([at(0, 0, 0), at(10, -12, 1), at(20, 0, 2)]);
  near(north[0]!.crossTrackM, 12);
  near(south[0]!.crossTrackM, 12);
});

test("longitude is scaled by cos(lat), so east and north are not interchangeable", () => {
  // A degree of longitude at 38.82N is about 78% of a degree of latitude. If
  // cos(lat) were dropped or applied to the wrong axis, this 20m eastward chord
  // would measure about 25.6m and every distance in the report would be wrong
  // by that factor.
  const m = measurePositionSpikes([at(0, 0, 0), at(10, 0, 1), at(20, 0, 2)]);
  near(m[0]!.chordM, 20, 0.3);
  const northward = measurePositionSpikes([at(0, 0, 0), at(0, 10, 1), at(0, 20, 2)]);
  near(northward[0]!.chordM, 20, 0.3);
});

test("the implied speed is the FASTER of the two legs", () => {
  // A spike is a dash out and a dash back; averaging over both legs halves the
  // number that gives it away.
  const m = measurePositionSpikes([at(0, 0, 0), at(30, 0, 1), at(35, 0, 2)]);
  near(m[0]!.impliedMps, 30, 0.5);
});

test("a zero time step gives an infinite implied speed rather than NaN", () => {
  const m = measurePositionSpikes([at(0, 0, 0), at(10, 0, 0), at(20, 0, 1)]);
  assert.equal(m[0]!.impliedMps, Infinity);
});

test("the reported speed and accuracy travel with the measurement, unchanged", () => {
  const m = measurePositionSpikes([
    at(0, 0, 0),
    at(10, 12, 1, { speedMps: 3.25, accuracyM: 7.5 }),
    at(20, 0, 2),
  ]);
  assert.equal(m[0]!.reportedMps, 3.25);
  assert.equal(m[0]!.accuracyM, 7.5);
  assert.equal(m[0]!.sampleId, 1);
  assert.equal(m[0]!.index, 1);
});

test("BOUNDARY: a chord under MIN_CHORD_M falls back to plain distance", () => {
  assert.equal(MIN_CHORD_M, 2);
  // The rider is stationary and one fix jumps 12m. There is no chord to take a
  // perpendicular against, so the honest answer is how far it jumped.
  const m = measurePositionSpikes([at(0, 0, 0), at(0, 12, 1), at(0, 0, 2)]);
  near(m[0]!.crossTrackM, 12);
  assert.equal(m[0]!.alongTrackM, 0, "no chord means no along-track component");
});

test("the threshold is overridable, so a sweep runs through this code", () => {
  const trip = [at(0, 0, 0), at(1.5, 5, 1), at(3, 0, 2)];
  // Chord is 3m. Above MIN_CHORD_M it takes a perpendicular; forced higher it
  // falls back to the raw distance, which is larger.
  const perp = measurePositionSpikes(trip, 2)[0]!.crossTrackM;
  const raw = measurePositionSpikes(trip, 10)[0]!.crossTrackM;
  near(perp, 5);
  assert.ok(raw > perp, `fallback ${raw.toFixed(2)} should exceed perpendicular ${perp.toFixed(2)}`);
});

test("the ends are never measured, because they have no pair of neighbours", () => {
  const m = measurePositionSpikes([at(0, 0, 0), at(10, 0, 1), at(20, 0, 2), at(30, 0, 3)]);
  assert.deepEqual(m.map((x) => x.index), [1, 2]);
});

test("degenerate inputs do not throw", () => {
  assert.deepEqual(measurePositionSpikes([]), []);
  assert.deepEqual(measurePositionSpikes([at(0, 0, 0)]), []);
  assert.deepEqual(measurePositionSpikes([at(0, 0, 0), at(10, 0, 1)]), []);
});

test("a non-finite coordinate is skipped rather than poisoning the output", () => {
  const bad = at(0, 0, 1);
  const m = measurePositionSpikes([at(0, 0, 0), { ...bad, lat: NaN }, at(20, 0, 2), at(30, 0, 3)]);
  for (const x of m) {
    assert.ok(Number.isFinite(x.crossTrackM), `crossTrackM was ${x.crossTrackM}`);
  }
  assert.ok(!m.some((x) => x.index === 1), "the bad fix itself is not measured");
});

test("a real dog-leg: 15m across the road and back in 2 seconds", () => {
  // The South Weber shape the note describes. 5m of progress, 15m sideways.
  const m = measurePositionSpikes([at(0, 0, 0), at(2.5, 15, 1), at(5, 0, 2)])[0]!;
  near(m.crossTrackM, 15);
  near(m.chordM, 5);
  assert.ok(m.impliedMps > 14, `implied speed ${m.impliedMps.toFixed(1)} m/s, about 55 km/h`);
  assert.ok(m.accuracyM != null && m.accuracyM < 30, "and it passes the 30m accuracy filter");
});

// ------------------------------------------------------------- isSpike

const measure = (over: Partial<SpikeMeasure> = {}): SpikeMeasure => ({
  index: 1,
  sampleId: 1,
  crossTrackM: 15,
  alongTrackM: 2.5,
  chordM: 5,
  impliedMps: 15,
  reportedMps: 5,
  accuracyM: 8,
  spanS: 2,
  ...over,
});

const RULE = { minCrossM: 8, crossToChord: 0.5 };

test("THE DISTINCTION: a corner deviates but advances, a spike does not", () => {
  // Both fixes sit 15m off their chord. The corner's chord is 40m because the
  // rider covered ground through the turn; the spike's is 5m because the rider
  // went out and came back. Judging on deviation alone would reject both, which
  // would clip every corner on the map.
  assert.equal(isSpike(measure({ crossTrackM: 15, chordM: 40 }), RULE), false, "a corner");
  assert.equal(isSpike(measure({ crossTrackM: 15, chordM: 5 }), RULE), true, "a spike");
});

test("BOTH conditions are required, not either", () => {
  // Far off the chord but advancing: not a spike.
  assert.equal(isSpike(measure({ crossTrackM: 20, chordM: 100 }), RULE), false);
  // Barely off the chord but going nowhere: also not a spike. 2m of wobble at a
  // traffic light is not worth touching.
  assert.equal(isSpike(measure({ crossTrackM: 2, chordM: 0.5 }), RULE), false);
});

test("BOUNDARY: both thresholds are inclusive, and both bite", () => {
  assert.equal(isSpike(measure({ crossTrackM: 8, chordM: 16 }), RULE), true, "exactly at both");
  assert.equal(isSpike(measure({ crossTrackM: 7.99, chordM: 16 }), RULE), false, "under minCross");
  assert.equal(isSpike(measure({ crossTrackM: 8, chordM: 16.1 }), RULE), false, "under the ratio");
});

test("a rider who did not move at all is all noise", () => {
  assert.equal(isSpike(measure({ crossTrackM: 15, chordM: 0 }), RULE), true);
  assert.equal(
    isSpike(measure({ crossTrackM: 1, chordM: 0 }), RULE),
    false,
    "still has to clear minCrossM",
  );
});

test("a NaN cross track is not a spike, rather than accidentally being one", () => {
  // `>=` against NaN is false, which is the safe direction. Written as a test
  // because a future rewrite to `!(x < min)` would silently flip it.
  assert.equal(isSpike(measure({ crossTrackM: NaN }), RULE), false);
});

test("the rule is parameterised, so the archive can pick the numbers", () => {
  const m = measure({ crossTrackM: 10, chordM: 30 });
  assert.equal(isSpike(m, { minCrossM: 8, crossToChord: 0.5 }), false);
  assert.equal(isSpike(m, { minCrossM: 8, crossToChord: 0.3 }), true);
  assert.equal(isSpike(m, { minCrossM: 12, crossToChord: 0.3 }), false);
});

// ----------------------------------------------------------- quantiles

test("quantiles sort before indexing, and pick the named one", () => {
  const q = quantiles([5, 1, 4, 2, 3], [0, 0.5, 0.99]);
  assert.deepEqual(q, [
    { p: 0, value: 1 },
    { p: 0.5, value: 3 },
    { p: 0.99, value: 5 },
  ]);
});

test("quantiles drop non-finite values rather than sorting them into the middle", () => {
  assert.deepEqual(quantiles([1, NaN, 3, Infinity, 2], [0.5]), [{ p: 0.5, value: 2 }]);
});

test("quantiles of nothing are NaN, not zero", () => {
  assert.deepEqual(quantiles([], [0.5]), [{ p: 0.5, value: NaN }]);
  assert.ok(Number.isNaN(quantiles([NaN], [0.5])[0]!.value));
});

test("quantiles do not mutate the caller's array", () => {
  const input = [3, 1, 2];
  quantiles(input, [0.5]);
  assert.deepEqual(input, [3, 1, 2]);
});

// ------------------------------------------- the matcher option is real

test("the matcher drops a spiked fix only when the filter is switched on", async () => {
  const { matchSamplesToSegments } = await import("./segmentMatcher.js");
  // A straight run east along one segment, with fix 2 thrown 18m north. The
  // segment is 200m of due-east road, so the spike is still inside the 25m
  // corridor and the 30m accuracy filter admits it: nothing today stops it.
  const segment = {
    id: 1,
    osmWayId: "w1",
    kind: "road",
    streetName: "Test Street",
    startNodeId: "n1",
    endNodeId: "n2",
    pieceIndex: 0,
    bearingDeg: 90,
    lengthM: 200,
    geom: {
      type: "LineString" as const,
      coordinates: [
        [-104.82, LAT],
        [-104.82 + 200 / (M_PER_DEG * COS_LAT), LAT],
      ],
    },
  } as unknown as Parameters<typeof matchSamplesToSegments>[1][number];

  const samples = [0, 1, 2, 3, 4].map((i) =>
    at(i * 20, i === 2 ? 18 : 0, i, { headingDeg: 90 }),
  );

  const off = matchSamplesToSegments(samples, [segment]);
  const on = matchSamplesToSegments(samples, [segment], {
    positionFilter: { minCrossM: 8, crossToChord: 0.3 },
  });

  const ids = (runs: ReturnType<typeof matchSamplesToSegments>) =>
    runs.flatMap((r) => r.samples.map((s) => s.id));
  assert.deepEqual(ids(off), [0, 1, 2, 3, 4], "shipped behaviour keeps every fix");
  assert.deepEqual(ids(on), [0, 1, 3, 4], "fix 2 is the spike and only it is dropped");
});

test("CONTROL: the default and an explicit null both keep every fix", async () => {
  const { matchSamplesToSegments } = await import("./segmentMatcher.js");
  const segment = {
    id: 1, osmWayId: "w1", kind: "road", streetName: "Test Street",
    startNodeId: "n1", endNodeId: "n2", pieceIndex: 0, bearingDeg: 90, lengthM: 200,
    geom: {
      type: "LineString" as const,
      coordinates: [[-104.82, LAT], [-104.82 + 200 / (M_PER_DEG * COS_LAT), LAT]],
    },
  } as unknown as Parameters<typeof matchSamplesToSegments>[1][number];
  const samples = [0, 1, 2, 3, 4].map((i) => at(i * 20, i === 2 ? 18 : 0, i, { headingDeg: 90 }));

  // If the default ever flips, every bucket on the map changes without the
  // option being passed anywhere. This is the test that would catch it.
  const byDefault = matchSamplesToSegments(samples, [segment]);
  const byNull = matchSamplesToSegments(samples, [segment], { positionFilter: null });
  const count = (runs: ReturnType<typeof matchSamplesToSegments>) =>
    runs.reduce((n, r) => n + r.samples.length, 0);
  assert.equal(count(byDefault), 5);
  assert.equal(count(byNull), 5);
});

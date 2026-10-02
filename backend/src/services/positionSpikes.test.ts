import { test } from "node:test";
import assert from "node:assert/strict";
import {
  measurePositionSpikes,
  isSpike,
  quantiles,
  rejectImpossibleSpeeds,
  MAX_PLAUSIBLE_MPS,
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

// -------------------------------------------- rejectImpossibleSpeeds

// The one that goes into the data path. If it rejects too eagerly it deletes
// real riding from the only durable record there is; if the both-directions
// rule is wrong it eats the whole stretch after a spike rather than the spike.

test("MAX_PLAUSIBLE_MPS sits above every speed this device has reported", () => {
  // 20 m/s = 72 km/h. The archive's device-reported maximum is 17.3 m/s
  // (62.4 km/h) over 30,342 fixes, with zero above 20. That headroom is the
  // reason the limit cannot reject real riding, so it is asserted rather than
  // left as a comment.
  assert.equal(MAX_PLAUSIBLE_MPS, 20);
  assert.ok(MAX_PLAUSIBLE_MPS > 17.3, "must clear the fastest fix in the archive");
});

test("ordinary riding is untouched", () => {
  // 20m per second is 72 km/h -- right at the limit but not over it.
  const ride = [0, 1, 2, 3, 4, 5].map((i) => at(i * 10, 0, i));
  const { kept, rejected } = rejectImpossibleSpeeds(ride);
  assert.equal(rejected.length, 0);
  assert.equal(kept.length, ride.length);
});

test("THE CASE THIS EXISTS FOR: a 352 km/h jump out and back", () => {
  // Fix 2 is thrown 100m sideways and returns: 100 m/s in, 100 m/s out.
  const ride = [at(0, 0, 0), at(10, 0, 1), at(20, 100, 2), at(30, 0, 3), at(40, 0, 4)];
  const { kept, rejected } = rejectImpossibleSpeeds(ride);
  assert.deepEqual(rejected.map((s) => s.id), [2]);
  assert.deepEqual(kept.map((s) => s.id), [0, 1, 3, 4]);
});

test("BOTH DIRECTIONS: a good fix after a spike is kept, not eaten", () => {
  // The failure mode a backward-only test has. The opening fix is 1km out, so
  // every later fix is impossible to REACH from it -- but each is perfectly
  // ordinary to LEAVE. Backward-only would reject fix after fix until enough
  // time had passed to make 1km plausible, taking ~50 fixes with it.
  const ride = [at(0, 1000, 0), ...[1, 2, 3, 4, 5].map((i) => at(i * 10, 0, i))];
  const { kept, rejected } = rejectImpossibleSpeeds(ride);
  assert.equal(rejected.length, 0, "the ride survives one bad opening fix");
  assert.equal(kept.length, ride.length);
});

test("the backward reference is the last fix KEPT, so a burst cannot drag it", () => {
  // Three consecutive spikes. Measured against raw neighbours each one would
  // look plausible relative to the last spike; against the last KEPT fix they
  // are all impossible.
  const ride = [
    at(0, 0, 0),
    at(5, 300, 1), at(10, 600, 2), at(15, 300, 3),
    at(20, 0, 4), at(30, 0, 5),
  ];
  const { rejected } = rejectImpossibleSpeeds(ride);
  assert.deepEqual(rejected.map((s) => s.id), [1, 2, 3]);
});

test("the first and last fix are always kept", () => {
  // Neither has the pair of neighbours the test needs, and a ride's endpoints
  // are where a rider is most likely genuinely stopped.
  const ride = [at(0, 5000, 0), at(10, 0, 1), at(20, 0, 2), at(30, 5000, 3)];
  const { kept } = rejectImpossibleSpeeds(ride);
  assert.ok(kept.some((s) => s.id === 0), "first kept");
  assert.ok(kept.some((s) => s.id === 3), "last kept");
});

test("BOUNDARY: the limit bites, and either side of it behaves", () => {
  // Deliberately NOT exactly 20 m/s. These fixtures build a position from a
  // metre offset and the check converts it back, and the round trip lands a
  // hair either side of the threshold -- an exact-boundary fixture here passes
  // or fails on the last bit of a double, which tests the floating point and
  // not the rule. 18 and 22 are unambiguous.
  const under = [at(0, 0, 0), at(0, 18, 1), at(0, 36, 2), at(0, 54, 3)];
  assert.equal(rejectImpossibleSpeeds(under).rejected.length, 0, "18 m/s is riding");
  const over = [at(0, 0, 0), at(0, 2100, 1), at(0, 0, 2), at(0, 10, 3)];
  assert.equal(rejectImpossibleSpeeds(over).rejected.length, 1, "2100 m/s is not");
});

test("the comparison is strictly greater, so the limit itself is allowed", () => {
  // Checked against the predicate's own arithmetic rather than through a
  // coordinate round trip, for the reason the test above gives.
  const ride = [at(0, 0, 0), at(0, 100, 1), at(0, 0, 2), at(0, 10, 3)];
  // The jump is ~100 m/s. At a limit of exactly 100 it must survive.
  assert.equal(rejectImpossibleSpeeds(ride, 101).rejected.length, 0, "under the limit");
  assert.equal(rejectImpossibleSpeeds(ride, 99).rejected.length, 1, "over the limit");
});

test("the limit is overridable, so a sweep runs through this code", () => {
  const ride = [at(0, 0, 0), at(10, 50, 1), at(20, 0, 2), at(30, 0, 3), at(40, 0, 4)];
  assert.equal(rejectImpossibleSpeeds(ride, 100).rejected.length, 0, "~51 m/s allowed at 100");
  assert.deepEqual(
    rejectImpossibleSpeeds(ride, 20).rejected.map((s) => s.id),
    [1],
    "and the one spike is rejected at 20",
  );
});

test("a zero or backwards time step cannot condemn a fix", () => {
  // Two fixes sharing a timestamp give an undefined speed, not an infinite
  // one. Treating that as impossible would delete every duplicate-timestamp
  // fix in the archive on no evidence at all.
  const ride = [at(0, 0, 0), at(500, 0, 0), at(20, 0, 1), at(30, 0, 2)];
  assert.equal(rejectImpossibleSpeeds(ride).rejected.length, 0);
});

test("a long gap makes a big jump plausible, which is correct", () => {
  // 1km in 10 minutes is 1.7 m/s. A dropout is not a teleport.
  const ride = [at(0, 0, 0), at(0, 1000, 600), at(0, 1010, 601), at(0, 1020, 602)];
  assert.equal(rejectImpossibleSpeeds(ride).rejected.length, 0);
});

test("degenerate inputs are returned untouched", () => {
  assert.deepEqual(rejectImpossibleSpeeds([]).kept, []);
  assert.equal(rejectImpossibleSpeeds([at(0, 0, 0)]).kept.length, 1);
  assert.equal(rejectImpossibleSpeeds([at(0, 0, 0), at(9999, 0, 1)]).kept.length, 2);
  assert.equal(rejectImpossibleSpeeds([at(0, 0, 0), at(9999, 0, 1)]).rejected.length, 0);
});

test("kept and rejected together account for every fix, in order", () => {
  const ride = [at(0, 0, 0), at(10, 400, 1), at(20, 0, 2), at(30, 0, 3), at(40, 900, 4), at(50, 0, 5)];
  const { kept, rejected } = rejectImpossibleSpeeds(ride);
  assert.equal(kept.length + rejected.length, ride.length);
  assert.deepEqual(
    [...kept, ...rejected].map((s) => s.id).sort((a, b) => a - b),
    ride.map((s) => s.id),
  );
  assert.deepEqual(kept.map((s) => s.id), [...kept].map((s) => s.id).sort((a, b) => a - b), "order preserved");
});

test("it does not mutate the samples it is given", () => {
  const ride = [at(0, 0, 0), at(10, 400, 1), at(20, 0, 2), at(30, 0, 3)];
  const before = JSON.stringify(ride);
  rejectImpossibleSpeeds(ride);
  assert.equal(JSON.stringify(ride), before);
});

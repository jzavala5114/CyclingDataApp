import { strict as assert } from "node:assert";
import { test } from "node:test";
import { rejectElevationSpikes, smoothElevations } from "./elevationSmoothing.js";
import type { SessionSample } from "../types/index.js";

// A ride as a list of heights. Position advances along a straight line so the
// spike rejector has real ground distances to divide by; the smoother itself
// only ever looks at elevationM and order.
function ride(elevations: number[], spacingM = 6.35): SessionSample[] {
  // ~6.35m is the archive's median fix spacing. Longitude degrees at 38.9N are
  // about 86,700m, which is close enough for a test that never asserts on
  // distance itself.
  const degPerM = 1 / 86_700;
  return elevations.map((elevationM, i) => ({
    id: i + 1,
    sessionId: 1,
    recordedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 2 * i)).toISOString(),
    lat: 38.9,
    lon: -104.8 + i * spacingM * degPerM,
    elevationM,
    elevationSource: "barometer",
    altitudeAccuracyM: 1,
    headingDeg: 90,
    speedMps: 5,
    accuracyM: 5,
  })) as SessionSample[];
}

const heights = (samples: SessionSample[]) => samples.map((s) => s.elevationM);

test("THE REGRESSION: a steady climb comes out where it happened, not behind it", () => {
  // The bug this replaced. A causal EMA reports the height of ground it has
  // already passed, so on a constant grade every reading sits below the truth
  // by a fixed amount -- at alpha 0.3 that was 2.333 samples' worth. Here the
  // ground rises 1m per fix, so a lag of n samples shows up directly as an
  // error of n metres.
  const climb = Array.from({ length: 400 }, (_, i) => 1800 + i);
  const out = heights(smoothElevations(ride(climb)));

  // Mid-ride, clear of both ends, the filter must sit exactly on the truth.
  for (const i of [150, 200, 250]) {
    assert.ok(
      Math.abs(out[i] - climb[i]) < 0.001,
      `at ${i}: ${out[i].toFixed(3)} vs true ${climb[i]} -- lag of ${(climb[i] - out[i]).toFixed(3)} samples`,
    );
  }
});

test("THE REGRESSION: two passes at different speeds agree about the same hill", () => {
  // Why the lag mattered in practice. Fixes arrive on a fixed ~2s interval, so
  // a rider going twice as fast covers twice the ground between them. With a
  // causal filter the faster pass lags further along the road and reads a
  // different height for the same spot -- a speed-dependent error on any
  // gradient, which is indistinguishable from the barometer drifting.
  //
  // 6% grade. Slow pass: 4.77m per fix. Fast pass: 11.83m per fix (both
  // measured medians). Both cross the same 1,200m of hill.
  const grade = 0.06;
  const atDistance = (d: number) => 1800 + d * grade;
  const slow = Array.from({ length: 252 }, (_, i) => atDistance(i * 4.77));
  const fast = Array.from({ length: 102 }, (_, i) => atDistance(i * 11.83));

  const slowOut = heights(smoothElevations(ride(slow, 4.77)));
  const fastOut = heights(smoothElevations(ride(fast, 11.83)));

  // Compare the two at the same place on the ground, mid-hill and clear of the
  // ends: slow fix 150 is at 715.5m, fast fix 60 is at 709.8m. Correct for the
  // 5.7m of real ground between them and nothing should be left.
  const slowAt = slowOut[150];
  const fastAt = fastOut[60] + (150 * 4.77 - 60 * 11.83) * grade;
  assert.ok(
    Math.abs(slowAt - fastAt) < 0.05,
    `same ground, different speeds: ${slowAt.toFixed(3)} vs ${fastAt.toFixed(3)} ` +
      `-- ${Math.abs(slowAt - fastAt).toFixed(3)}m of speed-dependent error`,
  );
});

test("it damps noise as hard as the filter it replaced", () => {
  // The other half of the trade. Removing the lag by smoothing twice would be
  // a silent downgrade in a different direction -- flattening short real
  // features -- so the coefficient was re-tuned to hold noise damping where it
  // was. Anyone changing EMA_ALPHA without redoing that arithmetic fails here.
  let seed = 4242;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32 - 0.5;
  };
  const noise = Array.from({ length: 20000 }, () => rand());
  const out = heights(smoothElevations(ride(noise.map((n) => 1800 + n))));

  const variance = (xs: number[]) => {
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    return xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  };
  // Trim the ends, where the filter is still filling up.
  const gain = variance(out.slice(500, -500)) / variance(noise.slice(500, -500));
  // The causal EMA at alpha 0.3 had noise gain alpha/(2-alpha) = 0.1765.
  assert.ok(
    Math.abs(gain - 0.1765) < 0.015,
    `noise gain ${gain.toFixed(4)}, expected ~0.1765 to match the old filter`,
  );
});

test("flat ground stays flat and keeps its level", () => {
  // Guards against a filter that leaks gain: a constant in must be the same
  // constant out, at both ends as well as the middle.
  const out = heights(smoothElevations(ride(Array(200).fill(1863.5))));
  for (const value of out) assert.ok(Math.abs(value - 1863.5) < 1e-9, `drifted to ${value}`);
});

test("the filter is symmetric end to end, including the first and last fixes", () => {
  // The property that IS zero lag: the result cannot depend on which end you
  // started from. A causal filter fails this outright.
  //
  // It also pins the edge padding. Without it the two passes start from
  // different kinds of value — the forward from a raw reading, the backward
  // from a filtered one — and the ends came out by as much as a metre while
  // the middle looked perfect. Asserting across the WHOLE array, short enough
  // that every index is an edge, is what catches that.
  // A ride's length, not a toy one: the run-up is capped at the length of the
  // series it reflects, so a 12-sample array cannot have the full 24 samples of
  // it and sits at ~5e-4 rather than ~1e-7. Real rides run to hundreds of
  // fixes, which is the case worth pinning.
  const profile = Array.from(
    { length: 200 },
    (_, i) => 1800 + 12 * Math.sin(i / 7) + 4 * Math.sin(i / 2.3),
  );
  const forward = heights(smoothElevations(ride(profile)));
  const backward = heights(smoothElevations(ride([...profile].reverse())));
  backward.reverse();
  for (let i = 0; i < profile.length; i++) {
    assert.ok(
      Math.abs(forward[i] - backward[i]) < 1e-6,
      `at ${i}: ${forward[i].toFixed(8)} vs ${backward[i].toFixed(8)}`,
    );
  }

  // A short ride still has to be handled sanely, just with a run-up limited by
  // its own length. Stated as a real bound rather than left unasserted.
  const short = [1800, 1802, 1809, 1811, 1808, 1804, 1805, 1812, 1818, 1815, 1810, 1806];
  const shortFwd = heights(smoothElevations(ride(short)));
  const shortBack = heights(smoothElevations(ride([...short].reverse()))).reverse();
  for (let i = 0; i < short.length; i++) {
    assert.ok(
      Math.abs(shortFwd[i] - shortBack[i]) < 1e-3,
      `short ride at ${i}: ${shortFwd[i].toFixed(6)} vs ${shortBack[i].toFixed(6)}`,
    );
  }
});

test("a ride that starts mid-slope is not flattened at its first fixes", () => {
  // Why the padding reflects about the endpoint value rather than mirroring.
  // A plain mirror turns the series around at the boundary, which reads as
  // flat ground and drags the opening fixes towards level — and pushing off
  // down a hill is an ordinary way to start a ride.
  const descent = Array.from({ length: 120 }, (_, i) => 1900 - i * 0.5);
  const out = heights(smoothElevations(ride(descent)));
  for (const i of [0, 1, 2, 5, 119]) {
    assert.ok(
      Math.abs(out[i] - descent[i]) < 0.01,
      `at ${i}: ${out[i].toFixed(3)} vs true ${descent[i]} on a constant slope`,
    );
  }
});

test("a peak stays where it is and is not shifted downhill", () => {
  // A hilltop is the case where a lag is most visible: the causal filter moved
  // the summit along the direction of travel. The smoothed maximum must land
  // on the same fix as the real one.
  const profile = Array.from({ length: 201 }, (_, i) => 1800 + 60 * Math.exp(-(((i - 100) / 25) ** 2)));
  const out = heights(smoothElevations(ride(profile)));
  const peakAt = out.indexOf(Math.max(...out));
  assert.equal(peakAt, 100, `peak moved to ${peakAt}`);
});

test("it preserves the order and identity of the samples", () => {
  const input = ride([1800, 1801, 1802, 1803]);
  const out = smoothElevations(input);
  assert.deepEqual(out.map((s) => s.id), [1, 2, 3, 4]);
  assert.deepEqual(out.map((s) => s.recordedAt), input.map((s) => s.recordedAt));
  // And does not mutate what it was handed.
  assert.deepEqual(heights(input), [1800, 1801, 1802, 1803]);
});

test("degenerate inputs do not throw", () => {
  assert.deepEqual(smoothElevations([]), []);
  assert.equal(heights(smoothElevations(ride([1800])))[0], 1800);
  const two = heights(smoothElevations(ride([1800, 1810])));
  assert.ok(two[0] > 1800 && two[0] < 1810 && two[1] > 1800 && two[1] < 1810);
});

test("rejectElevationSpikes drops a big spike — and the good fix before it", () => {
  // The archive's own example: a ~13m jump across a couple of metres of ground.
  // Covered here because spike rejection runs immediately before the smoother
  // and the two are read together.
  //
  // **This documents a defect rather than endorsing it.** The spike is caught,
  // but so is its innocent predecessor. Each fix is judged against the straight
  // line between the last fix KEPT and the next RAW sample — and when the next
  // raw sample is the spike, that line is nonsense, so the good fix before a
  // spike is condemned by it. The guard against consecutive spikes was applied
  // to the earlier side only.
  //
  // Cost is one real fix per large spike (117 spikes across the archive at last
  // count), which is why it is recorded and not quietly fixed here: repairing
  // it changes which fixes survive on every ride, so it needs its own
  // before/after measurement rather than a free ride on this branch.
  const { kept, rejected } = rejectElevationSpikes(ride([1971.0, 1971.4, 1984.1, 1971.8, 1972.1], 2.2));
  assert.deepEqual(heights(rejected), [1971.4, 1984.1]);
  assert.deepEqual(heights(kept), [1971.0, 1971.8, 1972.1]);

  // A spike small enough that the line to it stays plausible takes only itself,
  // which is the intended behaviour and shows the cause is the `after` side.
  const milder = rejectElevationSpikes(ride([1971.0, 1971.4, 1976.0, 1971.8, 1972.1], 2.2));
  assert.deepEqual(heights(milder.rejected), [1976.0]);
});

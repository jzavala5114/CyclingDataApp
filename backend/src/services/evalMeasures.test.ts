import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  MIN_REVISIT_GAP_S,
  crossRideDisagreements,
  selfDisagreements,
  summarise,
  terrainDisagreements,
  type Observation,
  type Observations,
} from "./evalMeasures.js";

// Gate tests for the three quality measures.
//
// These were written when the measures drove a before/after verdict on the
// sliding drift anchor, and most of that suite tested the comparison machinery
// -- the gates, the pairing, the untouched-bucket proof -- which went when the
// anchor did. What remains are the measures themselves, which were never about
// the anchor: they measure the model, and the model is still here.
//
// Several of these pin defects a cold review found in the measures. Those are
// kept verbatim in substance, because the defect classes outlive the feature
// that surfaced them.

const MIN = 60_000;

function observations(entries: Record<string, Observation[]>): Observations {
  return new Map(Object.entries(entries));
}

function obs(sessionId: number, atMs: number, elevationM: number, demM: number | null = null) {
  return { sessionId, atMs, elevationM, demM };
}

// ---------------------------------------------------------------------------
// summarise
// ---------------------------------------------------------------------------

test("summarise's quantiles are the ones it names", () => {
  // Twenty values, not ten: on ten, `at(0.9)` and `at(0.95)` both land on index
  // 9, so a p90 reported as p95 would be indistinguishable. An earlier version
  // of this test used ten and a mutant survived it.
  const s = summarise(Array.from({ length: 20 }, (_, i) => i));
  assert.equal(s.median, 10, "at(0.5) on twenty values");
  assert.equal(s.p90, 18, "and NOT 19, which is where p95 lands");
  assert.equal(s.worst, 19);
  assert.equal(s.mean, 9.5);
});

test("summarise keeps non-finite values out of its statistics and counts them", () => {
  // A mean over a set containing NaN is NaN, and every comparison against NaN
  // is false, so a NaN silently switches off any threshold it meets rather than
  // tripping it. Counted separately so it can be reported instead of vanishing.
  const s = summarise([1, 2, 3, NaN, Infinity]);
  assert.equal(s.n, 5);
  assert.equal(s.nonFinite, 2);
  assert.equal(s.median, 2);
  assert.equal(s.mean, 2);
});

test("summarise on an empty set is NaN rather than zero, and n says so", () => {
  // Zero would read as "perfect agreement" on a measure that measured nothing.
  const s = summarise([]);
  assert.equal(s.n, 0);
  assert.ok(Number.isNaN(s.median) && Number.isNaN(s.mean));
});

// ---------------------------------------------------------------------------
// self-consistency
// ---------------------------------------------------------------------------

test("BOUNDARY: a revisit is five minutes apart, and it bites", () => {
  // **This constant moved twice and the second move was a reversal.** It was
  // 300s on a barometer argument, raised to 1800s to match the drift fit's own
  // window, and returned to 300s when that fit was deleted -- there is nothing
  // left to align with, and a five-minute gap is a real revisit for the question
  // this measure asks.
  assert.equal(MIN_REVISIT_GAP_S, 300);
  const under = observations({ k: [obs(1, 0, 10), obs(1, 4 * MIN, 12)] });
  const over = observations({ k: [obs(1, 0, 10), obs(1, 5 * MIN, 12)] });
  assert.equal(selfDisagreements(under).size, 0);
  assert.equal(selfDisagreements(over).get("k|1"), 2);
});

test("self-consistency compares the first pass against the LAST, not the second", () => {
  // A ride passing a bucket three times has two increments, and the measure is
  // the ride's disagreement with itself across the whole ride. With passes at
  // 10, 12 and 20 that is 10, not 2.
  const three = observations({
    k: [obs(1, 0, 10), obs(1, 10 * MIN, 12), obs(1, 20 * MIN, 20)],
  });
  assert.equal(selfDisagreements(three).get("k|1"), 10);
});

test("self-consistency is keyed per ride, so two rides revisiting one bucket are two readings", () => {
  // The unit is one ride's disagreement with itself at one place. Collapsing
  // two rides into one reading would average away the thing being measured.
  const data = observations({
    k: [
      obs(1, 0, 10), obs(1, 10 * MIN, 13),
      obs(2, 0, 50), obs(2, 10 * MIN, 58),
    ],
  });
  const scored = selfDisagreements(data);
  assert.deepEqual([...scored.keys()].sort(), ["k|1", "k|2"]);
  assert.equal(scored.get("k|1"), 3);
  assert.equal(scored.get("k|2"), 8);
});

test("one pass over a bucket is not a revisit", () => {
  assert.equal(selfDisagreements(observations({ k: [obs(1, 0, 10)] })).size, 0);
});

test("a ride that drifts DOWN disagrees with itself just as much as one that drifts up", () => {
  // Every other fixture in this file rises, so dropping the `Math.abs` left the
  // suite green while the measure started reporting negative disagreements --
  // which drag the median and the mean down and stop `worst` being the worst. A
  // barometer falling over a ride is exactly as common as one rising.
  const up = observations({ k: [obs(1, 0, 10), obs(1, 10 * MIN, 12)] });
  const down = observations({ k: [obs(1, 0, 12), obs(1, 10 * MIN, 10)] });
  assert.equal(selfDisagreements(up).get("k|1"), 2);
  assert.equal(selfDisagreements(down).get("k|1"), 2, "a 2m fall is a 2m disagreement");
});

test("passes are ordered by time, not by the order they arrive in", () => {
  // The runs come out of the matcher in traversal order today, so every fixture
  // here happened to be ascending and removing the sort left the suite green.
  // Out of order, the unsorted version computes a NEGATIVE gap, fails the
  // revisit threshold, and silently drops the comparison -- the measure loses
  // data rather than reporting a wrong number, which is the harder failure to
  // notice.
  //
  // `sessionProcessor.test.ts` covered exactly this ("the earlier pass is the
  // early one, whatever order the runs arrive in") and was deleted with the
  // ramp. This is that coverage, moved to where the behaviour now lives.
  const shuffled = observations({
    k: [obs(1, 20 * MIN, 30), obs(1, 0, 10), obs(1, 10 * MIN, 20)],
  });
  assert.equal(selfDisagreements(shuffled).get("k|1"), 20, "first 10 against last 30");
});

// ---------------------------------------------------------------------------
// cross-ride
// ---------------------------------------------------------------------------

test("a ride moving between two others must move the cross-ride measure", () => {
  // `max - min` between per-ride means does not move when a NON-EXTREME
  // contributor moves. A review shifted a bracketed ride 5m at every bucket and
  // the measure reported 20.00m before and after. What the map draws is a
  // running mean, which moves whenever any contributor moves, so the spread
  // about that mean is the honest statistic.
  const before = observations({ k: [obs(1, 0, 20), obs(2, 0, 10), obs(3, 0, 30)] });
  const after = observations({ k: [obs(1, 0, 25), obs(2, 0, 10), obs(3, 0, 30)] });

  const range = (o: Observations) => {
    const v = o.get("k")!.map((x) => x.elevationM);
    return Math.max(...v) - Math.min(...v);
  };
  assert.equal(range(before), 20);
  assert.equal(range(after), 20, "the old statistic could not see this");

  assert.equal(Number(crossRideDisagreements(before).get("k")!.toFixed(4)), 6.6667);
  assert.equal(Number(crossRideDisagreements(after).get("k")!.toFixed(4)), 7.7778);
});

test("three passes of one ride get three votes, because mergeBuckets does", () => {
  // `mergeBuckets` is called once per run and increments `sample_count` by one
  // each call, so three passes get three votes in the drawn value. A measure
  // claiming to model what lands on the map has to weight the way the map does.
  const three = observations({
    k: [obs(1, 0, 10), obs(1, 1, 10), obs(1, 2, 10), obs(2, 0, 20)],
  });
  // Four votes about a mean of 12.5: |-2.5| three times and |7.5| once, over 4.
  assert.equal(Number(crossRideDisagreements(three).get("k")!.toFixed(4)), 3.75);
  // Collapsing ride 1 to a single mean of 10 would give the spread about 15,
  // which is 5. That is a number production does not draw.
  assert.notEqual(Number(crossRideDisagreements(three).get("k")!.toFixed(4)), 5);
});

test("cross-ride needs two rides, however many passes one ride made", () => {
  // The inclusion test is what keeps it a CROSS-ride measure now that every
  // pass votes. Without it, one ride passing three times would be scored here
  // as well as in self-consistency.
  const oneRide = observations({ k: [obs(1, 0, 10), obs(1, 1, 20), obs(1, 2, 30)] });
  assert.equal(crossRideDisagreements(oneRide).size, 0);
});

test("cross-ride is translation invariant, which is a known blind spot not a bug", () => {
  // Mean absolute deviation does not move when every contributor moves by the
  // same amount -- which is exactly when the drawn value moves most. Pinned
  // rather than fixed: setting a ride's level is the anchor's job, and a
  // disagreement measure should not punish it.
  //
  // What this records is that NO measure in this file sees a uniform level
  // change. If the level ever becomes the question it needs a fourth measure,
  // not an edit to this one, which would stop answering what it is named for.
  const before = observations({ k: [obs(1, 0, 10), obs(2, 0, 20), obs(2, 1, 30)] });
  const after = observations({ k: [obs(1, 0, 25), obs(2, 0, 35), obs(2, 1, 45)] });
  const drawn = (o: Observations) => {
    const v = o.get("k")!.map((x) => x.elevationM);
    return v.reduce((a, b) => a + b, 0) / v.length;
  };
  assert.equal(drawn(after) - drawn(before), 15, "the drawn value moved 15m");
  assert.equal(
    crossRideDisagreements(before).get("k"),
    crossRideDisagreements(after).get("k"),
    "and the measure does not move -- by construction, not by accident",
  );
});

// ---------------------------------------------------------------------------
// terrain shape
// ---------------------------------------------------------------------------

test("THE REGRESSION: terrain does not anchor a ride the anchor refused", () => {
  // This measure used to remove each ride's own median residual before scoring,
  // on the grounds that the level is the anchor's job and only the shape should
  // be judged. For an ANCHORED ride that step does nothing -- the caller has
  // already subtracted the anchor, so the residuals are centred on zero and
  // their median is zero.
  //
  // The rides it did affect were the ones `fitAnchor` REFUSED. A ride 80m off
  // the terrain is past MAX_PLAUSIBLE_OFFSET_M, so production merges it
  // unanchored and the map draws it 80m out -- and this measure anchored it
  // anyway, with the very offset the guard exists to reject, and reported
  // 1.00m. The one measure with an external referent was blind to exactly the
  // failure the external referent was brought in for.
  const eightyOut = observations(
    Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`k${i}`, [obs(1, i * 1000, 1880 + (i % 3) - 1, 1800)]]),
    ),
  );
  const scored = [...terrainDisagreements(eightyOut).values()].sort((a, b) => a - b);
  const median = scored[Math.floor(scored.length / 2)];
  assert.ok(median > 75, `an 80m-off ride must read as 80m-off, read ${median}`);
});

test("terrain measures the model as stored, so an anchored ride scores its shape", () => {
  // The caller subtracts production's anchor before these arrive, so for an
  // anchored ride the residuals are already centred and what is left is shape.
  const flat = observations({
    a: [obs(1, 0, 10, 10)],
    b: [obs(1, 1, 10, 10)],
    c: [obs(1, 2, 10, 10)],
  });
  const tilted = observations({
    a: [obs(1, 0, 5, 10)],
    b: [obs(1, 1, 10, 10)],
    c: [obs(1, 2, 15, 10)],
  });
  assert.deepEqual([...terrainDisagreements(flat).values()], [0, 0, 0]);
  assert.deepEqual([...terrainDisagreements(tilted).values()], [5, 0, 5]);
});

test("terrain skips buckets the terrain model has no value for", () => {
  // Without the null check, `elevationM - null` is `elevationM - 0`, so a
  // DEM-less bucket scores as a raw elevation -- around 1800 in this archive.
  const data = observations({
    a: [obs(1, 0, 1810, 1800)],
    b: [obs(1, 1, 1805, null)],
  });
  const out = terrainDisagreements(data);
  assert.equal(out.size, 1);
  assert.ok([...out.keys()][0].startsWith("a|"));
});

test("terrain keys each reading by bucket, ride and moment", () => {
  // Two rides over one bucket are two readings, and one ride's two passes over
  // it are two more. Dropping any part of the key collapses them and silently
  // discards all but the last.
  const data = observations({
    a: [obs(1, 0, 12, 10), obs(1, 99, 15, 10), obs(2, 0, 7, 10)],
  });
  const out = terrainDisagreements(data);
  assert.equal(out.size, 3);
  assert.equal(out.get("a|1|0"), 2);
  assert.equal(out.get("a|1|99"), 5);
  assert.equal(out.get("a|2|0"), 3);
});

import * as turf from "@turf/turf";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyLoss,
  traceSession,
  NEXT_DOOR_SHARE,
  type LossEvidence,
} from "./traceOutAndBack.js";
import { MAX_ACCURACY_M } from "../services/segmentMatcher.js";
import type { Segment, SessionSample } from "../types/index.js";

// The pass ledger decides which matcher defect is worth fixing, so a wrong
// label here sends work at the wrong thing. It did exactly that: `gate` was
// tried before the next-door share, fired on the existence of a 1-fix run, and
// filed 605m of ground that IS drawn on the neighbouring segment as a
// traversal-gate rejection -- which became a standing proposal to lower the
// gate. These are the script's first tests; the ordering is what they guard.

// -- classifyLoss -------------------------------------------------------------

/** Evidence for a pass with nothing wrong and nothing to explain it. */
const evidence = (over: Partial<LossEvidence> = {}): LossEvidence => ({
  right: [],
  opposite: [],
  fixesInPass: 10,
  fixesUnavailable: 0,
  fixesDrawnElsewhere: 0,
  fixesInRunHere: 0,
  fixesOnSameWay: 0,
  destinations: "10x nothing",
  noHeading: 0,
  looseAccuracy: 0,
  spikes: 0,
  ...over,
});

const shortRun = { qualified: false, spanM: 6, coverage: 0.04 };

test("THE DEFECT THIS FIXED: one stray fix does not make a neighbour's ride a gate rejection", () => {
  // Gold Camp Road #13308 in session 54, the widest case: a 140m pass whose 33
  // fixes went 28-to-the-neighbour and 1-to-here, filed as `gate` because that
  // 1 fix formed a run. The gate never judged this traversal.
  const { cause, detail } = classifyLoss(
    evidence({
      right: [shortRun],
      fixesInPass: 33,
      fixesInRunHere: 1,
      fixesDrawnElsewhere: 28,
      destinations: "13x #19475 Ladders backward",
    }),
  );
  assert.equal(cause, "next-door");
  assert.match(detail, /85% of 33 fixes drawn on another segment/);
});

test("a run that holds the pass and still fails the gate IS a gate rejection", () => {
  const { cause, detail } = classifyLoss(
    evidence({
      right: [{ qualified: false, spanM: 18, coverage: 0.49 }],
      fixesInPass: 10,
      fixesInRunHere: 9,
      fixesDrawnElsewhere: 0,
    }),
  );
  assert.equal(cause, "gate");
  assert.match(detail, /span 18m \/ 49% of segment/);
});

test("the gate detail names how much of the pass the run held, so the number cannot be quoted bare", () => {
  // Every surviving gate case holds a MINORITY of its pass's fixes (the worst
  // is 2 of 18). A detail string that said only "span 6m" invited the reading
  // that 6m is all the gate was short by.
  const { detail } = classifyLoss(
    evidence({ right: [shortRun], fixesInPass: 18, fixesInRunHere: 2, fixesDrawnElsewhere: 3 }),
  );
  assert.match(detail, /holding 2\/18 of the pass's fixes/);
  assert.match(detail, /17% drawn elsewhere/);
});

test("a qualifying run the other way wins over a short run this way", () => {
  // Order matters: with `gate` first, a 1-fix forward run hid the fact that the
  // matcher had drawn this very ground backwards.
  const { cause, detail } = classifyLoss(
    evidence({
      right: [shortRun],
      opposite: [{ qualified: true, direction: "backward" }],
      fixesInRunHere: 1,
    }),
  );
  assert.equal(cause, "wrong-dir");
  assert.match(detail, /drew backward over the same ground and time/);
});

test("wrong-dir beats the next-door share too, however high the share", () => {
  // THE ONE THAT KEEPS THE WRONG-DIR BUCKET ALIVE, 1073m and the largest defect
  // class in the ledger. A wrong-dir pass's fixes ARE drawn -- on this segment,
  // backwards -- so a share high enough to trigger next-door is the normal case
  // for it, not an odd one. This ordering is what stops the whole class
  // draining into the generous bucket.
  //
  // The caller's matching `to === segmentId` exclusion is a second line for the
  // case this cannot reach: `opposite` is filtered to runs overlapping the pass,
  // while "drawn elsewhere" is not, so a qualifying backward run at a DIFFERENT
  // time leaves `opposite` empty and would otherwise read as next-door.
  const { cause } = classifyLoss(
    evidence({
      opposite: [{ qualified: true, direction: "forward" }],
      fixesInPass: 10,
      fixesDrawnElsewhere: 10,
    }),
  );
  assert.equal(cause, "wrong-dir");
});

test("a NON-qualifying run the other way is not wrong-dir: nothing was drawn", () => {
  const { cause } = classifyLoss(
    evidence({ right: [shortRun], opposite: [{ qualified: false, direction: "backward" }] }),
  );
  assert.equal(cause, "gate");
});

test("BOUNDARY: exactly NEXT_DOOR_SHARE is next-door, an acceptance bound", () => {
  const atBound = classifyLoss(
    evidence({ right: [shortRun], fixesInPass: 10, fixesDrawnElsewhere: 10 * NEXT_DOOR_SHARE }),
  );
  assert.equal(atBound.cause, "next-door");
  // One fix less and the gate is the explanation again. The two verdicts have
  // to be separable by a single fix or the threshold is doing nothing.
  const belowBound = classifyLoss(
    evidence({ right: [shortRun], fixesInPass: 10, fixesDrawnElsewhere: 10 * NEXT_DOOR_SHARE - 1 }),
  );
  assert.equal(belowBound.cause, "gate");
});

test("fixes the matcher never saw are not the gate's fault", () => {
  const { cause, detail } = classifyLoss(
    evidence({
      right: [shortRun],
      fixesInPass: 10,
      fixesUnavailable: 6,
      noHeading: 4,
      looseAccuracy: 1,
      spikes: 1,
    }),
  );
  assert.equal(cause, "dropped");
  assert.match(detail, /6\/10 fixes filtered out: 4 no heading, 1 accuracy, 1 spike/);
});

test("BOUNDARY: exactly half the fixes unavailable is not enough to blame the filters", () => {
  // `>` not `>=`: a pass split evenly still had half its fixes offered, and
  // half a pass is enough to match. Only a majority excuses the matcher.
  const { cause } = classifyLoss(
    evidence({ right: [shortRun], fixesInPass: 10, fixesUnavailable: 5 }),
  );
  assert.equal(cause, "gate");
});

test("no run, nothing drawn elsewhere: the fixes went nowhere", () => {
  const { cause, detail } = classifyLoss(evidence({ fixesInPass: 8, destinations: "8x nothing" }));
  assert.equal(cause, "no-run");
  assert.match(detail, /0% of 8 fixes drawn on another segment: 8x nothing/);
});

test("a pass with no fixes in it divides by nothing and still answers", () => {
  // Reachable: `findPasses` bounds a pass by its own in-corridor fixes while
  // the evidence counts raw samples in that window, and the two can disagree at
  // the edges. A NaN share here would silently pick a branch by accident.
  const { cause, detail } = classifyLoss(
    evidence({ fixesInPass: 0, fixesDrawnElsewhere: 0, destinations: "" }),
  );
  assert.equal(cause, "no-run");
  assert.match(detail, /0% of 0 fixes/);
  assert.doesNotMatch(detail, /NaN/);
});

test("a pass drawn mostly on another piece of the same street is flagged", () => {
  // East Fountain Boulevard `#30947` -> `#30948`, same OSM way 1540862832. The
  // rider swept 31m of a 38m piece and the map paints the piece after it. The
  // reorder above files that as `next-door`, which reads as "fine, drawn on the
  // neighbour", so without the flag the case disappears into a 379-entry bucket
  // the defect total deliberately excludes.
  const { cause, detail, sameWay } = classifyLoss(
    evidence({
      fixesInPass: 6,
      fixesDrawnElsewhere: 4,
      fixesOnSameWay: 4,
      destinations: "4x #30948 East Fountain Boulevard backward",
    }),
  );
  assert.equal(cause, "next-door");
  assert.equal(sameWay, true);
  assert.match(detail, /4\/6 on ANOTHER PIECE OF THE SAME WAY/);
});

test("THE ONE-FIX TRAP, AGAIN: a couple of boundary fixes on a sibling piece prove nothing", () => {
  // The first version of this flag used `fixesOnSameWay > 0` and fired on 202
  // passes / 11.6km. That is not a positional-error class: a long OSM way is
  // cut into pieces, and a rider crossing a piece boundary always leaves a fix
  // or two on the piece next door. It is the same one-fix threshold the `gate`
  // ordering bug above was built on, reintroduced one function later. A share
  // is the only thing that separates the two cases.
  const { sameWay, detail } = classifyLoss(
    evidence({ fixesInPass: 20, fixesDrawnElsewhere: 12, fixesOnSameWay: 2 }),
  );
  assert.equal(sameWay, false);
  assert.doesNotMatch(detail, /SAME WAY/);
});

test("BOUNDARY: the same-way flag turns on at NEXT_DOOR_SHARE, not before", () => {
  const atBound = classifyLoss(
    evidence({ fixesInPass: 10, fixesDrawnElsewhere: 10, fixesOnSameWay: 10 * NEXT_DOOR_SHARE }),
  );
  assert.equal(atBound.sameWay, true);
  const belowBound = classifyLoss(
    evidence({ fixesInPass: 10, fixesDrawnElsewhere: 10, fixesOnSameWay: 10 * NEXT_DOOR_SHARE - 1 }),
  );
  assert.equal(belowBound.sameWay, false);
});

test("a genuine neighbour is not flagged as the same way", () => {
  const { cause, detail, sameWay } = classifyLoss(
    evidence({ fixesInPass: 6, fixesDrawnElsewhere: 4, fixesOnSameWay: 0 }),
  );
  assert.equal(cause, "next-door");
  assert.equal(sameWay, false);
  assert.doesNotMatch(detail, /SAME WAY/);
});

test("the widest run is the one reported, not whichever came first", () => {
  const { detail } = classifyLoss(
    evidence({
      right: [
        { qualified: false, spanM: 4, coverage: 0.03 },
        { qualified: false, spanM: 21, coverage: 0.2 },
        { qualified: false, spanM: 11, coverage: 0.09 },
      ],
      fixesInRunHere: 7,
    }),
  );
  assert.match(detail, /span 21m/);
});

// -- traceSession, end to end -------------------------------------------------

let nextSampleId = 1;
const ride = (
  count: number,
  { headingDeg = 90, accuracyM = 5 }: { headingDeg?: number | null; accuracyM?: number } = {},
): SessionSample[] => {
  const start = turf.point([-104.82, 38.85]);
  return Array.from({ length: count }, (_, i) => {
    const [lon, lat] = turf.destination(start, i * 10, 90, { units: "meters" }).geometry
      .coordinates as [number, number];
    return {
      id: nextSampleId++,
      sessionId: 1,
      recordedAt: new Date(Date.UTC(2026, 9, 4, 12, 0, i * 2)).toISOString(),
      lat,
      lon,
      elevationM: 1800,
      elevationSource: "barometer",
      altitudeAccuracyM: 1,
      headingDeg,
      speedMps: 5,
      accuracyM,
    } as SessionSample;
  });
};

/** One straight 200m segment running due east, matching the ride above. */
const eastSegment = (): Segment => {
  const a: [number, number] = [-104.82, 38.85];
  const b = turf.destination(turf.point(a), 200, 90, { units: "meters" }).geometry.coordinates as [
    number,
    number,
  ];
  return {
    id: 500,
    osmWayId: 9000,
    kind: "cycleway",
    streetName: "Test Trail",
    startNodeId: 1,
    endNodeId: 2,
    pieceIndex: 0,
    lengthM: 200,
    bearingDeg: 90,
    geom: { type: "LineString", coordinates: [a, b] },
  } as Segment;
};

test("a clean one-way traversal is drawn and produces no loss at all", () => {
  // The plumbing test. Projection, run building, the gate and the witness all
  // have to agree on the easy case, or every verdict downstream is noise.
  const t = traceSession(1, ride(21), [eastSegment()], { keepOneWay: true });
  assert.deepEqual(t.losses, []);
  assert.equal(t.merged, 1);
  assert.equal(t.discarded, 0);
  assert.ok(t.drawn.has("500|forward"), [...t.drawn].join(","));
  assert.equal(t.onePassSegments, 1);
  assert.equal(t.bothWays, 0);
  assert.equal(t.passes.length, 1);
  assert.equal(t.passes[0]!.direction, "forward");
});

test("a ride reporting no device heading is still matched: headings are derived from movement", () => {
  // Written expecting the opposite, and the code was right. `deriveHeadings`
  // takes the bearing between consecutive fixes past MIN_DERIVE_M = 6m of
  // motion, so a phone that reports no compass heading loses nothing on a ride
  // at speed. Kept as a test because the `dropped` cause counts missing
  // headings as fixes "the matcher never saw", which is true of the DEVICE
  // heading and not of the matcher's input.
  const t = traceSession(1, ride(21, { headingDeg: null }), [eastSegment()], { keepOneWay: true });
  assert.equal(t.merged, 1);
  assert.ok(t.drawn.has("500|forward"));
  assert.deepEqual(t.losses, []);
});

test("THE DOCUMENTED BLIND SPOT: a segment the matcher never touched reports nothing", () => {
  // Every fix is past MAX_ACCURACY_M, so the matcher makes no run, so the
  // segment is never projected and the rider's traversal is invisible here --
  // not a `no-run` loss, no loss at all. This is the limit printed at the end
  // of the report, asserted so it stays true rather than being rediscovered.
  const t = traceSession(1, ride(21, { accuracyM: MAX_ACCURACY_M + 1 }), [eastSegment()], {
    keepOneWay: true,
  });
  assert.equal(t.merged, 0);
  assert.equal(t.passes.length, 0);
  assert.deepEqual(t.losses, []);
});

test("a ride with no samples is an empty trace, not a crash", () => {
  const t = traceSession(1, [], [eastSegment()], { keepOneWay: true });
  assert.deepEqual(t.losses, []);
  assert.equal(t.coveredM, 0);
  assert.equal(t.buckets, 0);
});

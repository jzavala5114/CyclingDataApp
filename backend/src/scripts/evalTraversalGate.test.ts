import { test } from "node:test";
import assert from "node:assert/strict";
import {
  admittedRuns,
  judgeAdmitted,
  parseGates,
  gateLabel,
  NEAR_FLOOR_M,
} from "./evalTraversalGate.js";
import { SHIPPED_GATE } from "../services/elevationAggregator.js";
import type { DrawnRun, PassRecord } from "./traceOutAndBack.js";

const run = (over: Partial<DrawnRun> = {}): DrawnRun => ({
  sessionId: 1,
  segmentId: 100,
  direction: "forward",
  spanM: 20,
  coverage: 0.2,
  buckets: 2,
  coveredM: 20,
  startedMs: 10_000,
  endedMs: 20_000,
  ...over,
});

const pass = (over: Partial<PassRecord> = {}): PassRecord => ({
  sessionId: 1,
  segmentId: 100,
  direction: "forward",
  spanM: 18,
  fixes: 6,
  startedMs: 12_000,
  endedMs: 18_000,
  ...over,
});

test("the shipped gate always leads the sweep, once, because every arm is read against it", () => {
  const gates = parseGates("18/0.7,25/0.7,22/0.5");
  assert.deepEqual(gates.map(gateLabel), [gateLabel(SHIPPED_GATE), "18/0.7", "22/0.5"]);
  assert.equal(parseGates(undefined)[0], SHIPPED_GATE);
});

test("a malformed gate is refused rather than read as some other threshold", () => {
  // Number("") is 0: "18/" would otherwise sweep a gate that admits everything.
  for (const bad of ["18", "18/", "/0.7", "18/0.7/1", "a/0.7", "18/1.5", "-1/0.7", ""]) {
    assert.throws(() => parseGates(bad), /span\/cover/, bad);
  }
});

test("an admitted run is one the arm draws and the shipped gate does not, by exact identity", () => {
  const kept = run();
  const fresh = run({ segmentId: 200 });
  const later = run({ startedMs: 30_000, endedMs: 40_000 }); // same line, another visit
  assert.deepEqual(admittedRuns([kept], [kept, fresh, later]), [fresh, later]);
  assert.deepEqual(admittedRuns([kept, fresh], [kept, fresh]), []);
});

test("a pass overlapping the run, same segment and way, witnesses it", () => {
  assert.equal(judgeAdmitted(run(), [pass()], 15), "witnessed");
  // Touching at one instant is still overlap: a fix shared at the boundary.
  assert.equal(judgeAdmitted(run(), [pass({ startedMs: 20_000, endedMs: 25_000 })], 15), "witnessed");
});

test("a pass the other way, on another segment, in another ride, or at another time is no witness", () => {
  for (const other of [
    pass({ direction: "backward" }),
    pass({ segmentId: 101 }),
    pass({ sessionId: 2 }),
    pass({ startedMs: 21_000, endedMs: 30_000 }),
  ]) {
    assert.equal(judgeAdmitted(run({ spanM: 30 }), [other], 15), "denied", JSON.stringify(other));
  }
});

test("BOUNDARY: silence denies only a run that spans the floor", () => {
  // The witness cannot report a pass shorter than its floor, so a shorter run's
  // silence is not evidence. At the floor exactly, a pass could have been found.
  assert.equal(judgeAdmitted(run({ spanM: 14.99 }), [], 15), "unjudgeable");
  assert.equal(judgeAdmitted(run({ spanM: 15 }), [], 15), "denied");
  // A witnessed run is witnessed however short: the pass is the evidence.
  assert.equal(judgeAdmitted(run({ spanM: 6 }), [pass()], 15), "witnessed");
  assert.ok(NEAR_FLOOR_M > 0);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  verdictFor,
  runFateVerdict,
  fateOf,
  evidenceFor,
  witnessDisagreements,
  byVerdict,
  siblingKey,
  sensitivity,
  type LineEvidence,
  type PassFate,
  type SessionBuf,
} from "./enumerateHeadingLines.js";
import { NEXT_DOOR_SHARE, type DrawnRun, type PassRecord } from "./traceOutAndBack.js";
import { MIN_PASS_M } from "../services/segmentPasses.js";

// This file decides whether a heading change ships.
//
// The script it tests answers one question: of the 36 drawn lines the derived
// heading removes, which were lines the rider never rode? Get the rule wrong in
// the generous direction and a real regression ships as "consolidation"; get it
// wrong in the strict direction and a correct fix is rejected for a cost it
// does not have. Neither error is visible in the output, which is a page of
// plausible-looking street names either way.
//
// The four that matter most:
//   - `every` vs `some` in verdictFor: one pass drawn nowhere is a real loss.
//   - the MIN_PASS_M floor: silence from a witness that could not have spoken
//     is not evidence. The first run of this script got this wrong and called
//     13 sub-25m stubs phantoms, inflating the change's credit by half.
//   - the selfKey exclusion in fateOf: without it every line is next-door.
//   - the shared-segment filter in witnessDisagreements: without it, a segment
//     only one arm touched reads as the witness disagreeing with itself.

const pass = (over: Partial<PassRecord> = {}): PassRecord => ({
  sessionId: 1,
  segmentId: 100,
  direction: "forward",
  spanM: 80,
  fixes: 9,
  startedMs: 1_000,
  endedMs: 9_000,
  ...over,
});

const fate = (share: number): PassFate => ({ pass: pass(), fixes: 10, share, top: [] });

const evidence = (fates: PassFate[], over: Partial<LineEvidence> = {}): LineEvidence => ({
  key: "100|forward",
  sessions: [1],
  coveredM: 120,
  lengthM: 200, // long enough to witness, unless a test says otherwise
  fates,
  runFates: [],
  ...over,
});

const run = (over: Partial<DrawnRun> = {}): DrawnRun => ({
  sessionId: 1,
  segmentId: 100,
  direction: "forward",
  spanM: 80,
  coverage: 0.9,
  buckets: 6,
  coveredM: 120,
  startedMs: 1_000,
  endedMs: 9_000,
  ...over,
});

// ---------------------------------------------------------------- verdictFor

test("no pass witness is a phantom: the rider never went that way", () => {
  assert.equal(verdictFor(evidence([])), "phantom");
});

test("a segment too short to witness is UNJUDGED, not a phantom", () => {
  // `findPasses` needs MIN_PASS_M of travel along the geometry, so on a 10m
  // segment every possible span is below the threshold and silence means
  // nothing. The traversal gate has a second door the detector does not
  // (coverageFraction), which is how a 10m stub gets drawn in the first place.
  // Calling these phantoms credits the heading change with removing 13 lines
  // that nothing judged -- which is what the first run of this script did.
  assert.equal(verdictFor(evidence([], { lengthM: 10 })), "no-witness");
  assert.equal(verdictFor(evidence([], { lengthM: 24 })), "no-witness");
});

test("BOUNDARY: the cutoff is MIN_PASS_M exactly", () => {
  assert.equal(MIN_PASS_M, 25);
  assert.equal(verdictFor(evidence([], { lengthM: MIN_PASS_M })), "phantom", "25m can witness");
  assert.equal(verdictFor(evidence([], { lengthM: MIN_PASS_M - 0.01 })), "no-witness");
});

test("an unknown length reads as unjudged, never as a phantom", () => {
  // The generous default would credit the change for lines it has no evidence
  // about, and the credit is invisible in the output.
  assert.equal(verdictFor(evidence([], { lengthM: 0 })), "no-witness");
});

test("a short segment WITH a pass is judged on the pass, not on its length", () => {
  // A pass can span more than one segment's length is impossible, so this
  // combination should not arise -- but if the witness did speak, it wins.
  assert.equal(verdictFor(evidence([fate(1)], { lengthM: 5 })), "next-door");
  assert.equal(verdictFor(evidence([fate(0)], { lengthM: 5 })), "real-loss");
});

test("runFateVerdict reads the run windows, and says so when there are none", () => {
  assert.equal(runFateVerdict(evidence([], { runFates: [] })), "unknown");
  assert.equal(runFateVerdict(evidence([], { runFates: [fate(1)] })), "drawn-elsewhere");
  assert.equal(runFateVerdict(evidence([], { runFates: [fate(1), fate(0)] })), "drawn-nowhere");
  assert.equal(runFateVerdict(evidence([], { runFates: [fate(0.6)] }), 0.9), "drawn-nowhere");
});

test("ONE pass drawn nowhere makes the whole line a real loss", () => {
  // `some` instead of `every` here would report this line as consolidation,
  // which is the mutation that would let a regression ship. The rider made two
  // passes; one of them is now drawn on no line at all, and that is ground the
  // map stops showing whatever happened to the other.
  assert.equal(verdictFor(evidence([fate(1.0), fate(0.0)])), "real-loss");
  assert.equal(verdictFor(evidence([fate(0.0), fate(1.0)])), "real-loss", "order cannot matter");
});

test("every pass drawn elsewhere is consolidation, not a loss", () => {
  assert.equal(verdictFor(evidence([fate(1.0), fate(0.8)])), "next-door");
});

test("BOUNDARY: exactly at the share is next-door, a hair under is a loss", () => {
  assert.equal(NEXT_DOOR_SHARE, 0.5);
  assert.equal(verdictFor(evidence([fate(0.5)])), "next-door");
  assert.equal(verdictFor(evidence([fate(0.5 - 1e-9)])), "real-loss");
});

test("the share threshold is overridable, so a sensitivity sweep runs this code", () => {
  const ev = evidence([fate(0.6)]);
  assert.equal(verdictFor(ev, 0.5), "next-door");
  assert.equal(verdictFor(ev, 0.9), "real-loss");
});

test("a verdict is one of exactly four values, and all four are reachable", () => {
  const seen = new Set(
    [
      evidence([], { lengthM: 10 }),
      evidence([]),
      evidence([fate(1)]),
      evidence([fate(0)]),
    ].map((e) => verdictFor(e)),
  );
  assert.deepEqual([...seen].sort(), ["next-door", "no-witness", "phantom", "real-loss"]);
});

// -------------------------------------------------------------------- fateOf

const times = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, atMs: 1_000 * i }));

test("only fixes inside the pass window count", () => {
  const f = fateOf(pass({ startedMs: 2_000, endedMs: 4_000 }), times(10), new Map(), "100|forward");
  assert.equal(f.fixes, 3, "2000, 3000 and 4000 inclusive");
});

test("the window is INCLUSIVE at both ends", () => {
  // The pass's own first and last fix sit exactly on the boundary, so an
  // exclusive comparison would drop the two fixes that define the pass.
  const f = fateOf(pass({ startedMs: 0, endedMs: 9_000 }), times(10), new Map(), "100|forward");
  assert.equal(f.fixes, 10);
});

test("CONTROL: a line is never counted as drawn by itself", () => {
  // If selfKey leaked through, every lost line would look fully drawn
  // elsewhere and the whole report would read "next-door". It cannot happen
  // through the script -- a lost line is by definition not drawn under the
  // other arm -- so the guard is here to keep a future caller honest.
  const drawnFix = new Map(times(10).map((t) => [t.id, "100|forward"] as const));
  const f = fateOf(pass(), times(10), drawnFix, "100|forward");
  assert.equal(f.share, 0, "drawn only by itself is drawn nowhere else");
  assert.deepEqual(f.top, [["itself", 9]]);
});

test("a fix in no qualifying run is drawn nowhere", () => {
  const f = fateOf(pass(), times(10), new Map(), "100|forward");
  assert.equal(f.share, 0);
  assert.deepEqual(f.top, [["nothing", 9]]);
});

test("the share is the fraction drawn on another line, and names it", () => {
  const drawnFix = new Map<number, string>([
    [2, "200|backward"],
    [3, "200|backward"],
    [4, "200|backward"],
    [5, "300|forward"],
  ]);
  // Window 1000..5000 is fixes with ids 2,3,4,5,6 -> 4 of 5 drawn elsewhere.
  const f = fateOf(pass({ startedMs: 1_000, endedMs: 5_000 }), times(10), drawnFix, "100|forward");
  assert.equal(f.fixes, 5);
  assert.equal(f.share, 4 / 5);
  assert.deepEqual(f.top, [
    ["200|backward", 3],
    ["300|forward", 1],
    ["nothing", 1],
  ]);
});

test("an empty window reports share 0, which reads as a loss not a pass", () => {
  // Cannot arise from the script (a pass's window is built from its own
  // fixes), but if it ever did, reporting a cost is the safe direction: a
  // silently-hidden regression is the failure this report exists to prevent.
  const f = fateOf(pass({ startedMs: 10_000, endedMs: 20_000 }), times(5), new Map(), "100|forward");
  assert.equal(f.fixes, 0);
    assert.equal(f.share, 0);
  assert.equal(verdictFor(evidence([f])), "real-loss");
});

test("top is capped at three destinations", () => {
  const drawnFix = new Map(times(10).map((t) => [t.id, `${t.id}|forward`] as const));
  assert.equal(fateOf(pass({ startedMs: 0, endedMs: 9_000 }), times(10), drawnFix, "x").top.length, 3);
});

// -------------------------------------------------------------- evidenceFor

// Every segment in these fixtures is long enough for the witness to speak, so
// a phantom verdict means "no pass was found", not "no pass was possible".
const LONG = new Map([100, 200, 300, 900].map((id) => [id, 200] as const));

const buf = (over: Partial<SessionBuf> = {}): SessionBuf => ({
  sessionId: 1,
  fixTimes: times(10),
  device: { drawn: new Set(), runs: [], passes: [], drawnFix: new Map() },
  derived: { drawn: new Set(), runs: [], passes: [], drawnFix: new Map() },
  ...over,
});

test("only lines one arm draws and the other does not are reported", () => {
  const b = buf({
    device: {
      drawn: new Set(["100|forward", "100|backward"]),
      runs: [run(), run({ direction: "backward" })],
      passes: [],
      drawnFix: new Map(),
    },
    derived: {
      drawn: new Set(["100|forward", "200|forward"]),
      runs: [run(), run({ segmentId: 200 })],
      passes: [],
      drawnFix: new Map(),
    },
  });
  assert.deepEqual([...evidenceFor([b], "device").keys()], ["100|backward"]);
  assert.deepEqual([...evidenceFor([b], "derived").keys()], ["200|forward"]);
});

test("DIRECTION is part of the identity: the same segment can lose one way", () => {
  // The out-and-back defect is exactly this shape. Comparing by segment id
  // alone would report nothing here, which is the bug this measurement is for.
  const b = buf({
    device: { drawn: new Set(["100|forward", "100|backward"]), runs: [], passes: [], drawnFix: new Map() },
    derived: { drawn: new Set(["100|forward"]), runs: [], passes: [], drawnFix: new Map() },
  });
  assert.deepEqual([...evidenceFor([b], "device").keys()], ["100|backward"]);
});

test("a line is only lost if NO session draws it under the other arm", () => {
  const drew = new Set(["100|forward"]);
  const a = buf({ sessionId: 1, device: { drawn: drew, runs: [], passes: [], drawnFix: new Map() } });
  const c = buf({
    sessionId: 2,
    device: { drawn: drew, runs: [], passes: [], drawnFix: new Map() },
    derived: { drawn: drew, runs: [], passes: [], drawnFix: new Map() },
  });
  assert.equal(evidenceFor([a], "device").size, 1, "lost when session 1 is alone");
  assert.equal(evidenceFor([a, c], "device").size, 0, "session 2 draws it, so it is not lost");
});

test("metres and sessions come only from rides where the arm drew the line", () => {
  const key = new Set(["100|forward"]);
  const a = buf({
    sessionId: 7,
    device: { drawn: key, runs: [run({ sessionId: 7, coveredM: 90 })], passes: [], drawnFix: new Map() },
  });
  // Session 8 has a run record for the same line but did not draw it (the run
  // was discarded), so neither its metres nor its id may appear.
  const c = buf({
    sessionId: 8,
    device: { drawn: new Set(), runs: [run({ sessionId: 8, coveredM: 500 })], passes: [], drawnFix: new Map() },
  });
  const ev = evidenceFor([a, c], "device").get("100|forward")!;
  assert.deepEqual(ev.sessions, [7]);
  assert.equal(ev.coveredM, 90);
});

test("metres come from the lost DIRECTION only, not the whole segment", () => {
  // An out-and-back draws the same segment twice. If the metres were summed by
  // segment id, losing one direction would be reported at the cost of both --
  // which is the number the ship-or-not decision is made on.
  const b = buf({
    device: {
      drawn: new Set(["100|forward", "100|backward"]),
      runs: [
        run({ direction: "forward", coveredM: 40 }),
        run({ direction: "backward", coveredM: 400 }),
      ],
      passes: [],
      drawnFix: new Map(),
    },
    derived: { drawn: new Set(["100|backward"]), runs: [], passes: [], drawnFix: new Map() },
  });
  const ev = evidenceFor([b], "device").get("100|forward")!;
  assert.equal(ev.coveredM, 40, "the backward run's 400m is not lost and must not be counted");
});

test("metres add up across every session that drew the line", () => {
  const key = new Set(["100|forward"]);
  const mk = (sessionId: number, coveredM: number) =>
    buf({ sessionId, device: { drawn: key, runs: [run({ sessionId, coveredM })], passes: [], drawnFix: new Map() } });
  const ev = evidenceFor([mk(1, 40), mk(2, 60)], "device").get("100|forward")!;
  assert.deepEqual(ev.sessions, [1, 2]);
  assert.equal(ev.coveredM, 100);
});

test("a caller that forgets the lengths gets unjudged lines, not phantoms", () => {
  // `evidenceFor`'s own default, exercised through `evidenceFor` rather than
  // asserted on a hand-built LineEvidence, because the default is the thing
  // under test.
  const b = buf({
    device: { drawn: new Set(["100|forward"]), runs: [run()], passes: [], drawnFix: new Map() },
  });
  assert.equal(verdictFor(evidenceFor([b], "device").get("100|forward")!), "no-witness");
  assert.equal(verdictFor(evidenceFor([b], "device", LONG).get("100|forward")!), "phantom");
});

test("the drawn run's own window is collected, so a short line has evidence", () => {
  // Without this, every sub-25m line reports "unknown" and the report says
  // nothing at all about 13 of the 36 lines.
  const b = buf({
    device: {
      drawn: new Set(["100|forward"]),
      runs: [run({ startedMs: 0, endedMs: 4_000 })],
      passes: [],
      drawnFix: new Map(),
    },
    derived: {
      drawn: new Set(),
      runs: [],
      passes: [],
      drawnFix: new Map(times(10).map((t) => [t.id, "900|forward"] as const)),
    },
  });
  const ev = evidenceFor([b], "device").get("100|forward")!;
  assert.equal(ev.runFates.length, 1, "one run drawn, one run window");
  assert.equal(ev.runFates[0]!.fixes, 5, "the run's window, not the whole ride");
  assert.equal(ev.runFates[0]!.share, 1);
  assert.equal(runFateVerdict(ev), "drawn-elsewhere");
});

test("the pass witness is taken from BOTH arms, deduplicated", () => {
  // The device arm is the only one that projected this segment when only it
  // touched it, so reading one arm's list would miss the witness. Reading both
  // without deduplicating would count the same pass twice, which changes
  // nothing for `every` but makes the printed pass count a lie.
  const p = pass();
  const b = buf({
    device: { drawn: new Set(["100|forward"]), runs: [run()], passes: [p], drawnFix: new Map() },
    derived: { drawn: new Set(), runs: [], passes: [{ ...p }], drawnFix: new Map() },
  });
  assert.equal(evidenceFor([b], "device").get("100|forward")!.fates.length, 1);
});

test("a pass on another segment or the other direction is not this line's witness", () => {
  const b = buf({
    device: {
      drawn: new Set(["100|forward"]),
      runs: [run()],
      passes: [pass({ segmentId: 200 }), pass({ direction: "backward" })],
      drawnFix: new Map(),
    },
  });
  const ev = evidenceFor([b], "device", LONG).get("100|forward")!;
  assert.equal(ev.fates.length, 0);
  assert.equal(verdictFor(ev), "phantom");
});

test("end to end: a device phantom, a consolidation and a real loss in one ride", () => {
  const b = buf({
    sessionId: 3,
    fixTimes: times(10),
    device: {
      drawn: new Set(["100|forward", "200|forward", "300|forward"]),
      runs: [
        run({ sessionId: 3, segmentId: 100, coveredM: 10 }),
        run({ sessionId: 3, segmentId: 200, coveredM: 20 }),
        run({ sessionId: 3, segmentId: 300, coveredM: 30 }),
      ],
      passes: [
        // #100 has no pass: a direction the rider never made.
        // The two real passes sit in DIFFERENT halves of the ride, so what is
        // drawn in one half cannot speak for the other.
        pass({ sessionId: 3, segmentId: 200, startedMs: 0, endedMs: 4_000 }),
        pass({ sessionId: 3, segmentId: 300, startedMs: 5_000, endedMs: 9_000 }),
      ],
      drawnFix: new Map(),
    },
    derived: {
      drawn: new Set(["900|forward"]),
      runs: [run({ sessionId: 3, segmentId: 900 })],
      passes: [],
      // The first half is drawn on #900. The second half is drawn nowhere.
      drawnFix: new Map(
        times(10)
          .filter((t) => t.atMs <= 4_000)
          .map((t) => [t.id, "900|forward"] as const),
      ),
    },
  });
  const groups = byVerdict(evidenceFor([b], "device", LONG));
  assert.deepEqual(groups.get("phantom")!.map((e) => e.key), ["100|forward"]);
  assert.deepEqual(groups.get("next-door")!.map((e) => e.key), ["200|forward"]);
  assert.deepEqual(groups.get("real-loss")!.map((e) => e.key), ["300|forward"]);

  // Draw the second half too, and the real loss becomes a consolidation. The
  // verdict follows the evidence, not the shape of the fixture.
  b.derived.drawnFix = new Map(times(10).map((t) => [t.id, "900|forward"] as const));
  const again = byVerdict(evidenceFor([b], "device", LONG));
  assert.equal(again.get("real-loss"), undefined);
  assert.deepEqual(
    again.get("next-door")!.map((e) => e.key).sort(),
    ["200|forward", "300|forward"],
  );
});

// ------------------------------------------------------ witnessDisagreements

test("identical pass lists disagree nowhere", () => {
  const ps = [pass(), pass({ segmentId: 200, direction: "backward" })];
  assert.deepEqual(witnessDisagreements(ps, ps.map((p) => ({ ...p }))), {
    checked: 2,
    disagreed: 0,
  });
});

test("a segment only one arm touched is NOT a disagreement", () => {
  // The arms match differently, so they touch different segments and project
  // different ones. Only the overlap is comparable. Without this filter the
  // control would fail on every ride and its OK would mean nothing.
  const a = [pass({ segmentId: 100 }), pass({ segmentId: 200 })];
  const b = [pass({ segmentId: 100 })];
  assert.deepEqual(witnessDisagreements(a, b), { checked: 1, disagreed: 0 });
});

test("a different pass on a SHARED segment is a disagreement, counted both ways", () => {
  const a = [pass({ segmentId: 100, startedMs: 1_000 })];
  const b = [pass({ segmentId: 100, startedMs: 5_000 })];
  assert.deepEqual(witnessDisagreements(a, b), { checked: 1, disagreed: 2 });
});

test("direction is part of a pass's identity in the control too", () => {
  const a = [pass({ direction: "forward" })];
  const b = [pass({ direction: "backward" })];
  assert.equal(witnessDisagreements(a, b).disagreed, 2);
});

test("empty inputs do not throw", () => {
  assert.deepEqual(witnessDisagreements([], []), { checked: 0, disagreed: 0 });
  assert.deepEqual(witnessDisagreements([pass()], []), { checked: 0, disagreed: 0 });
});

// ----------------------------------------------------------------- byVerdict

test("byVerdict puts every line in exactly one bucket", () => {
  const m = new Map<string, LineEvidence>([
    ["a", evidence([], { key: "a" })],
    ["b", evidence([fate(1)], { key: "b" })],
    ["c", evidence([fate(0)], { key: "c" })],
  ]);
  const groups = byVerdict(m);
  assert.equal([...groups.values()].reduce((n, l) => n + l.length, 0), 3);
  assert.equal(groups.get("phantom")!.length, 1);
  assert.equal(groups.get("next-door")!.length, 1);
  assert.equal(groups.get("real-loss")!.length, 1);
});

test("byVerdict on nothing returns nothing", () => {
  assert.equal(byVerdict(new Map()).size, 0);
});

// ------------------------------------------------- siblingKey / sensitivity

test("siblingKey flips the direction and keeps the segment", () => {
  // The flag that says whether a street keeps any paint. Getting this backwards
  // would report every blanked street as fine and every fine street as blanked.
  assert.equal(siblingKey("100|forward"), "100|backward");
  assert.equal(siblingKey("100|backward"), "100|forward");
  assert.equal(siblingKey(siblingKey("100|forward")), "100|forward", "it is an involution");
});

test("sensitivity reports one row per share, totalling every line", () => {
  const m = new Map<string, LineEvidence>([
    ["a", evidence([fate(0.45)], { key: "a" })],
    ["b", evidence([fate(0.95)], { key: "b" })],
    ["c", evidence([], { key: "c" })],
    ["d", evidence([], { key: "d", lengthM: 5 })],
  ]);
  const rows = sensitivity(m, [0.4, 0.5, 0.99]);
  assert.equal(rows.length, 3);
  for (const r of rows) {
    assert.equal(r["no-witness"] + r.phantom + r["next-door"] + r["real-loss"], 4);
  }
  // The 0.45 line is the one that moves: consolidation at 0.4, a loss at 0.5.
  assert.equal(rows[0]!["next-door"], 2);
  assert.equal(rows[0]!["real-loss"], 0);
  assert.equal(rows[1]!["next-door"], 1);
  assert.equal(rows[1]!["real-loss"], 1);
  assert.equal(rows[2]!["next-door"], 0, "at 0.99 even the 0.95 line is a loss");
  assert.equal(rows[2]!["real-loss"], 2);
  // The two unwitnessed lines never move: the threshold has nothing to say.
  for (const r of rows) {
    assert.equal(r.phantom, 1);
    assert.equal(r["no-witness"], 1);
  }
});

test("sensitivity over no shares, or no lines, returns nothing surprising", () => {
  assert.deepEqual(sensitivity(new Map(), [0.5]), [
    { share: 0.5, "no-witness": 0, phantom: 0, "next-door": 0, "real-loss": 0 },
  ]);
  assert.deepEqual(sensitivity(new Map([["a", evidence([])]]), []), []);
});

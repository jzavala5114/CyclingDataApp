import { strict as assert } from "node:assert";
import { test } from "node:test";
import { RequestCancelled, type PathRequest } from "./api.js";
import { ASK_AFTER_MS, NEAR_END_M, SelectionController, connectionEndM, type Hit } from "./selectionController.js";
import { metresPerPoint } from "./holdGesture.js";
import { selectionStats } from "./pathSelection.js";
import { east, makePath, type PieceSpec } from "./testPaths.js";
import type { Direction, PathResponse, SegmentWithGradients } from "../types";

// Press and hold, driven the way the screen drives it, against a fake clock,
// fake frames and a fake server whose answers the test hands over by hand.
// Every flow the design names gets one: a tap, a pan, a hold, a release
// before the answer, a fork, a limit, a hold past the end, behind the start,
// on the selection, a trim, a flip, back, and an answer arriving too late.

const flush = () => new Promise((resolve) => setImmediate(resolve));

function rig() {
  let now = 0;
  let frames: Array<(now: number) => void> = [];
  const timers: Array<{ at: number; run: () => void; done: boolean }> = [];
  const asked: Array<{ request: PathRequest; signal?: AbortSignal; resolve: (r: PathResponse) => void; reject: (e: unknown) => void }> = [];
  const fits: Array<[number, number, number, number]> = [];
  let firstHolds = 0;
  const controller = new SelectionController({
    fetchPath: (request, signal) =>
      new Promise((resolve, reject) => {
        asked.push({ request, signal, resolve, reject });
        signal?.addEventListener("abort", () => reject(new RequestCancelled("/segments/path")));
      }),
    now: () => now,
    frame: (step) => {
      frames.push(step);
      return () => {
        frames = frames.filter((f) => f !== step);
      };
    },
    later: (run, ms) => {
      const timer = { at: now + ms, run, done: false };
      timers.push(timer);
      return () => {
        timer.done = true;
      };
    },
    fit: (bounds) => fits.push(bounds),
    onFirstHold: () => {
      firstHolds += 1;
    },
  });
  // Moves the clock on in 16ms frames, firing timers and frames as they fall due.
  const advance = async (ms: number) => {
    const end = now + ms;
    while (now < end) {
      now = Math.min(end, now + 16);
      for (const timer of timers) {
        if (!timer.done && timer.at <= now) {
          timer.done = true;
          timer.run();
        }
      }
      const due = frames;
      frames = [];
      for (const step of due) step(now);
      await flush();
    }
  };
  const answer = async (index: number, response: PathResponse) => {
    asked[index]!.resolve(response);
    await flush();
  };
  return { controller, asked, fits, advance, answer, firstHolds: () => firstHolds, snap: () => controller.getSnapshot() };
}

// Streets running east: each segment's forward line sits 4m south of it, its
// backward line 4m north.
function street(id: number, fromEastM: number, lengthM: number): SegmentWithGradients {
  const side = (northM: number) => ({
    type: "LineString" as const,
    coordinates: [east(fromEastM, northM), east(fromEastM + lengthM, northM)],
  });
  return {
    id,
    streetName: `Street ${id}`,
    geom: side(0),
    lengthM,
    directionalLines: [
      { direction: "forward", geometry: side(-4), colorStops: [{ distanceFraction: 0, color: "#eab308" }] },
      { direction: "backward", geometry: side(4), colorStops: [{ distanceFraction: 0, color: "#22c55e" }] },
    ],
  };
}

const first = street(1, 0, 200);
const second = street(2, 200, 200);
const far = street(40, 2000, 200);

const hitOn = (segment: SegmentWithGradients, eastM: number, direction: Direction = "forward", over: Partial<Hit> = {}): Hit => ({
  lonLat: east(eastM, direction === "forward" ? -4 : 4),
  zoom: 17,
  line: { segment, drawing: segment.directionalLines.find((l) => l.direction === direction)! },
  piece: null,
  branch: null,
  ...over,
});

// The server's answer to a press at 10m east on the first street: the rest of
// it, then the second street.
const pressAnswer = (stop: Parameters<typeof makePath>[1] = { reason: "end" }, more: PieceSpec[] = []) =>
  makePath(
    [
      { segmentId: 1, lengthM: 190, slopes: [3], fromM: 10 },
      { segmentId: 2, lengthM: 200, slopes: [5], rule: "only" },
      ...more,
    ],
    stop,
    10,
    -4,
  );

// A finger down on `hit`, held past the long press.
async function hold(r: ReturnType<typeof rig>, hit: Hit) {
  const id = r.controller.touchStarted();
  r.controller.touchResolved(id, hit);
  await r.advance(400);
  r.controller.longPressed();
  return id;
}

test("a tap asks the server nothing", async () => {
  const r = rig();
  const id = r.controller.touchStarted();
  r.controller.touchResolved(id, hitOn(first, 10));
  await r.advance(100);
  r.controller.touchEnded();
  await r.advance(400);
  assert.equal(r.asked.length, 0);
  assert.equal(r.snap().mode, "idle");
});

test("a finger that stays put is asked about before the long press, and a pan then calls it off", async () => {
  const r = rig();
  const id = r.controller.touchStarted();
  r.controller.touchResolved(id, hitOn(first, 10));
  await r.advance(ASK_AFTER_MS + 16);
  assert.equal(r.asked.length, 1, "asked about 250ms before the long press registers");
  assert.deepEqual(r.asked[0]!.request, { from: { segmentId: 1, direction: "forward", lon: east(10)[0], lat: east(10, -4)[1] } });
  r.controller.touchMoved();
  assert.equal(r.asked[0]!.signal!.aborted, true);
  r.controller.longPressed();
  assert.equal(r.snap().mode, "idle", "a long press after the pan selects nothing");
});

test("a hold grows along the pressed line at once, then on along the answer, and stops where the finger lifts", async () => {
  const r = rig();
  await hold(r, hitOn(first, 10));
  let snap = r.snap();
  assert.equal(snap.mode, "holding");
  assert.equal(snap.preview, true, "growing along the line the phone already draws");
  assert.equal(snap.busy, "path");
  assert.equal(r.firstHolds(), 1);
  await r.advance(500);
  // 120 points a second rising towards 400: 77.5 points in 0.5s, ~36m at zoom 17.
  const expected = 77.5 * metresPerPoint(17, east(10, -4)[1]);
  assert.ok(Math.abs(r.snap().grownM - expected) < 2, `grew ${r.snap().grownM}m, expected about ${expected}`);
  await r.answer(0, pressAnswer());
  snap = r.snap();
  assert.equal(snap.preview, false);
  assert.equal(snap.busy, null);
  assert.equal(snap.selection!.lengthM, 390);
  assert.ok(Math.abs(snap.grownM - expected) < 2.5, "the answer starts where the preview did, so growth carries on");
  await r.advance(1000);
  const reached = r.snap().grownM;
  assert.ok(reached > expected + 50);
  r.controller.touchEnded();
  snap = r.snap();
  assert.equal(snap.mode, "shown");
  assert.equal(snap.grownM, reached);
  assert.equal(r.fits.length, 1, "letting go frames the selection");
  await r.advance(500);
  assert.equal(r.snap().grownM, reached, "nothing grows once the finger is up");
  assert.ok(Math.abs(selectionStats(snap.selection!, snap.grownM).distanceM - reached) < 1e-9);
});

test("lifting the finger before the answer keeps what grew; the answer then fills in the numbers", async () => {
  const r = rig();
  await hold(r, hitOn(first, 10));
  await r.advance(300);
  r.controller.touchEnded();
  const grown = r.snap().grownM;
  assert.equal(r.snap().mode, "shown");
  assert.equal(r.fits.length, 0, "no frame for a stand-in");
  await r.answer(0, pressAnswer());
  assert.equal(r.snap().preview, false);
  assert.ok(Math.abs(r.snap().grownM - grown) < 1e-9);
  assert.equal(r.fits.length, 1);
});

test("growth pauses at a junction the fork rule decided, and runs straight through one with one way on", async () => {
  const r = rig();
  await hold(r, hitOn(first, 10));
  await r.answer(0, pressAnswer({ reason: "end" }, [{ segmentId: 3, lengthM: 300, slopes: [0], rule: "history" }]));
  // Grow up to the history junction at 390m; the "only" one at 190m costs no pause.
  for (let i = 0; i < 200 && r.snap().grownM < 390; i++) await r.advance(16);
  assert.equal(r.snap().grownM, 390);
  await r.advance(96);
  assert.equal(r.snap().grownM, 390, "still paused");
  await r.advance(96);
  assert.ok(r.snap().grownM > 390, "on after the pause");
});

test("at a limit the phone asks again from the tip, avoiding what is selected, while the finger stays down", async () => {
  const r = rig();
  await hold(r, hitOn(first, 10));
  await r.answer(0, pressAnswer({ reason: "limit" }));
  for (let i = 0; i < 400 && r.asked.length < 2; i++) await r.advance(16);
  assert.equal(r.asked.length, 2);
  const more = r.asked[1]!.request;
  assert.equal(more.from.segmentId, 2);
  assert.ok(Math.abs(more.from.atM! - 200) < 1e-9, "from the tip, in the tip's own travel metres");
  assert.deepEqual(more.avoid, [1, 2]);
  assert.equal(r.snap().busy, "more");
  await r.answer(1, makePath([{ segmentId: 5, lengthM: 300, slopes: [1] }], { reason: "fork" }, 400, -4));
  assert.equal(r.snap().selection!.lengthM, 690);
  await r.advance(200);
  assert.ok(r.snap().grownM > 390, "growth goes on into the new path");
});

test("at a fork growth stops and waits; nothing is asked", async () => {
  const r = rig();
  await hold(r, hitOn(first, 10));
  await r.answer(0, pressAnswer({ reason: "fork", aheadM: 20 }));
  for (let i = 0; i < 400 && r.snap().grownM < 390; i++) await r.advance(16);
  await r.advance(500);
  assert.equal(r.snap().grownM, 390);
  assert.equal(r.asked.length, 1);
  assert.equal(r.snap().canGrow, false);
});

// A selection of the first 150m, shown, finger up.
async function shownSelection(r: ReturnType<typeof rig>) {
  await hold(r, hitOn(first, 10));
  await r.answer(0, pressAnswer({ reason: "fork" }));
  for (let i = 0; i < 400 && r.snap().grownM < 150; i++) await r.advance(16);
  r.controller.touchEnded();
  return r.snap().grownM;
}

test("holding a line near the end joins it at once, then grows on from it", async () => {
  const r = rig();
  const grown = await shownSelection(r);
  const near = street(20, 10 + grown + 60, 200);
  await hold(r, hitOn(near, 10 + grown + 100));
  const request = r.asked[1]!.request;
  assert.equal(request.from.segmentId, 1, "from the selection's end");
  assert.ok(Math.abs(request.from.atM! - (10 + grown)) < 0.5);
  assert.equal(request.to!.segmentId, 20);
  assert.ok(Math.abs(request.to!.atM! - 40) < 0.5, "the held point, in the held line's travel metres");
  assert.equal(request.grow, true);
  assert.deepEqual(request.avoid, [1]);
  assert.equal(r.snap().busy, "connect");
  const toAtM = request.to!.atM!;
  // The connection: the rest of the first street, a link, the held line to the
  // held point; then growth from the held point.
  await r.answer(
    1,
    makePath(
      [
        { segmentId: 1, lengthM: 40, slopes: [3], fromM: 10 + grown, rule: null },
        { segmentId: 9, lengthM: 20, slopes: [0], source: "none", rule: "connect" },
        { segmentId: 20, lengthM: toAtM, slopes: [2], rule: "connect" },
        { segmentId: 20, lengthM: 200 - toAtM, slopes: [2], fromM: toAtM, rule: null },
      ],
      { reason: "end" },
      10 + grown,
      -4,
    ),
  );
  const joinedAt = grown + 60 + toAtM;
  assert.ok(Math.abs(r.snap().grownM - joinedAt) < 1e-6, "the bridge appears whole, up to the held point");
  assert.equal(r.snap().mode, "holding");
  await r.advance(300);
  assert.ok(r.snap().grownM > joinedAt, "and grows on while held");
  r.controller.touchEnded();
  assert.equal(r.snap().selection!.pieces[0]!.lengthM, grown, "the old selection is kept as it was cut");
});

test("a held line with no way to it from the end starts a new selection there", async () => {
  const r = rig();
  const grown = await shownSelection(r);
  const near = street(21, 10 + grown + 50, 200);
  await hold(r, hitOn(near, 10 + grown + 80));
  await r.answer(1, { pieces: [], spans: [], lengthM: 0, stop: { reason: "unreachable", atM: 0, aheadM: 0, branches: [] }, bands: [] });
  const again = r.asked[2]!.request;
  assert.deepEqual(Object.keys(again), ["from"], "a plain press on the held line");
  assert.equal(again.from.segmentId, 21);
  assert.equal(r.snap().preview, true);
  assert.equal(r.snap().selection!.pieces[0]!.segmentId, 21);
});

test("holding a line near the start leads into it: prepended, heights counted from the new start", async () => {
  const r = rig();
  const grown = await shownSelection(r);
  const before = street(30, -100, 90);
  await hold(r, hitOn(before, -60));
  const request = r.asked[1]!.request;
  assert.equal(request.grow, false);
  assert.equal(request.from.segmentId, 30);
  assert.equal(request.from.atM, undefined, "the held point is measured by the server, like a press");
  assert.equal(request.to!.segmentId, 1);
  assert.ok(Math.abs(request.to!.atM! - 10) < 1e-9, "to the selection's start, exactly");
  await r.answer(1, makePath([{ segmentId: 30, lengthM: 70, slopes: [-5], rule: "connect", fromM: 20 }], { reason: "joined" }, -60, -4));
  const snap = r.snap();
  assert.equal(snap.mode, "shown");
  assert.ok(Math.abs(snap.grownM - (70 + grown)) < 1e-9);
  assert.equal(snap.selection!.pieces[0]!.segmentId, 30);
  // The lead-in drops 3.5m, so the old start sits at -3.5m.
  assert.ok(Math.abs(snap.selection!.spans[1]!.heightM + 3.5) < 1e-9);
  assert.equal(r.fits.length, 2);
});

test("a hold far from the selection replaces it", async () => {
  const r = rig();
  await shownSelection(r);
  await hold(r, hitOn(far, 2050));
  assert.deepEqual(Object.keys(r.asked[1]!.request), ["from"]);
  assert.equal(r.snap().selection!.pieces[0]!.segmentId, 40);
  assert.ok(NEAR_END_M < 1800);
});

test("holding the selection carries it on from where it was let go, with no request", async () => {
  const r = rig();
  const grown = await shownSelection(r);
  assert.equal(r.snap().canGrow, true);
  await hold(r, hitOn(first, 50, "forward", { piece: 0 }));
  await r.advance(300);
  assert.ok(r.snap().grownM > grown);
  assert.equal(r.asked.length, 1);
});

test("a tap on the selection asks to trim from that piece; confirming cuts there and stops it growing", async () => {
  const r = rig();
  await hold(r, hitOn(first, 10));
  await r.answer(0, pressAnswer({ reason: "fork" }));
  for (let i = 0; i < 400 && r.snap().grownM < 300; i++) await r.advance(16);
  r.controller.touchEnded();
  r.controller.tapSelection(1);
  assert.equal(r.snap().trimFrom, 1);
  r.controller.confirmTrim();
  const snap = r.snap();
  assert.equal(snap.trimFrom, null);
  assert.equal(snap.grownM, 190);
  assert.equal(snap.selection!.pieces.length, 1);
  assert.equal(snap.canGrow, false, "growing again would only pick the trimmed branch");
  await hold(r, hitOn(first, 50, "forward", { piece: 0 }));
  await r.advance(300);
  assert.equal(r.snap().grownM, 190);
});

test("trimming from the first piece clears the selection", async () => {
  const r = rig();
  await shownSelection(r);
  r.controller.tapSelection(0);
  r.controller.confirmTrim();
  assert.equal(r.snap().selection, null);
  assert.equal(r.snap().mode, "idle");
});

test("an answer for a selection the rider has since replaced is dropped", async () => {
  const r = rig();
  await hold(r, hitOn(first, 10));
  await r.advance(100);
  r.controller.touchEnded();
  await hold(r, hitOn(far, 2050));
  await r.answer(0, pressAnswer());
  const snap = r.snap();
  assert.equal(snap.preview, true, "still waiting on the second hold's answer");
  assert.equal(snap.selection!.pieces[0]!.segmentId, 40);
});

test("a failed answer says so and leaves nothing selected", async () => {
  const r = rig();
  await hold(r, hitOn(first, 10));
  r.asked[0]!.reject(new Error("/segments/path failed: 500"));
  await r.advance(16);
  assert.equal(r.snap().selection, null);
  assert.equal(r.snap().mode, "idle");
  assert.match(r.snap().error!, /Couldn't load the path: \/segments\/path failed: 500/);
});

test("back closes the trim question first, then the selection, then is the system's", async () => {
  const r = rig();
  await shownSelection(r);
  r.controller.tapSelection(0);
  assert.equal(r.controller.back(), true);
  assert.equal(r.snap().trimFrom, null);
  assert.ok(r.snap().selection);
  assert.equal(r.controller.back(), true);
  assert.equal(r.snap().selection, null);
  assert.equal(r.controller.back(), false);
});

test("flip replaces the selection with the other way along the same streets", async () => {
  const r = rig();
  const grown = await shownSelection(r);
  const flipping = r.controller.flip();
  assert.equal(r.snap().busy, "flip");
  await flush();
  const request = r.asked[1]!.request;
  assert.equal(request.grow, false);
  assert.equal(request.from.direction, "backward");
  r.asked[1]!.resolve(makePath([{ segmentId: 1, lengthM: grown, slopes: [-3], direction: "backward", rule: "connect" }], { reason: "joined" }));
  await flipping;
  const snap = r.snap();
  assert.equal(snap.busy, null);
  assert.equal(snap.selection!.pieces[0]!.direction, "backward");
  assert.equal(snap.grownM, grown);
  assert.equal(snap.canGrow, true, "a flipped selection can grow on from its end");
});

test("the connection ends where the answer first reaches the held point", () => {
  const response = makePath([
    { segmentId: 4, lengthM: 30, slopes: [0], rule: "connect" },
    { segmentId: 20, lengthM: 40, slopes: [0], rule: "connect" },
    { segmentId: 20, lengthM: 160, slopes: [0], fromM: 40, rule: null },
  ]);
  assert.equal(connectionEndM(response, { segmentId: 20, direction: "forward", atM: 40 }), 70);
  assert.equal(connectionEndM(response, { segmentId: 20, direction: "forward", atM: 0 }), 30, "a branch is held at its start");
  assert.equal(connectionEndM(response, { segmentId: 20, direction: "backward", atM: 40 }), 0);
});

test("at a fork, holding a branch joins it at its start and grows on along it", async () => {
  const r = rig();
  await hold(r, hitOn(first, 10));
  const fork = pressAnswer({ reason: "fork", aheadM: 20 });
  const stub = { type: "LineString" as const, coordinates: [east(420, -4), east(420, -34)] };
  fork.stop.branches = [{ segmentId: 50, direction: "forward", streetName: "Branch Trail", source: "line", geometry: stub }];
  await r.answer(0, fork);
  for (let i = 0; i < 400 && r.snap().grownM < 390; i++) await r.advance(16);
  r.controller.touchEnded();
  const branch = r.snap().selection!.stop.branches[0]!;
  await hold(r, hitOn(first, 420, "forward", { line: null, branch }));
  const request = r.asked[1]!.request;
  assert.equal(request.from.segmentId, 2, "from the selection's end");
  assert.deepEqual([request.to!.segmentId, request.to!.atM], [50, 0], "to the branch's start, where the fork is");
  assert.deepEqual([request.to!.lon, request.to!.lat], stub.coordinates[0]);
  await r.answer(
    1,
    makePath(
      [
        { segmentId: 8, lengthM: 20, slopes: [0], source: "none", rule: "connect" },
        { segmentId: 50, lengthM: 300, slopes: [6], rule: null },
      ],
      { reason: "end" },
      400,
      -4,
    ),
  );
  assert.ok(Math.abs(r.snap().grownM - 410) < 1e-6, "the 20m to the fork appear at once");
  await r.advance(300);
  assert.ok(r.snap().grownM > 410, "and growth runs on up the branch");
});

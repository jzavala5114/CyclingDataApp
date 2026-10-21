import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as turf from "@turf/turf";
import { cutAt, fromResponse, profileColumns, selectionFeatures } from "./pathSelection.js";
import { createScrubGesture, createScrubStore, cursorLeft, scrubAt, scrubMetres, scrubProfile, scrubReadout, type ScrubState } from "./profileScrub.js";
import { east, makePath } from "./testPaths.js";

// Scrubbing the card's profile: the finger's distance along it, what the path
// does there, and where that is on the map. Expected values are worked by hand
// from the fixtures.

const close = (actual: number, expected: number, tolerance = 1e-6, what = "value") =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: expected ${expected}, got ${actual}`);
const metresApart = (a: [number, number], b: number[]) => turf.distance(turf.point(a), turf.point(b), { units: "meters" });

// 60m climbing at 4%, then 45m descending at -2%, both running east.
const twoPieces = () =>
  fromResponse(
    makePath([
      { segmentId: 1, lengthM: 60, slopes: [4, 4, 4, 4] },
      { segmentId: 2, lengthM: 45, slopes: [-2, -2, -2] },
    ]),
  );

test("the finger's place on the profile is a distance along it, held to the profile's ends", () => {
  close(scrubMetres(50, 200, 105), 26.25);
  close(scrubMetres(0, 200, 105), 0);
  close(scrubMetres(200, 200, 105), 105);
  close(scrubMetres(-30, 200, 105), 0, 0, "left of the profile reads its start");
  close(scrubMetres(260, 200, 105), 105, 0, "right of it reads its end");
  close(scrubMetres(50, 0, 105), 0, 0, "a profile not yet measured");
  close(scrubMetres(Number.NaN, 200, 105), 0);
});

test("a point reads how far in, the height from the start and the grade there, and lies where the map draws it", () => {
  const selection = twoPieces();
  // 30m up the first piece: 30 x 4% = 1.2m.
  const climbing = scrubAt(selection, 30)!;
  close(climbing.atM, 30);
  close(climbing.heightM, 1.2);
  assert.equal(climbing.gradePct, 4);
  assert.ok(metresApart(east(30), [climbing.lon, climbing.lat]) < 0.01);
  // 20m into the second: 60 x 4% - 20 x 2% = 2.0m.
  const descending = scrubAt(selection, 80)!;
  close(descending.heightM, 2.0);
  assert.equal(descending.gradePct, -2);
  assert.ok(metresApart(east(80), [descending.lon, descending.lat]) < 0.01);
  // The ends, and past them.
  const start = scrubAt(selection, 0)!;
  close(start.heightM, 0);
  assert.ok(metresApart(east(0), [start.lon, start.lat]) < 0.01);
  const end = scrubAt(selection, 105)!;
  close(end.heightM, 2.4 - 0.9);
  assert.ok(metresApart(east(105), [end.lon, end.lat]) < 0.01);
  assert.deepEqual(scrubAt(selection, 400), end, "past the end reads the end");
  assert.deepEqual(scrubAt(selection, -5), start, "before the start reads the start");
  assert.equal(scrubAt(selection, Number.NaN), null);
});

test("the grade is the span's under the finger, where the grade changes from span to span", () => {
  // Four 15m spans: 2%, 5%, -3%, 8%.
  const selection = fromResponse(makePath([{ segmentId: 1, lengthM: 60, slopes: [2, 5, -3, 8] }]));
  assert.deepEqual([7.5, 22.5, 37.5, 52.5].map((m) => scrubAt(selection, m)!.gradePct), [2, 5, -3, 8]);
  // 15m at 2%, then 7.5m at 5%.
  close(scrubAt(selection, 22.5)!.heightM, 0.3 + 0.375);
});

test("the readout's height is the profile's own: equal at every column, never a second calculation", () => {
  const selection = twoPieces();
  const columns = profileColumns(selection, selection.lengthM, 64);
  columns.forEach((column, i) => {
    const point = scrubAt(selection, ((i + 0.5) / 64) * selection.lengthM)!;
    assert.equal(point.heightM, column.heightM, `column ${i}`);
  });
});

test("every point sits on the line the map draws, round a corner too", () => {
  // One piece 50m east then 50m north: a corner the dot must turn.
  const response = makePath([{ segmentId: 1, lengthM: 100, slopes: [3] }]);
  response.pieces[0]!.geometry = { type: "LineString", coordinates: [east(0), east(50), east(50, 50)] };
  const selection = fromResponse(response);
  const drawn = selectionFeatures(selection).map((f) => turf.lineString(f.geometry.coordinates));
  for (let m = 0; m <= 100; m += 2.5) {
    const point = scrubAt(selection, m)!;
    const off = Math.min(...drawn.map((line) => turf.pointToLineDistance(turf.point([point.lon, point.lat]), line, { units: "meters" })));
    assert.ok(off < 0.01, `${m}m along is ${off}m off the drawn line`);
  }
  // 75m along: 25m past the corner, northward.
  const past = scrubAt(selection, 75)!;
  assert.ok(metresApart(east(50, 25), [past.lon, past.lat]) < 0.5, "turned the corner");
});

test("ground nothing measured reads no grade, its height still the profile's", () => {
  const selection = fromResponse(
    makePath([
      { segmentId: 1, lengthM: 30, slopes: [2, 2] },
      { segmentId: 2, lengthM: 30, slopes: [0], source: "none" },
    ]),
  );
  const point = scrubAt(selection, 45)!;
  assert.equal(point.gradePct, null);
  close(point.heightM, 0.6, 1e-6, "30m at 2%, then flat, unmeasured");
  assert.equal(scrubAt(selection, 10)!.gradePct, 2);
});

test("on a selection grown part way the point never passes what has grown", () => {
  const selection = twoPieces();
  const profile = cutAt(selection, 70);
  const point = scrubAt(profile, 100)!;
  close(point.atM, 70);
  assert.ok(metresApart(east(70), [point.lon, point.lat]) < 0.01);
});

test("the store tells each listener of a new point, once, and stops after it leaves", () => {
  const store = createScrubStore();
  assert.equal(store.get(), null);
  const seen: Array<number | null> = [];
  const off = store.subscribe(() => seen.push(store.get()?.atM ?? null));
  const point = scrubAt(twoPieces(), 30)!;
  store.set(point);
  store.set(point);
  store.set(null);
  store.set(null);
  assert.deepEqual(seen, [30, null], "the same point twice tells nobody twice");
  // A listener that leaves while being told does not stop the others hearing.
  const later: string[] = [];
  const first = store.subscribe(() => {
    later.push("first");
    first();
  });
  store.subscribe(() => later.push("second"));
  store.set(point);
  assert.deepEqual(later, ["first", "second"]);
  off();
  store.set(null);
  assert.deepEqual(seen, [30, null, 30], "gone after unsubscribing");
});

test("the profile a scrub reads is the selection cut to what has grown, and nothing while it is a preview", () => {
  const selection = twoPieces();
  close(scrubProfile(selection, 70, false)!.lengthM, 70, 1e-9, "grown 70m of 105m");
  assert.equal(scrubProfile(selection, 105, false), selection, "fully grown is the selection itself");
  assert.equal(scrubProfile(selection, 70, true), null);
  assert.equal(scrubProfile(null, 70, false), null);
});

test("the readout says how far in, the height from the start with its sign, and the grade or no data", () => {
  const at = (atM: number, heightM: number, gradePct: number | null) => scrubReadout({ atM, heightM, gradePct, lon: 0, lat: 0 });
  assert.deepEqual(at(478.5, 36.6, 3.14), { distance: "1,570 ft in", height: "+120 ft", grade: "+3.1%" });
  assert.deepEqual(at(1609.344, -12.2, -2), { distance: "1.00 mi in", height: "−40 ft", grade: "−2.0%" });
  assert.deepEqual(at(0, 0, null), { distance: "0 ft in", height: "0 ft", grade: "no data" });
});

test("the cursor sits centred on the point, inside the profile at both ends", () => {
  const point = (atM: number) => ({ atM, heightM: 0, gradePct: 0, lon: 0, lat: 0 });
  close(cursorLeft(point(50), 100, 300, 2)!, 149, 1e-9, "half way along 300 wide");
  close(cursorLeft(point(0), 100, 300, 2)!, 0, 0, "the start");
  close(cursorLeft(point(100), 100, 300, 2)!, 298, 0, "the end, kept inside");
  assert.equal(cursorLeft(point(50), 100, 0, 2), null, "before the profile is measured");
  assert.equal(cursorLeft(point(50), 0, 300, 2), null);
});

// The gesture, fed responder events as React Native sends them. The profile
// is 312 wide with its left edge 24 from the screen's: a 360-wide phone.
const EDGE = 24;
const WIDTH = 312;
function scrubbing(state: Partial<ScrubState> = {}) {
  const store = createScrubStore();
  const now: ScrubState = { profile: twoPieces(), width: WIDTH, scrubbable: true, ...state };
  const gesture = createScrubGesture(store, () => now);
  const atM = () => store.get()?.atM ?? null;
  const onProfile = (x: number) => ({ pageX: EDGE + x, locationX: x, identifier: 0 });
  return { store, now, gesture, atM, onProfile };
}
const along = (x: number) => (x / WIDTH) * 105;

test("a scrub reads the finger from the profile's own edge, kept from where the touch started", () => {
  const { gesture, atM, onProfile } = scrubbing();
  gesture.grant(onProfile(78));
  close(atM()!, along(78), 1e-9, "the start, from the profile's edge");
  // A move's locationX is measured against whatever the finger is over: off
  // the profile it says nothing about the profile. Only pageX is read.
  gesture.move({ pageX: EDGE + 156, locationX: 3, identifier: 0 });
  close(atM()!, along(156), 1e-9, "half way, by pageX");
  gesture.move({ pageX: EDGE + 500, locationX: 7, identifier: 0 });
  close(atM()!, 105, 1e-9, "slid off the right end reads the end");
  gesture.move({ pageX: 2, locationX: 2, identifier: 0 });
  close(atM()!, 0, 1e-9, "slid off the left reads the start");
});

test("a second finger, on the map or anywhere, does not move the dot", () => {
  // On Android every finger's moves reach the profile, each with its own id.
  const { gesture, atM, onProfile } = scrubbing();
  gesture.grant(onProfile(76));
  const seen: number[] = [];
  for (const [a, b] of [[86, 276], [96, 278], [106, 280]]) {
    gesture.move({ pageX: EDGE + a, locationX: a, identifier: 0 });
    seen.push(atM()!);
    gesture.move({ pageX: EDGE + b, locationX: b, identifier: 1 });
    seen.push(atM()!);
  }
  const a = [86, 96, 106].map(along);
  seen.forEach((m, i) => close(m, a[Math.floor(i / 2)]!, 1e-9, `event ${i}`));
});

test("lifting, or losing the touch, hides the dot, and nothing moves it until a new touch starts", () => {
  const { gesture, atM, onProfile } = scrubbing();
  assert.equal(gesture.canStart(), true);
  gesture.grant(onProfile(40));
  assert.equal(gesture.canStart(), false, "one scrub at a time");
  gesture.end();
  assert.equal(atM(), null);
  gesture.move({ pageX: EDGE + 100, locationX: 100, identifier: 0 });
  assert.equal(atM(), null, "a move after the end is ignored");
  assert.equal(gesture.canStart(), true);
  gesture.grant(onProfile(100));
  close(atM()!, along(100), 1e-9, "a new touch starts again");
});

test("no scrub while one may not run, and a scrub stops the moment it may not", () => {
  const blocked = scrubbing({ scrubbable: false });
  assert.equal(blocked.gesture.canStart(), false);
  const { gesture, now, atM, onProfile } = scrubbing();
  gesture.grant(onProfile(50));
  now.scrubbable = false; // a hold begins growing the selection
  gesture.move({ pageX: EDGE + 60, locationX: 60, identifier: 0 });
  assert.equal(atM(), null);
});

test("a new answer mid-scrub: the next move reads the new profile", () => {
  const { gesture, now, atM, onProfile } = scrubbing();
  gesture.grant(onProfile(156));
  close(atM()!, along(156), 1e-9);
  now.profile = cutAt(twoPieces(), 52.5);
  gesture.move({ pageX: EDGE + 156, locationX: 156, identifier: 0 });
  close(atM()!, 26.25, 1e-9, "half way along the new, shorter profile");
});

test("ending a scrub that never heard its finger lift frees the gesture for the next touch", () => {
  // The profile gone with a finger on it: no release, no termination, only
  // the card's own end when its profile changes.
  const { gesture, atM, onProfile } = scrubbing();
  gesture.grant(onProfile(60));
  assert.equal(gesture.canStart(), false);
  gesture.end();
  assert.equal(gesture.canStart(), true, "a later selection can be scrubbed");
  gesture.grant(onProfile(120));
  close(atM()!, along(120), 1e-9);
});

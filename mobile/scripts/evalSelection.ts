// npm run eval:selection -- [presses] [--record <file> | --replay <file>]
//
// The app's press-and-hold logic run over real answers from the live
// GET /segments/path. The gate tests pin the logic on synthetic paths; this
// asks whether it holds on what the server actually sends: thousands of real
// spans, short unmeasured joins, partly drawn lines, limits and forks. It only
// reads: GET /segments and GET /segments/path, nothing else. Never run it
// while a deploy is rolling out (see "Never send traffic to a deploying
// container" in context/session.md): check /health's builtAt first.
//
// For each press, on a drawn line picked by a fixed seed, so every run asks
// the same questions while the map stays the same:
//   tiles      pieces and spans run end to end from 0 to the path's length
//   heights    each span starts as high as the last one ended, the first at 0
//   card       climb less descent is the net; the band shares and the
//              unmeasured share make the whole distance; each band holds
//              the distance of the spans in its colour
//   cuts       a cut at five points tiles to the cut, and ends as high as the
//              uncut profile is there
//   features   the map's features cover the path with no gap or overlap, each
//              the same share of its piece on the map as along the path
//   scrub      a finger on the card's profile, at 121 points along the whole
//              path and along it cut part way: the dot within 0.5m of the
//              line the map draws, at the same share of its piece's drawn
//              line as of the piece's length, its height the profile's and
//              its grade its span's, and never past what has grown; and a
//              finger swept across Julian's phone reads the start up to 60dp
//              from the left, the end from 60dp off the right, and moves on
//              at every half dp between
//   limit      a path stopped by its limit, asked again from the tip as the
//              phone asks, joins on with no step in height
//   flip       its first 800m flips onto the other direction's lines of the
//              same streets
//   hold       the controller, driven as the screen drives it over this
//              answer and the lines the map draws, let go part way along a
//              long drawn piece: the tip it shows is hit-tested as the
//              selection; held through the faded line under it, the tip and
//              the middle of each piece already selected carry the selection
//              on, growing and asking nothing; held 25m ahead on the same
//              line, it joins straight along it; held on the street's other
//              line beside a segment selected end to end, it asks. Asks the
//              server nothing more.
//
// --record <file> saves every answer; --replay <file> answers from such a
// file and sends nothing, so a deliberately broken copy of the code can be
// judged without asking the server again.
// PASS: every check holds on every press, and at least 90% of flips succeed
// (a flip can fail honestly, where the other way has no connection the
// server will draw). Latency from this PC is reported, not judged.
import fs from "node:fs";
import * as turf from "@turf/turf";
import { MAX_AVOID, pathQuery, type PathRequest } from "../src/services/api";
import { flipSelection } from "../src/services/flipSelection";
import { buildColoredLineFeatures } from "../src/services/gradientRendering";
import { SELECTION_HIT_LAYERS, SELECTION_LAYER, hitFromFeatures, metresPerPoint, type RenderedFeature } from "../src/services/holdGesture";
import {
  appendPath,
  cutAt,
  fromResponse,
  growingFeature,
  pointOnPath,
  selectionFeatures,
  selectionSegmentIds,
  selectionStats,
  type Selection,
  type SelectionFeature,
} from "../src/services/pathSelection";
import { createScrubGesture, createScrubStore, scrubAt } from "../src/services/profileScrub";
import { SelectionController, type Hit } from "../src/services/selectionController";
import { API_BASE_URL } from "../src/config";
import type { LineString } from "geojson";
import type { PathResponse, SegmentWithGradients } from "../src/types";

const args = process.argv.slice(2);
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const PRESSES = Number(args.find((a) => /^d+$/.test(a)) ?? 16);
const RECORD = flag("--record");
const REPLAY = flag("--replay");
const recorded: Record<string, unknown> = REPLAY ? JSON.parse(fs.readFileSync(REPLAY, "utf8")) : {};
const FLIP_M = 800;
const FLIP_PASS_SHARE = 0.9;

// The trails around Ladders and Gold Camp Road, and downtown around the app's
// starting view: the two kinds of ground the selection has to work on.
const AREAS: Array<{ name: string; box: [number, number, number, number] }> = [
  { name: "trails", box: [-104.9, 38.79, -104.865, 38.81] },
  { name: "downtown", box: [-104.8306, 38.8167, -104.8095, 38.8379] },
];

// mulberry32: a fixed seed, so the same lines are pressed run to run.
function seeded(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const timings: number[] = [];
async function get<T>(path: string): Promise<T> {
  if (REPLAY) {
    if (!(path in recorded)) throw new Error(`not in the recording: ${path.slice(0, 100)}`);
    return recorded[path] as T;
  }
  const started = performance.now();
  const res = await fetch(`${API_BASE_URL}${path}`);
  const text = await res.text();
  if (path.startsWith("/segments/path")) timings.push(performance.now() - started);
  if (!res.ok) throw new Error(`${path.slice(0, 80)}: HTTP ${res.status} ${text.slice(0, 200)}`);
  const parsed = JSON.parse(text) as T;
  if (RECORD) recorded[path] = parsed;
  return parsed;
}
const fetchPath = (request: PathRequest) => get<PathResponse>(pathQuery(request));

type Check = "tiles" | "heights" | "card" | "cuts" | "features" | "scrub" | "limit" | "flip" | "hold";
const failures: Array<{ press: string; check: Check; detail: string }> = [];
const fail = (press: string, check: Check, detail: string) => failures.push({ press, check, detail });

const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;

// The height `x` along, summed straight from the spans: the profile the card
// draws, worked independently of the code under test.
function profileHeight(selection: Selection, x: number): number {
  let height = 0;
  for (const span of selection.spans) {
    if (span.atM + span.lengthM <= x) height += span.riseM;
    else if (span.atM < x) height += span.riseM * ((x - span.atM) / span.lengthM);
  }
  return height;
}

function checkTiles(press: string, selection: Selection, lengthM: number) {
  let at = 0;
  for (const piece of selection.pieces) {
    if (!near(piece.atM, at, 0.01)) return fail(press, "tiles", `piece on ${piece.segmentId} starts at ${piece.atM.toFixed(2)}, not ${at.toFixed(2)}`);
    at = piece.atM + piece.lengthM;
  }
  if (!near(at, lengthM, 0.01)) return fail(press, "tiles", `pieces end at ${at.toFixed(2)} of ${lengthM.toFixed(2)}`);
  at = 0;
  for (const span of selection.spans) {
    if (!near(span.atM, at, 0.01)) return fail(press, "tiles", `a span starts at ${span.atM.toFixed(2)}, not ${at.toFixed(2)}`);
    const piece = selection.pieces[span.piece];
    if (!piece || span.atM < piece.atM - 0.01 || span.atM + span.lengthM > piece.atM + piece.lengthM + 0.01) {
      return fail(press, "tiles", `a span at ${span.atM.toFixed(1)} lies off its piece ${span.piece}`);
    }
    at = span.atM + span.lengthM;
  }
  if (selection.spans.length > 0 && !near(at, lengthM, 0.01)) fail(press, "tiles", `spans end at ${at.toFixed(2)} of ${lengthM.toFixed(2)}`);
}

function checkHeights(press: string, selection: Selection) {
  let expected = 0;
  for (const span of selection.spans) {
    if (!near(span.heightM, expected, 1e-6)) return fail(press, "heights", `a span at ${span.atM.toFixed(1)} starts at ${span.heightM}, not ${expected}`);
    expected += span.riseM;
  }
}

function checkCard(press: string, selection: Selection) {
  const stats = selectionStats(selection, selection.lengthM);
  if (!near(stats.climbM - stats.descentM, stats.netM, 1e-6)) fail(press, "card", `climb ${stats.climbM} less descent ${stats.descentM} is not net ${stats.netM}`);
  if (!near(stats.distanceM, selection.lengthM, 1e-9)) fail(press, "card", `distance ${stats.distanceM} of ${selection.lengthM}`);
  const shares = stats.bands.reduce((sum, b) => sum + b.share, 0) + (stats.distanceM > 0 ? stats.noDataM / stats.distanceM : 0);
  if (stats.distanceM > 0 && !near(shares, 1, 1e-6)) fail(press, "card", `shares make ${shares}, not 1`);
  for (const [name, value] of Object.entries({ climb: stats.climbM, descent: stats.descentM, net: stats.netM })) {
    if (!Number.isFinite(value)) fail(press, "card", `${name} is ${value}`);
  }
  // Each band's distance, summed straight from the spans by their colour (the
  // server colours a span from the same table the bands come from): the colour
  // key, worked independently of the code under test. The identities above
  // hold whichever band a span lands in; this does not.
  const byColour = new Map<string, number>();
  for (const span of selection.spans) if (span.source !== "none") byColour.set(span.color, (byColour.get(span.color) ?? 0) + span.lengthM);
  for (const band of stats.bands) {
    const spansM = byColour.get(band.color) ?? 0;
    if (!near(band.lengthM, spansM, 0.01)) fail(press, "card", `the ${band.color} band holds ${band.lengthM.toFixed(1)}m, its spans ${spansM.toFixed(1)}m`);
    byColour.delete(band.color);
  }
  for (const [colour, m] of byColour) fail(press, "card", `${m.toFixed(1)}m of spans coloured ${colour}, no band's colour`);
}

function checkCuts(press: string, selection: Selection) {
  for (const fraction of [0.13, 0.37, 0.5, 0.71, 0.93]) {
    const m = selection.lengthM * fraction;
    const cut = cutAt(selection, m);
    checkTiles(`${press} cut at ${m.toFixed(0)}m`, cut, m);
    const end = cut.spans.length ? cut.spans[cut.spans.length - 1]!.heightM + cut.spans[cut.spans.length - 1]!.riseM : 0;
    if (!near(end, profileHeight(selection, m), 1e-6)) fail(press, "cuts", `cut at ${m.toFixed(0)}m ends at ${end}, the profile says ${profileHeight(selection, m)}`);
    if (!near(selectionStats(selection, m).distanceM, m, 1e-9)) fail(press, "cuts", `stats at ${m.toFixed(0)}m measure another distance`);
  }
}

function checkFeatures(press: string, selection: Selection) {
  const features = selectionFeatures(selection).sort((a, b) => a.properties.startM - b.properties.startM);
  let at = 0;
  for (const feature of features) {
    const { startM, endM, piece } = feature.properties;
    if (!near(startM, at, 0.01)) return fail(press, "features", `a feature starts at ${startM.toFixed(2)}, not ${at.toFixed(2)}`);
    // The map draws each line 4m to its side, so round a switchback the drawn
    // line is metres longer or shorter than the path, and the server spreads
    // the path's metres evenly along it (offsetTravelSlice). So a feature
    // holds the same share of its piece's drawn line as of the piece's length,
    // not the same metres: the first run of this eval checked metres, and 34
    // trail features failed it by design.
    const owner = selection.pieces[piece]!;
    const pieceDrawnM = turf.length(turf.lineString(owner.geometry.coordinates), { units: "meters" });
    const drawnM = turf.length(turf.lineString(feature.geometry.coordinates), { units: "meters" });
    const expectedM = pieceDrawnM * ((endM - startM) / owner.lengthM);
    if (!near(drawnM, expectedM, 0.01 * pieceDrawnM + 0.5)) {
      fail(press, "features", `a feature from ${startM.toFixed(0)}m is ${drawnM.toFixed(1)}m of its piece's ${pieceDrawnM.toFixed(1)}m drawn, not ${expectedM.toFixed(1)}m`);
    }
    at = endM;
  }
  if (!near(at, selection.lengthM, 0.01)) fail(press, "features", `features end at ${at.toFixed(2)} of ${selection.lengthM.toFixed(2)}`);
}

// The profile scrub (services/profileScrub.ts), judged without its code: the
// dot measured against the drawn line with turf's own distance, its share of
// its piece recovered by turf's nearest point (the share rule the features
// above are cut by), the height summed straight from the spans, the span
// found by a scan.
const SCRUB_SAMPLES = 120;
function checkScrub(press: string, selection: Selection) {
  const drawn = selectionFeatures(selection).map((f) => turf.lineString(f.geometry.coordinates));
  const grownM = selection.lengthM * 0.61;
  for (const [label, profile] of [["whole", selection], ["grown part way", cutAt(selection, grownM)]] as const) {
    for (let i = 0; i <= SCRUB_SAMPLES; i++) {
      const m = (i / SCRUB_SAMPLES) * profile.lengthM;
      const where = `${label}, ${m.toFixed(1)}m in`;
      const point = scrubAt(profile, m);
      if (!point) return fail(press, "scrub", `${where}: no point`);
      if (!near(point.atM, m, 1e-9)) return fail(press, "scrub", `${where}: read ${point.atM.toFixed(2)}m`);
      const dot = turf.point([point.lon, point.lat]);
      const off = Math.min(...drawn.map((line) => turf.pointToLineDistance(dot, line, { units: "meters" })));
      if (off > 0.5) return fail(press, "scrub", `${where}: the dot is ${off.toFixed(2)}m off the drawn line`);
      const piece = profile.pieces.find((p) => m <= p.atM + p.lengthM + 1e-9) ?? profile.pieces[profile.pieces.length - 1]!;
      const pieceLine = turf.lineString(piece.geometry.coordinates);
      const pieceDrawnM = turf.length(pieceLine, { units: "meters" });
      const alongM = turf.nearestPointOnLine(pieceLine, dot, { units: "meters" }).properties.totalDistance;
      const expectedM = piece.lengthM > 0 ? pieceDrawnM * ((m - piece.atM) / piece.lengthM) : 0;
      if (!near(alongM, expectedM, 0.5)) {
        return fail(press, "scrub", `${where}: the dot is ${alongM.toFixed(1)}m along its piece's drawn line, not ${expectedM.toFixed(1)}m`);
      }
      if (!near(point.heightM, profileHeight(profile, m), 1e-6)) {
        return fail(press, "scrub", `${where}: reads ${point.heightM.toFixed(3)}m, the profile says ${profileHeight(profile, m).toFixed(3)}m`);
      }
      let span = profile.spans[0];
      for (const s of profile.spans) if (s.atM <= m) span = s;
      const grade = !span || span.source === "none" ? null : span.slopePct;
      if (point.gradePct !== grade) return fail(press, "scrub", `${where}: reads grade ${point.gradePct}, its span ${grade}`);
    }
  }
  // Past what has grown reads the grown end, where the map's growth stops,
  // and says so: "1.20 mi in" on a selection 1.00 mi long would be wrong.
  const past = scrubAt(cutAt(selection, grownM), grownM + 50);
  const end = pointOnPath(selection, grownM);
  if (!past || !end || turf.distance(turf.point([past.lon, past.lat]), turf.point([end.lon, end.lat]), { units: "meters" }) > 0.5) {
    fail(press, "scrub", `past the grown part, the dot is not at the grown end`);
  } else if (!near(past.atM, grownM, 1e-9)) {
    fail(press, "scrub", `past the grown part, it reads ${past.atM.toFixed(1)}m in of ${grownM.toFixed(1)}m grown`);
  }
  checkReach(press, selection);
}

// The reach (asked for 2026-10-21): the path's start and end within reach
// short of the screen's sides. A finger swept across Julian's Pixel 10 Pro
// (1080px at 2.625px a dp; the card's profile 24dp in from each side), driven
// through the gesture as the card drives it, every 0.5dp: up to 60dp from the
// left the dot is on the drawn line's first point, from 60dp off the right on
// its last, and every step between moves it on, so the band has no dead spot.
const PHONE_DP = 1080 / 2.625;
const PROFILE_EDGE_DP = 24;
const REACH_DP = 60;
function checkReach(press: string, selection: Selection) {
  const store = createScrubStore();
  const gesture = createScrubGesture(store, () => ({
    profile: selection,
    width: PHONE_DP - 2 * PROFILE_EDGE_DP,
    windowWidth: PHONE_DP,
    scrubbable: true,
  }));
  const first = selection.pieces[0]!.geometry.coordinates[0]!;
  const lastPiece = selection.pieces[selection.pieces.length - 1]!.geometry.coordinates;
  const last = lastPiece[lastPiece.length - 1]!;
  const metresFrom = (to: number[]) => {
    const point = store.get()!;
    return turf.distance(turf.point([point.lon, point.lat]), turf.point(to), { units: "meters" });
  };
  gesture.grant({ pageX: PROFILE_EDGE_DP, locationX: 0, identifier: 0 });
  let before = -1;
  for (let x = 0; x <= PHONE_DP; x += 0.5) {
    gesture.move({ pageX: x, locationX: x, identifier: 0 });
    const point = store.get();
    if (!point) return fail(press, "scrub", `reach: no point at ${x}dp`);
    if (x <= REACH_DP && metresFrom(first) > 0.5) {
      return fail(press, "scrub", `reach: ${x}dp from the left reads ${point.atM.toFixed(1)}m in, ${metresFrom(first).toFixed(1)}m from the start`);
    }
    if (x >= PHONE_DP - REACH_DP && metresFrom(last) > 0.5) {
      const off = (PHONE_DP - x).toFixed(1);
      return fail(press, "scrub", `reach: ${off}dp from the right reads ${point.atM.toFixed(1)}m in, ${metresFrom(last).toFixed(1)}m from the end`);
    }
    if (x > REACH_DP && x < PHONE_DP - REACH_DP && !(point.atM > before)) {
      return fail(press, "scrub", `reach: no further along at ${x}dp than half a dp before (${point.atM.toFixed(2)}m)`);
    }
    before = point.atM;
  }
  gesture.end();
}

async function checkLimit(press: string, selection: Selection): Promise<string> {
  if (selection.stop.reason !== "limit") return "";
  const tip = pointOnPath(selection, selection.lengthM)!;
  const more = await fetchPath({
    from: { segmentId: tip.segmentId, direction: tip.direction, lon: tip.lon, lat: tip.lat, atM: tip.atM },
    avoid: selectionSegmentIds(selection).slice(-MAX_AVOID),
  });
  const joined = appendPath(selection, more);
  checkTiles(`${press} after the limit`, joined, joined.lengthM);
  checkHeights(`${press} after the limit`, joined);
  return ` then +${(more.lengthM / 1000).toFixed(2)}km (${more.stop.reason})`;
}

async function checkFlip(press: string, selection: Selection) {
  const base = cutAt(selection, Math.min(selection.lengthM, FLIP_M));
  if (base.pieces.length === 0) return { ok: true, requests: 0, note: "" };
  try {
    const { selection: flipped, requests } = await flipSelection(base, fetchPath);
    const wanted = [...new Set([...base.pieces].reverse().map((p) => `${p.segmentId}`))];
    const got = [...new Set(flipped.pieces.filter((p) => p.lengthM > 0).map((p) => `${p.segmentId}`))];
    if (wanted.join() !== got.join()) {
      fail(press, "flip", `flipped onto ${got.join(",")} for ${wanted.join(",")}`);
      return { ok: false, requests, note: "wrong streets" };
    }
    if (!flipped.pieces.every((p, i) => i === 0 || p.lengthM <= 0 || p.direction !== base.pieces.find((q) => q.segmentId === p.segmentId)!.direction)) {
      fail(press, "flip", "a flipped piece kept its direction");
    }
    checkTiles(`${press} flipped`, flipped, flipped.lengthM);
    checkHeights(`${press} flipped`, flipped);
    const stats = selectionStats(flipped, flipped.lengthM);
    return { ok: true, requests, note: `flipped ${(flipped.lengthM / 1000).toFixed(2)}km in ${requests}, climbs ${stats.climbM.toFixed(1)}m` };
  } catch (err) {
    return { ok: false, requests: 0, note: `flip failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// A finger finds a line this far off: the screen tests a box 22 points either
// side of the touch (HIT_PT in MapScreen.tsx), about 10m at zoom 17 here.
const HIT_BOX_M = 22 * metresPerPoint(17, 38.83);
// As queryRenderedFeatures hands them to the screen: plain features, their properties untyped.
const asRendered = (features: ReadonlyArray<{ geometry: LineString; properties: object }>) => features as unknown as RenderedFeature[];

// The controller with the screen's clock and frames faked, and a server that
// hands it this press's real answer and records anything else it is asked.
function driven(answer: PathResponse) {
  let now = 0;
  let frames: Array<(t: number) => void> = [];
  const timers: Array<{ at: number; run: () => void; done: boolean }> = [];
  const asked: PathRequest[] = [];
  const controller = new SelectionController({
    fetchPath: (request) => {
      asked.push(request);
      return asked.length === 1 ? Promise.resolve(answer) : new Promise<PathResponse>(() => undefined);
    },
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
    fit: () => undefined,
  });
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
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  const holdAt = async (hit: Hit) => {
    const id = controller.touchStarted();
    controller.touchResolved(id, hit);
    await advance(400);
    controller.longPressed();
  };
  return { controller, asked, advance, holdAt };
}

async function checkHold(
  press: string,
  answer: PathResponse,
  start: Hit,
  segments: Map<number, SegmentWithGradients>,
  base: RenderedFeature[],
): Promise<string> {
  const before = failures.length;
  const drawnLine = (segmentId: number, direction: string) =>
    !!segments.get(segmentId)?.directionalLines.some((l) => l.direction === direction && l.colorStops.length > 0);
  const long = fromResponse(answer)
    .pieces.map((piece, index) => ({ piece, index }))
    .filter(({ piece }) => piece.source === "line" && piece.lengthM >= 80 && drawnLine(piece.segmentId, piece.direction));
  if (long.length === 0) return "; hold: no drawn piece of 80m";
  const { piece, index } = long.reduce((a, b) => (b.piece.lengthM > a.piece.lengthM ? b : a));
  const target = piece.atM + 0.4 * piece.lengthM;

  // Hold the pressed line, take the real answer, grow 40% of the way along
  // that piece, let go. Each run of checks below gets its own controller let
  // go the same way, so one check's requests cannot colour another's.
  const letGo = async () => {
    const d = driven(answer);
    await d.holdAt(start);
    for (let i = 0; i < 20000 && d.controller.getSnapshot().grownM < target; i++) await d.advance(16);
    d.controller.touchEnded();
    return d;
  };
  const d = await letGo();
  const snap = d.controller.getSnapshot();
  const selection = snap.selection;
  if (!selection || snap.preview || snap.grownM < target) {
    fail(press, "hold", `growth stopped at ${snap.grownM.toFixed(0)}m, short of ${target.toFixed(0)}m`);
    return "; hold FAILED";
  }
  const tipM = snap.grownM;
  const tip = pointOnPath(selection, tipM)!;
  const finger = (m: number): [number, number] => {
    const at = pointOnPath(selection, m)!;
    return [at.lon, at.lat];
  };
  // What the screen's query returns at a finger: the base lines, and the
  // selection's features from the layers it names.
  const queried = (c: ReturnType<typeof driven>, at: [number, number], withSelection: boolean): RenderedFeature[] => {
    const current = c.controller.getSnapshot();
    const grown = current.features.filter((f) => f.properties.endM <= current.grownM + 0.001);
    const growing = growingFeature(current.features, current.grownM);
    const byLayer: Record<string, SelectionFeature[]> = {
      [SELECTION_LAYER.line]: grown.filter((f) => !f.properties.noData),
      [SELECTION_LAYER.gap]: grown.filter((f) => f.properties.noData),
      [SELECTION_LAYER.growingLine]: growing && !growing.properties.noData ? [growing] : [],
      [SELECTION_LAYER.growingGap]: growing && growing.properties.noData ? [growing] : [],
    };
    const drawn = [...base, ...asRendered(withSelection ? SELECTION_HIT_LAYERS.flatMap((id) => byLayer[id] ?? []) : [])];
    return drawn.filter(
      (f) => turf.pointToLineDistance(turf.point(at), turf.lineString((f.geometry as LineString).coordinates), { units: "meters" }) <= HIT_BOX_M,
    );
  };
  const hitAt = (c: ReturnType<typeof driven>, at: [number, number], withSelection: boolean): Hit =>
    hitFromFeatures(queried(c, at, withSelection), at, 17, segments, () => undefined);
  const onLine = (hit: Hit, segmentId: number, direction: string) => hit.line?.segment.id === segmentId && hit.line.drawing.direction === direction;

  // The tip the rider sees is the selection to a touch.
  if (hitAt(d, finger(tipM - 3), true).piece === null) fail(press, "hold", `the tip at ${tipM.toFixed(0)}m is not hit-tested as the selection`);

  // Held 25m ahead of the tip on the same line, it joins straight along it.
  const ahead = hitAt(d, finger(tipM + 25), false);
  if (onLine(ahead, tip.segmentId, tip.direction)) {
    const asked = d.asked.length;
    await d.holdAt(ahead);
    const request = d.asked[asked];
    const straight =
      !!request?.to && request.from.segmentId === tip.segmentId && request.to.segmentId === tip.segmentId && request.to.atM! > request.from.atM! + 15;
    if (!straight) fail(press, "hold", `held 25m ahead of the tip, it asked ${JSON.stringify(request ?? null).slice(0, 160)}`);
    d.controller.touchEnded();
  }

  // Held on the street's other line, beside a segment already selected end to
  // end, it asks the server: the other way along a street is another line,
  // not the selection. At the middle of a whole segment the two lines' travel
  // metres meet, so a rule that forgot direction would swallow the hold there.
  let otherAsked = 0;
  const wholeSegments = selection.pieces.filter((p, i) => {
    const segment = segments.get(p.segmentId);
    return i < index && p.lengthM >= 30 && !!segment && p.fromM <= 1 && p.toM >= segment.lengthM - 1;
  });
  for (const p of wholeSegments.slice(0, 3)) {
    const other = segments.get(p.segmentId)!.directionalLines.find((l) => l.direction !== p.direction && l.colorStops.length > 0);
    if (!other || selection.pieces.some((q) => q.segmentId === p.segmentId && q.direction !== p.direction)) continue;
    const beside = turf.nearestPointOnLine(turf.lineString(other.geometry.coordinates), turf.point(finger(p.atM + p.lengthM / 2))).geometry
      .coordinates as [number, number];
    const hit = hitAt(d, beside, true);
    if (!onLine(hit, p.segmentId, other.direction)) continue;
    const asked = d.asked.length;
    await d.holdAt(hit);
    if (d.asked.length > asked) otherAsked += 1;
    else fail(press, "hold", `held on ${p.segmentId}:${other.direction} beside the selection, it was taken for the selection`);
    d.controller.touchEnded();
  }

  // Through the faded line under it, the tip and the middle of each piece
  // already selected carry the selection on: growth runs on from the tip, and
  // nothing is asked.
  const e = await letGo();
  const points = [
    tipM - 3,
    ...selection.pieces
      .filter((p, i) => i < index && p.source === "line" && p.lengthM >= 30 && drawnLine(p.segmentId, p.direction))
      .slice(0, 5)
      .map((p) => p.atM + p.lengthM / 2),
  ];
  let tried = 0;
  for (const m of points) {
    const at = pointOnPath(selection, m)!;
    const hit = hitAt(e, finger(m), false);
    // Where another line lies nearer the finger, the finger is on that line: not the case under test.
    if (!onLine(hit, at.segmentId, at.direction)) continue;
    tried += 1;
    const asked = e.asked.length;
    const grownBefore = e.controller.getSnapshot().grownM;
    await e.holdAt(hit);
    await e.advance(100);
    const now = e.controller.getSnapshot();
    if (e.asked.length !== asked || now.mode !== "holding" || now.grownM < grownBefore + 1) {
      const did =
        e.asked.length !== asked ? "asked the server" : now.mode !== "holding" ? `went ${now.mode}` : `grew ${(now.grownM - grownBefore).toFixed(1)}m`;
      fail(press, "hold", `held at ${m.toFixed(0)}m on ${at.segmentId}:${at.direction} through the line under it, it ${did} rather than carrying on`);
    }
    e.controller.touchEnded();
  }
  if (tried === 0) fail(press, "hold", "no point on the selection found its own line under it");
  return failures.length === before ? `; hold ok, ${tried} of ${points.length} carried on${otherAsked ? `, the other line asks (${otherAsked})` : ""}` : "; hold FAILED";
}

// The package is CommonJS (no "type": "module"), so the run is a function, not top-level awaits.
async function main() {
  const health = await get<{ builtAt: string }>("/health");
  console.log(`eval:selection against ${API_BASE_URL}, builtAt ${health.builtAt}, ${PRESSES} presses\n`);

  const random = seeded(17);
  const presses: Array<{ area: string; segment: SegmentWithGradients; line: SegmentWithGradients["directionalLines"][number] }> = [];
  const drawnIn = new Map<string, { segments: Map<number, SegmentWithGradients>; base: RenderedFeature[] }>();
  for (const area of AREAS) {
    const [minLon, minLat, maxLon, maxLat] = area.box;
    const { segments } = await get<{ segments: SegmentWithGradients[] }>(`/segments?minLon=${minLon}&minLat=${minLat}&maxLon=${maxLon}&maxLat=${maxLat}`);
    drawnIn.set(area.name, { segments: new Map(segments.map((s) => [s.id, s])), base: asRendered(buildColoredLineFeatures(segments).features) });
    const lines = segments
      .sort((a, b) => a.id - b.id)
      .flatMap((segment) => segment.directionalLines.filter((l) => l.colorStops.length > 0).map((line) => ({ area: area.name, segment, line })));
    const wanted = Math.ceil(PRESSES / AREAS.length);
    for (let i = 0; i < wanted && lines.length > 0; i++) presses.push(lines.splice(Math.floor(random() * lines.length), 1)[0]!);
    console.log(`${area.name}: ${segments.length} segments drawn, ${wanted} presses`);
  }
  console.log("");

  let flips = 0;
  let flipsOk = 0;
  for (const { area, segment, line } of presses.slice(0, PRESSES)) {
    const coordinates = line.geometry.coordinates;
    const mid = turf.along(turf.lineString(coordinates), turf.length(turf.lineString(coordinates), { units: "meters" }) / 2, { units: "meters" })
      .geometry.coordinates;
    const press = `${area} ${segment.id}:${line.direction}`;
    let response: PathResponse;
    try {
      response = await fetchPath({ from: { segmentId: segment.id, direction: line.direction, lon: mid[0]!, lat: mid[1]! } });
    } catch (err) {
      fail(press, "tiles", `no answer: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const selection = fromResponse(response);
    const before = failures.length;
    checkTiles(press, selection, selection.lengthM);
    checkHeights(press, selection);
    checkCard(press, selection);
    checkCuts(press, selection);
    checkFeatures(press, selection);
    checkScrub(press, selection);
    const limit = await checkLimit(press, selection);
    const flip = await checkFlip(press, selection);
    const { segments: drawnSegments, base } = drawnIn.get(area)!;
    const start: Hit = { lonLat: mid, zoom: 17, line: { segment, drawing: line }, piece: null, branch: null };
    const held = await checkHold(press, response, start, drawnSegments, base);
    flips += 1;
    if (flip.ok) flipsOk += 1;
    const stats = selectionStats(selection, selection.lengthM);
    console.log(
      `${failures.length === before ? "ok  " : "FAIL"} ${press.padEnd(24)} ${String(response.pieces.length).padStart(3)} pieces ${(response.lengthM / 1000).toFixed(2)}km ` +
        `${response.stop.reason}${limit}, climb ${stats.climbM.toFixed(1)}m, no data ${stats.noDataM.toFixed(0)}m; ${flip.note}${held}`,
    );
  }

  const sorted = [...timings].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? NaN;
  console.log(`\nlatency from this PC over ${sorted.length} path requests: median ${(pct(0.5) / 1000).toFixed(2)}s, p95 ${(pct(0.95) / 1000).toFixed(2)}s`);
  console.log(`flips: ${flipsOk} of ${flips} onto the same streets`);
  for (const f of failures) console.log(`  ${f.check.padEnd(8)} ${f.press}: ${f.detail}`);
  if (RECORD) fs.writeFileSync(RECORD, JSON.stringify(recorded));
  const pass = failures.length === 0 && flips > 0 && flipsOk / flips >= FLIP_PASS_SHARE;
  console.log(pass ? "PASS" : `FAIL: ${failures.length} check(s) failed, flips ${flipsOk}/${flips}`);
  return pass;
}

main().then(
  (pass) => process.exit(pass ? 0 : 1),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

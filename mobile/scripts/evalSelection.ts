// npm run eval:selection -- [presses]
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
//              unmeasured share make the whole distance
//   cuts       a cut at five points tiles to the cut, and ends as high as the
//              uncut profile is there
//   features   the map's features cover the path with no gap or overlap, each
//              the same share of its piece on the map as along the path
//   limit      a path stopped by its limit, asked again from the tip as the
//              phone asks, joins on with no step in height
//   flip       its first 800m flips onto the other direction's lines of the
//              same streets
// PASS: every check holds on every press, and at least 90% of flips succeed
// (a flip can fail honestly, where the other way has no connection the
// server will draw). Latency from this PC is reported, not judged.
import * as turf from "@turf/turf";
import { MAX_AVOID, pathQuery, type PathRequest } from "../src/services/api";
import { flipSelection } from "../src/services/flipSelection";
import {
  appendPath,
  cutAt,
  fromResponse,
  pointOnPath,
  selectionFeatures,
  selectionSegmentIds,
  selectionStats,
  type Selection,
} from "../src/services/pathSelection";
import { API_BASE_URL } from "../src/config";
import type { PathResponse, SegmentWithGradients } from "../src/types";

const PRESSES = Number(process.argv[2] ?? 16);
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
  const started = performance.now();
  const res = await fetch(`${API_BASE_URL}${path}`);
  const text = await res.text();
  if (path.startsWith("/segments/path")) timings.push(performance.now() - started);
  if (!res.ok) throw new Error(`${path.slice(0, 80)}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}
const fetchPath = (request: PathRequest) => get<PathResponse>(pathQuery(request));

type Check = "tiles" | "heights" | "card" | "cuts" | "features" | "limit" | "flip";
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

// The package is CommonJS (no "type": "module"), so the run is a function, not top-level awaits.
async function main() {
  const health = await get<{ builtAt: string }>("/health");
  console.log(`eval:selection against ${API_BASE_URL}, builtAt ${health.builtAt}, ${PRESSES} presses\n`);

  const random = seeded(17);
  const presses: Array<{ area: string; segment: SegmentWithGradients; line: SegmentWithGradients["directionalLines"][number] }> = [];
  for (const area of AREAS) {
    const [minLon, minLat, maxLon, maxLat] = area.box;
    const { segments } = await get<{ segments: SegmentWithGradients[] }>(`/segments?minLon=${minLon}&minLat=${minLat}&maxLon=${maxLon}&maxLat=${maxLat}`);
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
    const limit = await checkLimit(press, selection);
    const flip = await checkFlip(press, selection);
    flips += 1;
    if (flip.ok) flipsOk += 1;
    const stats = selectionStats(selection, selection.lengthM);
    console.log(
      `${failures.length === before ? "ok  " : "FAIL"} ${press.padEnd(24)} ${String(response.pieces.length).padStart(3)} pieces ${(response.lengthM / 1000).toFixed(2)}km ` +
        `${response.stop.reason}${limit}, climb ${stats.climbM.toFixed(1)}m, no data ${stats.noDataM.toFixed(0)}m; ${flip.note}`,
    );
  }

  const sorted = [...timings].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? NaN;
  console.log(`\nlatency from this PC over ${sorted.length} path requests: median ${(pct(0.5) / 1000).toFixed(2)}s, p95 ${(pct(0.95) / 1000).toFixed(2)}s`);
  console.log(`flips: ${flipsOk} of ${flips} onto the same streets`);
  for (const f of failures) console.log(`  ${f.check.padEnd(8)} ${f.press}: ${f.detail}`);
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

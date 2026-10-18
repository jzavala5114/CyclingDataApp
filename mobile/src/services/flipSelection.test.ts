import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { PathRequest } from "./api.js";
import { FLIP_CHUNK_M, FlipFailed, chunkLines, flipSelection, twinLines } from "./flipSelection.js";
import { fromResponse, selectionStats } from "./pathSelection.js";
import { makePath, type PieceSpec } from "./testPaths.js";

// The flip asks the server for the other direction's lines and must end up
// on exactly those streets, even where the cheapest connection would cut a
// corner. A fake server stands in: it answers each connection along the twin
// lines it was asked for, or, where told to, with a shortcut onto another
// street, the way a straight road beside a winding trail would.

function server(selected: PieceSpec[], shortcutOver = Infinity) {
  const requests: PathRequest[] = [];
  // The flipped order: the selection's segments reversed, each backward.
  const twins = [...selected].reverse();
  const fetchPath = async (request: PathRequest) => {
    requests.push(request);
    const from = twins.findIndex((p) => p.segmentId === request.from.segmentId);
    const to = request.to!.atM === 0 ? twins.findIndex((p) => p.segmentId === request.to!.segmentId) : twins.length;
    const lines = twins.slice(from, to);
    if (lines.length > shortcutOver) {
      return makePath([{ segmentId: 99, lengthM: 50, slopes: [0], direction: "backward", rule: "connect" }], { reason: "joined" });
    }
    return makePath(
      lines.map((l) => ({ segmentId: l.segmentId, lengthM: l.lengthM, slopes: [-l.slopes[0]!], direction: "backward" as const, rule: "connect" as const })),
      { reason: "joined" },
    );
  };
  return { fetchPath, requests };
}

const blocks = (count: number, lengthM = 100): PieceSpec[] =>
  Array.from({ length: count }, (_, i) => ({ segmentId: i + 1, lengthM, slopes: [2 + (i % 3)] }));

test("a flip runs the same streets the other way, each on its other line, in one request when short", async () => {
  const selected = blocks(3);
  const selection = fromResponse(makePath(selected));
  const { fetchPath, requests } = server(selected);
  const { selection: flipped, requests: count } = await flipSelection(selection, fetchPath);
  assert.equal(count, 1);
  assert.deepEqual(
    flipped.pieces.map((p) => [p.segmentId, p.direction]),
    [[3, "backward"], [2, "backward"], [1, "backward"]],
  );
  assert.equal(flipped.lengthM, 300);
  // Uphill one way is downhill the other: 2%, 3% and 4% each over 100m.
  const there = selectionStats(selection, 300);
  const back = selectionStats(flipped, 300);
  assert.ok(Math.abs(back.descentM - there.climbM) < 1e-9);
  assert.equal(back.climbM, 0);
  // The two ends are named by coordinate, measured by the server like a press.
  const only = requests[0]!;
  assert.equal(only.from.atM, undefined);
  assert.equal(only.to!.atM, undefined);
  assert.deepEqual([only.to!.lon, only.to!.lat], selection.pieces[0]!.geometry.coordinates[0]);
  assert.equal(only.grow, false);
});

test("a long flip is asked in chunks under the connection cap, joined at line starts", async () => {
  const selected = blocks(25); // 2.5km: 18 lines, then 7
  const selection = fromResponse(makePath(selected));
  const { fetchPath, requests } = server(selected);
  const { selection: flipped, requests: count } = await flipSelection(selection, fetchPath);
  assert.equal(count, 2);
  assert.deepEqual(
    flipped.pieces.map((p) => p.segmentId),
    Array.from({ length: 25 }, (_, i) => 25 - i),
  );
  const [first, second] = requests;
  assert.equal(first!.to!.segmentId, 7, "the first chunk asks to reach the start of the 19th line");
  assert.equal(first!.to!.atM, 0);
  assert.equal(second!.from.segmentId, 7);
  assert.equal(second!.from.atM, 0, "and the next chunk starts there");
  // Heights carry across the join: the profile runs on without a step.
  const join = flipped.spans[18]!;
  const before = flipped.spans[17]!;
  assert.ok(Math.abs(join.heightM - (before.heightM + before.riseM)) < 1e-9);
});

test("a chunk that comes back on other streets is split until each part follows its lines", async () => {
  const selected = blocks(6);
  const selection = fromResponse(makePath(selected));
  const { fetchPath, requests } = server(selected, 2);
  const { selection: flipped } = await flipSelection(selection, fetchPath);
  assert.deepEqual(
    flipped.pieces.map((p) => p.segmentId),
    [6, 5, 4, 3, 2, 1],
  );
  assert.ok(!flipped.pieces.some((p) => p.segmentId === 99), "the shortcut never joins the flip");
  // 6 lines -> 3 + 3 -> each 3 -> 1 + 2: 1 + 2 + 4 asks.
  assert.equal(requests.length, 7);
});

test("a single line that will not come back as itself fails the flip, rather than flip onto another street", async () => {
  const selected = blocks(2);
  const { fetchPath } = server(selected, 0);
  await assert.rejects(flipSelection(fromResponse(makePath(selected)), fetchPath), FlipFailed);
});

test("pieces of one segment flip as one line; chunks hold at most the cap", () => {
  const response = makePath([
    { segmentId: 1, lengthM: 40, slopes: [0] },
    { segmentId: 1, lengthM: 60, slopes: [0], source: "none", fromM: 40 },
    { segmentId: 2, lengthM: 100, slopes: [0] },
  ]);
  const lines = twinLines(fromResponse(response));
  assert.deepEqual(
    lines.map((l) => [l.segmentId, l.direction, l.lengthM]),
    [[2, "backward", 100], [1, "backward", 100]],
  );
  const long = Array.from({ length: 40 }, (_, i) => ({ segmentId: i, direction: "forward" as const, lengthM: 100, start: [0, 0] }));
  const chunks = chunkLines(long);
  assert.ok(chunks.every((c) => c.reduce((sum, l) => sum + l.lengthM, 0) <= FLIP_CHUNK_M));
  assert.equal(chunks.flat().length, 40);
});

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { collectAnchorResiduals, mergeRuns } from "./sessionProcessor.js";
import { savePassBuckets } from "./elevationAggregator.js";
import { demKey } from "./demElevation.js";
import type { Direction, Segment } from "../types/index.js";

// Gate tests for the half of the anchor that `anchorFit.test.ts` cannot reach.
//
// **Why this file exists again.** Its previous 22 tests all covered
// `collectRevisits`, `runElevationSource` and `siteKeyFor` -- the evidence path
// for the sliding drift anchor -- and went when that feature was removed, which
// left `sessionProcessor.ts` (the file that decides what is written to the
// model) with no tests at all.
//
// The claim the removal rests on is "this cannot move a stored elevation".
// `anchorFit.test.ts` proves the FIT reproduces main's `fitDemOffset` over
// 20,000 random inputs. It proves nothing about what is fed to the fit, and the
// residual builder is where order, the DEM key and the null-skip all live --
// and order is load-bearing, because a median over a list containing a
// non-finite value depends on it.

function run(
  segmentId: number,
  direction: Direction,
  buckets: Array<{ distanceM: number; elevationM: number }>,
) {
  return {
    segment: { id: segmentId } as Segment,
    direction,
    buckets,
    coveredFromM: 0,
    coveredToM: 100,
    firstSampleId: 1,
    lastSampleId: 2,
  };
}

const dem = (entries: Array<[number, Direction, number, number]>) =>
  new Map(
    entries.map(([segmentId, direction, distanceM, elevationM]) => [
      demKey({ segmentId, direction, distanceM }),
      elevationM,
    ]),
  );

test("a residual is our height minus the terrain model's, per bucket", () => {
  const residuals = collectAnchorResiduals(
    [run(1, "forward", [{ distanceM: 0, elevationM: 1810 }, { distanceM: 15, elevationM: 1812 }])],
    dem([[1, "forward", 0, 1800], [1, "forward", 15, 1800]]),
  );
  assert.deepEqual(residuals, [10, 12]);
});

test("buckets the terrain model has no value for are skipped, not zeroed", () => {
  // A missing DEM entry means "we do not know this ground", not "the ground is
  // at sea level". Treating it as 0 would put a ~1800m residual into the median.
  const residuals = collectAnchorResiduals(
    [run(1, "forward", [{ distanceM: 0, elevationM: 1810 }, { distanceM: 15, elevationM: 1812 }])],
    dem([[1, "forward", 0, 1800]]),
  );
  assert.deepEqual(residuals, [10]);
});

test("THE ORDER IS THE RUN ORDER, then the bucket order within each run", () => {
  // Load-bearing, not cosmetic. `fitAnchor` takes a median, and a median over a
  // list containing a non-finite value depends on where that value sits -- which
  // is the documented divergence from main in anchorFit.test.ts. Reordering
  // this loop would change the anchor on exactly those rides.
  const residuals = collectAnchorResiduals(
    [
      run(2, "backward", [{ distanceM: 0, elevationM: 1830 }]),
      run(1, "forward", [{ distanceM: 15, elevationM: 1812 }, { distanceM: 0, elevationM: 1810 }]),
    ],
    dem([
      [2, "backward", 0, 1800],
      [1, "forward", 0, 1800],
      [1, "forward", 15, 1800],
    ]),
  );
  assert.deepEqual(residuals, [30, 12, 10], "run order first, bucket order within");
});

test("direction is part of the terrain key, so the two directions do not share a reading", () => {
  // Each direction of a segment carries its own DEM samples. Dropping direction
  // from the key would make a backward pass read the forward ground.
  const residuals = collectAnchorResiduals(
    [run(1, "backward", [{ distanceM: 0, elevationM: 1810 }])],
    dem([[1, "forward", 0, 1700]]),
  );
  assert.deepEqual(residuals, [], "the forward entry must not answer a backward lookup");
});

test("a ride with no qualifying runs produces no residuals rather than throwing", () => {
  assert.deepEqual(collectAnchorResiduals([], dem([])), []);
  assert.deepEqual(collectAnchorResiduals([run(1, "forward", [])], dem([])), []);
});

test("a DEM height of exactly zero is a reading, not a miss", () => {
  // The skip tests `== null`, deliberately, so `0` survives it. `!reference`
  // would drop sea level and silently thin the sample.
  const residuals = collectAnchorResiduals(
    [run(1, "forward", [{ distanceM: 0, elevationM: 12 }])],
    dem([[1, "forward", 0, 0]]),
  );
  assert.deepEqual(residuals, [12]);
});

// ---- what a ride writes -------------------------------------------------------
//
// The map fits a slope to each pass's own rows only while they account for
// every pass in a window's means, so a pass row has to hold exactly what its
// mean was given. These hold mergeRuns to that, against a client that records
// every statement and answers the match insert with a fresh id, as Postgres
// would.

function recordingClient() {
  const statements: Array<{ text: string; values: unknown[] }> = [];
  let nextId = 7000;
  const client = {
    query: async (text: string, values: unknown[] = []) => {
      statements.push({ text, values });
      return { rows: /insert into session_segment_matches/.test(text) ? [{ id: nextId++ }] : [] };
    },
  };
  return { client: client as unknown as PoolClient, statements };
}

// The (distance, height) pairs one statement wrote, from its flat value list.
function written(values: unknown[], width: number, distanceAt: number) {
  const pairs: Array<[unknown, unknown]> = [];
  for (let i = 0; i < values.length; i += width) pairs.push([values[i + distanceAt], values[i + distanceAt + 1]]);
  return pairs;
}

test("THE PASS ROWS ARE WHAT WAS MERGED: same distances, same anchored heights, under the id the match insert returned", async () => {
  // Heights and anchor at full precision, as the barometer and fitAnchor give
  // them, so a pass row rounded to the centimetre no longer equals its mean's.
  const { client, statements } = recordingClient();
  await mergeRuns(
    client,
    84,
    [
      run(28974, "backward", [{ distanceM: 75, elevationM: 1930.537291 }, { distanceM: 90, elevationM: 1930.204817 }]),
      run(19410, "forward", [{ distanceM: 0, elevationM: 1901.013376 }]),
    ],
    22.318734,
  );

  // Per run: the means, the coverage, the match row, then the pass rows,
  // which need the match row's id.
  assert.deepEqual(
    statements.map((s) => s.text.match(/insert into (\w+)/)![1]),
    [
      "segment_elevation_buckets", "segment_coverage", "session_segment_matches", "segment_pass_buckets",
      "segment_elevation_buckets", "segment_coverage", "session_segment_matches", "segment_pass_buckets",
    ],
  );
  const matchInserts = statements.filter((s) => /insert into session_segment_matches/.test(s.text));
  for (const insert of matchInserts) assert.match(insert.text, /returning id/, "the id has to come back");

  const means = statements.filter((s) => /insert into segment_elevation_buckets/.test(s.text));
  const passRows = statements.filter((s) => /insert into segment_pass_buckets/.test(s.text));
  assert.deepEqual(
    written(means[0]!.values, 4, 2),
    [[75, 1930.537291 - 22.318734], [90, 1930.204817 - 22.318734]],
    "the means get the anchored heights",
  );
  for (const k of [0, 1]) {
    assert.deepEqual(written(passRows[k]!.values, 3, 1), written(means[k]!.values, 4, 2), `run ${k}: the pass rows hold what the means were given`);
    const matchIds = new Set(passRows[k]!.values.filter((_, i) => i % 3 === 0));
    assert.deepEqual(matchIds, new Set([7000 + k]), `run ${k}: filed under its own match row`);
  }
});

test("an unanchored ride files its pass rows as measured, like its means", async () => {
  const { client, statements } = recordingClient();
  await mergeRuns(client, 84, [run(28974, "backward", [{ distanceM: 75, elevationM: 1930.537291 }])], null);
  const passRows = statements.find((s) => /insert into segment_pass_buckets/.test(s.text))!;
  assert.deepEqual(passRows.values, [7000, 75, 1930.537291]);
});

test("a run with no buckets writes no pass rows, rather than a statement with no values", async () => {
  const { client, statements } = recordingClient();
  await savePassBuckets(client, 7000, []);
  assert.deepEqual(statements, []);
});

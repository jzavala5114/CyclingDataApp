import { strict as assert } from "node:assert";
import { test } from "node:test";
import { collectAnchorResiduals } from "./sessionProcessor.js";
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

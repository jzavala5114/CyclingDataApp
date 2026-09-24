// Put a ride on the terrain model's datum.
//
// One number for the whole ride: the median of (our height - the DEM's height)
// across every bucket whose ground the terrain model knows. Subtracting it
// leaves the ride's SHAPE untouched and moves only its level, which is the
// point -- the barometer measures slope well and absolute height not at all.
//
// Why a median and not a mean: a handful of buckets sit on ground the OSM
// centreline does not actually follow (singletrack especially), and their
// residuals are large and one-sided. A mean lets a few of those drag the whole
// ride's level; a median does not.
//
//   MIN_POINTS_FOR_ANCHOR  below this the level is being fit to noise, so the
//                          ride merges unanchored, which is what the model did
//                          before any anchoring existed.
//   MAX_PLAUSIBLE_OFFSET_M an answer larger than this is not weather and not a
//                          datum difference; it is a broken ride. Colorado's
//                          geoid separation is about -16m and the ellipsoid /
//                          orthometric gap is the whole reason a non-zero
//                          offset is normal, so the bound has to clear that
//                          comfortably without admitting nonsense.
//
// **There used to be a sliding version of this**, which fitted a drift RATE
// from places a ride covered twice and tilted the ride to remove it. It was
// built, guarded, tested and measured across three rounds and rejected by four
// independent reviews, every one finding the same defect class in a new place:
// evidence that was not independent counted as a quorum, and checks that could
// not fail reported as checks that passed. It was removed on 2026-09-23, never
// having been merged or deployed -- `allowRamp` defaulted to false for its
// entire life, so no saved ride was ever tilted.
//
// The full history, the reviews and the reasoning are in `context/session.md`
// under "The sliding anchor". Read that before rebuilding it. The short version
// is that the archive does not hold the evidence the feature needed: it reached
// two rides in thirty-seven, and every honest round of fixes shrank its reach
// because every round removed a way for thin evidence to look like strong
// evidence.
//
// This file is the single-number anchor that shipped all along.

// Below this the level is being fit to noise, so the ride merges unanchored.
export const MIN_POINTS_FOR_ANCHOR = 10;

// And an answer this large is a broken ride, not a datum difference.
export const MAX_PLAUSIBLE_OFFSET_M = 60;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Metres to SUBTRACT from every measurement in the ride, or null when the ride
// should merge unanchored.
//
// Takes bare residuals rather than a struct carrying timestamps. That is
// deliberate and it is the point of the removal: with no drift rate to fit,
// when a residual was measured cannot matter, and a signature that still
// carried the time would leave the door open to something reading it again.
export function fitAnchor(residualsM: number[]): number | null {
  // Non-finite residuals cannot arise from the caller, which builds them from
  // DEM lookups it has already null-checked. Filtered anyway, because a median
  // over a list containing NaN sorts unpredictably and would return a silently
  // wrong level rather than failing.
  const clean = residualsM.filter((r) => Number.isFinite(r));
  if (clean.length < MIN_POINTS_FOR_ANCHOR) return null;

  // **`!Number.isFinite` cannot fire, and is kept deliberately.** After the
  // filter above, `clean` holds only finite doubles, and a median of those is
  // either one of them or `(a + b) / 2` for two of them -- which is finite, or
  // `±Infinity` on overflow, but never NaN, because the sum of two finite
  // doubles is never NaN. `±Infinity` is then caught by the magnitude test
  // beside it. Confirmed by 500,000 inputs chosen to force the overflow: zero
  // reached this term.
  //
  // It stays because the domination is a consequence of the FILTER above rather
  // than of anything stated here -- remove that and this becomes load-bearing
  // the same day. Said out loud because an undocumented check that cannot fire
  // is the exact pattern this feature was rejected for four times.
  const offsetM = median(clean);
  if (!Number.isFinite(offsetM) || Math.abs(offsetM) > MAX_PLAUSIBLE_OFFSET_M) return null;
  return offsetM;
}

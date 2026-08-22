import type { TrackedSample } from "../types";

// Mean Earth radius (IUGG). Good to a few parts in 10^3 anywhere on the globe,
// which is far finer than GPS itself and much finer than the thresholds below.
const EARTH_RADIUS_M = 6371008.8;

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

function haversineM(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): number {
  const dLat = toRadians(bLat - aLat);
  const dLon = toRadians(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(aLat)) * Math.cos(toRadians(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

// How far the ride ever got from where it began.
//
// The obvious alternative -- summing the distance between consecutive fixes --
// cannot be used to decide whether a ride happened, because GPS noise does not
// cancel when accumulated. A phone lying still reports positions wandering a
// few metres per fix, and those hops add up without bound, so a long enough
// stand-still manufactures hundreds of metres of "distance travelled". Extent
// stays inside the accuracy circle however long you stand there.
//
// It is also preferable to start-to-end displacement, which collapses to zero
// on a loop ride that finishes where it started.
export function rideExtentM(samples: TrackedSample[]): number {
  if (samples.length < 2) return 0;
  const origin = samples[0];
  let furthest = 0;
  for (let i = 1; i < samples.length; i++) {
    const d = haversineM(origin.lat, origin.lon, samples[i].lat, samples[i].lon);
    if (d > furthest) furthest = d;
  }
  return furthest;
}

// Below this a ride is treated as a mis-tap or a test rather than something to
// keep. Comfortably above the ~10-20m a stationary phone drifts through, and
// well below any deliberate ride. Nothing is deleted on this number alone --
// it only decides whether to ask.
export const MIN_SAVEABLE_EXTENT_M = 75;

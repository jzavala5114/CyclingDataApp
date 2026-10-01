import { MIN_SPAN_M } from "./elevationAggregator.js";
import { MAX_MATCH_DISTANCE_M, STITCH_WINDOW_S } from "./segmentMatcher.js";
import type { Direction } from "../types/index.js";

// Which way a rider went over a segment, decided from geometry and time alone.
//
// This exists to judge the matcher without using it. The matcher decides
// direction from the heading each fix reports, with a bearing tolerance and a
// connectivity preference and hysteresis; if the question is "did the matcher
// miss a pass", asking the matcher is no answer. Projecting the raw fixes onto
// the centreline and watching the projection rise and fall uses none of that
// machinery -- no headings, no candidates, no gate.
//
// The 2026-09-02 measurement that found 3 of 8 out-and-backs losing a direction
// used this idea; this is that method, made reusable and testable.

/** How far a fix may sit from the centreline and still count as on it. */
export const CORRIDOR_M = MAX_MATCH_DISTANCE_M;

/** How much ground a pass must cover to count. The traversal gate's own span,
 * so a pass detected here is one the gate would accept if it were matched. */
export const MIN_PASS_M = MIN_SPAN_M;

// How far the projection must come back against the current direction before
// it counts as a turn rather than noise.
//
// One bucket. Below this a stationary rider's jitter -- a few metres of
// multipath at a traffic light -- would register as a turn and split one
// traversal into several; far above it a genuine short out-and-back at the end
// of a dead-end trail would be swallowed into one pass.
export const RETRACE_M = 15;

// A gap between two in-corridor fixes longer than this ends the pass.
//
// Without it, a rider who reaches the far end of a trail, spends twenty minutes
// elsewhere and comes back reads as ONE arrival: the second visit's first fix
// sits at the same distance as the first visit's last, the extreme simply
// advances through it, and the outbound pass is reported as ending twenty
// minutes after it really did. For a trace that asks "what was the matcher
// doing at this moment", that is the wrong moment.
//
// The matcher's own window for "these fragments are one traversal", so the
// passes found here are divided the same way the runs they are compared
// against are.
export const MAX_PASS_GAP_S = STITCH_WINDOW_S;

// A pass cannot be shorter than the retrace that establishes its direction: the
// detector does not know which way the rider is going until they have moved
// RETRACE_M, so a shorter leg is invisible however low `minPassM` goes. Holds
// at the defaults (25 >= 15) and is asserted in the tests, because lowering
// MIN_PASS_M below RETRACE_M would silently stop finding short passes rather
// than finding more of them.

/** A fix projected onto one segment's centreline. */
export interface ProjectedFix {
  /** Milliseconds, for ordering and for reporting when the pass happened. */
  atMs: number;
  /** Distance along the geometry from its first coordinate, in metres. */
  distanceM: number;
  /** Perpendicular distance from the centreline, in metres. */
  offsetM: number;
}

export interface Pass {
  direction: Direction;
  /** Distance along the GEOMETRY where the pass began and ended. */
  fromM: number;
  toM: number;
  /** Ground covered, always positive. */
  spanM: number;
  startedMs: number;
  endedMs: number;
  fixes: number;
}

/**
 * The passes a rider made over one segment.
 *
 * `fixes` must be in time order and already projected. Fixes outside the
 * corridor are dropped first: a rider on the next street over projects onto
 * this one perfectly well, and without the corridor every parallel street would
 * show a pass.
 *
 * Direction is in the geometry's frame, which is the matcher's too: travelling
 * from the first coordinate towards the last is `forward`.
 */
export function findPasses(
  fixes: readonly ProjectedFix[],
  {
    minPassM = MIN_PASS_M,
    retraceM = RETRACE_M,
    corridorM = CORRIDOR_M,
    maxGapS = MAX_PASS_GAP_S,
  } = {},
): Pass[] {
  const inside = fixes.filter(
    (f) => Number.isFinite(f.distanceM) && Number.isFinite(f.offsetM) && f.offsetM <= corridorM,
  );
  if (inside.length < 2) return [];

  const passes: Pass[] = [];
  let anchorIndex = 0; // where the current leg started
  let extremeIndex = 0; // furthest point reached in the current direction
  let heading: 1 | -1 | 0 = 0;

  const close = (endIndex: number) => {
    const anchor = inside[anchorIndex]!;
    const end = inside[endIndex]!;
    const spanM = Math.abs(end.distanceM - anchor.distanceM);
    if (spanM < minPassM) return;
    passes.push({
      direction: end.distanceM >= anchor.distanceM ? "forward" : "backward",
      fromM: anchor.distanceM,
      toM: end.distanceM,
      spanM,
      startedMs: anchor.atMs,
      endedMs: end.atMs,
      fixes: endIndex - anchorIndex + 1,
    });
  };

  for (let i = 1; i < inside.length; i++) {
    const fix = inside[i]!;

    // A long silence inside the corridor is the rider having been somewhere
    // else. Close whatever was open and start again from here, rather than
    // letting the next arrival extend the last departure.
    if ((fix.atMs - inside[i - 1]!.atMs) / 1000 > maxGapS) {
      close(extremeIndex);
      anchorIndex = i;
      extremeIndex = i;
      heading = 0;
      continue;
    }

    // Until the rider has gone somewhere, there is no direction to retrace
    // against. `retraceM` is the same threshold on the way in: a rider idling
    // at a light has not started a pass.
    if (heading === 0) {
      const moved = fix.distanceM - inside[anchorIndex]!.distanceM;
      if (Math.abs(moved) >= retraceM) {
        heading = moved > 0 ? 1 : -1;
        extremeIndex = i;
      }
      continue;
    }

    const advanced = (fix.distanceM - inside[extremeIndex]!.distanceM) * heading;
    if (advanced >= 0) {
      extremeIndex = i;
      continue;
    }
    if (-advanced < retraceM) continue; // noise against the direction of travel

    // A turn. The pass ends at the furthest point reached, not where the
    // retrace was noticed, or every pass would be reported `retraceM` short.
    close(extremeIndex);
    anchorIndex = extremeIndex;
    extremeIndex = i;
    heading = heading === 1 ? -1 : 1;
  }

  close(extremeIndex);
  return passes;
}

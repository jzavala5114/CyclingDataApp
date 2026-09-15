import type { Pool, PoolClient } from "pg";
import { MAX_PLAUSIBLE_GRADE_PCT } from "./elevationSmoothing.js";

// Which rides the model is allowed to learn from, decided from the data rather
// than from a list of ids in someone's head.
//
// Lives here rather than in rebuildModel.ts because anything that measures the
// model has to agree with it about which rides count. Measuring over every
// session in the table includes rides the model throws away, and a change that
// only moved those reads as a real gain or loss.

// Sessions recorded before the barometer/GPS anchoring fix hold elevations on
// a ride-relative scale (-12m..+2m) rather than absolute metres. Averaging
// those into absolute readings produced buckets around 900m and slopes of
// -6000%, and their raw samples cannot be converted after the fact. Rather
// than keep a list of bad session ids in someone's head, the scale itself is
// the test: anything below this is not an altitude above sea level.
export const MIN_PLAUSIBLE_ELEVATION_M = 1000;

// How much of a ride may be physically impossible before the ride itself is
// the problem. Individual bad fixes are dropped by rejectElevationSpikes(); a
// ride whose bad fixes are not the exception is not worth reprocessing around.
//
// **This replaced a median-roughness test, and the reasons are worth keeping.**
// That test claimed to detect rides recorded on GPS altitude rather than the
// barometer, sorting the archive into bands at 0.35-0.49m, 0.69-0.89m and
// 1.48-6.39m of median absolute second difference. Both halves of it failed.
//
// The premise is wrong: GPS altitude quantises to 0.1m and holds its value
// across fixes -- 53.9% of session 61's readings repeat the one before -- so it
// reads *smoother* than a working barometer, not rougher. Labelled data shows
// GPS session 56 at 0.259m against barometer session 62 at 0.564m. The bands
// were sorting rides by terrain, not by sensor: the rough ones are the mountain
// trails.
//
// And a median cannot see a spike. Measured by the share of steps implying a
// gradient past MAX_PLAUSIBLE_GRADE_PCT, the old threshold excluded sessions 46
// (3.8%) and 50 (3.2%) while keeping session 54 at 6.6% -- nearly twice as bad
// as either. Across every ride only 178 steps of 10,820 are impossible, 1.6%,
// so throwing away three whole rides to reach some of them was the wrong unit.
//
// Session 45 is the one ride that genuinely fails: a *median* implied gradient
// of 41.5% and a 99th percentile of 408%, with 20.7% of its steps impossible.
// That is not a ride with spikes in it, it is a ride that is spikes. The next
// worst is 6.6%, so this sits in open space rather than being tuned.
//
// Rides carrying elevation_source are exempt -- once a ride says what it used,
// guessing from noise is strictly worse.
export const MAX_IMPLAUSIBLE_STEP_SHARE = 0.15;

export interface SessionVerdict {
  id: number;
  samples: number;
  min_elev: number | null;
  bad_share: number | null;
  labelled: number;
  scale_ok: boolean;
  plausible_ok: boolean;
}

export async function loadSessionVerdicts(db: Pool | PoolClient): Promise<SessionVerdict[]> {
  const { rows } = await db.query<SessionVerdict>(
    `with steps as (
       select session_id,
              abs(elevation_m - lag(elevation_m) over w)
                / nullif(st_distance(
                    st_setsrid(st_makepoint(lag(lon) over w, lag(lat) over w), 4326)::geography,
                    st_setsrid(st_makepoint(lon, lat), 4326)::geography), 0) * 100 as grade_pct,
              st_distance(
                st_setsrid(st_makepoint(lag(lon) over w, lag(lat) over w), 4326)::geography,
                st_setsrid(st_makepoint(lon, lat), 4326)::geography) as ground_m
         from session_samples
       window w as (partition by session_id order by recorded_at)
     ),
     implausible as (
       -- Steps shorter than a metre are mostly GPS jitter, and dividing by them
       -- turns an ordinary reading into an infinite gradient.
       select session_id,
              avg(case when grade_pct > $2 then 1.0 else 0.0 end) as bad_share
         from steps where grade_pct is not null and ground_m > 1 group by session_id
     )
     select s.id,
            count(ss.id)::int as samples,
            min(ss.elevation_m) as min_elev,
            max(i.bad_share) as bad_share,
            count(ss.elevation_source)::int as labelled,
            coalesce(min(ss.elevation_m) >= $1, false) as scale_ok,
            -- A labelled ride is trusted on its own account; an unlabelled one
            -- has to pass the plausibility test. A ride too short to have any
            -- step is let through on the scale test.
            (count(ss.elevation_source) > 0
               or coalesce(max(i.bad_share) <= $3, true)) as plausible_ok
       from sessions s
       left join session_samples ss on ss.session_id = s.id
       left join implausible i on i.session_id = s.id
      group by s.id
     having count(ss.id) > 0
      order by s.id`,
    [MIN_PLAUSIBLE_ELEVATION_M, MAX_PLAUSIBLE_GRADE_PCT, MAX_IMPLAUSIBLE_STEP_SHARE],
  );
  return rows;
}

export const isUsable = (s: SessionVerdict) => s.scale_ok && s.plausible_ok;

export function whySkipped(s: SessionVerdict): string {
  return !s.scale_ok
    ? `min elevation ${s.min_elev?.toFixed(1)}m is not absolute`
    : `${((s.bad_share ?? 0) * 100).toFixed(1)}% of its steps imply a gradient past ${MAX_PLAUSIBLE_GRADE_PCT}% — the ride is spikes, not a ride with spikes in it`;
}

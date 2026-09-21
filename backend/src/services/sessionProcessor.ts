import type { PoolClient } from "pg";
import { matchSamplesToSegments, stitchFragmentedRuns } from "./segmentMatcher.js";
import {
  assessRun,
  mergeBuckets,
  mergeCoverage,
  MIN_COVERAGE,
  MIN_SPAN_M,
  type BucketSample,
} from "./elevationAggregator.js";
import { rejectElevationSpikes, smoothElevations } from "./elevationSmoothing.js";
import { demKey, ensureDemElevations, type DemPosition } from "./demElevation.js";
import { fitAnchor, MIN_POINTS_FOR_ANCHOR, type AnchorPoint, type Revisit } from "./anchorFit.js";
import type { Direction, ElevationSource, Segment, SessionSample } from "../types/index.js";

// Candidate segments come from a box around the session's own samples. Fine
// for a prototype where a session is one short ride.
const BBOX_PAD_DEG = 0.005; // ~500m

// One run the traversal gate rejected, with the measurements behind the
// decision. A rejection has two very different causes that a bare count cannot
// tell apart: a genuine intersection touch, which SHOULD be rejected, and a
// real traversal the matcher chopped into pieces too short to qualify, which
// should not. `stitchedSpanM` is what separates them -- it is how far this run
// and every other run on the same segment and direction reach between them, so
// a fragment shows a large stitched span while a touch stays near zero.
export interface DiscardedRun {
  segmentId: number;
  streetName: string | null;
  kind: string;
  direction: Direction;
  segmentLengthM: number;
  spanM: number;
  coverageFraction: number;
  sampleCount: number;
  // How many runs in this session landed on the same segment and direction.
  // More than one means the traversal was broken up.
  runsOnSameSegment: number;
  stitchedSpanM: number;
  stitchedWouldQualify: boolean;
  // Seconds between the previous run on this same segment+direction ending and
  // this one starting; null if this is the first. Fragments of one traversal
  // are separated by a dropped fix or two, so a few seconds. Two genuinely
  // separate crossings of the same block are minutes apart. This is the signal
  // that lets stitching tell them apart.
  gapToPreviousRunS: number | null;
}

export interface ProcessResult {
  matchedRuns: number;
  discardedRuns: number;
  // Metres subtracted from this ride to line it up with the terrain model,
  // taken at the middle of the measured window, or null if it merged
  // unanchored.
  demOffsetM: number | null;
  // How much that correction changed across the stretch of the ride the drift
  // was measured over -- not the whole ride, since the ramp is held flat
  // outside that window. Zero when the fit fell back to a single number. This
  // is the ride disagreeing with itself over time, measured from places it
  // covered twice, so it owes nothing to the terrain model.
  demDriftM: number | null;
  demAnchorShape: "ramp" | "constant" | null;
  demPoints: number;
  // Fixes dropped for claiming a physically impossible height. Reported so a
  // ride that is mostly spikes is visible rather than silently thinned.
  rejectedSpikes: number;
  // Diagnostics only -- never written to the database, and stripped from the
  // API response. The rebuild script aggregates these.
  discards: DiscardedRun[];
}

interface QualifyingRun {
  segment: Segment;
  direction: Direction;
  buckets: BucketSample[];
  coveredFromM: number;
  coveredToM: number;
  firstSampleId: number;
  lastSampleId: number;
  // When this traversal happened, so the anchor can vary through the ride.
  // The midpoint of the run, not per bucket: a run is one pass over one
  // segment, ten to thirty seconds, and the weather does not move in that.
  atMs: number;
  // Which instrument measured this pass. See `runElevationSource`.
  elevationSource: RunElevationSource;
  // The place this pass happened. See `siteKeyFor`.
  siteKey: string;
}

// A run's instrument: one source for the whole traversal, or "mixed" when the
// phone changed sensor part way through it.
//
// `null` is its own value rather than an absence, and it matches itself: rides
// recorded before session_samples.elevation_source existed are all null, and two
// passes from one such ride did come from the same instrument even though the
// row cannot say which. Treating null as unknowable would bar every pre-column
// ride from the drift fit forever, for a difference that does not exist within
// any one of them.
export type RunElevationSource = ElevationSource | "mixed" | null;

// Exported for its tests, not for callers. Every test in sessionProcessor.test.ts
// hands `collectRevisits` a literal `elevationSource` and `siteKey`, so the two
// functions that PRODUCE those values in production had no coverage at all: a
// review mutated both and the suite stayed green. The instrument rule is the
// guard that caught session 76 -- the one defect in this feature that was
// actively corrupting a real ride -- and it was resting on an untested mapping.
export function runElevationSource(samples: SessionSample[]): RunElevationSource {
  if (samples.length === 0) return "mixed";
  const first = samples[0].elevationSource ?? null;
  for (const sample of samples) {
    if ((sample.elevationSource ?? null) !== first) return "mixed";
  }
  return first;
}

// The place a pass happened, for the quorum in anchorFit.ts.
//
// Not the segment id. A segments row is one OSM way split at every intersection
// node and then cut into piece_index slices, so one street ridden past two
// junctions is three rows -- and counting those as three independent sites lets
// a single stretch of road form a quorum by itself.
//
// The street name is the best available name for "the same road", and the way id
// covers the unnamed case, where consecutive pieces of one trail or connector
// still share it. Both are coarse in the same direction: one long street ridden
// at two ends of town collapses to one site and the quorum refuses. That is the
// correct way to be wrong here, since every failure this gate exists for is a
// systematic error that repeats along one road.
export function siteKeyFor(segment: Pick<Segment, "streetName" | "osmWayId">): string {
  const name = segment.streetName?.trim();
  return name ? `name:${name}` : `way:${segment.osmWayId}`;
}

// Not one scalar per segment: fitting that finely would absorb the real terrain
// along with the error. These set the ride's overall level only -- the slope
// comes from the revisits below, for reasons set out in anchorFit.ts.
function collectAnchorPoints(runs: QualifyingRun[], dem: Map<string, number>): AnchorPoint[] {
  const points: AnchorPoint[] = [];
  for (const run of runs) {
    for (const bucket of run.buckets) {
      const reference = dem.get(
        demKey({ segmentId: run.segment.id, direction: run.direction, distanceM: bucket.distanceM }),
      );
      if (reference == null) continue;
      points.push({ atMs: run.atMs, residualM: bucket.elevationM - reference });
    }
  }
  return points;
}

// Every pair of passes over ground this ride covered twice, and how much its
// reading moved between them. Same segment, same direction, same 15m cell, so
// the hill and the terrain model's error at that spot both cancel and most of
// what is left is the barometer sliding. See anchorFit.ts for how much "most"
// is: this cancels the ground to within where in the cell each pass sampled and
// the smoothing's speed-dependent lag, not exactly.
//
// **One comparison per pair of passes, not per bucket.** A single out-and-back
// over one block touches four or five buckets, but they all share the same two
// moments and the same disagreement. Emitting one revisit per bucket let that
// single comparison satisfy a quorum meant to need three independent ones, and
// made a median of four copies of one number look like a robust estimate.
//
// **Directions are kept apart, and the second reason is why that is not just
// an indexing detail somebody should tidy up later.** The first reason is
// indexing: a bucket's distance is measured along the direction of travel, so
// forward 30m and backward 30m are opposite ends of the segment and not the
// same ground at all. That much could be repaired by pairing forward `d`
// against backward `lengthM - d`.
//
// The second used to be unrepairable and **no longer is.** It read: smoothing
// was a causal EMA, so the height reported for a spot was really the height a
// little way BACK along the direction of travel; two passes the same way round
// share that displacement and it mostly cancels, while two passes in opposite
// directions are displaced in OPPOSITE directions along the ground, making the
// term 2 x lag x grade -- around 1.2m on a 6% street even at identical speeds,
// signed by gradient rather than random, and larger than the floor the drift has
// to clear at all.
//
// smoothElevations is now a forward-backward pass with exactly zero lag, so that
// term is zero. The blocker is gone and the direction rule below is, for the
// moment, stricter than the physics requires.
//
// It stays anyway, because removing it is a change with its own measurement to
// do rather than a line to delete: the bucket index has to be flipped (forward
// `d` against backward `lengthM - d`), and the resulting revisits have to be
// shown to help before they are believed. The prize is real -- 21 long revisits
// across the archive are declined for direction against 30 kept, so this is
// close to doubling the evidence for a feature currently starved of it.
// **And the same instrument, for the same reason as the same direction.**
//
// The rule above says two passes cancel the ground only if they are displaced
// along it identically. Two passes cancel the *instrument* only if there is one
// instrument. expo-sensors stops delivering barometer readings when the screen
// locks, so a ride falls back to GPS altitude mid-way and back again -- the
// phone records which per sample, and `elevation_source` exists precisely
// because that swap was otherwise invisible.
//
// Comparing a GPS-altitude pass against a barometric one measures the offset
// between two sensors, not the movement of one. That offset is not a constant
// either: GPS vertical error moves with satellite geometry and terrain, so it
// varies along the route, and the comparison reads as a drift that grows with
// distance rather than with time.
//
// Measured, on session 76: two laps of Culebras Trail, lap one inside a GPS
// stretch and lap two on the barometer, producing rises from -3.49m at the head
// of the trail to -17.96m at its end while every gap was 31 to 32 minutes. A
// barometer sliding with the weather gives the SAME rise for every pair with the
// same gap; a rise that tracks position instead is the tell. The fit called that
// -25.46 m/h and asked to tilt the ride 20m. Every guard passed it: the pairs
// agreed on sign, cleared the meaningfulness floor, covered 15 distinct sites
// and sat inside the rate cap.
//
// **And it has to be the barometer, not merely the same sensor twice.**
//
// Matching sources is necessary and not sufficient. Two GPS-altitude passes
// agree on their instrument and still measure nothing useful: there is no
// barometer in the loop, so there is no pressure drift to find, and what a fit
// would read instead is GPS vertical error moving between the two moments. The
// satellite constellation over thirty to seventy minutes is not the
// constellation at the start, and the argument above -- that GPS error varies
// with geometry -- applies to time exactly as it applies to place.
//
// So a pure-GPS ride can produce a confident ramp out of constellation wander,
// and had both of session 76's laps fallen inside its GPS stretch rather than
// straddling the switch, every rule here would have let it through.
//
// Null is the pre-column case and is excluded by the same reasoning, reluctantly
// but correctly: those rides cannot show they had a working barometer, and a
// drift fit is a claim about one. They keep the single number, which is what
// they have always had.
//
// The cost is the honest kind: rides that switch source lose the revisits that
// straddle the switch, not the ones on either side of it.
export function collectRevisits(
  runs: Array<{
    segmentId: number;
    direction: Direction;
    atMs: number;
    buckets: BucketSample[];
    // Required, not optional. When this was optional a caller that forgot it got
    // `undefined`, which fell through `?? "unknown"` into a key shared with the
    // pre-column case and silently switched the instrument guard off instead of
    // failing to compile.
    elevationSource: RunElevationSource;
    siteKey: string;
  }>,
): Revisit[] {
  const byBucket = new Map<string, Array<{ run: number; elevationM: number }>>();
  runs.forEach((run, index) => {
    // Anything that is not a whole pass on the barometer is no use as either
    // half of a comparison: "mixed" cannot be attributed to an instrument at
    // all, "gps" has no barometer to measure, and null cannot say.
    if (run.elevationSource !== "barometer") return;
    for (const bucket of run.buckets) {
      // Segment, direction and distance. The source no longer needs to be in the
      // key now that only barometer runs reach here at all, and leaving it out
      // keeps the key saying exactly what it means: the same ground, the same
      // way round.
      const key = `${run.segmentId}|${run.direction}|${bucket.distanceM}`;
      const readings = byBucket.get(key);
      const reading = { run: index, elevationM: bucket.elevationM };
      if (readings) readings.push(reading);
      else byBucket.set(key, [reading]);
    }
  });

  // Every bucket two passes share contributes one rise to that pair of passes.
  //
  // **Adjacent passes only, not every pair.** N passes over one cell contain
  // N-1 independent increments, but there are N(N-1)/2 ways to pair them up and
  // the extra ones carry no new information: for passes at t1 < t2 < t3, the
  // t1->t3 rise is exactly the t1->t2 rise plus the t2->t3 rise. Emitting all
  // three let three passes over a single 15m cell clear a quorum written to
  // need three independent observations -- two increments wearing three hats.
  // That is the same defect the comment above says this function prevents, one
  // level up: fixed there for buckets within a pair, missed here for passes
  // within a cell. `three passes over one block` in sessionProcessor.test.ts
  // asserted the broken behaviour as correct, which is how it survived review.
  //
  // Sorted by time rather than trusting `runs` order, because the caller builds
  // runs per segment and nothing guarantees they arrive chronologically.
  const risesByPair = new Map<string, number[]>();
  for (const readings of byBucket.values()) {
    if (readings.length < 2) continue;
    const inTimeOrder = [...readings].sort((a, b) => runs[a.run].atMs - runs[b.run].atMs);
    for (let i = 0; i + 1 < inTimeOrder.length; i++) {
      const early = inTimeOrder[i];
      const late = inTimeOrder[i + 1];
      const key = `${early.run}|${late.run}`;
      const rise = late.elevationM - early.elevationM;
      const rises = risesByPair.get(key);
      if (rises) rises.push(rise);
      else risesByPair.set(key, [rise]);
    }
  }

  const revisits: Revisit[] = [];
  for (const [key, rises] of risesByPair) {
    const [earlyIndex, lateIndex] = key.split("|").map(Number);
    // The median across the buckets the two passes share, so one bad cell in a
    // long shared stretch cannot set the comparison.
    const sorted = [...rises].sort((x, y) => x - y);
    const mid = Math.floor(sorted.length / 2);
    revisits.push({
      earlyAtMs: runs[earlyIndex].atMs,
      lateAtMs: runs[lateIndex].atMs,
      riseM: sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid],
      buckets: rises.length,
      // Where the comparison was made. Both runs in a pair necessarily share a
      // segment and direction -- the cell key they were grouped under contains
      // both -- so either run names the place.
      segmentId: runs[earlyIndex].segmentId,
      siteKey: runs[earlyIndex].siteKey,
    });
  }
  return revisits;
}

// Map-matches a session's samples against nearby segments and folds the
// result into the persistent elevation model.
//
// Shared by POST /sessions/:id/end and the offline rebuild, so that
// reprocessing old rides goes through exactly the same matching, gating and
// averaging as a ride coming off the phone -- a rebuild that drifted from the
// live path would quietly produce a model the app could never reproduce.
//
// Everything runs on the caller's client so the whole thing is one
// transaction: a session either lands in the model completely or not at all.
export async function processSession(
  client: PoolClient,
  sessionId: number,
): Promise<ProcessResult> {
  const { rows: sampleRows } = await client.query<SessionSample>(
    `select id, session_id as "sessionId", recorded_at as "recordedAt", lat, lon,
            elevation_m as "elevationM", elevation_source as "elevationSource",
            altitude_accuracy_m as "altitudeAccuracyM", heading_deg as "headingDeg",
            speed_mps as "speedMps", accuracy_m as "accuracyM"
       from session_samples where session_id = $1 order by recorded_at`,
    [sessionId],
  );

  if (sampleRows.length === 0) {
    return {
      matchedRuns: 0, discardedRuns: 0, demOffsetM: null, demDriftM: null,
      demAnchorShape: null, demPoints: 0, rejectedSpikes: 0, discards: [],
    };
  }

  const lats = sampleRows.map((s) => s.lat);
  const lons = sampleRows.map((s) => s.lon);
  const { rows: segmentRows } = await client.query<Segment>(
    `select id, osm_way_id as "osmWayId", kind, street_name as "streetName",
            start_node_id as "startNodeId", end_node_id as "endNodeId",
            piece_index as "pieceIndex",
            ST_AsGeoJSON(geom)::json as geom, length_m as "lengthM", bearing_deg as "bearingDeg"
       from segments
      where geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
        -- Sidewalks are represented by the road they run alongside, so only
        -- canonical geometry is a match candidate. Riding the sidewalk still
        -- matches, via the parent road a few metres away.
        and canonical_segment_id is null`,
    [
      Math.min(...lons) - BBOX_PAD_DEG,
      Math.min(...lats) - BBOX_PAD_DEG,
      Math.max(...lons) + BBOX_PAD_DEG,
      Math.max(...lats) + BBOX_PAD_DEG,
    ],
  );

  // Spikes are removed before the EMA, not after: smoothing an impossible
  // reading spreads it over the fixes around it instead of deleting it, so by
  // the time it reaches the buckets it has contaminated its neighbours too.
  const { kept, rejected: rejectedSpikes } = rejectElevationSpikes(sampleRows);
  const smoothed = smoothElevations(kept);
  // Rejoined before gating, not after: the gate judges whether a run covered
  // ground, and a traversal chopped into pieces cannot answer that honestly.
  const runs = stitchFragmentedRuns(matchSamplesToSegments(smoothed, segmentRows));
  const segmentsById = new Map(segmentRows.map((s) => [s.id, s]));
  // Used to hand each run the fix either side of it, so a short segment
  // crossed between two fixes can still be shown to have been ridden.
  const orderById = new Map(smoothed.map((s, i) => [s.id, i]));

  // Bucket everything first and write nothing yet: the anchor offset is fit
  // across the whole ride, so no part of it can be merged until all of it has
  // been measured.
  const qualifying: QualifyingRun[] = [];
  const rejected: Array<{ run: (typeof runs)[number]; segment: Segment; assessment: ReturnType<typeof assessRun> }> = [];
  // Every run's reach along its segment, kept per segment+direction so a
  // traversal broken into fragments can be recognised afterwards.
  const reachByKey = new Map<string, { from: number; to: number; runs: number }>();
  const keyFor = (segmentId: number, direction: Direction) => `${segmentId}|${direction}`;
  // When the previous run on each segment+direction finished, so the gap to the
  // next one can be measured. Runs arrive in chronological order.
  const lastEndByKey = new Map<string, number>();
  const gapByRun = new Map<(typeof runs)[number], number | null>();

  for (const run of runs) {
    const segment = segmentsById.get(run.segmentId);
    if (!segment) continue;
    // Runs that only clipped a segment -- crossing it at an intersection, or
    // sitting at a light beside it -- are dropped rather than merged, so they
    // can't invent a gradient line for a street that was never ridden.
    const firstIndex = orderById.get(run.samples[0].id) ?? 0;
    const lastIndex = orderById.get(run.samples[run.samples.length - 1].id) ?? 0;
    const assessment = assessRun(run, segment, {
      before: firstIndex > 0 ? smoothed[firstIndex - 1] : undefined,
      after: lastIndex < smoothed.length - 1 ? smoothed[lastIndex + 1] : undefined,
    });
    const { profile } = assessment;

    const key = keyFor(segment.id, run.direction);
    const reach = reachByKey.get(key) ?? { from: Infinity, to: -Infinity, runs: 0 };
    reach.from = Math.min(reach.from, profile.coveredFromM);
    reach.to = Math.max(reach.to, profile.coveredToM);
    reach.runs += 1;
    reachByKey.set(key, reach);

    const startedMs = Date.parse(run.samples[0].recordedAt);
    const endedMs = Date.parse(run.samples[run.samples.length - 1].recordedAt);
    const previousEndMs = lastEndByKey.get(key);
    gapByRun.set(run, previousEndMs == null ? null : (startedMs - previousEndMs) / 1000);
    lastEndByKey.set(key, endedMs);

    if (!assessment.qualified) {
      rejected.push({ run, segment, assessment });
      continue;
    }
    qualifying.push({
      segment,
      direction: run.direction,
      buckets: profile.buckets,
      coveredFromM: profile.coveredFromM,
      coveredToM: profile.coveredToM,
      firstSampleId: run.samples[0].id,
      lastSampleId: run.samples[run.samples.length - 1].id,
      atMs: (startedMs + endedMs) / 2,
      elevationSource: runElevationSource(run.samples),
      siteKey: siteKeyFor(segment),
    });
  }

  // Filled in after the loop because the stitched reach isn't known until every
  // run has been seen.
  const discards: DiscardedRun[] = rejected.map(({ run, segment, assessment }) => {
    const reach = reachByKey.get(keyFor(segment.id, run.direction))!;
    const stitchedSpanM = Math.max(0, reach.to - reach.from);
    const stitchedFraction = segment.lengthM > 0 ? stitchedSpanM / segment.lengthM : 0;
    return {
      segmentId: segment.id,
      streetName: segment.streetName,
      kind: segment.kind,
      direction: run.direction,
      segmentLengthM: segment.lengthM,
      spanM: assessment.spanM,
      coverageFraction: assessment.coverageFraction,
      sampleCount: run.samples.length,
      runsOnSameSegment: reach.runs,
      stitchedSpanM,
      stitchedWouldQualify: stitchedSpanM >= MIN_SPAN_M || stitchedFraction >= MIN_COVERAGE,
      gapToPreviousRunS: gapByRun.get(run) ?? null,
    };
  });

  const positions: DemPosition[] = qualifying.flatMap((run) =>
    run.buckets.map((bucket) => ({
      segmentId: run.segment.id,
      direction: run.direction,
      distanceM: bucket.distanceM,
    })),
  );
  const dem = await ensureDemElevations(client, positions);
  // No `allowRamp`, so this is the single-number anchor -- deliberately, and
  // this is the line that decides it for every ride the app saves.
  //
  // The sliding ramp is implemented, guarded and tested in anchorFit.ts, and it
  // is switched off here because it was measured and it loses: every ride it
  // touched came out worse on all three eval measures. See FitOptions.
  //
  // The revisits are still collected and still passed. They cost one pass over
  // the buckets, they are what `npm run eval:anchor` re-measures this decision
  // with, and a future reader turning the ramp on should find the evidence path
  // intact rather than have to rebuild it.
  const anchor = fitAnchor(
    collectAnchorPoints(qualifying, dem),
    collectRevisits(qualifying.map((r) => ({
      segmentId: r.segment.id, direction: r.direction, atMs: r.atMs, buckets: r.buckets,
      elevationSource: r.elevationSource, siteKey: r.siteKey,
    }))),
  );
  const demPoints = positions.filter((p) => dem.has(demKey(p))).length;
  if (anchor == null) {
    // Distinguish the two causes, because they call for opposite responses: too
    // little terrain is a coverage problem, an implausible offset is a broken
    // ride. Carrying the number is what made the old warning actionable.
    const covered = collectAnchorPoints(qualifying, dem);
    console.warn(
      covered.length < MIN_POINTS_FOR_ANCHOR
        ? `only ${covered.length} DEM points, merging unanchored`
        : `DEM offset is implausible over ${covered.length} points, merging unanchored`,
    );
  }

  for (const run of qualifying) {
    // Evaluated at this run's own moment, so a ride that slid during the hour
    // is put back on one level instead of being tilted around its average.
    const correctionM = anchor?.offsetAt(run.atMs);
    await mergeBuckets(
      client,
      run.segment.id,
      run.direction,
      correctionM == null
        ? run.buckets
        : run.buckets.map((b) => ({ ...b, elevationM: b.elevationM - correctionM })),
    );
    await mergeCoverage(client, run.segment.id, run.direction, run.coveredFromM, run.coveredToM);
    await client.query(
      `insert into session_segment_matches
         (session_id, segment_id, direction, first_sample_id, last_sample_id)
       values ($1, $2, $3, $4, $5)`,
      [sessionId, run.segment.id, run.direction, run.firstSampleId, run.lastSampleId],
    );
  }

  return {
    matchedRuns: qualifying.length,
    discardedRuns: runs.length - qualifying.length,
    demOffsetM: anchor?.midM ?? null,
    demDriftM: anchor?.driftM ?? null,
    demAnchorShape: anchor?.shape ?? null,
    demPoints,
    rejectedSpikes: rejectedSpikes.length,
    discards,
  };
}

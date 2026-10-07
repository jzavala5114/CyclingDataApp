import "dotenv/config";
import { pathToFileURL } from "node:url";
import { pool } from "../db/pool.js";

// Did the barometer stay alive with the screen off?
//
// READ ONLY. Every statement here is a select, so it is safe against the live
// database and safe to run while a ride is uploading.
//
// This exists because the change it judges cannot be judged any other way. The
// barometer dying on a locked screen is a phone behaviour: no replay of the
// archive reaches it, no unit test reaches it, and the only instrument is a
// ride. So the verdict has to come from a script rather than from reading the
// numbers by eye, or "it looked better" becomes the measurement.
//
//   npm run verify-barometer
//   npm run verify-barometer -- --session 65
//   npm run verify-barometer -- --reference 62
//
// WHAT TO DO WITH IT. Ride with the screen deliberately locked for a few
// minutes in the middle, save the ride, then run this. The ride passes if the
// verdict is `alive` and its barometer share is close to the reference's.
//
// Read `alive` next to the `unseen` column, always. The verdict covers the part
// of the ride that produced fixes; `unseen` is the part that produced none and
// so could not testify either way. A verdict of `unmeasured` means there was not
// enough ride left to conclude anything at all -- ride again.

// Session 62 is the screen-on reference: 842 fixes, 829 distinct elevations,
// 100% barometer. It is what a ride looks like when the sensor never stopped,
// and it was recorded before any of this work, so it cannot have been tuned to.
const DEFAULT_REFERENCE_SESSION = 62;

// Two consecutive fixes holding the same elevation to the millimetre. GPS
// altitude quantises to 0.1m and repeats constantly -- 53.9% of session 61's
// readings repeat the one before -- while a barometer at 0.01 hPa resolution
// almost never does, 1.5% on session 62.
//
// This is the independent check on `elevation_source`. The column is written by
// the phone and says what the phone believed; the repeat share is in the values
// themselves. A ride claiming 100% barometer with a GPS-like repeat share means
// the native module registered the listener and then got nothing, which is a
// failure the label alone would report as success.
//
// Deliberately NOT a roughness or median-second-difference measure. That was
// tried and is disproved in usableSessions.ts:24-35: because GPS holds its
// value across fixes it reads *smoother* than a working barometer, so the bands
// it produced were sorting rides by terrain, not by sensor.
const REPEAT_IS_SUSPICIOUS_ABOVE = 0.2;

// A locked screen today kills the barometer within 11-19 seconds and it stays
// dead until the next wake, so the signature is one long unbroken stretch of
// GPS rather than scattered single fixes. Anything past this is that signature
// and not a momentary gap.
const LONG_GPS_RUN_S = 30;

// How much of the gap either side of a GPS stretch may be charged to the
// barometer, as a multiple of the ride's OWN median gap between fixes.
//
// THE CAP IS NOT COSMETIC. Without one, bracketing a run by the nearest
// barometer fix on each side charges the barometer for time when the ride was
// not recording at all. Measured against the live archive, sessions 68, 69, 81
// and 82 each reported a ONE-FIX GPS stretch lasting 34s, 117s, 523s and 196s;
// all four were reported as having lost the barometer when they had not.
//
// BUT A FIXED CAP IS WORSE THAN NO CAP, and the first version of this file used
// one (10 seconds). A cold review broke it in both directions at once: a
// one-fix GPS stretch inside a nine-minute, a fifteen-minute or a one-hour
// barometer blackout was charged exactly 20s every time and reported `alive`,
// while an honest 20-second blip containing two fixes was charged 40s and
// reported `stopped`. The verdict was tracking how often GPS reported, not
// whether the barometer worked, which is the one thing it exists to measure.
//
// Taking the cap from the ride's own fix cadence fixes both: on a ride with
// fixes 2s apart the bracket is ~4s, so the 20-second blip reads as ~24s and
// passes, and the one-fix blackout reads as ~4s -- but the nine minutes with no
// fixes in it is then counted as UNMEASURED below rather than as a pass.
const BRACKET_GAP_MULTIPLE = 2;
// A floor, so a ride with sub-second fixes cannot produce a zero-width bracket,
// and a fallback for a ride too short to have a median.
export const MIN_BRACKET_S = 2;

// A stretch with no fixes at all this long says NOTHING about the barometer:
// there was no sample to record a source on. Counting it as healthy is how a
// blackout gets signed off, and counting it as an outage is how a trailhead
// pause does. It is counted as neither, and never charged as silence. Set to
// the same threshold as a long GPS run, because a gap that could hide an outage
// is exactly a gap long enough to be one.
const UNMEASURED_GAP_S = 30;

// How much of a ride may be unmeasured before no verdict can be given on it.
//
// This is the `no-witness` idea the heading-lines work already settled in this
// project: silence from a witness that could not have spoken is not evidence,
// and it gets its own verdict rather than being counted as either outcome.
//
// MEASURED, NOT CHOSEN. Every labelled ride in the archive was scored, and gaps
// with no fixes turn out to be completely ordinary: shares of 0%, 2.1%, 6.5%,
// 9.6%, 11.8%, 12.9%, 14.1%, 14.2%, 14.5%, 16.3%, 16.7%, 16.8%, 17.4%, 18.9%,
// 20.8%, 22.3%, 23.6%, 24.4%, 34.5% and 43.7%, with no gap in the distribution
// to cut at. Session 62 -- the 100%-barometer screen-on reference -- sits at
// 9.6%, so a tighter bar would fail the one ride known to be good, which is how
// an instrument gets ignored.
//
// So this is not "how much was missed", it is "is there enough ride left to
// conclude anything at all". Half. That sits above the archive's worst (43.7%,
// session 56) in open space rather than being tuned to it, and the ordinary
// caveat -- some of the ride was invisible -- is carried by the `unmeas` column
// and the per-minute strip, which are printed for every ride either way.
const UNMEASURED_SHARE_LIMIT = 0.5;

export interface SampleRow {
  sessionId: number;
  recordedAt: string;
  elevationM: number;
  elevationSource: "barometer" | "gps" | null;
  altitudeAccuracyM: number | null;
}

export interface GpsRun {
  fixes: number;
  startedAt: string;
  endedAt: string;
  /** From the run's first GPS fix to its last. Zero for a run of one fix. */
  ownSeconds: number;
  /** `ownSeconds` plus the gap to the barometer fix either side, each capped at
   *  the ride's own bracket. This is the number the verdict uses: how long the
   *  barometer was silent while the ride was actually recording. */
  seconds: number;
}

export interface SessionReport {
  sessionId: number;
  startedAt: string | null;
  fixes: number;
  labelled: number;
  barometerFixes: number;
  /** Share of LABELLED fixes on the barometer. Null when nothing is labelled,
   *  which is what a ride from before the column existed looks like -- not the
   *  same thing as a ride that got no barometer. */
  barometerShare: number | null;
  distinctElevations: number;
  /** Over every consecutive pair, whatever the source. Context only: on a ride
   *  that is mostly GPS this is high because GPS is repetitive, which says
   *  nothing about the barometer. */
  repeatShare: number | null;
  /** Over consecutive pairs where BOTH fixes are barometer-labelled. This is
   *  the one the verdict uses, because it is the only one that isolates the
   *  question "are the barometer readings actually barometric". */
  barometerRepeatShare: number | null;
  longestGpsRun: GpsRun | null;
  gpsRunsOver30s: number;
  /** Median seconds between consecutive fixes. The bracket is derived from it,
   *  so it is reported rather than hidden. */
  medianGapS: number | null;
  /** Total seconds inside gaps longer than UNMEASURED_GAP_S. Time the ride
   *  produced no fixes, so nothing is known about the barometer across it.
   *  Neither a pass nor a failure, and the reason the verdict has its own word
   *  for it. */
  unmeasuredS: number;
  unmeasuredGaps: number;
  /** The single longest gap with no fixes in it, seconds. This is what the
   *  verdict reads: many short pauses cannot hide a continuous outage, one long
   *  gap can. */
  longestUnmeasuredGapS: number;
  /** `unmeasuredS` over the ride's duration. The verdict reads this, not the
   *  total: a 34s gap in an hour-long ride and a nine-minute hole in a
   *  twenty-minute one are not the same finding. */
  unmeasuredShare: number | null;
  medianAltitudeAccuracyM: number | null;
  durationS: number | null;
}

function median(values: number[]): number | null {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The whole measurement, as a pure function of a session's fixes.
 *
 * Pure so that the cases that matter -- an unlabelled ride, a ride of one fix,
 * a ride that is entirely GPS -- are pinned by tests rather than by waiting for
 * one to turn up in the archive.
 *
 * `rows` must be ordered by `recordedAt`. The caller's query does that; a run
 * computed over unordered rows would report a long GPS stretch wherever the
 * ordering happened to clump, so this is an ordering the tests pin too.
 */
export function reportFor(sessionId: number, rows: readonly SampleRow[]): SessionReport {
  const labelled = rows.filter((r) => r.elevationSource != null);
  const barometerFixes = rows.filter((r) => r.elevationSource === "barometer").length;

  // Repeats are counted over consecutive pairs, so a ride of one fix has no
  // pairs and gets null rather than 0 -- "no repeats" and "nothing to compare"
  // are different answers and only one of them is evidence.
  //
  // Counted twice, over all pairs and over barometer-only pairs, because the
  // two answer different questions and the first one misled me. Session 61 is
  // 6.5% barometer and repeats 53.9% of its heights; read over all pairs that
  // looks like a stuck barometer, when it is just the 93.5% of the ride that is
  // GPS behaving the way GPS behaves.
  let repeats = 0;
  let pairs = 0;
  let baroRepeats = 0;
  let baroPairs = 0;
  for (let i = 1; i < rows.length; i++) {
    const current = rows[i]!;
    const previous = rows[i - 1]!;
    const same = current.elevationM === previous.elevationM;
    pairs++;
    if (same) repeats++;
    if (current.elevationSource === "barometer" && previous.elevationSource === "barometer") {
      baroPairs++;
      if (same) baroRepeats++;
    }
  }

  // The ride's own fix cadence, which sets the bracket below and is also what
  // separates "sparse fixes" from "a barometer outage". Taken as a median
  // rather than a mean because one twelve-minute pause at a trailhead would
  // drag a mean past every real interval on the ride.
  const gapsS: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    gapsS.push((Date.parse(rows[i]!.recordedAt) - Date.parse(rows[i - 1]!.recordedAt)) / 1000);
  }
  const medianGapS = median(gapsS);
  const bracketS = Math.min(
    UNMEASURED_GAP_S,
    Math.max(MIN_BRACKET_S, (medianGapS ?? MIN_BRACKET_S) * BRACKET_GAP_MULTIPLE),
  );

  // Time the ride recorded nothing. Charged to neither side.
  const longGaps = gapsS.filter((g) => g >= UNMEASURED_GAP_S);
  const unmeasuredS = longGaps.reduce((total, g) => total + g, 0);

  /**
   * How much of one gap either side of a GPS stretch is the barometer's fault.
   *
   * A gap past UNMEASURED_GAP_S buys nothing: there were no fixes in it, so
   * there is no evidence either way, and charging it as silence is how a ride
   * that paused at a trailhead gets reported as a failure. It is counted in
   * `unmeasuredS` instead, which is a different and honest answer.
   */
  const chargeableS = (gapS: number) =>
    gapS >= UNMEASURED_GAP_S ? 0 : Math.min(gapS, bracketS);

  // Runs are built over GPS fixes only. A run's silence runs from the barometer
  // fix before it to the one after, because the sensor went quiet somewhere in
  // those gaps and the run's own ends understate it by a fix interval at each
  // end -- but each gap is capped at `bracketS`, or a ride that simply stopped
  // producing fixes gets charged for the pause. See BRACKET_GAP_MULTIPLE.
  const runs: GpsRun[] = [];
  let runStart = -1;
  for (let i = 0; i <= rows.length; i++) {
    const isGps = i < rows.length && rows[i]!.elevationSource === "gps";
    if (isGps && runStart === -1) runStart = i;
    if (!isGps && runStart !== -1) {
      const firstGpsMs = Date.parse(rows[runStart]!.recordedAt);
      const lastGpsMs = Date.parse(rows[i - 1]!.recordedAt);
      // No earlier fix means the ride opened on GPS and there is no gap to
      // charge; same at the end. Both are zero rather than capped.
      const leadInS =
        runStart === 0
          ? 0
          : chargeableS((firstGpsMs - Date.parse(rows[runStart - 1]!.recordedAt)) / 1000);
      const leadOutS =
        i >= rows.length ? 0 : chargeableS((Date.parse(rows[i]!.recordedAt) - lastGpsMs) / 1000);
      const ownSeconds = (lastGpsMs - firstGpsMs) / 1000;
      runs.push({
        fixes: i - runStart,
        startedAt: rows[runStart]!.recordedAt,
        endedAt: rows[i - 1]!.recordedAt,
        ownSeconds,
        seconds: ownSeconds + leadInS + leadOutS,
      });
      runStart = -1;
    }
  }

  const longest = runs.reduce<GpsRun | null>(
    (best, run) => (best == null || run.seconds > best.seconds ? run : best),
    null,
  );

  const durationS =
    rows.length >= 2
      ? (Date.parse(rows[rows.length - 1]!.recordedAt) - Date.parse(rows[0]!.recordedAt)) / 1000
      : null;

  return {
    sessionId,
    startedAt: rows[0]?.recordedAt ?? null,
    fixes: rows.length,
    labelled: labelled.length,
    barometerFixes,
    barometerShare: labelled.length > 0 ? barometerFixes / labelled.length : null,
    distinctElevations: new Set(rows.map((r) => r.elevationM)).size,
    repeatShare: pairs > 0 ? repeats / pairs : null,
    barometerRepeatShare: baroPairs > 0 ? baroRepeats / baroPairs : null,
    longestGpsRun: longest,
    gpsRunsOver30s: runs.filter((r) => r.seconds >= LONG_GPS_RUN_S).length,
    medianGapS,
    unmeasuredS,
    unmeasuredGaps: longGaps.length,
    longestUnmeasuredGapS: longGaps.length > 0 ? Math.max(...longGaps) : 0,
    unmeasuredShare: durationS != null && durationS > 0 ? unmeasuredS / durationS : null,
    medianAltitudeAccuracyM: median(
      rows.map((r) => r.altitudeAccuracyM).filter((v): v is number => v != null),
    ),
    durationS,
  };
}

export type Verdict =
  | "unlabelled"
  | "alive"
  | "stopped"
  | "unmeasured"
  | "claimed-but-stuck"
  | "no-barometer";

/**
 * The call, so that nobody has to decide what the numbers mean while looking at
 * them. Ordered most-specific first: a ride that claims the barometer and shows
 * GPS-like values is a worse outcome than one that honestly reports GPS, and
 * reporting it as "alive" because the share is high is exactly the mistake this
 * function exists to prevent.
 *
 * The stuck test reads `barometerRepeatShare`, not `repeatShare`. Using the
 * all-pairs share here called session 61 -- an honest 93.5%-GPS ride -- a stuck
 * barometer, because GPS repeats its heights and GPS was almost the whole ride.
 */
export function verdictFor(
  report: SessionReport,
  repeatLimit = REPEAT_IS_SUSPICIOUS_ABOVE,
): Verdict {
  if (report.barometerShare == null) return "unlabelled";
  if (report.barometerShare === 0) return "no-barometer";
  if (report.barometerRepeatShare != null && report.barometerRepeatShare > repeatLimit) {
    return "claimed-but-stuck";
  }
  // A known failure outranks an uncertainty: if some stretch definitely lost
  // the barometer, say so, whatever else the ride also could not measure.
  if (report.gpsRunsOver30s > 0) return "stopped";
  // And an uncertainty outranks a pass. A ride with a long stretch of no fixes
  // at all cannot clear the barometer across it, and reporting that as `alive`
  // is how a failed test ride gets signed off -- which is what the fixed
  // 10-second bracket did before a cold review caught it.
  if (report.unmeasuredShare != null && report.unmeasuredShare >= UNMEASURED_SHARE_LIMIT) {
    return "unmeasured";
  }
  return "alive";
}

/** A per-minute strip of which sensor was in use, so a deliberate screen lock
 *  is visible as a block rather than having to be inferred from a total.
 *  `B` is a minute entirely on the barometer, `g` entirely on GPS, a digit is
 *  the barometer share rounded to a tenth. */
export function sourceStrip(rows: readonly SampleRow[]): string {
  if (rows.length === 0) return "";
  const startMs = Date.parse(rows[0]!.recordedAt);
  const perMinute = new Map<number, { baro: number; total: number }>();
  for (const row of rows) {
    if (row.elevationSource == null) continue;
    const minute = Math.floor((Date.parse(row.recordedAt) - startMs) / 60_000);
    const cell = perMinute.get(minute) ?? { baro: 0, total: 0 };
    cell.total++;
    if (row.elevationSource === "barometer") cell.baro++;
    perMinute.set(minute, cell);
  }
  const last = Math.max(...perMinute.keys());
  let out = "";
  for (let minute = 0; minute <= last; minute++) {
    const cell = perMinute.get(minute);
    if (cell == null || cell.total === 0) {
      out += "."; // no fixes in this minute at all
      continue;
    }
    const share = cell.baro / cell.total;
    out += share === 1 ? "B" : share === 0 ? "g" : String(Math.round(share * 10));
  }
  return out;
}

function pct(value: number | null, width = 6): string {
  return (value == null ? "-" : `${(100 * value).toFixed(1)}%`).padStart(width);
}

async function main(): Promise<void> {
  const sessionArg = process.argv.indexOf("--session");
  const referenceArg = process.argv.indexOf("--reference");
  const only = sessionArg === -1 ? null : Number(process.argv[sessionArg + 1]);
  const reference =
    referenceArg === -1 ? DEFAULT_REFERENCE_SESSION : Number(process.argv[referenceArg + 1]);
  if (only != null && !Number.isInteger(only)) throw new Error("--session needs a session id");
  if (!Number.isInteger(reference)) throw new Error("--reference needs a session id");

  const { rows } = await pool.query<SampleRow>(
    `select session_id as "sessionId", recorded_at as "recordedAt",
            elevation_m as "elevationM", elevation_source as "elevationSource",
            altitude_accuracy_m as "altitudeAccuracyM"
       from session_samples
      where ($1::bigint is null or session_id in ($1::bigint, $2::bigint))
      order by session_id, recorded_at`,
    [only, reference],
  );

  const bySession = new Map<number, SampleRow[]>();
  for (const row of rows) {
    const list = bySession.get(row.sessionId) ?? [];
    list.push(row);
    bySession.set(row.sessionId, list);
  }

  const reports = [...bySession.entries()]
    .map(([id, sessionRows]) => ({ report: reportFor(id, sessionRows), rows: sessionRows }))
    .sort((a, b) => a.report.sessionId - b.report.sessionId);

  console.log(
    `sess  fixes   baro%  baro-rpt%  gap  longest silence    >30s  unseen  verdict\n` +
      `----  -----  ------  ---------  ---  -----------------  ----  ------  -------`,
  );
  for (const { report } of reports) {
    const run = report.longestGpsRun;
    const runText = run
      ? `${run.fixes} fixes, ${run.seconds.toFixed(0)}s`.padEnd(17)
      : "none".padEnd(17);
    const marker = report.sessionId === reference ? "  <- reference (screen on)" : "";
    console.log(
      `${String(report.sessionId).padStart(4)}  ${String(report.fixes).padStart(5)}  ` +
        `${pct(report.barometerShare)}  ${pct(report.barometerRepeatShare, 9)}  ` +
        `${(report.medianGapS?.toFixed(0) ?? "-").padStart(3)}  ${runText}  ` +
        `${String(report.gpsRunsOver30s).padStart(4)}  ` +
        `${(report.unmeasuredS >= 1 ? `${(report.unmeasuredS / 60).toFixed(0)}m` : "-").padStart(6)}  ` +
        `${verdictFor(report)}${marker}`,
    );
  }

  for (const { report, rows: sessionRows } of reports) {
    console.log(`\nsession ${report.sessionId}  started ${report.startedAt}`);
    console.log(
      `  ${report.fixes} fixes over ${report.durationS == null ? "?" : (report.durationS / 60).toFixed(1)} min, ` +
        `${report.labelled} labelled, ${report.distinctElevations} distinct elevations, ` +
        `median altitude accuracy ${report.medianAltitudeAccuracyM?.toFixed(1) ?? "-"}m`,
    );
    console.log(`  per-minute source (B=barometer g=gps .=no fixes):`);
    console.log(`    ${sourceStrip(sessionRows)}`);
    console.log(
      `  fixes a median of ${report.medianGapS?.toFixed(1) ?? "-"}s apart, so a GPS stretch is ` +
        `bracketed by up to ${(Math.max(MIN_BRACKET_S, (report.medianGapS ?? MIN_BRACKET_S) * BRACKET_GAP_MULTIPLE)).toFixed(1)}s each side`,
    );
    if (report.longestGpsRun) {
      const run = report.longestGpsRun;
      console.log(
        `  longest GPS stretch: ${run.fixes} fixes spanning ${run.ownSeconds.toFixed(0)}s, ` +
          `${run.seconds.toFixed(0)}s of silence charged`,
      );
      console.log(`    ${run.startedAt} .. ${run.endedAt}`);
    }
    if (report.unmeasuredGaps > 0) {
      console.log(
        `  UNSEEN: ${report.unmeasuredGaps} gap(s) with no fixes at all, ` +
          `${(report.unmeasuredS / 60).toFixed(1)} min total ` +
          `(${(100 * (report.unmeasuredShare ?? 0)).toFixed(0)}% of the ride), ` +
          `longest ${report.longestUnmeasuredGapS.toFixed(0)}s. Nothing is known about the
` +
          `          barometer across these, so the verdict above covers only the rest.`,
      );
    }
    console.log(`  VERDICT: ${verdictFor(report)}`);
  }

  console.log(
    `\nWhat the verdicts mean.\n` +
      `  alive              the barometer reported wherever the ride was recording, no stretch\n` +
      `                     over ${LONG_GPS_RUN_S}s on GPS and no long gap hiding one.\n` +
      `  stopped            at least one stretch over ${LONG_GPS_RUN_S}s fell back to GPS. Before this work that is\n` +
      `                     what every locked screen produced, within 11-19s of the lock.\n` +
      `  unmeasured         NOT A PASS. The ride has ${UNMEASURED_GAP_S}s+ with no fixes at all, so the\n` +
      `                     barometer cannot be cleared across them. A locked screen can throttle\n` +
      `                     location until fixes are minutes apart, and a blackout hiding inside\n` +
      `                     one of those gaps looks identical to a working ride. Ride again with\n` +
      `                     fixes arriving before trusting a verdict on this one.\n` +
      `  claimed-but-stuck  the ride says barometer but ${(100 * REPEAT_IS_SUSPICIOUS_ABOVE).toFixed(0)}%+ of its BAROMETER-to-BAROMETER\n` +
      `                     pairs repeat the height, which is how GPS altitude behaves and\n` +
      `                     not how a 0.01 hPa sensor behaves. The listener registered and\n` +
      `                     got nothing. Read baro-rpt%, never all-rpt%: on a mostly-GPS\n` +
      `                     ride all-rpt% is high for a reason that is not the barometer.\n` +
      `  no-barometer       labelled, and none of it was barometric.\n` +
      `  unlabelled         recorded before elevation_source existed. Says nothing either way.`,
  );

  await pool.end();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

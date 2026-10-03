import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reportFor,
  verdictFor,
  sourceStrip,
  type SampleRow,
  type SessionReport,
} from "./verifyBarometer.js";

// This file pins the instrument, not the feature. The feature -- the barometer
// surviving a locked screen -- can only be measured by riding a bicycle. What
// can be pinned here is that the script reading that ride will not call a
// failure a success, which is the only way the ride is worth taking.
//
// The four that matter most:
//   - a ride that CLAIMS the barometer but holds GPS-like values is reported as
//     a failure, not as a 100% success. That is the exact shape of "the native
//     module registered the listener and got nothing".
//   - an unlabelled ride is `unlabelled`, never `no-barometer`. Silence from a
//     column that did not exist is not evidence of anything.
//   - a GPS stretch is measured from the last barometer fix BEFORE it to the
//     first AFTER it. Measuring the run's own ends understates the outage by a
//     fix interval at each end, which at 4s a fix is most of a short gap.
//   - the >=30s boundary bites.
//
// Two of the tests below are regressions for defects this script had on its
// first run against the live archive, both of which reported a working ride as
// a broken one. They are marked REGRESSION.

const BASE_MS = Date.parse("2026-10-01T18:00:00.000Z");

/** A fix `atS` seconds into the ride. Elevations sit near 1800m because that is
 *  where this city is, and a formula fed 0m would hide a scale error. */
function fix(
  atS: number,
  source: "barometer" | "gps" | null,
  elevationM: number,
  altitudeAccuracyM: number | null = 3,
): SampleRow {
  return {
    sessionId: 99,
    recordedAt: new Date(BASE_MS + atS * 1000).toISOString(),
    elevationM,
    elevationSource: source,
    altitudeAccuracyM,
  };
}

/** A barometer-like series: every value different, moving by centimetres. */
function barometerRide(fixes: number, everyS = 2): SampleRow[] {
  return Array.from({ length: fixes }, (_, i) =>
    fix(i * everyS, "barometer", 1800 + i * 0.07),
  );
}

test("a ride that never left the barometer is alive", () => {
  const report = reportFor(99, barometerRide(30));
  assert.equal(report.barometerShare, 1);
  assert.equal(report.gpsRunsOver30s, 0);
  assert.equal(report.longestGpsRun, null);
  assert.equal(verdictFor(report), "alive");
});

test("a ride labelled entirely gps is no-barometer, and that is not the same as unlabelled", () => {
  const rows = Array.from({ length: 20 }, (_, i) => fix(i * 2, "gps", 1800 + i * 0.1));
  const report = reportFor(99, rows);
  assert.equal(report.barometerShare, 0);
  assert.equal(verdictFor(report), "no-barometer");
});

test("an unlabelled ride is unlabelled, because a column that did not exist cannot testify", () => {
  const rows = Array.from({ length: 20 }, (_, i) => fix(i * 2, null, 1800 + i * 0.1));
  const report = reportFor(99, rows);
  assert.equal(report.labelled, 0);
  assert.equal(report.barometerShare, null);
  assert.equal(verdictFor(report), "unlabelled");
  // The trap: barometerFixes is 0 here too, so anything deciding on the count
  // rather than the share would call this no-barometer.
  assert.equal(report.barometerFixes, 0);
});

test("a ride that drops to gps mid-way for more than 30s is stopped", () => {
  // 10 barometer fixes, then 20 gps fixes 2s apart (40s), then barometer again.
  const rows: SampleRow[] = [
    ...Array.from({ length: 10 }, (_, i) => fix(i * 2, "barometer", 1800 + i * 0.07)),
    ...Array.from({ length: 20 }, (_, i) => fix(20 + i * 2, "gps", 1810 + i * 0.1)),
    ...Array.from({ length: 10 }, (_, i) => fix(60 + i * 2, "barometer", 1830 + i * 0.07)),
  ];
  const report = reportFor(99, rows);
  assert.equal(report.gpsRunsOver30s, 1);
  assert.equal(report.longestGpsRun?.fixes, 20);
  assert.equal(verdictFor(report), "stopped");
});

test("CLAIMED-BUT-STUCK beats a perfect barometer share, because the label is the phone's opinion", () => {
  // Every fix says barometer, and every value repeats the one before. That is
  // not what a 0.01 hPa sensor does; it is what GPS altitude does.
  const rows = Array.from({ length: 20 }, (_, i) =>
    fix(i * 2, "barometer", i < 2 ? 1800 : 1800.4),
  );
  const report = reportFor(99, rows);
  assert.equal(report.barometerShare, 1, "the label says the barometer worked");
  assert.ok(
    report.barometerRepeatShare! > 0.2,
    `barometer repeat share was ${report.barometerRepeatShare}`,
  );
  assert.equal(verdictFor(report), "claimed-but-stuck");
});

test("REGRESSION: a mostly-gps ride with repetitive heights is stopped, not claimed-but-stuck", () => {
  // Session 61's real shape: 6.5% barometer, and 53.9% of all consecutive pairs
  // repeat. The repeats are the GPS majority behaving normally. Deciding on the
  // all-pairs share called this honest ride a stuck barometer, which is a worse
  // error than the one the verdict exists to catch -- it blames the sensor for
  // working.
  const rows: SampleRow[] = [
    ...Array.from({ length: 5 }, (_, i) => fix(i * 4, "barometer", 1800 + i * 0.07)),
    // 72 GPS fixes that mostly hold their value, as GPS altitude does.
    ...Array.from({ length: 72 }, (_, i) => fix(20 + i * 4, "gps", 1810 + Math.floor(i / 8) * 0.1)),
  ];
  const report = reportFor(99, rows);
  assert.ok(report.repeatShare! > 0.5, `all-pairs repeat share was ${report.repeatShare}`);
  assert.equal(report.barometerRepeatShare, 0, "the barometer's own readings all differ");
  assert.equal(verdictFor(report), "stopped");
});

test("REGRESSION: one gps fix inside a long gap is not charged for the whole gap", () => {
  // Sessions 68, 69, 81 and 82 each reported a ONE-FIX GPS stretch lasting 34s,
  // 117s, 523s and 196s, and were all reported as having lost the barometer. A
  // single fix cannot itself be silent for nine minutes: the ride stopped
  // producing fixes, at a trailhead or under cover.
  const rows = [
    fix(0, "barometer", 1800),
    fix(600, "gps", 1801), // ten minutes later, one lone GPS fix
    fix(1200, "barometer", 1802), // ten minutes after that, back on the barometer
  ];
  const report = reportFor(99, rows);
  const run = report.longestGpsRun!;
  assert.equal(run.fixes, 1);
  assert.equal(run.ownSeconds, 0, "one fix spans no time");
  assert.equal(run.seconds, 0, "the two ten-minute gaps are unmeasured, so neither is charged");
  assert.equal(report.gpsRunsOver30s, 0, "it is not reported as a GPS stretch");
});

test("REGRESSION: but that gap is UNMEASURED, so the ride is not reported as a pass", () => {
  // The other half of the same defect, and the more dangerous half. Capping the
  // bracket stopped a trailhead pause reading as an outage -- and in doing so
  // made a barometer blackout of ANY length score 20s and report `alive`, as
  // long as it contained one GPS fix. A cold review swept 30s, 60s, 300s, 900s
  // and 3600s blackouts: every one scored 20s, every one said `alive`.
  //
  // A locked screen can throttle location until fixes are minutes apart, which
  // is exactly the condition the remaining failure mode lives in, so the
  // instrument was blind precisely where it had to see.
  const rows = [
    fix(0, "barometer", 1800),
    fix(600, "gps", 1801),
    fix(1200, "barometer", 1802),
  ];
  const report = reportFor(99, rows);
  assert.equal(report.unmeasuredGaps, 2, "both ten-minute gaps are unmeasured");
  assert.equal(report.unmeasuredS, 1200);
  assert.equal(verdictFor(report), "unmeasured", "NOT alive");
});

test("a blackout of any length containing one fix never reads as a pass", () => {
  // The sweep itself, as a test. Each of these is a ride where the barometer
  // could have been dead for the whole gap and nothing would say so.
  for (const outageS of [30, 60, 300, 900, 3600]) {
    const report = reportFor(99, [
      fix(0, "barometer", 1800),
      fix(outageS / 2, "gps", 1801),
      fix(outageS, "barometer", 1802),
    ]);
    assert.notEqual(
      verdictFor(report),
      "alive",
      `a ${outageS}s outage with one fix in it reported alive`,
    );
  }
});

test("REGRESSION: an honest 20s blip on a dense ride is alive, not stopped", () => {
  // The other direction of the fixed-bracket defect. On a ride with fixes 2s
  // apart, two GPS fixes spanning 20s were charged 40s by the old flat 10s
  // bracket and reported `stopped`. The bracket now comes from the ride's own
  // cadence, so it is ~4s and the blip reads as ~24s.
  const rows: SampleRow[] = [];
  for (let i = 0; i < 100; i++) rows.push(fix(i * 2, "barometer", 1800 + i * 0.07));
  rows.push(fix(200, "gps", 1807), fix(220, "gps", 1808));
  for (let i = 0; i < 100; i++) rows.push(fix(222 + i * 2, "barometer", 1809 + i * 0.07));

  const report = reportFor(99, rows);
  assert.equal(report.medianGapS, 2);
  const run = report.longestGpsRun!;
  assert.equal(run.ownSeconds, 20);
  assert.ok(run.seconds < 30, `charged ${run.seconds}s, which a flat 10s bracket made 40s`);
  assert.equal(verdictFor(report), "alive");
});

test("THE BRACKET comes from the ride's own cadence, not from a constant", () => {
  // A sparse ride and a dense ride with the same shaped outage get different
  // brackets, which is the whole point.
  const dense: SampleRow[] = [];
  for (let i = 0; i < 20; i++) dense.push(fix(i, "barometer", 1800 + i * 0.07));
  dense.push(fix(20, "gps", 1802));
  for (let i = 0; i < 20; i++) dense.push(fix(21 + i, "barometer", 1803 + i * 0.07));
  assert.equal(reportFor(99, dense).medianGapS, 1);
  // 1s median -> 2s bracket, but the gaps either side are only 1s and you
  // cannot charge more silence than the gap holds, so 0 + 1 + 1.
  assert.equal(reportFor(99, dense).longestGpsRun?.seconds, 2);

  const sparse: SampleRow[] = [];
  for (let i = 0; i < 20; i++) sparse.push(fix(i * 8, "barometer", 1800 + i * 0.07));
  sparse.push(fix(160, "gps", 1802));
  for (let i = 0; i < 20; i++) sparse.push(fix(168 + i * 8, "barometer", 1803 + i * 0.07));
  assert.equal(reportFor(99, sparse).medianGapS, 8);
  // 8s median -> 16s bracket, and the gaps either side are 8s, so 0 + 8 + 8.
  assert.equal(reportFor(99, sparse).longestGpsRun?.seconds, 16);
});

test("STOPPED outranks UNMEASURED, because a known failure beats an uncertainty", () => {
  const rows: SampleRow[] = [
    ...Array.from({ length: 10 }, (_, i) => fix(i * 2, "barometer", 1800 + i * 0.07)),
    // A definite 40s GPS stretch...
    ...Array.from({ length: 20 }, (_, i) => fix(20 + i * 2, "gps", 1810 + i * 0.1)),
    ...Array.from({ length: 10 }, (_, i) => fix(60 + i * 2, "barometer", 1830 + i * 0.07)),
    // ...and a ten-minute hole as well.
    fix(700, "barometer", 1840),
  ];
  const report = reportFor(99, rows);
  assert.ok(report.gpsRunsOver30s > 0);
  assert.ok(report.unmeasuredS >= 30);
  assert.equal(verdictFor(report), "stopped");
});

test("THE RUN DURATION spans the silence, from the last barometer fix before to the first after", () => {
  // Barometer at 0s, gps at 10s and 20s, barometer at 30s. The barometer was
  // quiet across 0s..30s, not 10s..20s.
  const rows = [
    fix(0, "barometer", 1800),
    fix(10, "gps", 1801),
    fix(20, "gps", 1802),
    fix(30, "barometer", 1803),
  ];
  const run = reportFor(99, rows).longestGpsRun;
  assert.equal(run?.fixes, 2);
  assert.equal(run?.ownSeconds, 10, "the run's own ends");
  assert.equal(run?.seconds, 30, "measuring the run's own ends alone would give 10");
  // The reported window is still the run itself, so the timestamps point at
  // the GPS fixes a reader would go looking for.
  assert.equal(run?.startedAt, new Date(BASE_MS + 10_000).toISOString());
  assert.equal(run?.endedAt, new Date(BASE_MS + 20_000).toISOString());
});

test("BOUNDARY: a 30s silence counts as a long run and a 29s one does not", () => {
  const atThirty = reportFor(99, [
    fix(0, "barometer", 1800),
    fix(10, "gps", 1801),
    fix(20, "gps", 1802),
    fix(30, "barometer", 1803),
  ]);
  assert.equal(atThirty.gpsRunsOver30s, 1);
  assert.equal(verdictFor(atThirty), "stopped");

  const atTwentyNine = reportFor(99, [
    fix(0, "barometer", 1800),
    fix(10, "gps", 1801),
    fix(20, "gps", 1802),
    fix(29, "barometer", 1803),
  ]);
  assert.equal(atTwentyNine.longestGpsRun?.seconds, 29);
  assert.equal(atTwentyNine.gpsRunsOver30s, 0);
  assert.equal(verdictFor(atTwentyNine), "alive");
});

test("a gps run at the very start has no earlier fix, so it uses its own first", () => {
  const rows = [
    fix(0, "gps", 1800),
    fix(10, "gps", 1801),
    fix(20, "barometer", 1802),
  ];
  const run = reportFor(99, rows).longestGpsRun;
  assert.equal(run?.fixes, 2);
  assert.equal(run?.seconds, 20);
});

test("a gps run at the very end has no later fix, so it uses its own last", () => {
  const rows = [
    fix(0, "barometer", 1800),
    fix(10, "gps", 1801),
    fix(20, "gps", 1802),
  ];
  const run = reportFor(99, rows).longestGpsRun;
  assert.equal(run?.fixes, 2);
  assert.equal(run?.seconds, 20);
});

test("two separate silences are two runs, and the longest is reported", () => {
  const rows = [
    fix(0, "barometer", 1800),
    fix(10, "gps", 1801),
    fix(20, "barometer", 1802),
    fix(30, "gps", 1803),
    fix(40, "gps", 1804),
    fix(50, "gps", 1805),
    fix(60, "barometer", 1806),
  ];
  const report = reportFor(99, rows);
  assert.equal(report.longestGpsRun?.fixes, 3);
  assert.equal(report.longestGpsRun?.seconds, 40, "20s..60s, not 30s..50s");
  assert.equal(report.gpsRunsOver30s, 1, "the 20s run does not qualify");
});

test("a single fix has no pairs, so the repeat share is null rather than zero", () => {
  const report = reportFor(99, [fix(0, "barometer", 1800)]);
  assert.equal(report.repeatShare, null);
  assert.equal(report.durationS, null);
  assert.equal(report.fixes, 1);
});

test("an empty session does not throw, and reports nothing rather than zero", () => {
  const report = reportFor(99, []);
  assert.equal(report.fixes, 0);
  assert.equal(report.barometerShare, null);
  assert.equal(report.repeatShare, null);
  assert.equal(report.longestGpsRun, null);
  assert.equal(report.startedAt, null);
  assert.equal(verdictFor(report), "unlabelled");
});

test("distinct elevations counts values, not fixes, which is how a stuck sensor shows", () => {
  const rows = [
    fix(0, "barometer", 1800),
    fix(2, "barometer", 1800),
    fix(4, "barometer", 1800),
    fix(6, "barometer", 1801),
  ];
  const report = reportFor(99, rows);
  assert.equal(report.fixes, 4);
  assert.equal(report.distinctElevations, 2);
});

test("median altitude accuracy skips the nulls instead of counting them as zero", () => {
  const rows = [
    fix(0, "barometer", 1800, null),
    fix(2, "barometer", 1801, 4),
    fix(4, "barometer", 1802, 6),
    fix(6, "barometer", 1803, null),
  ];
  assert.equal(reportFor(99, rows).medianAltitudeAccuracyM, 5);
});

test("a ride with no altitude accuracy at all reports null, not NaN", () => {
  const rows = [fix(0, "barometer", 1800, null), fix(2, "barometer", 1801, null)];
  assert.equal(reportFor(99, rows).medianAltitudeAccuracyM, null);
});

test("THE REPEAT LIMIT is overridable, and the default is what decides the verdict", () => {
  const rows = Array.from({ length: 10 }, (_, i) => fix(i * 2, "barometer", i < 5 ? 1800 : 1801));
  const report = reportFor(99, rows);
  // 8 of 9 pairs repeat.
  assert.ok(report.barometerRepeatShare! > 0.8);
  assert.equal(verdictFor(report), "claimed-but-stuck", "the default calls this stuck");
  assert.equal(verdictFor(report, 0.99), "alive", "a loose limit lets it through");
});

test("BOUNDARY: the repeat limit is exclusive, so a share exactly on it is not stuck", () => {
  // 10 barometer fixes, 9 pairs. Repeating exactly 2 of 9 is 22%, over the 20%
  // limit; repeating 1 of 5 is exactly 20% and must NOT trip it, or the
  // threshold is really a different number than the one written down.
  const atLimit = reportFor(99, [
    fix(0, "barometer", 1800),
    fix(2, "barometer", 1800),
    fix(4, "barometer", 1801),
    fix(6, "barometer", 1802),
    fix(8, "barometer", 1803),
    fix(10, "barometer", 1804),
  ]);
  assert.equal(atLimit.barometerRepeatShare, 0.2);
  assert.equal(verdictFor(atLimit), "alive");
});

test("a barometer reading next to a gps reading is not a barometer pair", () => {
  // Two barometer fixes that hold the same height, but with a GPS fix between
  // them. They are not consecutive, so they are not evidence of a stuck
  // sensor -- the barometer stopped and restarted at the same altitude, which
  // is what standing still looks like.
  const rows = [
    fix(0, "barometer", 1800),
    fix(2, "gps", 1800),
    fix(4, "barometer", 1800),
  ];
  const report = reportFor(99, rows);
  assert.equal(report.repeatShare, 1, "every pair repeats, read over all sources");
  assert.equal(report.barometerRepeatShare, null, "but there is no barometer-to-barometer pair");
  assert.equal(verdictFor(report), "alive");
});

test("CONTROL: a mixed ride whose silences are all short is alive, not stopped", () => {
  // One GPS fix every ten, which is what a momentary gap looks like. None of
  // them reaches 30s, so none of them is the screen-lock signature.
  const rows = Array.from({ length: 40 }, (_, i) =>
    fix(i * 2, i % 10 === 5 ? "gps" : "barometer", 1800 + i * 0.07),
  );
  const report = reportFor(99, rows);
  assert.ok(report.barometerShare! < 1, "there are GPS fixes in here");
  assert.equal(report.gpsRunsOver30s, 0);
  assert.equal(verdictFor(report), "alive");
});

test("the per-minute strip shows WHERE the barometer stopped, which a total cannot", () => {
  // Three minutes: all barometer, all gps, all barometer.
  const rows: SampleRow[] = [];
  for (let i = 0; i < 30; i++) rows.push(fix(i * 2, "barometer", 1800 + i * 0.07));
  for (let i = 0; i < 30; i++) rows.push(fix(60 + i * 2, "gps", 1810 + i * 0.1));
  for (let i = 0; i < 30; i++) rows.push(fix(120 + i * 2, "barometer", 1820 + i * 0.07));
  assert.equal(sourceStrip(rows), "BgB");
});

test("a minute with no fixes is a dot, not a zero, because no data is not gps", () => {
  const rows = [
    fix(0, "barometer", 1800),
    fix(30, "barometer", 1801),
    // nothing in minute 1 at all
    fix(120, "barometer", 1802),
  ];
  assert.equal(sourceStrip(rows), "B.B");
});

test("a part-barometer minute is a digit, so a partial loss is not rounded away", () => {
  const rows = [
    fix(0, "barometer", 1800),
    fix(10, "barometer", 1801),
    fix(20, "barometer", 1802),
    fix(30, "barometer", 1803),
    fix(40, "gps", 1804),
  ];
  assert.equal(sourceStrip(rows), "8");
});

test("unlabelled fixes are left out of the strip rather than counted as gps", () => {
  const rows = [fix(0, null, 1800), fix(30, null, 1801), fix(60, "barometer", 1802)];
  assert.equal(sourceStrip(rows), ".B");
});

test("an empty session has an empty strip rather than throwing on Math.max", () => {
  assert.equal(sourceStrip([]), "");
});

test("THE VERDICT ORDER puts stuck ahead of stopped, because a lying label is worse", () => {
  // Both failures at once: every label says barometer, the values repeat, AND
  // there is a long GPS run. Only one verdict can be returned and it has to be
  // the one that says the readings cannot be trusted.
  const rows: SampleRow[] = [
    ...Array.from({ length: 10 }, (_, i) => fix(i * 2, "barometer", 1800)),
    ...Array.from({ length: 20 }, (_, i) => fix(20 + i * 2, "gps", 1800)),
  ];
  const report = reportFor(99, rows);
  assert.ok(report.gpsRunsOver30s > 0, "it is also stopped");
  assert.equal(verdictFor(report), "claimed-but-stuck");
});

test("ORDER IS THE INPUT ORDER: runs are contiguous in the array, not re-sorted", () => {
  // Deliberately out of time order. The script's query orders by recorded_at
  // and this function trusts it, so the pinned behaviour is that it does NOT
  // quietly re-sort -- a caller handing it unordered rows gets a visibly wrong
  // answer rather than a silently repaired one, and that is why the query is
  // ordered.
  const unordered = [
    fix(0, "gps", 1800),
    fix(60, "barometer", 1801),
    fix(10, "gps", 1802),
  ];
  const ordered = [
    fix(0, "gps", 1800),
    fix(10, "gps", 1802),
    fix(60, "barometer", 1801),
  ];
  // Sorted, the two GPS fixes are one run of two. Unsorted, the barometer fix
  // splits them into two runs of one.
  assert.equal(reportFor(99, ordered).longestGpsRun?.fixes, 2);
  assert.equal(reportFor(99, unordered).longestGpsRun?.fixes, 1);
});

test("a report is a plain object, so the script can be read by another script", () => {
  const report: SessionReport = reportFor(7, barometerRide(5));
  assert.equal(report.sessionId, 7);
  assert.deepEqual(Object.keys(report).sort(), [
    "barometerFixes",
    "barometerRepeatShare",
    "barometerShare",
    "distinctElevations",
    "durationS",
    "fixes",
    "gpsRunsOver30s",
    "labelled",
    "longestGpsRun",
    "longestUnmeasuredGapS",
    "medianAltitudeAccuracyM",
    "medianGapS",
    "repeatShare",
    "sessionId",
    "startedAt",
    "unmeasuredGaps",
    "unmeasuredS",
    "unmeasuredShare",
  ]);
});

import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { pool } from "../db/pool.js";
import { processSession } from "../services/sessionProcessor.js";
import { isUsable, loadSessionVerdicts } from "../services/usableSessions.js";

// What a rebuild would do to the stored heights, without doing it.
//
// `rebuild-model` is not revertable. It runs `delete from
// segment_elevation_buckets` and recomputes every height as a running mean over
// every ride, and a running mean cannot have one ride subtracted back out. So
// an algorithm change that moves which fix matches which street moves heights,
// and today the only way to find out by how much is to do it.
//
// This does the real rebuild inside a transaction and ROLLS IT BACK. The point
// of using the real `processSession` rather than recomputing the merge here is
// that a reimplementation of the averaging would be measuring itself: the
// numbers would be about this file, not about what production will store.
//
// Nothing is written. The rollback is in a `finally`, so it happens on an
// exception too, and there is no `commit` anywhere in this file.
//
// It holds a write transaction on three tables while it runs. Readers are
// unaffected (Postgres MVCC serves them the pre-delete rows), but a ride
// finishing through POST /sessions/:id/end during the window would block until
// the rollback. Do not run it while a ride is being uploaded.
//
//   npm run verify-rebuild
//   npm run verify-rebuild -- --top 40

interface Bucket {
  segmentId: number;
  direction: string;
  distanceM: number;
  elevationM: number;
  sampleCount: number;
}

const keyOf = (b: Bucket) => `${b.segmentId}|${b.direction}|${b.distanceM}`;

/** Heights as currently stored, keyed for comparison. */
async function readModel(
  client: { query: (t: string) => Promise<{ rows: unknown[] }> },
): Promise<Map<string, Bucket>> {
  const { rows } = (await client.query(
    `select segment_id as "segmentId", direction, distance_m as "distanceM",
            elevation_m as "elevationM", sample_count as "sampleCount"
       from segment_elevation_buckets`,
  )) as { rows: Bucket[] };
  return new Map(rows.map((b) => [keyOf(b), b]));
}

function quantiles(values: number[], ps: number[]): number[] {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  return ps.map((p) =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! : NaN,
  );
}

const OUT_DIR =
  process.env.VERIFY_OUT_DIR ??
  "C:/Users/Julian/AppData/Local/Temp/claude/c--Users-Julian-Documents-GitHub-CyclingDataApp/e24d4bb5-018e-46b7-89ee-9dee82f392bf/scratchpad";

async function main(): Promise<void> {
  const topArg = process.argv.indexOf("--top");
  const top = topArg === -1 ? 25 : Number(process.argv[topArg + 1]);
  if (!(top > 0)) throw new Error("--top needs a positive number");

  const sessions = await loadSessionVerdicts(pool);
  const usable = sessions.filter(isUsable);
  console.log(`comparing a rebuild from ${usable.length} usable sessions against the stored model`);
  console.log(`NOTHING IS WRITTEN: the transaction below is rolled back.\n`);

  const client = await pool.connect();
  await client.query("set statement_timeout = '30min'");

  const before = await readModel(client);
  console.log(`stored now: ${before.size} buckets`);

  // The snapshot is written before the transaction opens, so it exists even if
  // the rebuild throws. It is also the pre-rebuild backup for the real run.
  const snapshot = [
    "segment_id,direction,distance_m,elevation_m,sample_count",
    ...[...before.values()].map(
      (b) => `${b.segmentId},${b.direction},${b.distanceM},${b.elevationM},${b.sampleCount}`,
    ),
  ].join("\n");
  const snapshotPath = `${OUT_DIR}/model-before.csv`;
  mkdirSync(dirname(snapshotPath), { recursive: true });
  writeFileSync(snapshotPath, snapshot);
  console.log(`snapshot of every current bucket: ${snapshotPath}`);

  let after: Map<string, Bucket>;
  try {
    await client.query("begin");
    // Exactly what rebuildModel.ts does, in the same order.
    await client.query("delete from session_segment_matches");
    await client.query("delete from segment_coverage");
    await client.query("delete from segment_elevation_buckets");

    let done = 0;
    for (const session of usable) {
      await processSession(client, session.id);
      done++;
      if (done % 10 === 0) console.log(`  rebuilt ${done}/${usable.length} sessions`);
    }
    after = await readModel(client);
  } finally {
    // Before any reporting, so a crash in the report cannot leave it open.
    await client.query("rollback");
    console.log(`\nrolled back. the stored model is untouched.`);
  }

  const added = [...after.keys()].filter((k) => !before.has(k));
  const removed = [...before.keys()].filter((k) => !after.has(k));
  const shared = [...after.keys()].filter((k) => before.has(k));

  const deltas = shared.map((k) => ({
    key: k,
    before: before.get(k)!,
    after: after.get(k)!,
    deltaM: after.get(k)!.elevationM - before.get(k)!.elevationM,
  }));
  const abs = deltas.map((d) => Math.abs(d.deltaM));
  const moved = abs.filter((d) => d > 0.005).length; // half a centimetre
  const [p50, p90, p99, max] = quantiles(abs, [0.5, 0.9, 0.99, 1]);

  console.log(`\nBUCKETS`);
  console.log(`  before ${before.size}   after ${after.size}   (${after.size - before.size >= 0 ? "+" : ""}${after.size - before.size})`);
  console.log(`  added ${added.length}   removed ${removed.length}   in both ${shared.length}`);

  // Reported because the first version of this script did not, and the one
  // thing a rebuild visibly changed was the line count: the speed limit on
  // 2026-10-01 moved buckets 6,080 -> 6,069 (predicted) and lines 956 -> 951
  // (not predicted, and only noticed by querying the live API afterwards).
  // A bucket count cannot see a line disappear, because a line losing its last
  // bucket and a line losing one of twelve look the same in a total.
  const linesOf = (m: Map<string, Bucket>) =>
    new Set([...m.values()].map((b) => `${b.segmentId}|${b.direction}`));
  const linesBefore = linesOf(before);
  const linesAfter = linesOf(after);
  const lostLines = [...linesBefore].filter((k) => !linesAfter.has(k));
  const newLines = [...linesAfter].filter((k) => !linesBefore.has(k));
  console.log(`\nDRAWN LINES (segment + direction)`);
  console.log(
    `  before ${linesBefore.size}   after ${linesAfter.size}   ` +
      `(${linesAfter.size - linesBefore.size >= 0 ? "+" : ""}${linesAfter.size - linesBefore.size})`,
  );
  console.log(`  lost ${lostLines.length}   gained ${newLines.length}`);
  const segmentsOf = (s: Set<string>) => new Set([...s].map((k) => k.split("|")[0]));
  const segBefore = segmentsOf(linesBefore);
  const segAfter = segmentsOf(linesAfter);
  const blanked = [...segBefore].filter((id) => !segAfter.has(id));
  console.log(
    `  segments drawn ${segBefore.size} -> ${segAfter.size}` +
      (blanked.length
        ? `   ${blanked.length} STREET(S) GO BLANK in both directions: ${blanked.join(", ")}`
        : `   no segment loses both directions`),
  );
  for (const k of lostLines.slice(0, 20)) console.log(`    lost   ${k}`);
  if (lostLines.length > 20) console.log(`    ...${lostLines.length - 20} more`);
  for (const k of newLines.slice(0, 20)) console.log(`    gained ${k}`);
  if (newLines.length > 20) console.log(`    ...${newLines.length - 20} more`);

  console.log(`\nHEIGHTS, over the ${shared.length} buckets present both ways`);
  console.log(`  moved more than 5mm: ${moved} (${((100 * moved) / Math.max(1, shared.length)).toFixed(1)}%)`);
  console.log(
    `  |change| (m): p50 ${p50!.toFixed(4)}  p90 ${p90!.toFixed(4)}  ` +
      `p99 ${p99!.toFixed(4)}  max ${max!.toFixed(4)}`,
  );

  const biggest = deltas.sort((a, b) => Math.abs(b.deltaM) - Math.abs(a.deltaM)).slice(0, top);
  if (biggest.length) {
    console.log(`\n  biggest moves first (top ${top}):`);
    for (const d of biggest) {
      console.log(
        `    #${String(d.before.segmentId).padStart(6)} ${d.before.direction.padEnd(8)} ` +
          `${String(d.before.distanceM).padStart(4)}m  ` +
          `${d.before.elevationM.toFixed(2)}m -> ${d.after.elevationM.toFixed(2)}m  ` +
          `(${d.deltaM >= 0 ? "+" : ""}${d.deltaM.toFixed(2)}m)  ` +
          `readings ${d.before.sampleCount} -> ${d.after.sampleCount}`,
      );
    }
  }

  const rows = [
    "segment_id,direction,distance_m,elevation_before_m,elevation_after_m,delta_m,count_before,count_after",
    ...deltas.map(
      (d) =>
        `${d.before.segmentId},${d.before.direction},${d.before.distanceM},` +
        `${d.before.elevationM},${d.after.elevationM},${d.deltaM},` +
        `${d.before.sampleCount},${d.after.sampleCount}`,
    ),
    ...added.map((k) => {
      const b = after.get(k)!;
      return `${b.segmentId},${b.direction},${b.distanceM},,${b.elevationM},,,${b.sampleCount}`;
    }),
    ...removed.map((k) => {
      const b = before.get(k)!;
      return `${b.segmentId},${b.direction},${b.distanceM},${b.elevationM},,,${b.sampleCount},`;
    }),
  ].join("\n");
  const diffPath = `${OUT_DIR}/model-before-after.csv`;
  writeFileSync(diffPath, rows);
  console.log(`\nfull before/after for every bucket: ${diffPath}`);

  console.log(
    `\nWhat this does and does not tell you. It runs the real processSession, so the heights\n` +
      `above are what a rebuild would store. It does NOT say which version is more correct --\n` +
      `a bucket moving 3m means the two matchings disagree about which ride crossed it, not\n` +
      `that either height is wrong. For that, read the lines the change gains and loses\n` +
      `(npm run eval:heading-lines) alongside this.`,
  );

  client.release();
  await pool.end();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

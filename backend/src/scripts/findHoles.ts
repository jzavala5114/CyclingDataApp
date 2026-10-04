import "dotenv/config";
import { pathToFileURL } from "node:url";
import { pool } from "../db/pool.js";
import { BUCKET_SIZE_M } from "../services/elevationAggregator.js";
import { interiorHoles, type Hole } from "../services/interiorHoles.js";

// Counts the unpainted stretches in the middle of drawn lines, and splits them
// into the ones physics explains and the ones that need explaining.
//
// A hole is ground with a bucket before it and a bucket after it but no value
// of its own (see services/interiorHoles.ts). Two things produce that:
//
//  - A structure overhead. No GPS fix is possible under a tunnel or a roof, so
//    the stretch is unrecordable and the line is as complete as it can ever
//    be. `segments.is_tunnel` marks these; osm-pipeline/scripts/lib/tags.mjs
//    decides what counts.
//  - Everything else, which is a defect: a run that was ridden and lost. That
//    is the list worth working from, and before the flag existed it was
//    inflated by the first category with no way to tell them apart.
//
// Read-only. Every query is a select.
//
//   npm run find-holes
//   npm run find-holes -- --all        # list every unexplained hole
//   npm run find-holes -- --top 50

/** One row of the bucket query. Snake case, straight from the database. */
export interface BucketRow {
  segment_id: string;
  direction: string;
  distance_m: number;
  street_name: string | null;
  kind: string;
  length_m: number;
  is_tunnel: boolean;
  folded: boolean;
}

export interface LineHoles {
  segmentId: string;
  direction: string;
  streetName: string | null;
  kind: string;
  lengthM: number;
  isTunnel: boolean;
  folded: boolean;
  holes: Hole[];
}

/** Groups bucket rows into one entry per drawn line, each with its holes. */
export function holesByLine(rows: readonly BucketRow[]): LineHoles[] {
  const byLine = new Map<string, { row: BucketRow; distances: number[] }>();
  for (const row of rows) {
    const key = `${row.segment_id}|${row.direction}`;
    const entry = byLine.get(key) ?? { row, distances: [] };
    entry.distances.push(row.distance_m);
    byLine.set(key, entry);
  }

  const lines: LineHoles[] = [];
  for (const { row, distances } of byLine.values()) {
    const holes = interiorHoles(distances);
    if (holes.length === 0) continue;
    lines.push({
      segmentId: row.segment_id,
      direction: row.direction,
      streetName: row.street_name,
      kind: row.kind,
      lengthM: row.length_m,
      isTunnel: row.is_tunnel,
      folded: row.folded,
      holes,
    });
  }
  // Worst first, by the widest hole on the line, so the list opens on the
  // cases most likely to be one cause rather than noise.
  return lines.sort((a, b) => Math.max(...b.holes.map((h) => h.gapM)) - Math.max(...a.holes.map((h) => h.gapM)));
}

const tally = (lines: readonly LineHoles[]) => ({
  lines: lines.length,
  holes: lines.reduce((n, l) => n + l.holes.length, 0),
  metres: lines.reduce((n, l) => n + l.holes.reduce((m, h) => m + h.gapM, 0), 0),
});

function describe(line: LineHoles): string {
  const where = line.holes
    .map((h) => `${h.fromM}->${h.toM}m (${h.gapM}m, ${h.missingBuckets} missing)`)
    .join(", ");
  return (
    `  seg ${line.segmentId.padStart(6)} ${line.direction.padEnd(8)} ` +
    `${(line.streetName ?? "(unnamed)").padEnd(30)} ${line.kind.padEnd(9)} ` +
    `len ${line.lengthM.toFixed(0).padStart(4)}m  ${where}` +
    (line.folded ? "   [folded, not drawn]" : "")
  );
}

async function main(): Promise<void> {
  const all = process.argv.includes("--all");
  const topArg = process.argv.indexOf("--top");
  const top = all ? Infinity : topArg === -1 ? 20 : Number(process.argv[topArg + 1]);
  if (!(top > 0)) throw new Error(`--top needs a positive number, got ${process.argv[topArg + 1]}`);

  // Every bucket in the model, which is thousands of rows, not millions. Held
  // in memory so the grouping and the gap rule live in tested code rather than
  // in a window function nothing can exercise.
  const { rows } = await pool.query<BucketRow>(
    `select b.segment_id, b.direction, b.distance_m,
            s.street_name, s.kind, s.length_m, s.is_tunnel,
            (s.canonical_segment_id is not null) as folded
       from segment_elevation_buckets b
       join segments s on s.id = b.segment_id`,
  );

  const drawnLines = new Set(rows.map((r) => `${r.segment_id}|${r.direction}`)).size;
  const lines = holesByLine(rows);
  const explained = lines.filter((l) => l.isTunnel);
  const unexplained = lines.filter((l) => !l.isTunnel);

  const t = tally(lines);
  console.log(`buckets: ${rows.length} across ${drawnLines} directional lines`);
  console.log(
    `holes:   ${t.holes} across ${t.lines} lines ` +
      `(${((100 * t.lines) / drawnLines).toFixed(1)}% of lines), ${t.metres}m of unpainted ground\n`,
  );

  const e = tally(explained);
  const u = tally(unexplained);
  console.log(`under a structure (physics, leave alone): ${e.holes} holes on ${e.lines} lines, ${e.metres}m`);
  console.log(`everything else (defects to explain):     ${u.holes} holes on ${u.lines} lines, ${u.metres}m`);

  const byKind = new Map<string, { lines: number; holes: number }>();
  for (const l of unexplained) {
    const k = byKind.get(l.kind) ?? { lines: 0, holes: 0 };
    k.lines += 1;
    k.holes += l.holes.length;
    byKind.set(l.kind, k);
  }
  console.log("\nunexplained by kind:");
  for (const [kind, k] of [...byKind].sort((a, b) => b[1].holes - a[1].holes)) {
    console.log(`  ${kind.padEnd(9)} ${String(k.holes).padStart(4)} holes on ${k.lines} lines`);
  }

  const folded = unexplained.filter((l) => l.folded).length;
  if (folded > 0) {
    console.log(
      `\n${folded} of those lines are on folded segments, so they hold buckets the map ` +
        `never draws. Left in the count because they were in it when 173/140 was recorded.`,
    );
  }

  if (explained.length > 0) {
    console.log(`\nholes under a structure (all ${explained.length}):`);
    for (const line of explained) console.log(describe(line));
  }

  console.log(`\nunexplained holes, widest first${Number.isFinite(top) ? ` (top ${top})` : ""}:`);
  for (const line of unexplained.slice(0, top)) console.log(describe(line));
  if (unexplained.length > top) {
    console.log(`  ... ${unexplained.length - top} more. Re-run with --all.`);
  }

  // A segment UNDER A STRUCTURE that draws nothing at all is the other half of
  // the same story: not a hole in a line, an absent line.
  //
  // "COVERED" HERE MEANS ROOFED, NOT RIDDEN, and the wording below used to say
  // "covered segments" without saying which. A later session read that line as
  // "segments with ride coverage that draw nothing", turned it into an open item
  // claiming 2,344m of road was missing from the map, and recommended exposing
  // `is_tunnel` on `/segments` to paint it. Measured 2026-10-04, the real figure
  // is **one 55m segment** (Gold Camp Road `#49704`): of the 67 dataless
  // canonical tunnel segments, that is the only one with drawn neighbours at
  // BOTH ends, which is the only arrangement where a rider sees paint, break,
  // paint. The other 66 (2,110m) have no drawn neighbour at all, so they look
  // like any other street nobody has ridden. Every number in the census below
  // was correct; only the label was ambiguous, and it cost a month-old open item
  // that overstated the work by roughly 40x.
  const { rows: [census] } = await pool.query<{
    flagged: number; canonical: number; drawing: number; blank: number; metres: string;
  }>(
    `select count(*)::int as flagged,
            count(*) filter (where canonical_segment_id is null)::int as canonical,
            count(*) filter (where canonical_segment_id is null and exists (
              select 1 from segment_elevation_buckets b where b.segment_id = s.id))::int as drawing,
            count(*) filter (where canonical_segment_id is null and not exists (
              select 1 from segment_elevation_buckets b where b.segment_id = s.id))::int as blank,
            round(sum(length_m)::numeric, 0)::text as metres
       from segments s where s.is_tunnel`,
  );
  console.log(
    `\nsegments UNDER A STRUCTURE (roofed, not ridden): ${census.flagged} flagged (${census.metres}m), ` +
      `${census.canonical} canonical, ${census.drawing} drawing something, ` +
      `${census.blank} drawing nothing at all (expected: no fix under a roof)`,
  );
  if (census.flagged === 0) {
    console.log(
      "  NO segment is flagged. Either the extract has no tunnels or the flag was " +
        "never loaded -- run osm-pipeline's `split` then `load`, and check the count " +
        "`split` prints. Until then every hole above reads as a defect.",
    );
  }

  console.log(
    `\nbucket grid ${BUCKET_SIZE_M}m. Blind spot: this cannot see a stretch that is ` +
      `missing from BOTH sides of a line, because a hole needs a value either side of it.`,
  );

  await pool.end();
}

// Only when run as the entry point, so the test can import `holesByLine`
// without opening a connection to the live database.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

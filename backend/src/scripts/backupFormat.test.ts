import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  archiveContents,
  archiveFile,
  archiveState,
  backupFileName,
  childEnv,
  compareMeasures,
  compareSchema,
  coverageProblems,
  createArchiveReader,
  dataArgs,
  dropLibpqSettings,
  droppedTables,
  dumpArgs,
  dumpFileOf,
  encryptOwnConnection,
  expectedTables,
  isInside,
  libpqEnv,
  listArgs,
  readManifest,
  restorableList,
  restoreArgs,
  samePath,
  sequenceProblems,
  toolMajor,
  type RestoreTest,
} from "./backupFormat.js";

// The backup's rules that decide whether it is a backup at all, and whether it
// can ever write to production: what each tool is handed, how their output is
// read, what a database must hold before it is backed up, and how a copy is
// judged against the original. backupDatabase.ts and restoreDrill.ts run the
// tools; these are the parts with no tool to run. restoreDrill.test.ts and
// throwawayServer.test.ts test the parts that touch files.

const URL_ = "postgresql://postgres.otsxafnmgdlldqkctzgo:p%40ss%2Fw%3Ard%20x@aws-0-us-west-2.pooler.supabase.com:5432/postgres";
const PASSWORD = "p@ss/w:rd x";

test("pg_dump's connection is libpq's variables, the password decoded, and TLS required whatever it is pointed at", () => {
  assert.deepEqual(libpqEnv(URL_), {
    PGHOST: "aws-0-us-west-2.pooler.supabase.com",
    PGPORT: "5432",
    PGUSER: "postgres.otsxafnmgdlldqkctzgo",
    PGPASSWORD: PASSWORD,
    PGDATABASE: "postgres",
    PGSSLMODE: "require",
    PGCONNECT_TIMEOUT: "20",
    PGAPPNAME: "cyclingdataapp-backup",
  });
  const local = libpqEnv("postgres://u@127.0.0.1/");
  assert.equal(local.PGPORT, "5432", "no port: libpq's default");
  assert.equal(local.PGDATABASE, "postgres", "no database: postgres");
  assert.equal(local.PGSSLMODE, "require", "a local database is no exception: there is one setting, and it is TLS");
  assert.equal(libpqEnv(`${URL_}?sslmode=disable`).PGSSLMODE, "require", "a setting in the URL is not passed on");
  assert.throws(() => libpqEnv("mysql://u:p@h/db"), /not postgres/);
  assert.throws(() => libpqEnv("postgresql:///db"), /no host/);
  assert.throws(() => libpqEnv("not a url"), /not a URL/);
});

test("the backup's own connection (pool.ts) drops the shell's libpq settings and asks node-postgres for TLS", () => {
  const env: NodeJS.ProcessEnv = { PATH: "C:\\Windows", PGSSLMODE: "disable", PGOPTIONS: "-c search_path=x", pghost: "elsewhere", PG_BIN: "C:\\pg", DATABASE_URL: URL_ };
  encryptOwnConnection(env);
  assert.deepEqual(env, { PATH: "C:\\Windows", PGSSLMODE: "no-verify", DATABASE_URL: URL_ }, "no-verify: node-postgres's name for libpq's require");
  const restoreTestEnv: NodeJS.ProcessEnv = { PGSSLMODE: "require", PGPASSWORD: "x", TEMP: "C:\\t" };
  dropLibpqSettings(restoreTestEnv);
  assert.deepEqual(restoreTestEnv, { TEMP: "C:\\t" }, "the restore test's connection is its URL alone");
});

test("no tool is ever handed the password or an address on its command line", () => {
  const every = [...dumpArgs("00000003-0000001B-1", "C:\\b\\x.dump.partial"), ...listArgs("x"), ...dataArgs("x"), ...restoreArgs(55432, "x", "l")];
  for (const arg of every) {
    assert.ok(!arg.includes(PASSWORD) && !arg.includes("supabase"), `${arg} carries the connection`);
  }
  for (const arg of dumpArgs("s", "f")) assert.doesNotMatch(arg, /^(-h|-d|-U|--host|--dbname|--username|--port)/, `pg_dump is handed ${arg}`);
  assert.doesNotMatch([...listArgs("x"), ...dataArgs("x")].join(" "), /--(host|dbname|port)/, "reading an archive connects to nothing");
});

test("pg_dump reads the measures' snapshot: the public schema and PostGIS, compressed, no owners or grants", () => {
  assert.deepEqual(dumpArgs("00000003-0000001B-1", "C:\\b\\x.dump.partial"), [
    "--format=custom",
    "--schema=public",
    "--extension=postgis",
    "--no-owner",
    "--no-privileges",
    "--lock-wait-timeout=30s",
    "--snapshot=00000003-0000001B-1",
    "--file=C:\\b\\x.dump.partial",
  ]);
});

test("the restore can only reach this computer, and stops at the first error", () => {
  const args = restoreArgs(55432, "C:\\b\\x.dump", "C:\\t\\restore.list");
  assert.equal(args.filter((a) => a.startsWith("--host")).join(), "--host=127.0.0.1");
  assert.ok(args.includes("--port=55432"));
  assert.ok(args.includes("--exit-on-error"), "a restore that half-worked is a failed test, not a pass");
  assert.ok(args.includes("--use-list=C:\\t\\restore.list"), "only the entries the list keeps");
  assert.equal(args.at(-1), "C:\\b\\x.dump");
});

test("a tool runs with none of the shell's libpq settings: only the ones it is given", () => {
  const shell = {
    PATH: "C:\\Windows",
    SystemRoot: "C:\\Windows",
    PGHOST: "db.elsewhere",
    PGPASSWORD: "leaked",
    pgservice: "prod",
    PGPASSFILE: "C:\\pgpass",
    DATABASE_URL: URL_,
    PG_BIN: "C:\\old",
  };
  assert.deepEqual(childEnv(shell, { PGSSLMODE: "disable" }), { PATH: "C:\\Windows", SystemRoot: "C:\\Windows", PGSSLMODE: "disable" });
  assert.deepEqual(childEnv(shell, {}), { PATH: "C:\\Windows", SystemRoot: "C:\\Windows" });
});

test("a tool's version is its major number", () => {
  assert.equal(toolMajor("pg_dump (PostgreSQL) 17.11"), 17);
  assert.equal(toolMajor("pg_dump (PostgreSQL) 18beta1"), 18);
  assert.equal(toolMajor("pg_restore (PostgreSQL) 9.6.24"), 9);
  assert.equal(toolMajor("pg_dump: command not found"), null);
});

// What pg_restore --list prints (pg_restore 17.11 on a backup of 2026-10-25,
// trimmed; the trigger, policy and row security lines are in its format, for
// entries production does not have yet): ";" lines are comments; an entry is
// "id; table-oid oid KIND schema name owner".
const LIST = `;
; Archive created at 2026-10-25 11:02:11 MDT
;     Dumped from database version: 17.6
;
; Selected TOC Entries:
;
26; 2615 2200 SCHEMA - public pg_database_owner
4739; 0 0 COMMENT - SCHEMA public pg_database_owner
2; 3079 17000 EXTENSION - postgis
5023; 0 0 COMMENT - EXTENSION postgis
226; 1259 17236 TABLE public sessions postgres
225; 1259 17235 SEQUENCE public sessions_id_seq postgres
5024; 0 0 SEQUENCE OWNED BY public sessions_id_seq postgres
4512; 2604 18537 DEFAULT public sessions id postgres
5001; 0 17236 TABLE DATA public sessions postgres
5030; 0 0 SEQUENCE SET public sessions_id_seq postgres
230; 1259 17300 TABLE public segment_coverage postgres
5009; 0 17300 TABLE DATA public segment_coverage postgres
4999; 0 16420 TABLE DATA public spatial_ref_sys supabase_admin
4870; 2606 17241 CONSTRAINT public sessions sessions_pkey postgres
4880; 1259 18900 INDEX public session_samples_session_idx postgres
4890; 2606 18910 FK CONSTRAINT public session_samples session_samples_session_id_fkey postgres
4900; 2620 18920 TRIGGER public sessions sessions_touch postgres
4910; 3256 18930 POLICY public sessions sessions_own postgres
4920; 0 0 ROW SECURITY public sessions postgres
;5002; 0 17400 TABLE DATA public commented_out postgres
`;

test("an archive's list gives its tables, their data, sequence values and extensions", () => {
  const contents = archiveContents(LIST);
  assert.deepEqual([...contents.tables].sort(), ["segment_coverage", "sessions"]);
  assert.deepEqual([...contents.data].sort(), ["segment_coverage", "sessions", "spatial_ref_sys"]);
  assert.deepEqual([...contents.sequenceSets], ["sessions_id_seq"]);
  assert.deepEqual([...contents.extensions], ["postgis"]);
  assert.ok(!contents.data.has("commented_out"), "a commented-out entry is not restored, so it is not there");
});

test("a restore leaves out CREATE SCHEMA public, which every database already has, and nothing else: no index, key, default, trigger or policy", () => {
  const lines = LIST.split("\n");
  const kept = restorableList(LIST).split("\n");
  assert.deepEqual(
    lines.filter((line) => !kept.includes(line)),
    ["26; 2615 2200 SCHEMA - public pg_database_owner"],
    "exactly one line goes",
  );
  for (const kind of ["COMMENT - SCHEMA public", " DEFAULT ", " CONSTRAINT ", " INDEX ", " FK CONSTRAINT ", " TRIGGER ", " POLICY ", " ROW SECURITY ", " SEQUENCE SET "]) {
    assert.ok(kept.some((line) => line.includes(kind)), `the ${kind.trim()} entry stays`);
  }
  assert.ok(kept.includes(";5002; 0 17400 TABLE DATA public commented_out postgres"), "comments stay comments");
  for (const other of ["26; 2615 2200 SCHEMA - publicity owner", "7; 2615 3000 SCHEMA - public_extra owner", "8; 2615 3001 SCHEMA - extensions postgres"]) {
    assert.equal(restorableList(other), other, `${other} stays`);
  }
});

test("the archive's data gives rows per table, to each one's end marker, and each public sequence's value", () => {
  const reader = createArchiveReader();
  const text = [
    "--",
    "-- PostgreSQL database dump",
    "SET statement_timeout = 0;",
    "COPY public.sessions (id, started_at, ended_at, device_info) FROM stdin;",
    "1\t2026-08-12 01:02:03+00\t\\N\tPixel",
    "2\t2026-08-13 01:02:03+00\t\\N\tline one\\nline two",
    "SELECT pg_catalog.setval('public.not_a_sequence', 5, true);",
    "\\.",
    "",
    "COPY public.segment_coverage (segment_id, direction, covered_from_m, covered_to_m, updated_at) FROM stdin;",
    "\\.",
    'COPY public."Odd ""name""" (a) FROM stdin;',
    "\\\\.",
    ".",
    "\\.",
    "SELECT pg_catalog.setval('public.sessions_id_seq', 89, true);",
    "SELECT pg_catalog.setval('public.unused_id_seq', 1, false);",
    "SELECT pg_catalog.setval('public.\"Odd\"\"seq\"', 7, true);",
    "SELECT pg_catalog.setval('public.\"it''s\"', 3, true);",
    "SELECT pg_catalog.setval('auth.refresh_tokens_id_seq', 400, true);",
  ];
  for (const line of text) reader.line(line);
  const { rows, sequences, unfinished } = reader.done();
  assert.deepEqual(
    [...rows],
    [["sessions", 3], ["segment_coverage", 0], ['Odd "name"', 2]],
    "a value of \\. is written \\\\., so it is a row, not the end; a line like a setval inside a table's rows is a row",
  );
  assert.equal(unfinished, null);
  assert.deepEqual(sequences, [
    { name: "sessions_id_seq", value: 89, called: true },
    { name: "unused_id_seq", value: 1, called: false },
    { name: 'Odd"seq', value: 7, called: true },
    { name: "it's", value: 3, called: true },
  ], "public's sequences only, names unquoted");

  const cut = createArchiveReader();
  for (const line of ["COPY public.sessions (id) FROM stdin;", "1", "2"]) cut.line(line);
  assert.equal(cut.done().unfinished, "sessions", "text that stops inside a table's rows says so");
});

test("a copy matches its original only with every table's rows and contents, and every sequence, the same", () => {
  const original = {
    tables: [
      { name: "sessions", rows: 33, fingerprint: "aa" },
      { name: "session_samples", rows: 34965, fingerprint: "bb" },
    ],
    sequences: [
      { name: "sessions_id_seq", lastValue: 89 },
      { name: "unused_seq", lastValue: null },
    ],
  };
  assert.deepEqual(compareMeasures(original, original), []);
  assert.deepEqual(
    compareMeasures(original, {
      tables: [
        { name: "sessions", rows: 32, fingerprint: "aa" },
        { name: "session_samples", rows: 34965, fingerprint: "cc" },
        { name: "extra", rows: 1, fingerprint: "dd" },
      ],
      sequences: [{ name: "sessions_id_seq", lastValue: 88 }],
    }),
    [
      "sessions: 32 rows, the original has 33",
      "session_samples: same 34965 rows, different contents (fingerprint cc, the original bb)",
      "extra: not in the original",
      "sequence sessions_id_seq: at 88, the original at 89",
      "sequence unused_seq: missing",
    ],
  );
  assert.deepEqual(compareMeasures(original, { tables: [{ name: "sessions", rows: 33 }] }), ["session_samples: missing"], "rows alone, as the archive check counts them");
});

test("a restored table matches only with every column, constraint, index, trigger and policy line the original had, and no others", () => {
  const original = [
    {
      name: "sessions",
      definition: [
        "column 1: id bigint not null default nextval('public.sessions_id_seq'::regclass)",
        "constraint sessions_pkey: PRIMARY KEY (id)",
        "index CREATE UNIQUE INDEX sessions_pkey ON public.sessions USING btree (id)",
        "table: row security off, logged",
      ],
    },
    { name: "segment_coverage", definition: ["table: row security off, logged"] },
  ];
  assert.deepEqual(compareSchema(original, original), []);
  const restored = [
    {
      name: "sessions",
      definition: ["column 1: id bigint not null", "constraint sessions_pkey: PRIMARY KEY (id)", "table: row security on, logged"],
    },
    { name: "stray", definition: [] },
  ];
  assert.deepEqual(compareSchema(original, restored), [
    "sessions: missing column 1: id bigint not null default nextval('public.sessions_id_seq'::regclass)",
    "sessions: missing index CREATE UNIQUE INDEX sessions_pkey ON public.sessions USING btree (id)",
    "sessions: missing table: row security off, logged",
    "sessions: not in the original: column 1: id bigint not null",
    "sessions: not in the original: table: row security on, logged",
    "segment_coverage: no definition found",
    "stray: a definition the original does not have",
  ]);
});

const SCHEMA_SQL = fileURLToPath(new URL("../db/schema.sql", import.meta.url));

test("the tables a backup must hold are the ones schema.sql creates", () => {
  assert.deepEqual(expectedTables(fs.readFileSync(SCHEMA_SQL, "utf8")), [
    "segment_coverage",
    "segment_dem_elevations",
    "segment_elevation_buckets",
    "segment_pass_buckets",
    "segments",
    "session_samples",
    "session_segment_matches",
    "sessions",
  ]);
  const sql = [
    "create table a (id int);",
    "  CREATE TABLE IF NOT EXISTS public.b (id int);",
    'create unlogged table "c" (id int);',
    "-- create table not_this (id int);",
    "create index d_idx on a (id);",
    "create table a (id int);",
  ].join("\n");
  assert.deepEqual(expectedTables(sql), ["a", "b", "c"], "a commented-out line is not a table; each name once");
});

test("a backup refuses a database it cannot hold all of: none of the app's tables, one schema.sql creates missing, one in another schema, one the last backup held gone", () => {
  const all = ["segments", "session_samples", "sessions"];
  const ok = { tables: all, expected: all, elsewhere: [], previous: { file: "cyclingdataapp-2026-10-25T16-55-26Z.dump", tables: all }, dropped: [] };
  assert.deepEqual(coverageProblems(ok), []);
  assert.deepEqual(coverageProblems({ ...ok, previous: null }), [], "the first backup has no last one");

  assert.deepEqual(coverageProblems({ ...ok, tables: [], expected: [], previous: null }), ["public holds no app tables: this would be a backup of nothing"]);
  assert.deepEqual(coverageProblems({ ...ok, tables: ["segments", "sessions"], previous: null }), [
    "session_samples: schema.sql creates it, and public has no such table",
  ]);
  assert.deepEqual(coverageProblems({ ...ok, elsewhere: [{ schema: "private", tables: "ride_notes" }] }), [
    "schema private holds tables this backup does not copy (it copies public only): ride_notes",
  ]);
  const gone = { ...ok, tables: ["segments", "sessions"], expected: ["segments", "sessions"] };
  assert.deepEqual(coverageProblems(gone), [
    "session_samples: in the last backup (cyclingdataapp-2026-10-25T16-55-26Z.dump) and gone now; if it was dropped on purpose, run with --dropped=session_samples",
  ]);
  assert.deepEqual(coverageProblems({ ...gone, dropped: ["session_samples"] }), [], "--dropped says it went on purpose");
  assert.deepEqual(
    coverageProblems({ ...ok, tables: ["segments", "sessions"] }),
    ["session_samples: schema.sql creates it, and public has no such table"],
    "one table, one problem: schema.sql's says it, the last backup's would repeat it",
  );
  assert.deepEqual(
    coverageProblems({ ...ok, tables: ["segments", "sessions"], dropped: ["session_samples"] }),
    ["session_samples: schema.sql creates it, and public has no such table"],
    "--dropped does not excuse a table schema.sql still creates",
  );
  // Every app table moved out of public: the review's second reproduction.
  assert.equal(coverageProblems({ ...ok, tables: [], elsewhere: [{ schema: "app", tables: all.join(", ") }] }).length, 1 + all.length + 1);
});

test("--dropped names tables, comma-separated, in one flag or several", () => {
  assert.deepEqual(droppedTables(["node", "backup", "--no-restore-test", "--dropped=a,b", "--dropped= c ,"]), ["a", "b", "c"]);
  assert.deepEqual(droppedTables(["node", "backup"]), []);
});

test("an archive's sequences restore safely only at or above the ids their columns already hold, in the snapshot", () => {
  const bounds = [
    { name: "sessions_id_seq", max: 89 },
    { name: "session_samples_id_seq", max: 40014 },
    { name: "empty_id_seq", max: null },
  ];
  const sets = [
    { name: "sessions_id_seq", value: 89, called: true },
    { name: "session_samples_id_seq", value: 40017, called: true },
    { name: "empty_id_seq", value: 1, called: false },
  ];
  assert.deepEqual(sequenceProblems(sets, bounds), [], "at the max, ahead of it (a ride saved while pg_dump ran), and unused on an empty table");
  assert.deepEqual(
    sequenceProblems(
      [
        { name: "sessions_id_seq", value: 88, called: true },
        { name: "session_samples_id_seq", value: 40014, called: false },
      ],
      bounds,
    ),
    [
      "sequence sessions_id_seq: the archive has it at 88, below the 89 its column already holds",
      "sequence session_samples_id_seq: the archive has it at 40014 (unused), below the 40014 its column already holds",
      "sequence empty_id_seq: no value in the archive",
    ],
  );
});

test("an archive is a backup once a restore test passed, unless its bytes have changed since", () => {
  const run = (passed: boolean, sha256?: string): RestoreTest => ({ passed, at: "2026-10-25T17:00:00.000Z", problems: passed ? [] : ["x"], seconds: 5, sha256 });
  const state = (...restoreTests: RestoreTest[]) => archiveState({ sha256: "good", restoreTests });
  assert.equal(state(), "untested");
  assert.equal(state(run(true, "good")), "passed");
  assert.equal(state(run(false, "good")), "failed");
  assert.equal(state(run(true, "good"), run(false, "good")), "passed", "a failure after a pass is the environment's, recorded, not the archive's");
  assert.equal(state(run(false, "good"), run(true, "good")), "passed", "a pass after a failure proves it");
  assert.equal(state(run(true, "good"), run(false, "bad")), "failed", "the bytes changed after they passed: that pass does not cover these");
  assert.equal(state(run(true)), "passed", "a test from before the sha256 was recorded");

  const dump = "cyclingdataapp-2026-10-25T16-55-26Z.dump";
  assert.equal(archiveFile(dump, "passed"), dump);
  assert.equal(archiveFile(dump, "untested"), `${dump}.untested`);
  assert.equal(archiveFile(dump, "failed"), `${dump}.failed`);
  for (const file of [dump, `${dump}.untested`, `${dump}.failed`]) assert.equal(dumpFileOf(file), dump, file);
  for (const file of [`${dump}.partial`, `${dump}.json`, "notes.dump", "cyclingdataapp-x.sql"]) assert.equal(dumpFileOf(file), null, file);
});

test("a manifest from before the history reads as one with its single restore test as the history, and no schema", () => {
  const legacy = {
    file: "cyclingdataapp-2026-10-25T16-55-26Z.dump",
    createdAt: "2026-10-25T16:55:26.305Z",
    server: { version: "17.6", postgis: "3.3.7" },
    pgDump: "pg_dump (PostgreSQL) 17.11",
    bytes: 9480721,
    sha256: "7b55",
    tables: [{ name: "sessions", rows: 52, fingerprint: "aa" }],
    sequences: [{ name: "sessions_id_seq", lastValue: 89 }],
    restoreTest: { passed: true, at: "2026-10-25T16:56:18.046Z", problems: [], seconds: 4.9 },
  };
  const read = readManifest(JSON.stringify(legacy));
  assert.deepEqual(read.restoreTests, [legacy.restoreTest]);
  assert.equal(read.schema, null);
  assert.ok(!("restoreTest" in read), "written back in today's shape");
  assert.equal(archiveState(read), "passed");
  assert.deepEqual(readManifest(JSON.stringify({ ...legacy, restoreTest: null })).restoreTests, []);
});

test("a backup's name sorts by time and has no colon, which Windows refuses in a file name", () => {
  assert.equal(backupFileName(new Date("2026-10-25T16:55:03.123Z")), "cyclingdataapp-2026-10-25T16-55-03Z.dump");
  assert.ok(backupFileName(new Date("2026-10-25T09:00:00Z")) < backupFileName(new Date("2026-10-25T10:00:00Z")));
});

test("inside means inside: the folder itself or below it, not a neighbour sharing its start", () => {
  const repo = path.resolve("/work/CyclingDataApp");
  assert.ok(isInside(path.join(repo, "backups"), repo));
  assert.ok(isInside(repo, repo));
  assert.ok(!isInside(path.resolve("/work/CyclingDataApp-backups"), repo), "a neighbour whose name starts the same");
  assert.ok(!isInside(path.resolve("/work"), repo));
  if (process.platform === "win32") {
    assert.ok(isInside("C:\\WORK\\cyclingdataapp\\x", "c:\\work\\CyclingDataApp"), "Windows paths ignore case");
    assert.ok(samePath("C:/Users/x/Temp/cyclingdataapp-throwaway-1/data", "C:\\Users\\x\\Temp\\cyclingdataapp-throwaway-1\\data"));
  }
  assert.ok(!samePath(path.resolve("/work/a"), path.resolve("/work/a/b")));
});

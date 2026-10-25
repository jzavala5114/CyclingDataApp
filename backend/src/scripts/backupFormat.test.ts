import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {
  archiveContents,
  backupFileName,
  childEnv,
  compareMeasures,
  createRowCounter,
  dataArgs,
  dumpArgs,
  isInside,
  libpqEnv,
  listArgs,
  restorableList,
  restoreArgs,
  toolMajor,
} from "./backupFormat.js";
import { removeWork, samePath } from "./restoreDrill.js";

// The backup's rules that decide whether it is a backup at all, and whether it
// can ever write to production: what each tool is handed, how their output is
// read, and how a copy is judged against the original. backupDatabase.ts and
// restoreDrill.ts run the tools; these are the parts with no tool to run.

const URL_ = "postgresql://postgres.otsxafnmgdlldqkctzgo:p%40ss%2Fw%3Ard%20x@aws-0-us-west-2.pooler.supabase.com:5432/postgres";
const PASSWORD = "p@ss/w:rd x";

test("the connection becomes libpq's variables, the password decoded, TLS required for production", () => {
  assert.deepEqual(libpqEnv(URL_, "require"), {
    PGHOST: "aws-0-us-west-2.pooler.supabase.com",
    PGPORT: "5432",
    PGUSER: "postgres.otsxafnmgdlldqkctzgo",
    PGPASSWORD: PASSWORD,
    PGDATABASE: "postgres",
    PGSSLMODE: "require",
    PGCONNECT_TIMEOUT: "20",
    PGAPPNAME: "cyclingdataapp-backup",
  });
  const plain = libpqEnv("postgres://u@db.example/", "disable");
  assert.equal(plain.PGPORT, "5432", "no port: libpq's default");
  assert.equal(plain.PGDATABASE, "postgres", "no database: postgres");
  assert.equal(plain.PGSSLMODE, "disable");
  assert.throws(() => libpqEnv("mysql://u:p@h/db", "require"), /not postgres/);
  assert.throws(() => libpqEnv("postgresql:///db", "require"), /no host/);
  assert.throws(() => libpqEnv("not a url", "require"), /not a URL/);
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
// trimmed): ";" lines are comments; an entry is "id; table-oid oid KIND schema name owner".
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
5001; 0 17236 TABLE DATA public sessions postgres
5030; 0 0 SEQUENCE SET public sessions_id_seq postgres
230; 1259 17300 TABLE public segment_coverage postgres
5009; 0 17300 TABLE DATA public segment_coverage postgres
4999; 0 16420 TABLE DATA public spatial_ref_sys supabase_admin
4870; 2606 17241 CONSTRAINT public sessions sessions_pkey postgres
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

test("a restore leaves out only CREATE SCHEMA public, which every database already has", () => {
  const kept = restorableList(LIST).split("\n");
  assert.equal(LIST.split("\n").length - kept.length, 1, "one line goes");
  assert.ok(!kept.includes("26; 2615 2200 SCHEMA - public pg_database_owner"));
  assert.ok(kept.includes("4739; 0 0 COMMENT - SCHEMA public pg_database_owner"), "its comment stays");
  assert.ok(kept.includes("5001; 0 17236 TABLE DATA public sessions postgres"));
  assert.ok(kept.includes(";5002; 0 17400 TABLE DATA public commented_out postgres"), "comments stay comments");
  for (const other of ["26; 2615 2200 SCHEMA - publicity owner", "7; 2615 3000 SCHEMA - public_extra owner", "8; 2615 3001 SCHEMA - extensions postgres"]) {
    assert.equal(restorableList(other), other, `${other} stays`);
  }
});

test("rows are counted out of the archive's data, table by table, to each one's end marker", () => {
  const counter = createRowCounter();
  const text = [
    "--",
    "-- PostgreSQL database dump",
    "SET statement_timeout = 0;",
    "COPY public.sessions (id, started_at, ended_at, device_info) FROM stdin;",
    "1\t2026-08-12 01:02:03+00\t\\N\tPixel",
    "2\t2026-08-13 01:02:03+00\t\\N\tline one\\nline two",
    "\\.",
    "",
    "COPY public.segment_coverage (segment_id, direction, covered_from_m, covered_to_m, updated_at) FROM stdin;",
    "\\.",
    'COPY public."Odd ""name""" (a) FROM stdin;',
    "\\\\.",
    ".",
    "\\.",
  ];
  for (const line of text) counter.line(line);
  const { rows, unfinished } = counter.done();
  assert.deepEqual([...rows], [["sessions", 2], ["segment_coverage", 0], ['Odd "name"', 2]], "a value of \\. is written \\\\., so it is a row, not the end");
  assert.equal(unfinished, null);

  const cut = createRowCounter();
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
  if (process.platform === "win32") assert.ok(isInside("C:\\WORK\\cyclingdataapp\\x", "c:\\work\\CyclingDataApp"), "Windows paths ignore case");
});

test("the restore test deletes its own temp folder and nothing else", () => {
  const tmp = path.resolve(os.tmpdir());
  for (const victim of [tmp, path.join(tmp, "other"), path.resolve("/"), path.join(tmp, "..", "cyclingdataapp-restore-test-x")]) {
    assert.throws(() => removeWork(victim, tmp), /refusing to delete/, victim);
  }
  assert.ok(samePath("C:/Users/x/Temp/cyclingdataapp-restore-test-1/data", "C:\\Users\\x\\Temp\\cyclingdataapp-restore-test-1\\data") || process.platform !== "win32");
});

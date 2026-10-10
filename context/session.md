# CyclingDataApp — project context

Working notes for picking this project back up. Covers what exists, why it's
built the way it is, and the failure modes already paid for.

Last updated 2026-10-05.

**Read the four blocks below before anything else.** They are the authoritative
queue and state. Everything after them is evidence and history: where a section
further down disagrees with these blocks, these blocks win and that section is
stale.

## NEXT, IN ORDER

### 1. Make every bigint id a number at the driver: one global int8 parser

**WHERE THIS STANDS (2026-10-10): COLD CRITIC ROUND 6 FAILED `dcec070`.
DECISION PENDING WITH JULIAN: fix F1-F7 and stop the loop (recommended), fix
and run round 7, or rebuild the scan on the type checker. Do not start work
until he answers. Nothing is pushed, merged or deployed.** Report:
`int8-parser\critique\round6\critic\critic-round-6.md`. All five round-5
findings CLOSED (each reproduction re-run). New, all in this round's code:
F1 minor, `import P = pgx.Pool` (an ImportEqualsDeclaration, its `pgx.Pool` a
QualifiedName) passes the scan, and findHoles reads ids as text; F2 minor, a
class parameter property `constructor(readonly types = rounding)` spread into
a query config passes the member rule, ids past 2^53 round silently; F3 nit,
pool.ts `export { Pool }` (no module specifier) passes, a second unchecked
Pool; F4 nit, `import pg from "pg"; export default pg` not flagged where
written (a consumer's `.Pool` is); F5 nit, a cast one level down (`flag ? (h
as unknown as any[]) : []`) hides a callback from the census; F6 nit, `[1] as
number[]` in the values slot now fails a healthy unread query; F7 nit, the
truthy-binary test tries only `true` and `1`, so `== true` survives (add
`"true"`). The critic's fixes: `ts.isImportEqualsDeclaration` with an
EntityName ending in Pool or Client (and `export import`); parameter
properties in the member rule; flag a local export of a binding imported from
pg; narrow F5's title or walk operands; let `opaque` ask the innermost layer
before assuming a callback; a string binary case. Round 6's critic cost 196k
tokens. Round 6's evidence, all
read-only from the committed tree, in `round6\` with a README: the full
mutation run on `dcec070`, 176 mutants, 0 not as expected (172 killed, the 4
controls survive); the run on `3e348fb` found R33 (the `never` flag in
`opaque`) dead once casts were opaque, which `dcec070` removed. The live
census: 82 sites, 11 timestamp lies, 0 of every other kind, identical to round
5's apart from line numbers. The `/segments` rehearsal: production, the
branch's local server and production again all `ba5cd316e15be6e4` (746
segments, 953 lines, 5,194 stops), ids numbers on the branch. What `3e348fb`
changed:
R1, a failed-connection test (A1, A1b killed). R2, `clientReplaced` tests
binary by truthiness; the scan in `pool.test.ts` is rewritten: each name it
looks for counts as an identifier in listed places and as a string or
template literal ANYWHERE (computed keys, element access, `Reflect.set`,
`Object.defineProperty`), `.types`/`.binary` read through any assignment,
members of every kind; its comment lists exactly what it reads and that a
name assembled at runtime is beyond it (P2f, P4b, P3, and 30 SC mutants on
the scan's own rules, killed). R3, the binary comments reworded. R4, a cast
argument is opaque, `callbackOf` looks under casts and reads the handler's own
parameter types, and a statement is read off the value under its cast (fixture
lines 76-86, CB1-CB10 killed). R5, `export * as x from "pg"` and `export {
default } from "pg"` flagged (E3d, E3e killed). A first run of the new mutants
found CB6 and CB7 (`satisfies`, `!`) equivalent on the fixture; fixture lines
83-84 (a cast under each) now kill them. Round 5's report:
`C:\Users\Julian\AppData\Local\Temp\int8-parser\critique\round5\critic\critic-round-5.md`
(its mutants and probes are beside it, `work\critic-mutants-5.mjs` and
`work\backend\probe5\`). All seven round-4 findings are CLOSED, and the
checkout behaves correctly at runtime. What failed, and the planned fix:
- **R1, minor (rubrics 5, 3).** `pool.ts:44`, `if (err || client === undefined)
  return callback(err, client, done);`, the connection-error path every
  `pool.query` takes, has no test. Mutant A1 (`return;`) hangs every query
  while the database is down; A1b (`callback(undefined, client, done)`) throws
  an uncaught TypeError that would crash the server. Both pass 425/425.
  **Fix:** in `pool.test.ts`, a stubbed connection step that answers with an
  error: `pool.query`, `pool.connect()` and `pool.connect(cb)` must each get
  that error (the promise branch rejects through `super.connect()` already).
- **R2, minor (rubrics 1, 8, 9).** Two spellings pass both the scan and the
  checkout. P2f: per-query parsers under a computed key, `{ ["types"]:
  rounding, text }`. P4b: `(pool.options as X).binary ||= 1`: the scan's
  `given()` (`pool.test.ts:168-177`) reads only `=` and never computed keys,
  and `clientReplaced` tests `binary === true` (`pgTypes.ts:101`) while pg
  tests truthiness (`pg/lib/client.js:102`, `:739`). **Fix:** `given()` reads
  every assignment operator (`=`, `||=`, `&&=`, `??=`) and computed keys that
  are string literals, and every object member (property, shorthand, method,
  get/set accessor); `clientReplaced` tests truthiness. Then make the
  comments exact rather than "however": the scan reads names written as an
  identifier, a string, or a computed string literal (`pgTypes.ts:50-53`,
  `pool.test.ts:154-156` and `:260`).
- **R3, nit (rubric 8).** "a client set to binary reads no text parser"
  (`pool.ts:16`, `pgTypes.ts:45`, `:97-98`, `:103`) is false: pg asks for
  binary only on parameterized queries, so others still read the text parser.
  **Fix:** reword; refusing a binary client stays right (pg-int8's binary
  parser returns int8 as text).
- **R4, nit (rubric 7).** A callback cast `as unknown as any[]` or `as unknown
  as undefined` passes the census silently. **Fix:** `callbackOf` and
  `resultUsed` look through casts (`as`, `<T>`, parentheses, `!`, `satisfies`)
  to the value; a function underneath is a callback. Add fixture lines and a
  test.
- **R5, nit.** `export * as pgx from "pg"` is not flagged where it is written
  (harmless: any `pgx.Pool` is). **Fix:** flag it.

**Then, in order:** (DONE 2026-10-09: mutants added, `3e348fb` and `dcec070`
committed, both full runs, the census, the rehearsal, `round6\README.txt`, the
brief. Round 6's critic was launched, then stopped at Julian's request before
its verdict. Never edit `backend/src`, run the census or commit while a
mutation run is going, since it rewrites files in place.) Relaunch round 6's
critic (see the top of this item), then read its verdict. If it FAILS, fix, run the mutants, commit, redo the census
and rehearsal, and brief round 7 the same way. Rounds 2 to 5 each found less;
if round 6 finds only further contrived spellings, put the choice to Julian:
stop the loop with the scan's limits stated exactly, or keep going. On a PASS:
ship (step 2 below, after Julian's go-ahead), then notes, then cleanup.

**IN PROGRESS on branch `global-int8-parser` (2026-10-05 to 10-09): BUILT, NOT
MERGED OR DEPLOYED. The cold critic's round 2 FAILED it on 2026-10-06; every
round-2 finding was fixed (`044d29c`, 2026-10-08). Round 3 confirmed all ten
closed and FAILED it on one new hole, pg's own `parseInt8` switch, plus smaller
findings, fixed the same day (`8eeeb4f`). Round 4 confirmed those closed and
FAILED it on minor and nit findings only, also fixed the same day (`d321bd5`,
see "Round 4" below). Round 5 confirmed those closed and FAILED it on minor
findings and nits (R1-R5 above), fixed 2026-10-09 (`3e348fb`).** Commits: `1206bed`
(the parser, the fallout, the new eval `npm run eval:query-types`), `0bf631d`
(critic round 1's fixes: a gate test on the `/segments` join, now
`services/segmentsResponse.ts`; census blind spots closed), progress saves,
`044d29c` (round-2 fixes), `8eeeb4f` (round-3 fixes), `d321bd5` (round-4
fixes), `3e348fb` (round-5 fixes). **427 backend tests** (394 before round 2's
fixes).

**What the critic is, and why it ran.** CLAUDE.md requires that a change be
attacked before it ships by a separate sub-agent that did not build it: a
"cold critic" that gets only the code, the evidence and a rubric frozen before
the work began, never the builder's reasoning, and whose job is to REJECT. It
may not touch the repository or the database; it mutates its own scratch copy.
The rubric's nine lines: one mechanism makes every int8 a number in every
process; nothing relies on ids being text; past 2^53 a query fails loudly
without a crash; numeric is untouched; every guard test fails when its
behaviour breaks; every test file states which driver it runs; the census
executes nothing, never skips a query in silence and fails when it cannot
check; comments are true; the phone's contract holds. **Round 1** (2026-10-05)
was cut off by the account's rate limit before its verdict, but its evidence
drove `0bf631d`. **Round 2** (2026-10-06) reviewed `1206bed` + `0bf631d`; full
report and probes in `C:\Users\Julian\AppData\Local\Temp\int8-parser\critique\round2\critic\`
(a temp folder: the substance is here).

**Round 2: FAIL.** The driver change itself held: one parser, loaded by the only
Pool, which both routes and all 18 scripts use; past 2^53 the query is rejected
and the process lives; numeric untouched; confirmed in a compiled production
build under plain node. It failed on the census and on guard tests:
- **Major 1. The census passes queries it cannot check whose result is READ.**
  An `untyped` verdict never fails it (`judgeCensus`, `evalQueryTypes.ts:572`),
  and `declaredRow` (`:232-245`) reads only a generic or a cast directly on the
  awaited call, so a cast on `.rows`, a cast on the promise, rows handed to a
  typed function, a typed `.then` callback and a callback-style query all come
  out `any`. The findHoles crash, rewritten with untyped rows, passes. Three
  real untyped-and-read sites: `routes/sessions.ts:17` (POST /sessions),
  `pruneEmptySessions.ts:58`, `rebuildModel.ts:86`. **Fix:** untyped-and-read
  fails the census (a callback counts as reading), and those three get generics.
- **Major 2. Production's driver could round past 2^53 with every test green.**
  `pool.test.ts` checks only "84" -> 84, so a `pool.ts` that swapped pgTypes.ts
  for a lenient `Number` parser (mutant C1b), or kept it and then registered the
  common `parseInt` override (C2), passes everything. **Fix:** assert in
  `pool.test.ts` that the configured parser throws on "9007199254740993".
- **Major 3. Nothing tests that the census's `main()` uses its safety helpers.**
  Replacing describe with execute AND dropping READ ONLY (C18b + C19, two edits
  together) passes every test, and in the real statement order the census would
  then run, in autocommit, `delete from session_segment_matches`, `segment_coverage`
  and `segment_elevation_buckets` (from `rebuildModel.ts:54-56` and
  `verifyRebuild.ts:99-101`): **the production elevation model.** Latent, two
  edits away, but the census points at production. Also untested in `main()`:
  the exit code (C17) and descriptions lining up with their sites (C20).
  **Fix:** extract `runCensus(client, sites)` and test it with the fake client
  the `describeAll` test already uses.
- **Minor.** (4) Census scope is never asserted on the real program: reading
  `tsconfig.json` instead (which drops `evalLinkerFold.ts`), or skipping
  `routes/` or `scripts/`, survives (C13-C15). (5) Silent skips and misreports:
  a `pg.Query` passed to `client.query` vanishes without a line; a
  callback-style runtime statement reads as "result not read";
  `osm-pipeline/scripts/lib/linkPlan.mjs:162` runs on the backend's client and
  never appears (another service's untyped JS: cover it or record it as out of
  scope); an unquoted camelCase alias, which pg lowercases so the field is
  always undefined, passes. (6) "Only one Pool" is a comment, not a check: a
  script building its own Pool survives (C4), and the census would not notice.
  (7) The routes' wire contracts are untested: the route stringifying ids
  before the join (C11, a blank map) and POST /sessions returning the id as
  text (C12) both survive. The phone is fine either way.
- **Nits.** `MapScreen.tsx:113-114` draws stale lines until restart if the app
  is open across the deploy (known, cosmetic). `pgTypes.ts:31-34` says
  bad_share is "the one numeric this backend reads", false: `evalLinkerFold.ts:263`
  reads `len` (typed string, only printed). `pool.ts:2-3`: a parser is looked up
  once per result, not per row. `evalQueryTypes.ts:13`: "nine fields", not
  "nine interfaces". `backend/README.md:66` omits the `unchecked` exit.
  `segmentsResponse.test.ts:59` asserts the blank-street FAILURE, so it would
  block hardening the join to tolerate mixed id types: delete it.
- **And it was right about my evidence.** "54 mutants, all as expected" (in
  `0bf631d`'s message and this note's last version) was never re-run after N6
  was retired; the file on disk is the 55-mutant run in which N6 survived.
  `census-on-main-driver.txt` came from the round-1 census, not the current one.
  (The prune-sessions diff it found missing is now saved.)

**Round-2 fixes, 2026-10-08.** Evidence in
`C:\Users\Julian\AppData\Local\Temp\int8-parser\critique\round3\` (temp; the
substance is here).
- **Major 1.** Rows typed `any` that the code reads now fail the census
  (`Census.untypedRead`; `any` rows nothing reads still pass). A callback counts
  as reading the result. The row type is now also read from a cast on the
  promise and from a callback's result parameter; any other place (a cast on
  `.rows`, rows handed to a typed function) stays `any`, which fails when read,
  so it cannot pass by accident. The three real sites got row types. The
  findHoles crash written untyped (fixture line 49) now FAILS.
- **Major 2.** `pool.test.ts` asserts that the driver pool.ts leaves in place
  throws on `9007199254740993`, for int8 and int8[]. C1b and C2 are killed.
- **Major 3.** `runCensus(client, sites, outside, log)` is everything `main()`
  did after finding the queries, the exit code included. A recording fake
  client pins exactly what reaches the database: `begin read only`; per
  statement `savepoint describe`, the describe, `release savepoint describe`;
  the pg_type lookup; `rollback`. C17-C20, C18b and C18c are killed.
- **Minor 4.** A gate test loads the real program (about 1.3 s) and asserts
  sites in `routes/`, `services/`, `scripts/` and `evalLinkerFold.ts`. C13-C15
  are killed.
- **Minor 5.** A Submittable (`pg.Query`, a cursor) is now a site that fails
  the census, except the census's own `DescribeStatement` (by class AND file).
  A runtime statement with a callback is unchecked, so it fails. `linkPlan.mjs`
  is named under OUTSIDE THE CENSUS (through `linkPlan.d.mts`). An unquoted
  camelCase alias fails (`Census.caseFolded`). A census with no sites fails.
  A column whose type pg_type did not return throws, which kills C16 (round 2
  had judged it equivalent).
- **Minor 6.** `pool.test.ts` scans every non-test source file: no other
  `new Pool`/`new Client` (under any import name), no `types` parser override
  on a query or connection config (passed directly or built beforehand), no
  `setTypeParser` outside `pgTypes.ts`. It has its own control test. C4, C4b
  and C4c are killed.
- **Minor 7.** `routes/segments.test.ts` and `routes/sessions.test.ts` drive
  the real routers over HTTP, `pool.query` mocked, rows built by the configured
  driver. C10-C12 are killed.
- **Nits.** Comments fixed: pgTypes' numeric claim, pool.ts's lookup timing,
  the census header and the README's exit conditions. The segmentsResponse test
  that asserted the blank-street failure is deleted (C29, a String()-keyed
  join, now survives, as a hardening should). `linkPlan.mjs:172`'s pre-existing
  wrong comment is corrected: node ids come out of `json_agg`, so they are JSON
  numbers on any driver.
- **MapScreen's transient double-draw** cannot be fixed from here: the app
  that is open across the deploy is the installed APK. After the deploy, close
  and reopen the app once.
- **Mutation run (`mutation-run-3.txt`)**: 92 mutants, each against the WHOLE
  gate suite, survivors also typechecked. An earlier run of the same harness
  (`mutation-run-3-first.txt`) found one claimed-equivalent control wrong: S14
  (int8[] syntax read by the int4[] parser) is caught by the new pool test,
  because its refusal names 9007199254740992 instead of the 9007199254740993
  the database sent. It is now an ordinary mutant.
- **Census, live and read-only:** on the branch (`census-on-branch.txt`): 82
  sites, 11 timestamp lies, 0 untyped and read, FAIL by design. The CURRENT
  census on main's code and driver (`census-on-main.txt`, from the frozen copy
  of `origin/main` 235f963): 56 lies, 44 of them int8 declared `number`
  arriving as text, plus the 3 untyped sites: FAIL, as it should.
- `segments-probe.mjs` is now in the evidence folder: it normalises `id` to
  text before hashing, and the response carries no other int8 field (`id`,
  `streetName`, `geom`, `lengthM`, `directionalLines`), so the identical hash
  across the type change is honest. `before-after-summary.tsv` holds all 14
  pairs. Round 2 reported four missing because the run was still finishing
  during its review: the last pair completed at 19:27 on 2026-10-06 (progress
  log), and the copy it was handed was rewritten then.

**Round 3 (2026-10-08, on `044d29c`): FAIL, and right.** Scoped, per Julian, to
re-checking round 2 and attacking the new code: 35 mutants, 16 census probes.
All ten round-2 findings CLOSED (C1b-C20 killed; C29 survives, correctly). What
it found, all fixed on 2026-10-08; report in
`int8-parser\critique\round3\critic\critic-round-3.md`:
- **F1, major. pg's own switch, `pg.defaults.parseInt8`, got past every guard.**
  `= true` installs int4's parseInt (rounds past 2^53), `= false` puts pg's
  text parser back; one line in `src/index.ts` did either with all 418 tests
  green, and `pgTypes.ts`'s comment claimed it was covered. **Fixed twice
  over:** `pool.ts` now builds a `CheckedPool` whose `connect()` (which
  `pool.query` also goes through) asks `driverReplaced()` (exported by
  `pgTypes.ts` with the two parsers it registers) whether the int8 and int8[]
  parsers are still its own, and fails the checkout with the reason if not:
  every spelling, every process, before any row is parsed. And the source scan
  now flags any mention of `parseInt8`, `setTypeParser` outside `pgTypes.ts`
  (element access too), and any VALUE reference to pg's Pool or Client outside
  `pool.ts` (`new (pg.Pool)`, `pg["Pool"]`, destructuring, an aliased import,
  `pg-pool`), with a walk that must reach named files. The scan catches it at
  commit time; the tripwire catches what the scan cannot spell.
- **F2, minor.** An argument typed `any` after the statement now counts as a
  possible callback (read), and a first argument typed `any` as a possible
  Submittable (unchecked, fails).
- **F3, minor.** `main()`'s wiring is now `censusCommand(client, program,
  backendDir)`, run over the REAL program in `evalQueryTypes.program.test.ts`
  with a database that describes every statement as columnless. And code the
  census cannot read now FAILS it unless `ACCEPTED_OUTSIDE` names it with why
  it is safe (linkPlan.mjs is the one entry); an entry whose module is gone
  fails too.
- **F4, minor.** The promise-cast test could not fail for pg's own query,
  because TypeScript infers the generic from the cast; a plain-client fixture
  (line 62) now needs the code.
- **F5-F7, nits.** Scan spellings (above); the README's exit list completed;
  the round-3 census output cited a line one off from the commit (it ran on the
  working tree before two comment edits), so round 4's census is run from the
  committed tree; `round3\before-after-summary.tsv` is round 2's, carried over
  (labelled as such in `round4\README.txt`).
- **The gate's time:** the suite takes about 3.5 s (it was 3.3 s at 394 tests,
  already over CLAUDE.md's 2 s before this work); the real-program tests sit in
  their own file so they run in parallel.
- **Evidence (`int8-parser\critique\round4\`, `8eeeb4f`):** 113 mutants, each
  against the whole gate suite with survivors typechecked: 109 killed, every
  round-3 survivor among them, and the 4 controls survive. (Round 1's census
  mutants and round 3's are both numbered N1, N3, N5 in that log; their
  descriptions tell them apart.) The live census from the committed tree: 82
  sites, 11 timestamp lies, nothing else. Rides 86 and 87 landed after
  2026-10-06, so main's frozen copy and the branch were re-run on today's
  data: `find-holes` and `verify-barometer` byte-identical, `prune-sessions`
  differing only in `'5'` against `5`, every exit 0 (the tripwire stays silent
  in real processes). The `/segments` rehearsal on today's data: production
  and the branch's server run locally both give whole-response hash
  `ba5cd316e15be6e4` (746 segments, 953 lines, 5,194 stops), ids text in
  production and numbers on the branch; production's hash was the same before
  and after.

**Round 4 (2026-10-08, on `0abc022`): FAIL, minor and nits only.** All seven
round-3 findings CLOSED (N1, N1b, N3, N5, N12, N16 killed; probes N.c and N.d
fail the census). Report: `int8-parser\critique\round4\critic\critic-round-4.md`.
What it found, all fixed on 2026-10-08:
- **G1, minor.** No test sent a healthy `pool.query` through the checkout's
  CALLBACK branch, the one pg-pool's `query` uses: a refactor making every query
  hang (H1) or reject (H2) passed. Now a test runs a healthy `pool.query`, a
  promise checkout and a callback checkout through a real, never-connected pg
  Client handed out by a stubbed connection step.
- **G2, minor.** `pool.options.types = { getTypeParser }` got past the
  tripwire, which read only the registry, while pg asks a client's own `types`
  first; the server would have rounded silently. Now every checkout also checks
  the CLIENT it hands out, through pg's own lookup (`clientReplaced` in
  `pgTypes.ts`), refuses a client set to binary (pg-int8's binary parser
  returns text), and releases a refused client WITH the error, which makes
  pg-pool remove it. The scan also flags `types` given by assignment or in any
  object literal (unless it is an array, the census's Parse message), and
  `binary` anywhere.
- **G3, minor.** `export { Pool } from "pg"` in one file let another build a
  Pool past the scan. The scan now flags re-exports of Pool or Client, and
  `export * from "pg"` or `"pg-pool"`.
- **G4, nit.** A replacement made while a client is checked out reaches that
  client's later queries; the comments said "fails the query". They now say
  the next checkout refuses.
- **G5, nit.** Arguments spread from a tuple, and a callback cast `as never`,
  passed the census as unread. Both are now "opaque", like `any`.
- **G6, nit.** `binary` (covered above). **G7, nit.** `ACCEPTED_OUTSIDE` said
  only buildLinkPlan runs; `decide`, which is pure, runs too. Reworded.
- Accepted, as round 2 accepted it: `main()` itself is a one-line hand-off to
  `censusCommand`, which is tested; a mutant bypassing it in `main()` survives.
- **Evidence so far (`int8-parser\critique\round5\`):** 127 mutants, each
  against the whole gate suite, survivors typechecked: 0 not as expected, 123
  killed (round 4's H1, H2, E1, E3 among them, plus H3-H8, E4, R32, R33), and
  the 4 controls survive. 425 backend tests, typecheck clean. NOT yet redone
  for this round: the live census and the rehearsal (step 0 below).

**Verified, and not to redo unless a fix touches it:** all 14 read-only scripts
run from frozen copies of main and the branch on fingerprinted data, 13
byte-identical and `prune-sessions` differing only in printing `'5'` as `5`
(`eval:smoothing` exits 1 on BOTH sides, its own verdict, see item 6); the
branch's server run locally returns `/segments` with production's whole-response
hash, `0a2be04de99909af`, ids now numbers, while a broken-join control returns 0
lines; the live census finds 81 sites (82 since 2026-10-08, when the census's
own describe became a site), 0 numeric lies, 11 timestamp lies; the production
build compiles with no sibling directories. The `/segments` rehearsal was not
repeated for the round-2 fixes: `routes/segments.ts` is unchanged since it ran,
and `routes/sessions.ts` gained only a type annotation, which compiles away.
Round 3's tripwire DOES change the server's query path (every checkout now
passes through `CheckedPool.connect`), so the rehearsal and three quick
read-only scripts are re-run for it: results in `int8-parser\critique\round4\`.

**How much is left, in order (working time, roughly 1 hour plus the critic):**
0. **DONE 2026-10-09: round 5's evidence, all read-only, from the committed
   tree (`d321bd5`), in `int8-parser\critique\round5\` with a README.** The
   live census: 82 sites, 11 timestamp lies, 0 of every other kind. Main's
   frozen copy against the branch on today's data (unchanged since
   2026-10-08): `find-holes` and `verify-barometer` byte-identical,
   `prune-sessions` only `'5'` against `5`, every exit 0. The `/segments`
   rehearsal: production, the branch's local server and production again all
   `ba5cd316e15be6e4` (746 segments, 953 lines), ids numbers on the branch;
   its GET went through the per-client check on a real pg client. How it was
   run, for next time: the census by `npm run eval:query-types`; the scripts
   as `npx tsx <cmp\before copy>` then `npx tsx src/scripts/<name>.ts` with
   `node tmp-fingerprint.mjs` before and after (`prune-sessions` never with
   `--apply`); the server with `PORT=3999 node --import tsx src/index.ts`,
   probed with `BASE=http://localhost:3999 node segments-probe.mjs`, then
   `taskkill //PID <pid> //F` (PID from `netstat -ano`).
1. **Cold critic round 5: DONE 2026-10-09, FAIL on minor findings and nits
   (R1-R5, at the top of this item), fixed in `3e348fb`. Next: round 6's
   evidence (the census and the rehearsal, as in step 0), then round 6, its
   brief drafted in `int8-parser\critique\round6\`.** Scoped like rounds 3 and 4
   (Julian asked on 2026-10-08 to keep sub-agent use down): re-check round 4's
   findings and attack only the new code. Brief and verdict in
   `int8-parser\critique\round5\`. Loop until it passes; a round that cannot
   pass names what is missing. Rounds 2 to 4 each found less, and round 4's
   findings were all minor or nits.
2. **Ship, about 15 min, after Julian's go-ahead, since merging deploys.**
   Merge `global-int8-parser` into `main`
   (fast-forward) and push, which deploys. In the session scratchpad
   (`C:\Users\Julian\AppData\Local\Temp\claude\c--Users-Julian-Documents-GitHub-CyclingDataApp\e24d4bb5-018e-46b7-89ee-9dee82f392bf\scratchpad\`):
   **First, just before merging, `node segments-probe.mjs` against production**
   and keep its hash: the old expected hash, `0a2be04de99909af`, went stale when
   rides 86 and 87 landed (on 2026-10-08 it was `ba5cd316e15be6e4`, and the
   branch's local server matched it). After the merge, `bash watch-deploy.sh`
   until `builtAt` moves, then `node segments-probe.mjs` again: the same hash as
   the pre-merge probe, with `idTypes ["number"]`. A ride landing in between
   moves the hash legitimately, so compare counts and re-probe if it moved. Then
   close and reopen the app once (MapScreen's transient double-draw).
3. **Notes, about 20 min.** `notes-int8.mjs` in the scratchpad rewrites this
   file's top for the closed state. Its text already covers rounds 1-3 (11
   swaps, dry-run clean on 2026-10-08); add round 4's verdict and the new
   rehearsal hash, dry-run with `NOTES=<copy>`, then `node notes-int8.mjs <main
   commit> <builtAt> <tests> "<critic verdict>"`; commit on a branch, merge,
   push.
4. **Clean up.** Delete the frozen copies in `scratchpad\cmp\` (on 2026-10-08
   `cmp\before` also gained the current census and main's
   `tsconfig.check.json`, for the census-on-main run). Each
   `backend\node_modules` in them is a JUNCTION into the repo: remove the link
   itself first, never recurse through it. Check the round 3 and round 4
   critics' folders for a junction the same way (round 3's critic reported
   removing its own). (Round 1's critic left one under
   `int8-parser\critique\critic\repro\`; removed 2026-10-06.)

**Found on the way, not fixed: timestamps arrive as `Date` and `Date.parse()`
drops their milliseconds** (34,361 of 34,402 fixes carry a sub-second part;
the matcher, the spike filter and the ride processor are all affected). It
becomes item 1 when this one closes; the notes script writes it up.

**Recommended on 2026-10-04 as the fastest and the safest of three options,
all three measured.** Julian asked which would take the least time and this is
the answer, and he gave the go-ahead on 2026-10-05. The order of this list is a
recommendation he can change. node-postgres returns `bigint` as text, and nine
fields in `types/index.ts` are typed `number` while holding text:
`Segment.id`, `osmWayId`, `startNodeId`, `endNodeId`; `SessionSample.id`,
`sessionId`; `MatchedRun.segmentId`; `ElevationBucket.segmentId`;
`SegmentCoverage.segmentId`. **They are joined to each other**, so converting
one without its partners ships every street with an empty profile and throws
nothing (see the Open items entry). A single parser converts all of them at
once, so they cannot get out of step. That is why (b) beats doing it by hand.

**Build:**
- `backend/src/db/pgTypes.ts` calling
  `pg.types.setTypeParser(20, (text) => bigintId(text, "int8 column"))`,
  imported on the first line of `db/pool.ts`. **Its own module, not a side
  effect inside pool.ts**, because no test imports pool.ts: a registration that
  lives only there leaves every test on pg's default while production runs
  numbers. Its test imports the module and asserts the parser turns "84" into
  84 and throws on "9007199254740993".
- `numeric` (OID 1700) is not int8 and stays text: keep `numericOrNull` for
  `bad_share`. Int8 ARRAYS have their own parser (OID 1016); none come back to
  JS today, only `$1::bigint[]` inputs, so leave it and say so in the module.

**Fix, found 2026-10-04 by searching for code that relies on ids being text:**
- **The one crash:** `findHoles.ts:91` calls `line.segmentId.padStart(6)`
  without `String()`, so `npm run find-holes` would throw a TypeError. Retype
  `BucketRow.segment_id` and `LineHoles.segmentId` to `number` and update
  `findHoles.test.ts`.
- **Five row types declaring a bigint column as `string`**, which become lies
  the other way: `findHoles.ts:29`, `evalLinkerFold.ts:261` (`id`),
  `pruneEmptySessions.ts:18` (`id`), `demElevation.ts:68` and `:104`
  (`segment_id`; its `Number(row.segment_id)` calls become no-ops, remove them).
- **The premise tests** in `pgNumbers.test.ts` and `usableSessions.test.ts` build
  fixtures with pg's DEFAULT int8 parser. Decide on purpose whether they test the
  converter against raw driver text or the configured driver. Do not let import
  order decide it.

**Already checked, do not re-check:**
- The ride-end path (`sessionProcessor` -> `demElevation`) keys DEM rows with a
  template literal, `${segmentId}|...`, which gives "123" for both 123 and
  "123". Safe.
- No `::text` cast on any id; no ordering comparison (`<`, `>`, `localeCompare`)
  on any id; every other `padStart` on an id is already wrapped in `String()`.
- **No phone change is needed.** `mobile/src/services/api.ts:45` already types
  the id `number`, so this makes it true. One side effect: `MapScreen.tsx:113-114`
  merges segments by `id`, so if the app is open across the deploy one batch of
  lines draws twice until it is reopened. Cosmetic. The persisted session id
  (`useTrackingSession.ts:399`) is never compared by value.
- The alternatives, measured on a scratch copy so nobody measures them again:
  (a) convert 16 query sites by hand, same end state as (b); (c) retype the nine
  as `string`: 243 type errors in 16 files, 164 in tests (153 in
  `coverageExtent.test.ts`).

**Verify with checks that CAN fail:**
- **Live `/segments`, before and after the deploy.** Baseline taken 2026-10-05
  over `minLon=-105.1&minLat=38.6&maxLon=-104.5&maxLat=39.1`: **745 segments,
  all 745 with at least one directional line, 951 directional lines, 0 lines
  with fewer than 2 points, 0 lines with zero `colorStops`, 5,181 `colorStops`
  in total, `id` sent as a string.** After: the same counts, `id` sent as a
  number. Any drop is the join failure.
- **A `trace-passes` replay PINNED to a fixed ride list.** Unlike the
  session-id fix, where the replay was blind because that id is only a label,
  segment ids are Map keys throughout the matcher, so any mixed comparison moves
  the counts. Pin it: session 85 arrived mid-task on 2026-10-04 and moved every
  unpinned number.
- Then `builtAt` moving.

### 2. Grade session 85

`npm run verify-barometer` from `backend/`. Ride of 2026-10-04 19:03 UTC, 2,689
fixes, never graded. Read-only. See "HOW TO REBUILD THE APK, AND HOW A RIDE IS
GRADED".

### 3. A fix from an ended ride is filed under the next one

Session 83's last fix landed in session 84, timestamped 21 s before 84 began.
**Not located yet.** Likeliest place: the phone's background location buffer
(`mobile/src/services/backgroundLocationTask.ts`) being flushed after the active
session changed. Find the mechanism before sizing it.

### 4. The 9 m barometric outlier

Session 84, 19:35:04Z, one fix in 1367. The fix is NOT the spike filter: persist
`readingCount` and `meanOffsetMs` from `altitudeAtFix` so the next one can be
diagnosed after the ride. A migration, an app change and an APK rebuild.
**The migration touches production: confirm with Julian before running it.**

### 5. The matcher's two open levers, which both wait on one instrument

Build the instrument first: `findPasses` with `minPassM: 15` and `MIN_SPAN_M`
left at 25, so the witness can see under 25 m and stays independent of what is
swept. A measurement, not a change. Then:
- **`TANGENT_WINDOW_M`**, the strongest open lever: 14 m is 286 m better than
  the shipped 10 m. Its +4 / -4 lines need the `eval:heading-lines` treatment,
  and moving it needs a `rebuild-model`.
- **The traversal gate**: the corrected sweep leans toward loosening and cannot
  settle it.
See "What is left for the matcher".

### 6. Smaller, in no order

- **The zero-run census**: how many ridden segments produce no run at all, and so
  appear in no ledger here. The most valuable unmeasured number.
- **The same-way class**: 196 next-door passes / 11.3 km drawn mostly on another
  piece of the same OSM way, almost all on switchback trails. Two explanations
  tried and both wrong. Flagged in `trace-passes` output, not claimed as a defect.
- **`eval:heading` and `eval:spikes`** still report `gate` columns from the
  classifier before `9c13174`. Their conclusions rest on wrong-dir and discard
  rate, which that fix does not touch, so they stand; the gate columns do not.
- **Debt:** the linker's measuring tools have no tests, and
  `context/architecture.html` is over a month stale.

## SETTLED: do not re-examine

| question | answer | evidence |
|---|---|---|
| Viterbi matching | **No.** 28 m of genuine fork, and the graph has no edge at 45 of the 47 places the rider turned | "Does the matcher need Viterbi?" |
| joining segment ends that meet but share no node (`endpointSnapM`) | **Built, left at 0.** Cuts impossible transitions 35% and moves the map 70 m in 225 km | "Lever 1 was BUILT and MEASURED" |
| `MAX_BEARING_DELTA_DEG` | **Swept, left at 45.** Strictly worse at every width | its doc comment in `segmentMatcher.ts` |
| hairpins causing wrong-dir | **No.** 1 of 23 passes | "Lever 2" |
| tunnels missing from the map | **A misread label.** The real defect is 55 m of Gold Camp Road | struck entry in "Open items" |
| `STITCH_WINDOW_S` | **Swept, keep 45.** 90 s adds 249 m, 214 m of it unwitnessed, and no new line | note 26 |
| "the gate losses were unstitched fragments" | **No.** Each is one pre-stitch run (close to a base rate). The traversals fragment across SEGMENTS, which the stitcher cannot join | "The gate sweep: ATTEMPTED" |
| the pass ledger's cause order | **Fixed** in `9c13174`. `gate` is 4 passes / 179 m over 44 rides | paid-for #31 |
| `SessionVerdict.id` and `bad_share` arriving as text | **Fixed** in `af653f8`, converted at the boundary | paid-for #30 |
| whether a docs-only push deploys | **No.** Railway watches `backend/**`; tested 2026-10-04 | commit `4b028c8` |
| the barometer | **Finished.** Session 84 graded `alive`, 1366 of 1367 fixes barometric | "The barometer: shipped, installed, verified" |

## OPEN: genuinely undecided, do not treat as closed

- **The traversal gate.** The instrument cannot judge it. Item 5.
- **`TANGENT_WINDOW_M`.** Closed on 2026-10-04 and reopened the same day. Item 5.
- **The same-way class.** Unexplained. Item 6.

## STATE, 2026-10-05

`main` is the only branch, local and remote; last code change `af653f8`.
Production serves `builtAt 2026-10-05T00:07:16.856Z`, verified by the timestamp
moving. Live model **745 segments / 951 lines** (counts above). **328 backend
tests, 56 app tests**; `mobile/` has a gate lane. **45 usable rides**; session 85
is the newest and ungraded. A deploy failed once on 2026-09-30, see note 29,
before adding anything to `backend/` that imports outside it.

**How every measurement here is run, each rule learned by breaking it:**
- **Pin the control to a fixed ride list.** New rides arrive mid-task.
- **Before trusting a check, run the input that should make it say no.**
- **A witness with a floor cannot speak below it.** `findPasses` needs 25 m, so
  its silence about anything shorter is not evidence.
- **Verify a deploy by `builtAt` moving, never by status**, and if a timestamp
  looks unexplained, suspect the recorded baseline before the deploy trigger.
- **A Windows junction in a scratch copy points INTO the repo.** Delete the link
  itself (`[System.IO.Directory]::Delete(path, $false)`); never recurse into it.

**The house defect**, shared by six of the nine errors made on 2026-10-04: **a
check that cannot fail, reported as a check that passed.**

Where to start depends on what you came for:

| you want to | read |
|---|---|
| know what the app is and how a ride becomes a coloured line | "What it is", "Layout", "Data flow" |
| change anything in the backend | "Bugs already paid for" — 31 failure modes, each one paid for once already |
| run a measurement before changing anything | `npm run` in `backend/`: `find-holes`, `diagnose-holes`, `trace-passes`, `eval:coverage`, `eval:tangent`, `eval:heading`, `eval:heading-lines`, `diagnose-spikes`, `eval:spikes`, `verify-rebuild`, `eval:linker` |
| touch the importer or the matcher | "Operational gotchas", then the pipeline sections |
| pick up the next piece of work | **"NEXT, IN ORDER"** at the top of this file. Item 1 is fully specified, including what not to re-check |
| understand why there is no drift correction | "What the drift anchor taught us" |
| see the branch and deploy state | "Where things stand", immediately below |

## Where things stand

**Current state is in "STATE, 2026-10-05" at the top.** This section keeps the
older history of what was cleared and when.

Cleared on 2026-10-01: the measurement tooling merged, the derived heading and
the speed limit shipped with a rebuild each, and two branches were dropped after
their findings were written into this file —
`fold-unnamed-into-trails` (`c3e919f`, measured and rejected; the numbers and
the reason it could come back are in "Riding a segment both ways") and
`jzavala5114/drift-round3-wip-8f13d5f2` (`b5c5eab`, round-three drift-ramp
fixes with 5 tests deliberately red, which would reinstate a feature four
reviews rejected; its finished half `c1a250a` is already in `main`). Both are
recoverable at tags `dropped/fold-unnamed-into-trails` and
`dropped/drift-round3-wip`, pushed before the branches were deleted.

Eleven already-merged branches were deleted at the same time, plus
`fold-missed-sidewalks`, which existed only on the remote and was checked as an
ancestor of `main` before it went.

This file is ~19k tokens. It is not meant to be read end to end; the headings
are the index.

---

## What it is

A prototype elevation tracker for cyclists. It records GPS + barometric
altitude during a ride, map-matches the ride to OpenStreetMap street segments,
and renders **two direction-aware gradient lines per street** — riding a block
east-to-west and west-to-east produce separately coloured lines, offset either
side of the centreline. Repeat passes refine a shared model via a running mean
rather than overwriting it.

Colour scale by slope: purple (steep descent) → blue → green → yellow →
orange → red (steep climb).

## Layout

```
mobile/         Expo (React Native + TS) app — tracking UI + MapLibre map
backend/        Node/TS + Express API — matching, aggregation, gradients
osm-pipeline/   One-off scripts: OSM extract -> segments in PostGIS
context/        This file
```

- **Repo**: github.com/jzavala5114/CyclingDataApp (tag `v0.1`)
- **API**: https://cyclingdataapp-backend-production.up.railway.app (Railway)
- **DB**: Supabase Postgres + PostGIS — the only datastore; Railway holds none

## Data flow: Stop button → gradient on the map

1. `stop()` drains the AsyncStorage buffer the background task has been filling.
2. `POST /sessions/:id/samples` → raw rows into `session_samples`. The only
   durable record of a ride.
3. `POST /sessions/:id/end` → `processSession()`, all in one transaction:
   - load candidate `segments` in a bbox around the samples (+500m), canonical only
   - `rejectElevationSpikes()` — drop fixes that cannot be reconciled with the
     fixes either side, BEFORE smoothing, since smoothing an impossible reading
     smears it across its neighbours instead of deleting it
   - `smoothElevations()` — zero-phase (forward then backward) filter over the
     elevation series, so it damps noise without the lag a one-pass EMA has
   - `matchSamplesToSegments()` — nearest segment + bearing + hysteresis → runs
   - `profileRun()` — **discard runs that only clipped the segment**, then
     project onto the line and bucket by 15m of distance-along-segment
   - `ensureDemElevations()` + `fitAnchor()` — **anchor the whole ride to
     the terrain model with one median offset**
   - `mergeBuckets()` — **upsert a running mean**
   - write `session_segment_matches` for the runs that were merged
4. `GET /segments?bbox` → `buildDirectionalGradientLines()` (windowed-regression
   slope → colour stops, ±4m offset per direction) → app slices into short
   coloured pieces → MapLibre draws them.

Five tables do the work: `session_samples` (raw), `segments` (network),
`segment_dem_elevations` (terrain reference), `segment_coverage` (how much of
each segment has been ridden), `segment_elevation_buckets` (the
model).

`processSession()` lives in `services/sessionProcessor.ts` and is shared with
`src/scripts/rebuildModel.ts`, so reprocessing old rides goes through exactly
the same path as a ride coming off the phone.

## Decisions made

| Decision | Why |
|---|---|
| Multi-user *capable*, privately run | Full engineering story for a portfolio at solo cost; can open up later without rework. Means crowd-averaging can't be leaned on, so per-ride precision matters. |
| Railway Hobby ($5/mo) | Trial expires; zero migration, keeps the URL so no APK rebuild. |
| Road centreline canonical | Measured: a typical downtown road has 3–4 parallel sidewalk segments, and 14.5% have none. Sidewalk-canonical would have *increased* line count and dropped streets. |
| Standalone trails stay canonical | Pikes Peak Greenway, Bear Creek Trail etc. are real routes; there the path *is* the road. |
| Release APK, not debug | Debug fetches JS from Metro at launch, so it dies away from your network. |
| DEM as reference frame, not as data | USGS 3DEP anchors each ride's absolute level; the barometer still supplies the shape. Seeding unridden segments from the DEM was considered and rejected — it would colour the whole city and undercut the crowd-sourced premise. |
| Speed-derived GPS interval | Fixes stay ~11m apart instead of 8m climbing and 34m descending. Roughly power-neutral: slow riding gets a longer interval than the flat 3s it replaced. |

## Current state

*(as of 2026-09-29, measured rather than remembered — every figure here came
from a query on that date)*

- **Network**: 66,684 segments over 38.71–38.97 N, −104.90 to −104.75 W —
  central Colorado Springs plus the northwest suburbs and Ute Valley Park.
  **46,271 canonical + 20,413 folded = 66,684** after the sidewalk fold landed
  (was 47,015 + 19,669; the 17,020 quoted here until 2026-09-27 was the
  `is_sidewalk`-tagged subset and did not add up). Every road stays canonical.
  Of 31,910 eligible paths, **11,497 are still canonical** — down from 12,241,
  and most of those correctly, having no road within 20 m. Eligibility is by
  **name**, not by the `is_sidewalk` tag, which the linker never reads; the
  "2,643 tagged and never folded" figure quoted here until 2026-09-27 was the
  wrong population. See "The sidewalk fold".
- **Model**: **6,069 buckets across 745 segments, 951 drawn lines**, 0
  implausible, rebuilt 2026-10-01 for the derived heading and then again for the
  speed limit. **54.6% of buckets are blended from more than one pass** — see
  the note under "Elevation accuracy", because that is the threshold where
  anchoring stops being preventative and starts setting rendered colours.
  Earlier states, for reading older notes against: 5,953 buckets on 2026-09-24
  (zero-phase smoother), 6,098 / 749 segments / 966 lines from the sidewalk fold
  on 2026-09-29 through to 2026-10-01. Lines are clipped to what was ridden, and
  **140 of them have a bucket gap somewhere in the middle — which is NOT a
  defect**: the renderer spans a gap, so nothing appears blank. That was
  verified on 2026-09-30 after an earlier note claimed otherwise.
  These carry the single-number anchor, which
  is now the only anchor there is; the sliding version was deleted on 2026-09-23
  after five reviews. See "The sliding anchor is gone".
- **Rides**: **44 usable** as of 2026-10-04, and the count is 44 rather than 43
  because **session 83 is a 13-second, 4-fix false start that passes the usable
  filter**. It contributes nothing and cannot produce a pass, but it is in the
  set and in the denominator. Every
  2026-10-01 measurement replayed **42** (41 on 09-26, 39 on 09-24, 36 on 09-16,
  34 on 09-13), so **pin the session list before comparing against any number
  measured on an earlier date** — the set grows underneath you, and a before/
  after that straddles a new ride is comparing two different archives.
  **Sessions 5 and 6
  are permanently corrupt** — `rebuildModel.ts` excludes them by elevation
  scale. Session 45 is excluded for being spikes rather than a ride (20.7% of
  its steps impossible); 46 and 50 were restored when the roughness test was
  replaced.
- Every saved ride is merged by `/end` as it is saved, so the model is current
  without a rebuild. A rebuild is only needed when the *algorithm* changes; the
  last one was 2026-09-06 for Stage 1 connectivity.
- **DB**: was 40 MB of Supabase's 500 MB before the re-import roughly doubled
  the segment count. Not re-measured since.
- **Cost headroom**: ~55 KB/ride; ~9,200 rides before the storage cap (decades
  solo). Egress (5 GB/mo) binds first and only with real users (~40–50).

## Bugs already paid for

Keep these in mind before "simplifying" anything.

1. **Supabase IPv6** — Railway can't route IPv6 out, so the direct
   `db.*.supabase.co` host fails `ENETUNREACH` and crashes the process on
   every query. Use the **session pooler** host (IPv4).
2. **`express.json()` 100 kb default** — a ride's samples exceed it; uploads
   died with `PayloadTooLargeError` and three rides were silently lost. Now
   `limit: "10mb"`.
3. **Orphaned `/end`** — locking the phone right after Stop suspended the JS
   thread mid-request, leaving rides uploaded but never matched. Now a blocking
   "Saving ride…" state, and failures raise an alert instead of vanishing
   (release builds have no LogBox).
4. **`RECEIVE_BOOT_COMPLETED`** — `expo-task-manager` schedules a *persisted*
   JobScheduler job; without this permission Android throws the moment a
   background fix arrives. Because the task outlives the app, it crash-*loops*
   on every launch. Neither config plugin adds it. See `mobile/README.md`.
5. **Elevation scale mixing** — the barometer reports metres *relative* to ride
   start; GPS reports absolute (~1800 m). Mixed raw, one Cimarron bucket
   averaged −2.73 with 1808.12 → 902.65 and a **−6035% slope**, painting a flat
   street purple and red. Barometer readings are now anchored to the session's
   first GPS altitude, and stale ones (>5 s) fall back to GPS.
   **Sessions 5 and 6 predate this fix**; their raw samples are unrecoverable.
6. **Fixed-area import** — the original extract covered only ~1.2 × 1.7 km, so
   two-thirds of a ride matched nothing. Nothing was lost; there was nothing to
   match against.
7. **Hardcoded viewport** — `MapScreen` requested a fixed bbox, so a wider
   import would not have shown up. Now fetches the real viewport (padded 20%,
   skipped when already covered).
8. **`fetch_overpass.mjs` 406** — Overpass rejects a raw-text body; it must be
   form-encoded as `data=`. The script had never actually worked (the first
   import was a manual `curl`).
9. **Segment fragmentation** — driveways/alleys shared nodes with the sidewalks
   they crossed, and every shared node became a boundary. Dropping non-rideable
   ways cut 2,795 segments → 956 in the same area without losing an
   intersection. Sidewalks can also run 400 m+ without sharing a node with
   anything, so segments are additionally capped at 150 m.
10. **Matcher flip-flop** — a street and its sidewalk sit well inside GPS error,
    so per-sample nearest-segment scattered one pass across parallel lines.
    Hysteresis (a rival must be 8 m closer) took one ride from 118 runs to 34.
11. **Head gap** — the first colour stop was anchored to the first *bucket*, not
    the segment start, leaving a 15–17 m unpainted stub at every segment head.
    Chained together that read as a dashed line.
12. **Dropped lines** — `buckets.length >= 2` silently discarded 21% of
    directional lines, punching whole-segment holes.
13. **Slope noise** — differencing two adjacent buckets turned ~0.15 m of
    barometer noise into ~1% of slope error, about one colour band wide. Now a
    least-squares fit over ±2 buckets (~60 m) with a ±25% plausibility clamp.
14. **A touch became a whole street** — crossing an intersection drops a fix or
    two on the cross street: real samples, correctly matched, but not a ride.
    Nothing rejected them, so one point became one bucket and the renderer
    painted the *entire* segment from it — and since one bucket carries no
    slope, flat green. That gave 77m of Sahwatch Street, 139m of South
    Institute Street and 143m of South Wahsatch Avenue a full-length line
    apiece off 0–8m of travel. A run now has to span 25m **or** 70% of the
    segment (raised from 35% when bracketing fixes were added, since they
    inflate every span).

    **Do not repeat the old justification for this.** It used to read "the
    populations barely overlap — touches span a median of 0m, real traversals
    60m+". That was measured *before* bracketing. Re-measured on 2026-08-22
    across 169 discards, span no longer separates them at all: in the 15–25m
    band it is 21 fragments against 21 touches, an exact coin flip. What does
    separate them is whether the run's *stitched* extent covers ground — see
    #26.
15. **Lines painted ground that was never ridden** — the traversal gate decided
    *whether* to draw, but the renderer always drew the segment's **full
    length**. A rider who clipped 45m of a 129m footway beside East Fountain
    Boulevard got all 129m painted, 80m of it running off into a park. Lines
    are now clipped to the covered extent.
16. **Clipping to the bucket grid put a hole at every segment head** — the first
    fix of the fix. Coverage was inferred from bucket positions, but a bucket
    sits at the *centre* of the 15m of ground it averages and is rounded onto a
    grid anchored at the segment start. `min(L, lastBucket + 7.5)` clamped the
    tail to the segment end; `max(0, firstBucket − 7.5)` had no equivalent, so
    any line whose first bucket was 15m or more began with a fixed 7.5m hole —
    head gap median 7.5m against a tail median of 0. Only 10% of lines were
    painted end to end, and chained together they read as dashes.
    `profileRun` already computed the true extent (the bracketing fixes clamp
    exactly to the segment ends on a pass-through) and threw it away; it is now
    persisted in `segment_coverage`. Head gap median 7.5m → 2.1m, fully painted
    10% → 38%.

    **A bucket labelled PAST the end of its segment is correct, not a bug.**
    Checked 2026-09-26 because it looks alarming: 414 buckets carry a
    `distance_m` greater than their segment's `length_m` — five separate pieces
    of The Chutes each have one at 150m on a 143m segment. It follows from the
    centre-label above. `bucketizeRun` rounds with `Math.round`, so a fix at
    143m lands in the bucket centred on 150, covering 142.5–157.5m of which only
    the first half-metre is real. The label can therefore overshoot by up to
    `BUCKET_SIZE_M / 2` = 7.5m and no further. **Measured: worst overshoot
    7.47m, zero above 7.5m, zero negative labels.** The renderer never trusts it
    anyway — `buildDirectionalGradientLines` clamps with
    `Math.min(segment.lengthM, …)` before slicing and clamps the fractions again
    after. Do not "fix" this; the bound is what makes it provably harmless.
17. **Backward gradients were drawn mirrored** — bucket distances are measured
    *along the direction of travel*, so on a backward run distance 0 is the
    segment's far end. The renderer sliced the offset line in forward geometry
    order and used those distances as-is, reversing every backward line
    end-for-end. Both directions now agree: forward slope + backward slope sums
    to ~0 at every point on a segment, where before they disagreed.
18. **Short crossings became gaps** — fixes land ~11m apart, so a rider crossing
    a 10m stretch of trail often gets one fix inside it and scores a span of
    zero. 23 lines vanished that way in a single ride. The span is now measured
    across the fixes either side of the run too, which brackets the crossing.
    A perpendicular touch still scores near zero, because moving along the
    street you are on barely moves your projection onto the one you cross.
    Bracketing inflates spans, so `MIN_COVERAGE` went 0.35 → 0.7. That 0.7 is
    the remaining source of gaps: a 23 m block covered 0.63 is dropped, and it
    cannot be separated by threshold from a 12 m trail stub clipped at 0.60.
19. **Canonical linking ate trails** — matching sidewalks to roads *by geometry*
    (within 20 m, parallel) also swallowed the stretches where a real trail runs
    beside a road: Shooks Run lost 57 segments, Midland 35, Pikes Peak Greenway
    10. Eligibility is by **name**: a path qualifies if OSM tags it
    `footway=sidewalk`, or if nobody named it at all. Of the 1,328 paths here
    running within 20 m of a road and parallel to it, 1,066 are unnamed — a
    path that hugs a street for its whole length without earning a name is a
    pavement whatever its tags say, and one such 129 m footway was splitting
    rides down East Fountain Boulevard between the road and itself. Every trail
    lost to the geometric pass was named, so the name test alone protects them.
    Verified after: Shooks Run 109 canonical, Pikes Peak Greenway 149, Midland
    57, Bear Creek 35 — none absorbed.

20. **One round trip per row.** `POST /:id/samples` inserted samples one at a
    time inside a single transaction, and `/end` did the same for every bucket,
    coverage row and DEM cache entry. At ~150 ms to Supabase that is ~96 s to
    upload a 600-sample ride and ~150 s to match it. A ride died at the first
    (the transaction rolled back and left **zero rows** in session 16) and
    falsely reported failure at the second (session 29 committed a minute after
    the phone gave up). All three paths are batched now.
21. **`fetch` has no timeout.** React Native waits forever, so a stalled upload
    on mobile data hung on "Saving ride…" for 22 minutes with no error and no
    way out. Now 20 s per upload chunk, 120 s for matching.
22. **The recovery path threw rides away.** On launch, a stopped-but-unsaved
    ride hit `setActiveSession(null)`, clearing the pointer while leaving the
    samples in AsyncStorage — present but unreachable, with no UI to retry.
    Startup now surfaces them, minting a new session if the pointer is already
    gone.
23. **An async throw killed the whole backend.** Express 4 does not catch
    rejections from async handlers, so one duplicate-key error became an
    unhandled rejection and exited the process. Every route goes through
    `asyncRoute()` now, with error middleware returning 500. Worth knowing that
    this also made deploys *look* broken: restarting containers were being
    crashed by test traffic before they could pass a health check.
24. **Timeouts were reported as cancellations.** Expo SDK 57 installs its own
    native `fetch`; its rejection is a plain `Error` whose `name` stays
    `"Error"`, so the usual `err.name === "AbortError"` test never matched and
    every timeout surfaced as the raw `fetch failed: Fetch request has been
    canceled`. Check `controller.signal.aborted` — state we own — not the error
    we were handed.
25. **Start required the network.** A round trip stood between the button and
    recording, demanded exactly where signal is worst. Worse, a timed-out retry
    cannot tell "the server never got it" from "the server got it and the reply
    was lost", so each retry left an orphan session. Rides now begin entirely
    on the phone and register at save time, reusing the orphan-recovery path.
26. **The matcher tore traversals into unusable fragments.** A run ends whenever
    a fix fails to match, which on singletrack happens at every switchback: one
    146m descent of the BeaUTEiful Loop arrived as *five* runs of 1–15m, each
    too short to clear the gate, so the whole descent was lost.
    `stitchFragmentedRuns()` rejoins runs on the same segment+direction within
    `STITCH_WINDOW_S = 45`. **The window was measured, not chosen**: fragments
    cluster at 0–45 s (49 of 51) and separate crossings of the same block at
    90 s+, with nothing between — that gap is the whole basis for the number,
    so re-measure before changing it. Discards 169 → 94, fragments 75 → 2,
    while genuine clips held at 94 → 92, which is the proof that no phantom
    lines came back. No threshold moved.
    **RE-MEASURED AND SWEPT 2026-10-04. The stated basis was overstated, 45
    still sits at the edge of a real trough, and widening buys mostly phantom,
    so it STAYS AT 45.** Counts moved with the archive (runs 2724 → 2532,
    discards 443 → 324), which is expected. The distribution over 399 same-key
    pre-stitch gaps:

    | gap | 0-10s | 10-30s | 30-45s | **45-60s** | 60-75s | 75-90s | 90-300s | 300s+ |
    |---|---|---|---|---|---|---|---|---|
    | gaps | 145 | 35 | 12 | **1** | 10 | 6 | 26 | 164 |

    **"Nothing between 45 s and 90 s" is wrong as written** — 17 gaps sit in that
    band — **but the trough is real and 45 is at its near edge**: the 45-60 s bin
    holds 1 gap of 399. The honest correction is that the empty band is 45-60 s,
    not 45-90 s. A first version of this entry said "no value is defensible,
    including 45", which overstated it in the other direction.
    **And the window was properly swept, which closes the lever.** Re-stitching
    every ride at each window and re-assessing every run through `assessRun`:

    | window | discards | covered m | vs 45 s | lines | UNWITNESSED runs | unwit m |
    |---|---|---|---|---|---|---|
    | **45 s shipped** | 324 | 224745 | 0 | 956 | 115 | 2180 |
    | 75 s | 312 | 225004 | **+259** | 956 | 117 | 2394 |
    | 90 s | 306 | 224994 | **+249** | 956 | 117 | 2394 |
    | 300 s | 285 | 224891 | +146 | 956 | 116 | 2390 |

    The +249 m at 90 s reproduces a cold review's figure exactly, and that review
    said plainly it had not tested whether the paint is honest. It mostly is not:
    **of the +249 m, +214 m lands on runs with no witness pass** (2180 → 2394),
    and **the line count never moves** — 956 at every window. A wider window
    therefore extends existing lines over ground nothing corroborates, which is
    the full-length phantom this note exists to prevent, appearing in the
    measurement rather than in the argument. **Left at 45.**
    **Caveat, the same one that wrecked the gate sweep:** "unwitnessed" inherits
    `findPasses`'s 25 m floor, so a run that qualified on COVERAGE over a segment
    shorter than 25 m is unwitnessABLE, not unwitnessed. **+214 m is an upper
    bound on the phantom, not a measurement of it** — which is enough to decline
    a change, and would not be enough to justify one.
27. **A wider bbox orphans existing segments.** `load` upserts on
    `(osm_way_id, start_node_id, end_node_id, piece_index)`, so it can only add
    or update. But a segment boundary is "a node shared by two or more kept
    ways", so newly imported ways re-split existing ones: the new pieces arrive
    under new keys and the old piece stays behind, leaving two geometries over
    the same tarmac for the matcher to argue over. Extending to Ute Valley
    orphaned 609. `prune_orphans.mjs` deletes them, and must run **after `load`
    and before `link`** — deleting a road nulls its sidewalks'
    `canonical_segment_id`, promoting them to standalone lines.
28. **A deploy could not be verified from outside.** Three separate releases
    needed a bespoke probe, and one internal-only change had no observable
    difference at all short of uploading a synthetic ride. `npm run build` now
    writes a timestamp into `dist/buildInfo.json` and `/health` returns it as
    `builtAt`. One request confirms which build is answering.
29. **A local build is not a rehearsal of the deploy.** Railway builds `backend/`
    alone; the rest of the repo is not in the build context. `evalLinkerFold.ts`
    imports across into `../../../osm-pipeline/`, deliberately — it scores a
    pipeline decision against the backend's behaviour, so it needs both halves.
    `tsc` resolves imports at **build** time, so the deploy died on `TS2307`
    while `npm run build` passed locally every time, because a developer
    checkout has the sibling directory the container does not. The comment in
    the file even stated that Railway ships only `backend/` and then concluded
    the deploy was unaffected, reasoning about runtime resolution. Production
    never went down — a failed build leaves the previous container serving — and
    the sidewalk fold was untouched, because that change is rows rather than
    code. Now: `tsconfig.json` excludes the tool, `tsconfig.check.json`
    typechecks it anyway, and `src/buildContext.test.ts` fails on any relative
    import in the production build that resolves outside `backend/src`. To
    rehearse for real, copy `backend/` somewhere with no siblings and build
    there; that is what caught it and what confirmed the fix.
30. **Database numbers arrived as text whatever the type said.** node-postgres
    returns `bigint` and `numeric` as STRINGS by design: a JS number cannot
    hold every int8, and numeric is arbitrary precision. Every id in
    `schema.sql` is `bigserial`/`bigint`, and the generic on `db.query<T>`
    is an assertion the driver never sees, so `SessionVerdict.id` was typed
    `number` and held "84" for the life of the project. Nine scripts wrapped it
    in `Number()`; `evalLinkerFold` only did so after it matched a
    `Set<number>` against the text, never matched, and printed "n/a" for its
    headline metric. Measured at runtime, the same interface's `bad_share`
    (`avg()` over numeric literals) arrived as "0.00000000000000000000" in 28
    of 48 live sessions -- a TRUTHY string, so `if (bad_share)` would have read
    a perfect ride as a bad one. **Now:** `db/pgNumbers.ts` converts at the
    boundary. `bigintId` is exact, throws past 2^53, refuses "" (which
    `Number` reads as 0) and `undefined` (which a misspelled alias produces).
    `numericOrNull` keeps SQL NULL as null and refuses NaN, Infinity, and a
    numeric too large for a double. `loadSessionVerdicts` types its raw row
    honestly and maps through them, and the nine `Number()` wrappers are gone.
    The tests build their fixtures with pg's OWN type parsers, so they test the
    driver rather than a belief about it; restoring the bug fails 9 of them and
    13 of 13 mutants die. **Nine more fields in the shared types lie the same
    way and are NOT fixed** -- see the open item, and read its warning about
    join partners before touching any of them.
31. **A one-fix threshold decided a verdict, twice in one day.** The pass
    ledger in `traceOutAndBack.ts` tried `gate` before its next-door share
    test and fired on the mere EXISTENCE of a run, so one stray fix forming a
    1-fix run filed a ride drawn on the neighbouring segment as a traversal-gate
    rejection: **9 of 12 `gate` losses, 605 m of 784 m**, and that bucket was
    the evidence for a proposal to lower the gate. Fixed in `9c13174`:
    `classifyLoss` tries claims strongest first and tests every one against
    where the fixes actually went. **Then the same commit reintroduced it**: a
    new "drawn on another piece of the same OSM way" flag used `> 0` and fired
    on 202 passes, caught only because the number was too large to be what it
    claimed. **Now:** both use a share (`NEXT_DOOR_SHARE`), and restoring
    either `> 0` fails tests. **Rule: a verdict that a single observation can
    flip needs a share or a count behind it, never mere existence.**

## Trails the importer was silently throwing away

Found 2026-08-30 from a screenshot: Ridgeway Trail drew colour along its dashed
half and nothing along its solid half. The two halves are two OSM ways —
`36980276` is `highway=path` + `bicycle=designated` and reached the database;
`7686548` is `highway=track` + `bicycle=yes` + `access=no` and never did. The
blank half was not unridden or unmatched; it had never existed in our data.

`classify()` in `split_ways.mjs` rejected it twice over, and one of those was a
real bug:

- **`access` was read without its overrides.** OSM access is layered — a
  mode-specific tag beats the general one, so `access=no` + `bicycle=designated`
  means *designated bike route*, not "keep out". Testing `access` alone
  discarded 42 ways the map explicitly opens to bikes.
- **`highway=track` was excluded wholesale.** Of 234 in this extract, 203 really
  are driveways and farm roads (Cedar Heights Drive, Amber Valley Drive,
  `access=private`, unpaved) — but 31 are trails.

Now: tracks are admitted only when bikes are explicitly allowed
(`yes|designated|permissive` — deliberately not `dismount` or `destination`),
classified `cycleway` when `bicycle=designated` and `footway` otherwise. The
kind matters: `link_canonical.mjs` folds footway/cycleway into parent roads but
treats `road` as a **parent**, so calling a track a road would let it absorb the
trails beside it. And the access test now yields to an explicit bicycle tag.

Measured exactly against the same extract the live network was built from:
**27,775 → 27,845 ways (+70, none removed), 66,424 → 66,684 segments.** 0.3%
more data, concentrated entirely in what this project exists to record —
Pikes Peak Greenway ×3, Ute Valley Regional Trail ×8, Rim Trail ×9,
Red Rock Canyon ×3, Mesa Trail ×2, New Santa Fe Regional Trail ×4, and the
Palmer Park singletrack network (Thriller, Shreadzilla, Rolly Poly, Rattlerocks,
Pinball, Crank it, High-ya, Icebreaker), none of which existed in `segments` at
all.

**This corrects an earlier finding.** The note that Ute Valley Regional Trail
was "present and correctly classified, never ridden" was true only of its
`path`-tagged pieces; its `track`-tagged pieces were missing entirely. Any
future "is this trail missing or just unridden?" question has to check the OSM
tags, not only the `segments` table — absence from `segments` is not evidence
that OSM lacks the way.

**Applied 2026-08-30** via `split → load → prune → link` then `rebuild-model`.
Results, all verified rather than assumed:

- Segments 66,424 → 66,684. `prune` removed 49 orphans, **0 of them carrying
  buckets** — the re-split of Woodmen Trail predicted by note #27, costing no
  ride data.
- `link` folded 19,669 paths and the sidewalk count held at 19,663, so it
  absorbed pavements and not trails. Every newly admitted named trail came out
  **100% canonical, 0 absorbed** — the name test carried them, no linker change
  needed.
- Model 2,535 buckets / 384 segments → **2,778 / 414, 0 implausible**.
- Ridgeway Trail: 2 segments → 19. The formerly excluded way `7686548` now
  holds **78 buckets across 11 segments**, making Ridgeway the 8th
  most-covered named route in the model.

**The rides were already there.** Nothing was re-ridden: those samples had sat
in `session_samples` since they were recorded, matching nothing because the
geometry did not exist. A classification bug in the importer is therefore
retroactive in both directions — fixing it recovers history, and any future one
is invisible until someone looks at a blank stretch of map and asks why.

## Operational gotchas

- **Pipeline order is `fetch → split → load → prune → link`**, then
  `rebuild-model` in `backend/`. `prune` must sit between `load` and `link`;
  see #27. `link` is a dry run unless `--apply` is passed, and writes a
  per-line CSV either way. It decides eligibility from `street_name`, **not**
  from `is_sidewalk` — that tag is recorded and reported but the linker never
  reads it, because a few named trails carry `footway=sidewalk` in OSM and the
  name is what protects them.
- **A schema change needs a migration file, and `psql` is not installed here.**
  `schema.sql` is a fresh-install script of bare `create table`, so it cannot be
  re-run against a database holding rides. Every column since then has a numbered
  file in `backend/src/db/migrations/`. Run one with
  `cd backend && npm run migrate -- src/db/migrations/00N_name.sql --apply`,
  which prints the SQL and stops without `--apply`, wraps it in a transaction,
  and refuses any path outside that directory — `schema.sql` included, because it
  sits one tab-completion away and would fail halfway through.
- **Verify a deploy by `builtAt`, never by status.** During a rollout Railway
  reports the service Online *and* `/health` answers 200 — both from the old
  container. One rollout sat like that for five minutes. Compare
  `curl /health | builtAt` against the value from before the deploy, and send
  no application traffic to a container that is still deploying (#23).
- **`/end` re-merges unless guarded.** Buckets are running means, so folding a
  ride in twice weights it double and cannot be undone. The route now returns
  early when `ended_at` is set, but a *recovered* ride used to mint a fresh
  session on every retry and slip past that; the phone now remembers the
  session it adopted. When in doubt, rebuild — `rebuildModel.ts` wipes first.
- **Never send traffic to a deploying container.** A crashing request during
  rollout fails the health check and Railway marks the whole deploy failed.
  Half an hour was lost to a poll loop that crashed each new container as it
  came up, looking exactly like a broken build.
- **Verify deploys by behaviour, not by status.** `/health` answers from the
  *old* container during a rollout. Time an upload or check a response field
  that only the new build returns.
- **Never `POST /sessions/{5,6}/end`.** It re-poisons the model. Rebuilding via
  `npx tsx src/scripts/rebuildModel.ts` is safe — it skips any session whose
  elevations are not absolute, so the rule is enforced in code, not memory.
- **Changing the gate, bucket size or matcher needs a rebuild.** Buckets are
  running means and one run's contribution can't be subtracted back out, so
  the model has to be recomputed whole from `session_samples`. Use
  `rebuildModel.ts --dry-run` first to see which sessions qualify.
- **`railway up` needs `--service cyclingdataapp-backend`** (multiple services).
- Supabase kills long correlated subqueries; `link_canonical.mjs` batches and
  sets `statement_timeout`.
- Backend-only changes need **no APK rebuild** — reopen the app to refetch.
- Wireless `adb` drops when the phone leaves the network; the daemon usually
  re-pairs over mDNS a few seconds after `adb devices`.
- A Gradle `packageRelease` failure is usually a transient Windows file lock —
  retry before investigating.
- **Pushing now deploys — fixed 2026-08-30, and here is what was wrong.** The
  running server once sat six days behind `main` while Railway reported healthy
  and `/health` answered `ok` from the old container. The cause was not a broken
  webhook. Connecting the repo on 2026-08-29 created a **second service** named
  after the repo (`CyclingDataApp`) instead of attaching the repo to the service
  that owns the domain, and that second service had **no service instance in any
  environment** — so its GitHub trigger fired on every push with nothing to
  deploy, while the real service kept serving its last `railway up` image.
  A second fault would have broken it anyway: `rootDirectory` was null and there
  is **no `package.json` at the repo root**, so a GitHub build would have cloned
  the monorepo root and found nothing to build.
  Fixed via the Railway GraphQL API (`backboard.railway.com/graphql/v2`, bearer
  `~/.railway/config.json` → `user.accessToken`; note `user.token` is refused):
  `serviceInstanceUpdate` set `rootDirectory: "backend"` and
  `watchPatterns: ["backend/**"]`, then `serviceConnect` attached
  `jzavala5114/CyclingDataApp` @ `main`, then `serviceDelete` removed the stray
  service — necessary, not tidy, because by then both services carried a trigger
  on `main` and every push would have fired both. **Set the root directory
  before connecting the repo**: `serviceConnect` deploys immediately, and it did.
  Consequences to remember: `watchPatterns: ["backend/**"]` means a commit
  touching only `mobile/` or `context/` deploys nothing, by design. And a GitHub
  deploy serves *committed* code, so anything uncommitted that was pushed up
  with `railway up` is silently rolled back the next time a push lands — which
  happened to the access log the moment the repo was connected.
  Verified by a real push, not by the config looking right: `ae75369..65450fd`
  moved `builtAt` to 2026-08-30T18:14:34.337Z in ~60s, and the access log that
  only exists in the new commits then appeared in `railway logs`.
  Still verify by `builtAt`; it remains the only field that moves with the image.
  Railway's log stream lags a container start by a few seconds — an empty tail
  right after a deploy means "too early", not "not running".
- `railway link` is per-directory and interactive unless given
  `-p cyclingdataapp-backend -e production -s cyclingdataapp-backend`.
  `railway status --json` carries the real deployment state; `deploymentStopped`
  is misleading and `status` is the field to read (`DEPLOYING` ≠ failed).
- **Pixel logcat holds ~16 seconds** at the default 256 KiB — useless for
  diagnosing anything after the fact. `adb logcat -G 64M` buys about an hour;
  it resets on reboot. Confirm app output actually appears (`ReactNativeJS`)
  before relying on it in a release build.
- `POST /sessions` returns `id` as a **string**, not a number.

## Elevation accuracy, measured

Compared against USGS 3DEP (10m for all 526 buckets, 1m lidar for 121 on the
best-covered lines):

- **Slope is good.** End-to-end agreement with 1m lidar is mean 0.01, sd 0.83
  percentage points. Flat East Cimarron reads 0.06 / 0.21 / −0.37% against the
  DEM's −0.17 / 0.25 / −0.24%. The barometer, bucketing and regression all work.
- **Absolute level was not.** A −14.57m bias, identical at both DEM
  resolutions, is the WGS84 ellipsoid (what Android reports) versus NAVD88
  orthometric height (what the DEM reports) — Colorado's geoid separation is
  ~−16m. Not error, but it means the stored numbers were never metres above
  sea level. Anchoring now puts them on the DEM's datum; bias is 0.00m.
- **The real error was per-session.** Sessions 11–14 sat at −14.85, −16.54,
  −13.35 and −13.20m: a 3.3m spread between rides of the same streets, because
  each anchors to the GPS altitude of its own first fix. Anchoring removes it.
- **Residual spread is 3.52m** and mostly *within* a session — barometric drift
  over a ride plus DEM sampling error along an imperfect OSM centreline. A
  single offset per ride cannot remove it; a drift term was built to, and was
  removed after five reviews — see "What the drift anchor taught us".
- ~~Every directional line comes from exactly one session, so anchoring has not
  changed any rendered colour yet.~~ **No longer true as of 2026-09-26, and this
  is the moment the feature started paying.** 3,286 of 6,043 buckets (54.4%) are
  now blended from more than one pass, and 1,745 of those from three or more.
  Anchoring is what puts those passes on a common datum before the running mean
  combines them; without it, a bucket fed by two rides that each anchored to
  their own first GPS fix would average a 3.3m disagreement into the colour.
  Treat any future "anchoring is preventative" framing as stale.

## Which sensor: measured, 2026-08-29

`session_samples.elevation_source` now records `barometer` or `gps` per fix
(migration `001_elevation_source.sql`, additive, null on older rows). Deployed
and verified end to end. This settled several things and overturned others.

- **The barometer works, and the screen is the whole problem.** Screen on: 100%
  barometer, including session 62 — 842 fixes, 45 minutes, 186 m of climb at
  Stratton, 829 distinct values. Screen off: it dies in 11–19 s and GPS takes
  over for the rest of the ride.
- **`expo-sensors` unregisters the sensor deliberately — and re-subscribes on
  its own.** `SensorProxy.kt` has `OnActivityEntersBackground →
  stopObserving()`. Android is not refusing to deliver; the library stops
  asking. `isObserving` survives the pause, so `OnActivityEntersForeground`
  restores it with no code from us. **Confirmed on session 64** (2026-08-30), a
  3:39 ride locked and woken twice on purpose: barometer 60 s → gps 17 s →
  barometer 46 s → gps 4 s → barometer 83 s.
- **Losing the barometer is slow; getting it back is instant.** The fallback
  needs 11–19 s of sensor silence plus the 5 s `BAROMETER_STALE_AFTER_MS`
  window before it switches to GPS, but the first fix after the screen wakes is
  already barometric. So the damage is bounded by how long the screen stays
  dark, not by the length of the ride — session 64 lost 13% of its fixes,
  session 61 (screen off and left off) lost 93.5%.
- **The barometer is ~2× better for slope, which is all this app computes.**
  Colour depends on how much the error *changes* between adjacent buckets, not
  on absolute error. Median change per 15 m: barometer 0.29 m (1.96% slope
  error), GPS altitude 0.65 m (4.35%). Against 3-point colour bands, GPS
  altitude alone can shift a piece a whole band.
- **GPS altitude is quantized to 0.1 m and holds values across fixes** — 53.9%
  of fixes identical to the previous one in session 61. But only 3.2% in
  session 56, also GPS. The signature is **not consistent enough to classify
  the unlabelled archive retroactively**; that was tried and abandoned.
- **Two obvious metrics both mislead here, in the same direction.** Flat-ground
  second difference favours GPS because a held value has zero jitter by
  construction — it measures stillness, not precision. DEM residual spread also
  favours GPS, but is confounded by terrain: spread rises 3.24 m → 5.32 m with
  steepness regardless of sensor, and the barometer rides are the steep ones.
  Only the adjacent-bucket delta answers the question the app actually asks.
- **GPS vertical accuracy on a Pixel 10 Pro is 1.2–2.2 m**, not the ±10–20 m
  assumed throughout the earlier planning. Dual-frequency GNSS. Every argument
  built on the larger figure was wrong by roughly an order of magnitude.

## What oversampling actually bought, measured 2026-08-30

Session 66 (Ute Valley, 790 fixes, 48 min, 100% barometer in a single unbroken
run — keep-awake held the screen for the whole ride) against the six earlier
Ute Valley rides on the same trails.

- **Sensor noise fell hard.** Median absolute second difference 0.759 m → 0.304 m
  and local-fit residual 0.372 m → 0.228 m, so **2.5× and 1.6×**. Understated,
  because 66 ran at 7.1 m fix spacing against ~5 m and the second difference's
  terrain term scales with spacing².
- **Confirmed from an unrelated angle: 790 distinct elevation values out of 790
  samples, 0.0% repeats.** A 1 Hz barometer ride repeats 1.5%; GPS session 61
  repeats 53.9%. A mean of ~18 readings essentially never lands twice on the
  same value, so the averaging is visible in the data itself.
- **But end-to-end it bought much less: 5.00% → 3.90% of slope error**, about
  22%, measured as the median change in DEM residual between adjacent 15 m
  buckets — the quantity the colour bands actually depend on. **An earlier
  projection of ~0.8% from the noise figures was wrong**; it assumed the
  barometer was still the dominant error term.
- **It is not, on trails.** Same sensor, same 1 Hz rate: downtown street rides
  sit at 0.24–0.40 m of per-bucket error change, Ute Valley rides at
  0.59–0.98 m. Two to three times worse purely for being a trail. That gap is
  the DEM sampled along an OSM centreline that on singletrack is not where you
  rode, 10 m 3DEP not resolving trail-scale terrain, and lateral match error.
- **Read 3.90% as an upper bound, not an estimate.** The metric charges us for
  the DEM's own error as well as ours, and there is no way to separate them at
  10 m resolution.

**Replicated 2026-09-02 on identical terrain**, which the session 66 comparison
could not claim. Sessions 68 and 69 rode the same Chamberlain / Ladders /
Ladders-to-Chutes trails as 62 and 63 did before oversampling:

| session | date | fixes | 2nd diff | residual | spacing |
|---|---|---|---|---|---|
| 62 | Aug 29 | 842 | 0.564 | 0.298 | 5.0 m |
| 63 | Aug 29 | 406 | 0.582 | 0.316 | 5.3 m |
| 68 | Sep 02 | 735 | **0.263** | **0.166** | 5.4 m |
| 69 | Sep 02 | 597 | **0.304** | **0.211** | 5.9 m |

Noise roughly halved with terrain held constant, and the newer rides ran at
slightly *wider* fix spacing, which works against them — so the gain is
understated. Both were 99.9% barometer across 36 and 27 minutes, so keep-awake
holds for a whole ride.

Consequence for the backlog: further barometer work has poor marginal return on
trails, and matching/reference error is now the larger term. That is what moved
the bearing/tangent fix up the list.

## The bearing test compared against the wrong line, 2026-08-30

`directionForBearing` was fed `segment.bearingDeg` — the straight line from one
end of a segment to the other. On a street that line *is* the street. On a
switchback it describes no part of the trail, so a rider correctly on the
segment reads as 90° off, the segment drops out of the candidate list, the run
ends, and one traversal arrives as fragments too short to clear the gate.

**This is not another threshold.** `MAX_BEARING_DELTA_DEG` is still 45,
`MAX_MATCH_DISTANCE_M` still 25, `SWITCH_MARGIN_M` still 8. It is the same test
asked of the right geometry. The artifact's "honest limitation" note still
stands — this is still nearest-segment + bearing + hysteresis, not an HMM.

**Two implementations; the first was subtly wrong.** Snapping to the nearest
point on the line and taking its tangent fails on exactly the geometry it was
meant to fix: on a switchback the *neighbouring* leg is often closer than the
one being ridden, and its tangent points backwards. `nearestAlignedEdge` walks
the segment's edges instead and takes the nearest one that is both within 25 m
**and** aligned — so the leg you are on wins, being near *and* aligned. Measured,
edge-selection beat point-snapping on every column (5,011 → 5,074 buckets,
29.0% → 27.2% trail discard).

Measured through the real matcher, gate and stitcher, chord versus tangent:

| | chord | tangent+edge |
|---|---|---|
| buckets | 4,810 | **5,074** (+5.5%) |
| trail buckets | 2,973 | **3,240** (+9.0%) |
| covered | 77.26 km | **78.83 km** |
| trail discard | 31.6% | **27.2%** |

**Insensitive to the window**, which is the check that it is not a tuned knob:
10 m and 20 m give 5,074 and 5,081 buckets. The window only has to be long
enough to average out metre-scale OSM digitising noise.

**Lines drawn fell 524 → 517, and that is a gain, not a loss.** The clearest
case was Gold Camp Road segment 13309: under the chord it drew 116 m of a 140 m
segment at 0.83 coverage from **four fixes**, while 27 of the 34 fixes near it
matched Ladders — the trail beside it — where the rider actually was. Bracketing
inflates a span across the fixes either side of a run, so four scattered fixes
became most of a road. The new matcher produces no run there and hands those
fixes back to Ladders (backward 9 → 13). Most of the other 21 dropped lines are
coverage 0.21–0.39, the same shape. So the count falls while the data rises:
phantoms deleted, real traversals lengthened.

**Beware the aggregate.** Road buckets read 1837 → 1837 across the first
comparison and were briefly taken as proof the change could not touch streets.
The per-line diff showed roads both lost and gained; the totals coincided.

Also added a result-preserving bbox prefilter (`PREFILTER_PAD_DEG`), since the
distance from a point to a segment's bounding box is a lower bound on its
distance to the segment. Per-edge tangents are precomputed per segment, so the
per-fix work is arithmetic rather than turf geometry calls.

## The matcher has no idea the network is connected

Measured 2026-09-05, and it is the strongest argument yet for changing the
matcher's *kind* rather than its thresholds.

Across sessions 62–72, **37 of 365 consecutive run transitions (10.1%) join
segments that do not touch in the network, and 30 of those happen within 10
seconds.** They are not routes anyone rode. `matchSamplesToSegments` decides
each fix on its own — nearest canonical segment, bearing test, a reluctance to
switch — and nothing anywhere checks that the resulting sequence is a walk a
bicycle could take.

The Hancock Expressway ride shows it end to end:

```
Hancock Expressway #17971  ->  (unnamed) #22505            4s
(unnamed) #22505           ->  (unnamed) #23278            2s
(unnamed) #23278           ->  Hancock Expressway #17974   1s
```

Fixes stepped onto two sidewalk segments for a few seconds and back. Those runs
were too short to clear the gate, so they drew nothing, leaving a 191 m hole in
the middle of a road that was ridden continuously — between two *drawn* pieces
of the same carriageway, which is topologically impossible.

**Hancock is a divided highway**, and that part is working: of 19 blank pieces
with fixes, 14 have a drawn twin 12–13 m away at a bearing delta of 175–180°.
That is the opposite carriageway and it is correct to leave it blank. Only 5
pieces (~380 m) are genuinely missing. Do not mistake a dual carriageway for a
bug — check for a parallel twin at ~180° before investigating.

**Topology is already in the schema and unused.** Every canonical segment
(47,015 when this was written, 46,271 since the sidewalk fold) carries
`start_node_id` and `end_node_id`; 23% are 150 m
cap-slices that also need `piece_index` to order them. That is a routable graph
sitting idle — and it is the one thing an external map-matcher would have been
adopted to provide.

Genuine parallel duplicates, for scale: 10% of cycleway segments carrying data,
5% of footways, 6% of roads. Of 37 duplicate pairs, 29 are named-vs-named.

**Two earlier measurements on this were wrong, both flattering the map over the
matcher.** A "87% of segments have a twin" figure counted *connected
neighbours* as duplicates. An "8 segments ridden both ways" figure compared fix
headings to the segment **chord** — the quantity this project spent a day
proving meaningless on switchbacks. Redone by projecting fixes along the
segment and watching the distance rise and fall, only 3 segments lost a
direction. Any duplicate or direction test must exclude shared nodes and must
not use `bearing_deg`.

## Decision: build the matcher's topology in, do not adopt Valhalla

Taken 2026-09-05, against the 10.1%-impossible-transitions measurement above.

**Rejected: Valhalla / Meili** (the mature open-source routing engine and its
HMM map-matching component). Not on cost. Meili matches against *Valhalla's own*
graph and answers in OSM way ids, while this model is keyed to the `segments`
table and everything encoded in it — 19,663 sidewalks folded into parent roads,
ways split at intersections and capped at 150 m with `piece_index` identity,
per-direction buckets. **Meili would happily match a ride onto the sidewalk**,
which is the exact failure `link_canonical.mjs` exists to prevent and which took
two attempts to get right. Adopting it means writing a translation layer back
onto our pieces — most of the work it was supposed to save — plus a second
service wanting a GB or two against a $5/mo box. It answers a different question
about a different map. Revisit only if the project also wants routing.

**Chosen: add topology to the matcher we have, in two stages.**

- **Stage 1 — connectivity preference.** Build an adjacency graph from
  `start_node_id`/`end_node_id` (plus `piece_index` for the 23% that are 150 m
  cap-slices sharing a node pair), and prefer candidates reachable from the
  segment the run is already on. ~80 lines. This is the same *kind* of change as
  the chord→tangent fix: it gives the matcher information it does not currently
  have, rather than retuning how it weighs what it already has. No threshold
  moves.
- **Stage 2 — full HMM (Newson–Krumm + Viterbi), only if Stage 1 leaves real
  damage.** Emission probability from distance (already computed), transition
  probability from network distance between candidates, Viterbi over the whole
  ride. Greedy connectivity cannot undo a wrong choice made earlier; Viterbi
  can. Several hundred lines and a rewrite of the core — and 2026-08-30 showed
  how quietly that goes wrong, when `nearestAlignedEdge` changed direction
  assignment on switchbacks and was caught only by accident.

**Success test for Stage 1:** impossible transitions from 10.1% to under 2%,
with buckets and covered distance not falling. If it gets there, Stage 2 is not
needed.

## Stage 1 shipped, and the success test was measuring the wrong thing

Built 2026-09-06, commit `48224eb`. It works, it does not reach 2%, and **2%
was never reachable** — the metric has a floor the matcher cannot touch.

**What shipped.** `buildAdjacency` in `segmentMatcher.ts` builds a segment →
neighbours map per ride: shared OSM node, except that slices of one capped run
all carry that run's end nodes, so within such a family adjacency is
`piece_index ± 1`. A candidate that does not touch where the rider just was is
charged `DISCONNECT_PENALTY_M`. The anchor is the last matched segment and
survives an unmatched fix for `ANCHOR_MAX_GAP_S = 15`, because a dropped fix is
exactly when the next one most needs holding to a route. A penalty, not a veto:
with no connected candidate every candidate is charged the same and it cancels,
so the old behaviour stands.

**Measured, on the 32 sessions the model actually uses:**

| penalty | impossible | buckets | covered km |
|---|---|---|---|
| 0 (old) | 10.1% | 6285 | 98.78 |
| **6m (shipped)** | **8.2%** | **6263** | **98.81** |
| 10m | 7.3% | 6244 | 98.56 |
| 25m | 6.8% | 6220 | 98.27 |

Live after rebuild: 3532 → 3503 buckets, 483 → **491** segments, 618 → **628**
coverage rows. Fewer buckets over more ground, the same shape as chord→tangent:
rides consolidate off parallel duplicates onto the chain they connect to.

**Why 6m and not 10m.** At 10m a descent of Ladders in session 54 loses 23 of
its fixes to Upper Chutes — a *different* trail that touches Ladders at one end
and diverges to 90m — turning a clean 110 m traversal into 29 m. Ladders' own
chain is intact (`#19474↔#19475` by piece, `#19475↔#23848` by node), so this is
not a graph defect: the matcher takes one wrong turn and connectivity, which
cannot look back, holds it there. **That is the ceiling of a greedy rule and the
concrete argument for Viterbi**, should this ever need to go further. At 6m
Ladders keeps 32 backward / 30 forward against 32 / 31 before.

**The 2% target was measured against the wrong denominator.** `tmp-impossible.mjs`
reads `session_segment_matches`, which only holds runs that *cleared the
traversal gate*. Of the 27 residual unconnected transitions, `tmp-residual.mjs`
shows **14 have a discarded run sitting between them** — the rider did ride a
connecting segment, the gate threw its run away, and the two survivors look like
a jump. Genuinely unreachable jumps went **17 → 11**. Any future version of this
test must separate the two; the raw rate cannot fall below roughly 4% while the
gate discards intervening runs.

**Hancock's 191 m hole is half closed.** `#17972` now draws `forward:11-100`
where it was blank. `#17973` stays blank, and **that half is a pipeline bug, not
a matcher one**: both competing paths (`#23278`, `#22505`) are tagged
`is_sidewalk = true` yet still canonical, so they compete for fixes when
`link_canonical.mjs` exists precisely to stop that. The linker's parallel test
uses `bearing_deg` — the chord — with a 20° tolerance, and `#23278` misses
Hancock by one degree. Forcing the road to win instead needs a 10m+ penalty,
which is what breaks Ladders. Fix the linker, not the number.

*Closed 2026-09-27 by "The sidewalk fold" below. The diagnosis above was right
about the cause and wrong about the size of it: the miss is 20.6°, not one
degree, and `#23278` is not a near-parallel line at all — it turns a corner.*

New scripts: `tmp-connect-sweep.mjs` (penalty sweep, reproduces the 10.1%
baseline at penalty 0 — check that before believing any other row),
`tmp-residual.mjs` (splits teleports from gate artefacts by hop count),
`tmp-connect-diff.mjs` (per-line gained/lost), `tmp-connect-detail.mjs`
(per-session, per-direction, for one street), `tmp-claim.mjs` (which segment
claimed these fixes, before vs after), `tmp-chain.mjs` (is a street's own chain
connected). All restrict to the sessions `rebuildModel` uses — measuring over
every session counts rides the model throws away.

## The sidewalk fold

**Built 2026-09-27 on branch `fold-missed-sidewalks`.** The last named lever in
"Open items", and the fix is a frontage test in `link_canonical.mjs`.

**The headline number in this document was wrong.** "2,643 tagged sidewalks
never folded" counted the wrong population. The linker's eligibility clause does
not read `is_sidewalk` at all — it is `kind in ('footway','cycleway') and
(street_name is null or street_name ilike '%sidewalk%')`, by name. Measured, the
real picture is **12,241 eligible paths still canonical**: 8,940 with no road
within 20 m, which is correct, and **3,301 near a road that failed the parallel
test**, which is the bug. Of the 2,643, only 34 are named paths the name rule
protects on purpose (Midland Trail, Vindicator Drive Trail, Homestead Trail).

**"Off by one degree" was also wrong, and that mattered.** `#23278` misses
Hancock by 20.6°, and it is not a near-parallel line. It is one 146 m footway
that **turns a corner**: 30 m east along Transit Drive, a 14 m corner radius,
then 102 m south along Hancock at a local heading 0.8° off Hancock's own. The
chord is the average of two legs belonging to different streets. Widening the
tolerance would have been the wrong fix — the bearing-delta histogram puts 831
of the 3,301 in the 80–90° band, and those are genuine perpendicular connectors
that must stay canonical.

**What shipped.** `scripts/lib/frontage.mjs`: walk the path in 5 m steps and ask
of each step whether a road is within 20 m **and heading the same way there**.
The fraction of the path's length that answers yes is its frontage; fold at 60%.
Same chord→tangent move as note 17, applied to the linker instead of the matcher.

Two details are load-bearing:

- **Frontage is measured against all nearby roads at once**, and it pools across
  *different streets*, which is the point rather than an accident. Two reasons:
  roads are split at junctions and capped at 150 m while paths are split on
  their own nodes; and a pavement follows the network around corners. `#23278`
  is 30 m of Transit Drive's pavement and 102 m of Hancock's, so a single-road
  threshold would reject the very segment this exists to fold — its best single
  street holds only 53%. Measured over the 744 folds: 519 pool across more than
  one street name and 345 would miss the gate on their best single street —
  corner pavements, the ~50/50 two-street split being the signature (`North
  Cascade Avenue 52% + West Pikes Peak Avenue 48%`).
  **But pooling alone is unbounded**, so it is not the whole rule: a path must
  also run alongside *one connected run* of street network, or have *one street*
  holding 40% of it. The linker fetches `street_name` and both node ids to
  decide that, which it did not before. The dry run lists in full every fold
  where no single road holds even a third — 15 of them — so the thinnest cases
  stay visible rather than merely bounded.
- **The linker only ever adds parents.** `canonical_segment_id` is a "hide me"
  flag — all five readers test it for null and **none reads which road it
  names**. Two consequences, and they pull in opposite directions.
  **Releasing is risky**: recomputing every parent from scratch releases 743
  paths, and replaying the matcher over that set cost Brenner Place `#37523`
  and `#8361` their lines and 430 m of carriageway, to gain five pavement lines
  nobody has ridden. **Reparenting is inert**: frontage picks a better parent
  than the old nearest-road rule for 5,562 already-folded paths, and rewriting
  them would change nothing anyone can observe while making the production
  write eight times larger. So the default writes **744 rows, every one of
  which moves a line on the map**, and `--unfold` / `--reparent` do the rest on
  request. The dry run always reports both counts.

**Measured read-only** by `npm run eval:linker` (`evalLinkerFold.ts`), which
replays the real matcher, gate and stitcher over the 42 usable sessions against
both candidate sets — the same harness as `tmp-connect-sweep.mjs`, sweeping the
candidate set instead of the penalty. Nothing was written to measure this. It
takes thresholds as an argument (`npm run eval:linker 0.5,0.6,0.7`) and prints
a **per-line** gained/lost diff, flagging any road that lost its line, because a
net bucket count hides a street losing to a sidewalk.

| | impossible | buckets | covered km | road km | lines |
|---|---|---|---|---|---|
| before | 8.2% | 14,711 | 225.06 | 55.14 | 750 |
| **after** | **7.1%** | 14,710 | **225.10** | **55.37** | 749 |

**Two honest caveats on that table, both raised by the cold review.** Buckets
fall by one — the success test said they must not fall, and one bucket out of
14,711 is a sidewalk stub that stopped being drawn, but the criterion said what
it said. And the replay is **blind to 99.6% of the change**: of the 744 folds,
exactly three currently draw a line, so the other 742 cannot move any number
here until someone rides them. `eval:linker` now prints that coverage figure
under its own table, because a measurement that silently covers 0.4% of its
subject is worse than none.

**Hancock `#17973` goes from 0 m of its 91 m drawn to 90 m.** `#17974` goes
47 m → 79 m. Three pavement lines stop being drawn — all three tagged
`footway=sidewalk`, unnamed, 0–7 m from their street — and two pieces of Hancock
start being drawn. One named line folds, `Cheyenne Rd North sidewalk`, whose
name is the rule working. **No named trail is touched.**

The threshold is not delicate and that was measured, not assumed: 0.5, 0.6 and
0.7 give byte-identical buckets, coverage and impossible rates through the full
matcher, because the two populations are bimodal — 78% of already-folded paths
score exactly 1.0, 91% of canonical ones score below 0.1, and the middle is
nearly empty.

**Tests.** `osm-pipeline` had none before this; it now has 106 (`npm test`, no
database, under a tenth of a second) and the pre-commit hook runs them. The
centrepiece is a control that asserts the **old** chord rule still rejects
`#23278` — if that ever starts passing, the fixture has drifted and every
assertion under it is measuring nothing. 58 mutants, 57 killed; the survivor is
a one-point-road guard that cannot be reached against a
`geometry(LineString, 4326)` column and is documented in place as such.

**The cold review rejected the first version, and it was right.** Two findings
were disqualifying, and both were the defect class this file already names.

- **The suite could not fail when the bug came back.** `MIN_FRONTAGE` was a
  private constant in `link_canonical.mjs`. Raising it to 0.95 un-folds
  `#23278`, restores the hole, and leaves every test green. Twelve more
  write-path mutations survived too — `--unfold` as the default, every path
  becoming its own parent, the UPDATE's key and value swapped, `r.kind = 'road'`
  dropped so a path folds into another path. The *library* was well covered; the
  seam between the library and Postgres had no coverage at all, and I had
  claimed the regression was proven on the strength of a mutation *inside* the
  library. `MIN_FRONTAGE`, `plannedParent`, `updateBatch` and `CANDIDATE_SQL`
  moved into `linkPlan.mjs` where tests reach them. All thirteen now die.
- **Both boundary tests were tautologies.** They built their fixtures from
  `MAX_OFFSET_M ± 1` and `MAX_TANGENT_DELTA_DEG ± 2` and then checked them
  against those same constants, so they passed at a 200 m offset limit and at a
  2° tangent limit — the bug in both directions. Literals now.

**The third review rejected it too, and found the same pattern one level out.**
Its words: "the finding was answered where it was pointed, and the same defect
survives one level out." It confirmed every earlier finding genuinely fixed,
then found that `npm test` globbed `scripts/lib/*.test.mjs` and
`link_canonical.mjs` is not in `lib/` — so **eight single-line edits there
survived all 81 tests**, five of them restoring the Hancock hole. The worst
inverts `if (!apply)`, so a bare `npm run link` writes to production while
`--apply` reports a dry run. My own mutation count had been measured over a set
that excluded that file: I claimed 50 of 51; the reviewer measured 93 of 130.

The fix was not another move. `runLink()` now takes its client, argv, logger and
clock as arguments, so a test drives the whole script against a fake client;
`npm test` globs `scripts/**` and the pre-commit hook with it. All eight die.

**And the pooling rule got the floor it never had.** Summing frontage over every
nearby road is unbounded: 25 disjoint roads each flanking a twenty-fifth of a
path reach frontage 1.000 with no road holding 7%, and `#19091` really did fold
on 24% from its best road across six of them. `decide` now also requires that
the roads which won steps form **one connected run of street network**, or that
**one street holds 40%** of the path. Grouping by street name is what makes the
second test work: Hancock's `#17973` and `#17974` are two rows and one street,
so `#23278` scores 0.697 by street against 0.531 by road.

Measured against every alternative rather than chosen: best road ≥ 0.35 cost 16
folds, connectivity alone cost 20, best street ≥ 0.50 cost 90. **The pair costs
exactly one**, `#89600` — the case this file previously named as its own
counterexample and folded anyway. It draws no line, and every matcher number is
unchanged.

Three smaller ones, all real. A repeated vertex **in a road** fabricated a due
east heading (`atan2(0,0)`) that won the tie-break and folded a path into a road
it crosses — no such vertex exists in the table today, but `turf.lineSliceAlong`
emits them and `split_ways.mjs` uses it, so the next import arms it. The
named-line guard printed on every run could not fire, because its test is the
same predicate as the eligibility clause; it throws now instead of reassuring.
And the claim that the projection is "exact to well under a centimetre" was
wrong by 20× — really 0.162 m long north-south and 0.197 m short east-west over
150 m, still ~300× below the thresholds it feeds, with the arithmetic now in the
file instead of the adjective.

**Applied 2026-09-29.** `npm run link -- --apply` wrote **744 rows**, all folds,
none released or reparented. Network `47,015 + 19,669` → `46,271 + 20,413`.
Verified after the write: `#23278 → 17973`, `#89600` still canonical (the floor
held it out), 0 roads folded, 0 self-references, and every named trail fully
canonical — Greenway 226/226, Shooks Run 109/109, Midland 65/65, Ridgeway 19/19.
Reversal snapshot at `%TEMP%/link_canonical/before-2026-09-29T02-12-31-901Z.csv`,
744 rows, every previous value null, so undoing it is one `update ... set
canonical_segment_id = null` over those ids.

`rebuild-model` then merged 2,228 runs, discarded 502, dropped 158 impossible
fixes: **6,100 buckets / 750 segments → 6,098 / 749**, 0 implausible.

| | buckets before → after |
|---|---|
| Hancock `#17973` | **0 → 5**, covering 15–90 m of 91 m |
| Hancock `#17974` | 3 → 5 |
| Hancock `#26446` | **0 → 5** |
| `#23278`, `#21671`, `#24463` | 14 → 0, folded away |

Hancock now runs continuously across `#17971` (30–105 m), `#17972` (45–105 m),
`#17973` (15–90 m) and `#17974` (30–90 m). Confirmed through the live
`/segments` endpoint, not just the database: all four pieces return, all three
sidewalks are gone.

**The first deploy failed** on `TS2307` and taught note 29. Production stayed up
throughout, and the map fix never depended on the deploy — it is rows, not code.

## The sliding anchor is gone

**Decided and done 2026-09-23, on branch `strip-the-ramp`.** Julian took the
recommendation from the fourth review: fix the measuring tool, then take the
tilt out. Both are done.

**What was deleted.** `fitDriftRate`, the chain walk (`netObservedRiseM`), the
contradiction veto, the allowance rule, `collapseToObservations`,
`largestCoveredBlock`, the `Revisit` type, `FitOptions`/`allowRamp`, eleven of
thirteen constants, `collectRevisits`, `siteKeyFor`, `runElevationSource`,
`demDriftM`, `demAnchorShape`, and `evalAnchorDrift.ts`. `anchorFit.ts` went
from 791 lines to about 70.

**What is left** is the single-median anchor that shipped all along:
`fitAnchor(residualsM)` returns one number or null. It takes bare residuals, not
timestamps — deliberately, so nothing can read a time again without changing the
signature.

**The safety claim, and how it was proved.** The surviving fit had to reproduce
`main`'s `fitDemOffset` exactly, or merging would move stored elevations. Tested
against an independent transcription over 20,000 random residual sets, plus a
cold reviewer's own transcription over a further 350,163 adversarial finite
cases — including `±0` mixes, `Number.MAX_VALUE` inputs chosen to overflow the
even-median average to `±Infinity`, every count 0–20, and levels pinned either
side of 60. **Zero divergences on finite input.**

**One deliberate divergence, on non-finite input.** Main filters nothing, and
sorting with a NaN present is not a sort: comparisons involving it answer NaN,
the array comes back partly unsorted, and the "median" is whatever landed in the
middle. Consequences, both measured rather than reasoned: main returns **NaN as
the offset** in 5,846 of 100,000 NaN-bearing cases — and `Math.abs(NaN) > 60` is
false, so the plausibility guard waves it through and the caller subtracts it
from every bucket, turning a whole ride into NaN heights. For other positions it
returns a real number that **depends on the array order**. The new version
filters first. `elevation_m` is `double precision` on both sides of that
subtraction and Postgres admits NaN, so "cannot happen" rested on the database,
not on the code.

**What replaced the eval.** `evalAnchorDrift.ts` was a before/after comparison
built to judge the ramp; with no second mode its gates, pairing and
untouched-bucket proof are meaningless, so it became `evalModelQuality.ts` — a
report, not a gate. The three measures survive because they were never about the
ramp. Two things to know before comparing its numbers to anything older:
`heldOutKeys` is gone, so the populations are roughly **twice** the size; and
`terrainDisagreements` no longer removes a per-ride level (see below).

**A defect the cold review found in the new eval, worth carrying forward.**
`terrainDisagreements` used to subtract each ride's own median residual so it
would judge shape rather than level. For an *anchored* ride that does nothing —
the caller has already subtracted the anchor, so the median is zero. The rides it
affected were the ones `fitAnchor` **refused**: a ride 80m off the terrain is
past `MAX_PLAUSIBLE_OFFSET_M`, production merges it unanchored and the map draws
it 80m out, and the measure anchored it anyway with the very offset the guard
exists to reject and reported **1.00m**. The one measure with an external
referent was blind to exactly the failure the external referent was brought in
for. It now scores the model as stored.

**Also removed, and it could not be kept.** The fourth review recommended
keeping "the instrument rule" — the guard that refuses to compare a GPS pass
against a barometric one, which caught session 76 asking to tilt a real ride
20m. It has no meaning without the ramp: its only consumer was the barometer
filter inside `collectRevisits`, and it guards a *comparison between two
passes*. Delete the comparison and the guard has nothing to protect. What
survives independently is the `elevation_source` column itself, still recorded
per sample and still used for ride eligibility in `usableSessions.ts`.

## The merge and the rebuild

**2026-09-24.** `main` moved for the first time since 2026-09-06:
`9727a28..7708224`, nine commits, the whole elevation stack at once. Deploy
verified by `builtAt` moving `2026-09-06T07:14:04.086Z` →
`2026-09-24T01:46:26.360Z`, never by status.

**The only runtime behaviour change in all nine commits is the smoother.** The
anchor is arithmetically identical to what was already running, and about 5,000
of the lines are tests, evals and docs the server never loads.

Then `rebuildModel.ts`, to put the stored model on the same filter as new rides.
Snapshot of all three wiped tables taken first, under
`scratchpad/pre-rebuild/*.csv`.

- 39 of 42 sessions qualified. The three skips are the documented ones: 5 and 6
  (elevations not absolute), 45 (20.7% impossible steps).
- 1,792 runs merged, 444 discarded, 143 impossible fixes dropped.
- **5,953 buckets across 739 segments, 0 implausible — identical counts to
  before.** That is correct, not a no-op: the smoother changes heights, not
  which runs clear the gate.
- **Every one of the 5,953 buckets moved. 0 identical, 0 added, 0 removed.**
  Absolute change: median 0.655m, p90 1.770m, worst 5.154m, mean 0.824m. Full
  before/after at `scratchpad/rebuild-before-after.csv`.

**Did it help? Partly, and the honest answer is mixed.** Measured with
`eval:quality` over the same 39 rides, old filter against new:

| | main's smoother | after rebuild |
|---|---|---|
| terrain median / mean / worst | 2.43 / 3.71 / 30.87 | **2.37 / 3.67 / 27.84** |
| cross-ride mean / worst | 2.08 / 13.58 | **2.01 / 12.72** |
| self-consistency median / p90 | **2.75 / 10.43** | 2.87 / 11.85 |

Terrain is the only measure with a referent outside the archive, and it improves
on median, mean and worst. Self-consistency gets worse. That is the expected
signature rather than a surprise: **a lagging filter makes two passes of the
same ground agree with each other while both are wrong in the same direction**,
so removing the lag costs self-agreement and buys accuracy. It also independently
reproduces what commit `3010e8b` measured with a different instrument, which is
the strongest evidence the new eval works.

Caveat on the terrain row: its comparison count rose 11,146 → 11,213, because
the rebuild calls `ensureDemElevations` and fetched terrain the eval never
does. Slightly different populations, so read that row as indicative.

**Not done, deliberately:** draft PRs #1 and #2 are still open and now contain
nothing `main` lacks (#1 already contained #2 via the `0be4344` merge). The four
old `jzavala5114/*` branches and `fix-eval-gates` / `strip-the-ramp` are all
merged and still exist. Both are Julian's to close.

---

---

## What the drift anchor taught us, kept after the code went

Three rounds of building, five adversarial reviews, ~4,300 lines deleted. The
mechanics are in git (`47a2a14` through `7708224`); what follows is the part
that transfers to work that has nothing to do with barometers.

**The defect class, which recurred in five separate places.** Evidence that is
not independent counted as a quorum, and a check that cannot fail reported as a
check that passed. Every round of fixes introduced fresh instances of the same
pattern *while fixing it*. Concrete forms worth recognising again:

- **A control that shares an implementation with the treatment is not a
  control.** The eval "proved" every untouched bucket was identical by comparing
  `flat()` against `flat()` reached by two routes. It proved `flat() === flat()`.
- **A proof with no subjects prints as a proof.** The same check printed
  `verified identical: 0/0` and exited 0 whenever every bucket had a treated
  contributor. A reassuring `8742/8742` and a vacuous `0/0` were
  indistinguishable to the gate.
- **NaN silences a threshold rather than tripping it.** `Math.max(NaN, x)` is
  NaN and `NaN > limit` is false, so one unreadable value switched off two of
  five gates for a whole measure — and got counted as a regression, padding the
  count in the passing direction. This exact bug was found, fixed, and then
  reintroduced thirty lines away in the same commit.
- **A measure can be blind to the thing it was added for.** The one quality
  measure with an external referent removed each ride's median residual "to
  judge shape, not level" — which silently *anchored* the rides the anchor had
  refused, reporting a ride the map draws 80m out as 1.00m.
- **N passes over one cell are N−1 independent increments, not N(N−1)/2 pairs.**
  Emitting every pair let three passes over one bucket clear a quorum written to
  need three independent observations.
- **A rule written as a ratio of two timestamps is invisible to a suite whose
  fixtures all start at zero.** A 5% band on absolute epoch milliseconds spans 85
  years and admits everything; every fixture started its ride at `atMs 0`, where
  the line is correct. Generalise this: test at production magnitudes, not just
  production shapes.

**Measurement findings that still hold.**

- **A GPS pass compared against a barometric pass measures the offset between
  two sensors, not drift.** Session 76 read −3.49m at the head of Culebras Trail
  and −17.96m at its end with every gap 31–32 minutes, which no drifting
  barometer can produce: its first lap fell in a GPS stretch and its second was
  barometric. Every other guard passed it and it asked to tilt the ride 20m.
  `elevation_source` is still recorded per sample and still gates ride
  eligibility in `usableSessions.ts` — that column earns its keep independently.
- **Counting `segments` rows as distinct places inflates any quorum.** A segments
  row is one OSM way split at every junction and capped at 150m, so session 76's
  "15 distinct sites" were 15 consecutive pieces of one trail.
- **Fitting a drift term against the DEM is dead, and not for a fixable
  reason.** It made each ride more self-consistent and *less* consistent with
  other rides (cross-ride median 1.86m → 1.93m): within one ride, where you are
  is correlated with when you are, so the line absorbs the DEM's own
  place-dependent error and tilts the ride to match it. Two rides crossing the
  same ground in opposite order get opposite tilts.
- **The archive does not hold the evidence a drift correction needs.** Every
  honest round of fixes shrank its reach, because every round removed a way for
  thin evidence to look strong. It ended at two rides in thirty-seven.

**How the reviews were run, because the method worked.** Each reviewer got the
deliverable and a named reference and nothing else — no commit messages, no
build reasoning, and an explicit instruction that its job was to reject. Two
reviewers on the same commit, neither seeing the other, agreed on the defect
class and found it in different places. Mutation harnesses (patch a line, run
the suite, restore, report which test died) found what the tests could not: a
test that passes proves nothing about the bug it is named for.

**If a drift correction is ever wanted again**, the settled design is one check
comparing the ramp against *every* observation over that observation's own
interval — `|rate × gap − rise| <= leak allowance`, with the allowance from the
measured noise floor rather than from either side of the comparison. That single
rule replaces the chain walk, the joint veto and the minimum-allowance rule, and
kills four of the five findings at once. Read this section first; the obvious
approaches are the ones already tried.
## Open items

### The 36 lines, enumerated — DONE, and it SHIPPED 2026-10-01

`npm run eval:heading-lines` (`enumerateHeadingLines.ts`, 39 tests, 15/15
mutants as expected). Every line one heading draws and the other does not, each
with a verdict from `findPasses`, which reads projection and the clock and never
a heading, so it is **identical under both arms** — 2,565 passes on segments
both arms touched, **0 disagreements**, printed as a control on every run.

| | lines | metres | what it is |
|---|---|---|---|
| ground **lost** | 2 | 63 | a pass whose fixes are drawn nowhere under derived. **the cost** |
| ground **gained** | 1 | 24 | a pass the device drew nowhere |
| phantoms **removed** | 13 | 594 | no pass in that direction, ever. paint never earned |
| phantoms **created** | 4 | 181 | the same mistake, the other way |
| consolidated away / in | 8 / 13 | 347 / 654 | the same ground, drawn on the neighbour. a wash |
| under 25 m, lost | 13 | 163 | **unjudgeable** (see below); 11 of 13 drawn elsewhere |

So the `net −10 lines` was never the cost. The real trade is **63 m of ground
against 413 m of net phantom paint removed**, plus 28 recovered passes and the
discard rate. The answer holds either way: sweeping the next-door share from 0.3 to 0.7
moves the real-loss count only between 1 and 2.

**One street visibly goes blank:** `#37523 Brenner Place backward`, 26 m,
session 56 — the only real loss whose segment keeps no paint in either
direction. The other, `#75456`, is a 36 m footway at 47% (it flips to
consolidation below 0.47) and its street keeps paint.

**A defect in the first version of this measurement, worth keeping.** It
reported 26 phantoms. 13 of those were segments **9–24 m long**, and
`findPasses` needs `MIN_PASS_M` = 25 m of travel, so on them no pass can ever be
found and silence proves nothing. The traversal gate has a second door the
detector does not (`spanM >= MIN_SPAN_M || coverageFraction >= MIN_COVERAGE`),
which is how a 10 m stub gets drawn in the first place. Calling them phantoms
credited the change with removing 13 lines nothing had judged — **half its
apparent benefit**. They are now a fourth verdict, `no-witness`, reported on
their run window and explicitly not counted either way.

**And the obvious fix does not work.** The guess was that derived loses these
where it returns null (under `MIN_DERIVE_M` = 6 m of motion), so a fallback to
the device heading would be free. Measured on both real losses: Brenner Place
has **12 fixes in corridor, 1 null derived, 0 null device, median device/derived
gap 9°, max 23°**. The two headings agree. The loss is not the derived heading
being wrong about that segment — it is the greedy matcher, where one different
decision earlier in the ride moves where the run starts and the traversal gate
then rejects it. A heading fallback cannot recover it. **Viterbi can**, which is
the ceiling three other notes already name.

**SHIPPED 2026-10-01**, `builtAt 2026-10-02T01:32:09.613Z`, followed by a full
`rebuild-model`. The dry run — `npm run verify-rebuild`, which does the real
rebuild inside a rolled-back transaction rather than reimplementing the
averaging — predicted 6,080 buckets, and the rebuild produced exactly **6,080
across 745 segments, 0 implausible**. Live `/segments` returns 745 segments and
956 lines against the predicted 745 / 956.

**What the dry run was for.** 86% of the 5,961 shared buckets moved: median
2.8 cm, p90 8.6 cm, but **p99 1.15 m and worst 14.6 m** (`#19477` backward at
0 m, where the readings collapse 3 → 1). The big movers are nearly all bucket 0
of a line whose averaging disappears, which is a thinner number rather than a
better one.
**What made it shippable is the gradient, because that is what gets painted.**
Adjacent-bucket `|grade|` is flat to better at every threshold: >15% 136 → 132,
>25% 34 → 34, >40% 9 → 7, >60% 5 → 4, >100% 1 → 1, and p50/p90/p99
3.6/9.4/20.6 → 3.6/9.4/21.0. The absurd ones that exist (103%, −76%) are
identical before and after, so they are pre-existing and not this change. Four
line-starts gained a spurious cliff (`#19477` −21% → +75%, `#19475`, `#23848`,
`#14359`) and two worse ones elsewhere went away.
**Residual risk, stated rather than resolved:** buckets that drop to a single
reading are noisier even where today's gradient looks fine.
**The default is now pinned by a test.** Flipping `headingSource` from
`"device"` to `"derived"` left all 204 tests green — nothing watched the most
consequential constant in the matcher. The new test was verified by flipping
the default back and watching it go red, not by assuming it would.

### The barometer: shipped, installed, verified

**DONE, merged (`4f0038d`, `957c8fb`), installed, and VERIFIED on session 84
(2026-10-03): verdict `alive`, 1366 of 1367 fixes barometric.** See "The ride
that proved it" below. Nothing is outstanding. Everything shipped on 2026-09-30
and 2026-10-01 was backend work provable against the archive; this was an
Android sensor lifecycle, no replay reaches it, and that is why closing it
needed a ride rather than a test.

**The defect.** `expo-sensors` unregistered the pressure sensor itself:
`SensorProxy.kt:99` has `OnActivityEntersBackground → stopObserving()`. Android
was not refusing to deliver, the library stopped asking. Screen on gave 100%
barometer; screen off and it died in **11-19 s**, then GPS altitude took over.
Per 15 m bucket that is **0.29 m (1.96% slope error) against 0.65 m (4.35%)** --
a whole colour band. Session 61, left locked, lost **93.5%** of its fixes.

**That 11-19 s was the diagnosis, not just the symptom.** A clean stop at a
repeatable delay is an explicit unregister. CPU suspend starving a non-wake
sensor would look intermittent instead. **So no wake lock was needed and none is
taken** -- which was the expensive thing this was expected to cost.

**What shipped: `mobile/modules/ride-barometer/`,** a local Expo module.
Autolinked from `./modules` with no config (`nativeModulesDir` defaults there).
It is NOT under `mobile/android/`, which is gitignored `expo prebuild` output and
would be wiped by the next prebuild -- that is the trap to remember if another
native module is ever added. It registers a `SensorEventListener` against the
**application context** on its own `HandlerThread`, and has **no
`OnActivityEntersBackground` hook at all**; that omission is the whole feature.

**Readings go into a ring buffer with wall-clock timestamps**, pulled once per
task invocation, rather than pushed as bridge events: 5 Hz into a paused JS
context for a twenty-minute screen-off stretch is 6,000 crossings nothing is
listening to. The consumer changed shape to match. A running sum drained once per
fix was bounded at 1-4 s only because the drain and the sampling shared a
context; once readings accumulate natively nothing bounds it, and **a mean over
sixty seconds is a height at no particular place** -- 15 m of error at 5 m/s on a
5% grade. Each fix now averages readings within **+/-500 ms of its own
timestamp**, half of `MIN_INTERVAL_MS`, so neighbouring fixes never share a
reading. They must not: shared readings correlate their noise and the backend
differences neighbours to get a gradient.

#### The hardware, measured over USB on 2026-10-03 — do not re-measure

The test device is a **Pixel 10 Pro** (`59150DLCH000E8`). `adb shell dumpsys
sensorservice` reports:

```
SPL07003 Barometer | Goermicro | type: android.sensor.pressure(6) | flags: 0x0
  continuous | minRate=1.00Hz | maxRate=25.00Hz
  FIFO (max,reserved) = (3000, 3000) events | non-wakeUp
```

Four things follow, and they are why two constants are what they are:

- **5 Hz is comfortable.** Max rate is 25 Hz, so the 200 ms request is well
  inside the part.
- **It is `non-wakeUp`**, so `getDefaultSensor(TYPE_PRESSURE, true)` returns null
  and the module takes the normal variant. Expected, not a fault. The status line
  reports it by omitting "wake-up".
- **The FIFO holds 3000 events**, which is ten minutes at 5 Hz and fifty at the
  1 Hz floor. A non-wake sensor keeps filling that FIFO while the SoC is
  suspended and flushes it on wake, so **readings legitimately arrive carrying
  true timestamps minutes old.** This is good news for screen-off riding: the
  sensor queues rather than stopping.
- A live reading of **821.80 hPa** converts to 1731.9 m by our formula against a
  real elevation near 1840 m. That gap is correct and expected: the formula
  assumes a fixed sea-level pressure, only differences are used, and the DEM
  anchor sets the level per ride.

#### What the cold review caught, and what the hardware caught after it

A cold review rejected the first version. Read this before touching any of it.

- **`startAsync` returning true means Android ACCEPTED the registration, not
  that a reading arrived.** The hook treated it as success and never subscribed
  `expo-sensors`, so a sensor that registered and went quiet cost the ride its
  barometer end to end -- including the screen-on part that worked before any of
  this. A real regression, reproduced against the running code.
  `shouldAbandonNative` now falls back after 20 s with no barometric fix, judged
  on the **fixes actually stored**, not on the module's own counters.
- **The instrument was wrong in both directions.** A flat 10 s bracket in
  `verifyBarometer.ts` reported `alive` for a barometer blackout of any length
  that contained one GPS fix (30 s, 60 s, 300 s, 900 s, 3600 s all scored 20 s)
  and `stopped` for an honest 20 s blip containing two. It was tracking fix
  density, not barometer health, **and a test defended it**. The bracket now
  comes from the ride's own median gap, gaps past 30 s are never charged, and a
  ride too sparse to judge gets its own `unmeasured` verdict.
- Three smaller ones, each with a regression test naming what the broken version
  printed: the on-bike line read `5.0 Hz, 12000 readings` while every stored
  height was GPS; an unregistered sensor rendered as `Barometer starting` for the
  rest of the ride; `start()`'s idempotent early return left counters cumulative
  across rides.

**Then the hardware caught the fix for the first one** (`957c8fb`). Answering the
review I had narrowed `MAX_EVENT_AGE_MS` from 120 s to 5 s, reasoning that
`maxReportLatencyUs = 0` disables batching so nothing could legitimately be old.
The 3000-event FIFO above proves that false. The 5 s guard would have stamped
every flushed reading "now" -- hundreds spanning minutes, collapsed onto one
instant and averaged into a single fix, which is exactly the error the windowing
exists to prevent, caused by the guard meant to protect it.

**The lesson under it: that guard was never the filter.** `altitudeAtFix` is. An
old reading matches no fix's window and is already handled correctly by being
ignored; repairing it to "now" is the only thing that breaks that. The guard is
now a backstop for one case alone, a sensor clock on a different BASE from the
boot clock. `MAX_EVENT_AGE_MS` is an hour and `RING_CAPACITY` is 4096, both sized
to the measured FIFO rather than guessed.

**Still not fixed, known:** a dev-build-only remount race, if Fast Refresh lands
inside `startAsync`'s first few milliseconds. The watchdog cuts it from losing a
ride to losing 20 seconds. Also: the Kotlin has no test harness in this repo, so
`PressureRing` is covered only by a throwaway JVM probe a reviewer wrote (400
differential-fuzz trials, 2.4 M concurrent reads, zero divergence) and not by
anything that runs again on its own.

#### The ride that proved it, session 84 on 2026-10-03

**`npm run verify-barometer -- --session 84` → `alive`.** 61.9 minutes, 1367
fixes, **1366 barometric (99.93%)**, screen locked twice and the app backgrounded
to record a video.

| | session 84 | session 62 (screen-on reference) |
|---|---|---|
| verdict | **alive** | alive |
| barometer share | 99.9% | 100.0% |
| baro-to-baro repeat share | **0.0%** | 1.5% |
| GPS stretches over 30 s | **0** | 0 |
| unseen (no fixes at all) | 9.1 min, 15% | 4.0 min, 10% |
| distinct elevations | 1366 of 1367 | 829 of 842 |

**The verdict is not the proof. The throttled minutes are.** Android cut the fix
rate hard with the screen off, and the per-minute cadence shows four distinct
stretches: minutes 13-15 (7, 1, 17 fixes/min), **29-33 (2, 0, 0, 1, 6, with a
156 s gap and two minutes producing nothing at all)**, 36-45 (~14/min sustained
against ~30 elsewhere, most likely the backgrounded video), and 51-52 (7, 5).
**Every fix in all four is barometric.** Minute 14 has exactly one fix and
minute 32 has exactly one; both are barometric. A fix landing inside a throttled
screen-off stretch and carrying a barometric height means the sensor was
delivering into that fix's ±500 ms window at that moment, which is the thing
that could not be true before this change.

**No gap hid a restart.** All seven gaps over 30 s are `barometer -> barometer`
with steps of −0.74, +0.41, −1.80, +1.84, −0.04, −0.68 and −0.71 m. A module
that stopped and restarted across a gap would reset its baseline and step hard.
None does.

**The one GPS fix is fix #0, and it is harmless**: it reads 1883.58 m and fix #1
(barometer) reads 1883.58 m, so the series is continuous. The ring has nothing
inside the first fix's window yet, which happens at the start of every ride —
session 83, the 13-second false start immediately before this one, shows the
identical pattern.

**Two findings came out of the ride, both under Open items**: a single reading
9 m low that spike rejection lets through, and a buffered fix from the abandoned
session 83 attributed to session 84.

#### What NOT to attempt

Patching out `OnActivityEntersBackground` in `node_modules`: unsupported, and no
build reproduces it. A `PARTIAL_WAKE_LOCK`: the 11-19 s signature says suspend
was never the cause, and it would cost battery for the whole ride. Both were
considered and rejected on evidence.

**And do not try wireless debugging on the current network.** Measured
2026-10-03: this machine sits on `100.110.132.17/26` and the phone on
`100.110.146.104`, different subnets behind carrier-grade NAT, mutually
unreachable (ICMP and TCP to the phone both time out). Multicast never crosses
subnets, so `adb mdns services` is empty even with the pairing dialog open and
Android Studio's pairing spins forever. **USB works and is the answer.** A phone
hotspot also works, since the phone then hosts the network itself.

#### HOW TO REBUILD THE APK, AND HOW A RIDE IS GRADED

The release APK is **already built and installed** (`lastUpdateTime 2026-10-03
08:38:01`). To rebuild and reinstall after a change:

```
cd mobile/android && ./gradlew :app:assembleRelease
"$ANDROID_HOME/platform-tools/adb.exe" install -r \
  app/build/outputs/apk/release/app-release.apk
```

Note **release, not debug**: `assembleDebug` produces an APK with no
`index.android.bundle` in it, which loads JS from the Metro dev server and dies
the moment the phone leaves the laptop's network. That would waste a ride.

To grade another ride, lock the screen deliberately for several minutes in the
middle. While riding, the map shows one line: `Barometer 100% of fixes, 5.0 Hz`
is healthy, and anything red names what is wrong. Afterwards:

```
cd backend && npm run verify-barometer
```

A pass is **`alive`** with a barometer share near the reference. Read the
`unseen` column beside it: that is how much of the ride produced no fixes and so
could not testify either way. **`unmeasured` is not a pass** -- it means the ride
was too sparse to conclude anything, and the answer is to ride again. Session 62
is the screen-on reference: 842 fixes, 45 minutes, 186 m of climb, 829 distinct
values, 100% barometer. The pre-change baseline for every ride in the archive is
in that script's output; roughly half the labelled rides read `stopped`, with
sessions 76 and 79 losing 17 minutes each.

**Session 84 is now the post-change reference** and the better comparison for
anything screen-off: 1367 fixes over 61.9 minutes, 1366 barometric, two
deliberate locks. Session 62 remains the screen-on control.

**Do not confuse this with the oversampling work**, which is separate and also
done: oversampling cut sensor noise 2.5x but end-to-end slope error only
5.00% → 3.90%, because on trails the barometer is **not** the dominant error
term -- the DEM sampled along an OSM centreline that on singletrack is not where
the rider actually was accounts for more. Closing the screen-off gap raises
screen-off rides to screen-on quality; it does not make trail rides as good as
street rides.

### Does the matcher need Viterbi? Measured 2026-10-03 — NO, and the graph is why

**The answer is no, but almost every reason in the first draft of this note was
wrong, and a cold review caught it.** Read the corrections: the headline "0.22%
of covered distance" should not be quoted, and the first lever is NOT the
traversal gate.

`tmp-viterbi-price.mjs`, read-only, pinned to the 42 sessions the 2026-10-01
numbers were measured over. **The control reproduces exactly** before any other
row is read: wrong-dir 23 passes (1073 m), gate 12 passes (722 m), 35 passes and
1795 m. Identical to "The 36 lines, enumerated". That part held under review.

#### THE REAL FINDING: the segment graph has no edge where the rider turned

**47 transitions looked like teleports — over 4 hops apart in the network and
under 10 s apart in time. They are not teleports. They are missing edges.**
Measured in PostGIS, 45 of the 47 join segments whose endpoints are within 30 m
of each other and which share **no OSM node**. Verified instances:

| pair | gap | same OSM way | shares a node |
|---|---|---|---|
| `#75376`/`#75377` Palmer Point Trail | **4 m** | yes (1082541623) | **no** |
| `#49851`/`#49850` Captain Jacks 667 | **2 m** | yes | **no** |
| `#14160`/`#14161` Shooks Run Trail | 3 m | no | no |
| `#19090`/`#6124` Shooks Run Trail | 2 m | no | no |
| `#44533`/`#12277` Grand View Overlook | 37 m | no | no | <- the only genuine gap, both directions, session 56 |

**Network-wide, canonical pairs that meet on the ground and share no node:
89 within 1 m, 1,987 within 5 m, 11,899 within 10 m — and 1,305 of the
within-10 m pairs are the SAME OSM way split into pieces.** Read 11,899 as an
upper bound: at 10 m it includes bridges, overpasses and trails that genuinely
pass near each other. The 89 at 1 m and the 1,305 same-way pairs are the
defensible core, and pieces of one way failing to share a node is unambiguous.

**This is the strongest argument against building Viterbi, and the first draft of
this note missed it entirely.** A Newson-Krumm transition cost is
`|great-circle distance between fixes − route distance on the network|`. Where
two paths meet physically but carry no edge, the route distance is enormous or
infinite, so **a Viterbi would refuse the rider's real movement** and route them
onto whatever happens to be connected. The greedy matcher survives this only
because `DISCONNECT_PENALTY_M` is a soft 6 m penalty and explicitly not a veto
(`segmentMatcher.ts:84-106` says so, deliberately). **Building a graph search on
this graph makes the map worse.** Repair the graph first; it is also the cheapest
thing in this whole investigation.

#### The corrected ledger

**The old "0.80% of covered ground" double-counted.** A wrong-dir loss means a
qualifying run EXISTS on that segment in the other direction, so that ground is
painted and sits in the 224.74 km denominator. Numerator and denominator
overlapped on exactly it.

| | passes | metres | share of 224.74 km |
|---|---|---|---|
| ground with **no line at all** (gate) | 12 | 722 | **0.32%** |
| ground with a line in only **one of two** directions ridden (wrong-dir) | 23 | 1073 | 0.48% |

Both figures count only passes on segments the matcher produced at least one run
for, and both exclude 344 `next-door` passes whose fixes landed in a qualifying
run on a neighbour.

#### wrong-dir is INSIDE Viterbi's budget, not outside it

The first draft said a Newson-Krumm Viterbi could not fix the 23 wrong-dir
passes "because that formulation has no direction term". The premise is true and
**the inference does not follow.** An HMM emits a sequence of matched positions
ALONG each link, so direction falls out of whether those positions advance or
retreat. It needs no separate term.

**This project already owns the proof.** `findPasses`
(`segmentPasses.ts:87-164`) decides direction from the projection sweep alone,
with no headings at all, and it is the witness that catches the matcher being
backwards all 23 times. The signal an HMM path would produce is already known to
be sufficient here.

**And direction has a cheaper fix than Viterbi.** The matcher asks per fix, from
one reported heading against one tangent (`segmentMatcher.ts:246-251`), so a
single fix 180° off flips a whole run. Four interventions have failed to move
that bucket: the tangent window swept over seven values (flat at 36-41), the
spike filter (redundant), derived heading (39 → 23, then stalled). **Accept a
candidate when the tangent aligns with the heading OR ITS REVERSE, then assign
direction from the order of matched positions within the run.** That is scoped to
`nearestAlignedEdge` plus run assembly, and it attacks the largest bucket.

#### The gate class is 28 m of greedy error, not 500 m

Every claimant pair was pulled from PostGIS. "A touching segment took the fixes"
turns out to be evidence of the OPPOSITE in most cases:

| what it really is | passes | metres | why Viterbi cannot help |
|---|---|---|---|
| **a genuine fork** | **1** | **28** | `#14357` Ladders, session 54: `#19473` and `#22414` both start at node 6474011046, a real 3-way split. The only true case. |
| continuation of one way, end to start | 5 | 235 | A Viterbi visits both pieces in sequence exactly as greedy does. The only free variable is the split point, set by the emission term = perpendicular distance = the same quantity greedy's nearest-point rule uses. **Worse: `SWITCH_MARGIN_M = 8` (`segmentMatcher.ts:17`, applied at `:585`) already hands the losing piece ~8 m MORE than pure emission would.** Dropping hysteresis for a global path gives these FEWER fixes. |
| parallel-corridor over-reporting | 3 | 237 | `findPasses` reports a pass on every line whose projection sweeps, which `traceOutAndBack.ts:49-55` warns about. |
| already excluded as coherent | 3 | 220 | unchanged |

**So the upper bound on Viterbi is 1 pass and 28 m (0.012%)**, or 263 m (0.12%)
if every end-to-start continuation is charitably kept as a split point a global
path might move — which the hysteresis argument above says it would not.

**The flagship case in the first draft was a false positive.** It called
`#13308` Gold Camp Road losing fixes to Ladders "the exact confusion
`segmentMatcher.ts:102` names as the greedy ceiling". Two errors. That comment
describes *Ladders* losing fixes to *Upper Chutes* at a **10 m penalty that was
never shipped**, not Gold Camp Road at the shipped 6 m. And measured:
**`#13308` is 140 m long, its closest approach to `#19475` is 10 m, and 123 of
its 140 m lies within 25 m of it.** A braided corridor, discarded by the same
rule the note had already used on three other cases — applied inconsistently.

**The same inconsistency hit the classification twice.** `#19474`/`#19475` are
one OSM way (905853788, pieces 1 and 2 of three), exactly like
`#49643`/`#49644` which the note DID reclassify. So "flip-flop between two
ways, 140 m" was wrong on facts already in this document.

#### The gate sweep: ATTEMPTED 2026-10-04, and the instrument cannot settle it

**NOT a wash and NOT a win. A non-result, for a structural reason worth
remembering.** Nothing was shipped and no constant moved.

**The blocker recorded here was not the real blocker.** It said the sweep needs
`MIN_PASS_M` pinned at 25 first, because `segmentPasses.ts:22` sets
`MIN_PASS_M = MIN_SPAN_M`. That is true and it is also avoidable: every rejected
run already carries a span and a coverage, so "would this run qualify at
threshold T" is arithmetic on numbers already computed, with the witness held at
25 throughout. No constant has to move to run the sweep.

**The real blocker is that the witness is blind to the swept population.**
`findPasses` needs `MIN_PASS_M` = 25 m of projection sweep to report anything.
Every run in the swept set is currently rejected, so `spanM < 25` and
`coverage < 0.7` both hold by construction. **The detector that was supposed to
vouch for each recovered line refuses to speak about any line in the set.**
Counting that silence as "phantom, nobody rode it" is the `no-witness` defect
this document already records one section below, in a worse form: there it cost
half of one change's apparent benefit, here it decided the sign of the answer.

The first table reported a best ratio of **2.75 phantom per real** at
`span 22 / cover 0.7` and concluded the gate should stay. Two corrections, found
independently and agreeing:

| `span / cover` | as first published | mute bucket = segment AND sweep under 25 m | witness floor dropped to 1 m |
|---|---|---|---|
| 22 / 0.7 | 2.75 | **1.00** | **1.00** |
| 20 / 0.7 | 2.57 | 1.00 | 0.86 |
| 18 / 0.7 | 2.17 | 0.92 | 0.67 |
| 15 / 0.7 | 2.00 | 0.79 | 0.55 |
| 22 / 0.5 | **1.42**, its "best" | 0.42 | **0.33** |

The middle column moves the cases the witness cannot judge into their own bucket
(102 judgeable, 222 mute, of 324 rejected runs). The right column instead drops
`findPasses`'s reporting floor to 1 m and changes nothing else: **29 of 40
"phantoms" turn out to have a real pass over that exact ground, direction and
time, 15-25 m long.** One, `#18849` backward, was called a phantom by a margin
of **1.1 m**. `RETRACE_M` = 15 still floors that instrument, so rows at 15 m and
above are sound and the 10 m row stays contaminated.

**So the published conclusion was wrong, and the corrected table points the
other way without settling anything.** At `span 18 / cover 0.7`, 38 runs would
be admitted: 12 witness-backed, 11 denied, 15 unjudgeable. That is not a
decision. Moving mute cases out of the phantom column is NOT a claim they are
real -- it is this file's own `no-witness` rule applied to the cases the first
version of the sweep missed.

**Against loosening, still standing:** 0.7 was not plucked from the air. It went
`0.35 -> 0.7` on measurement, against five phantom lines observed in real rides
(note 14), and note 14's own re-measurement found span does NOT separate the
populations in the 15-25 m band -- 21 fragments against 21 touches, a coin flip
across 169 discards. That measurement and the loose-witness one disagree about
the same band and neither has been reconciled. **The coverage clamp (note 15,
2026-09-30) does change the stakes**: a phantom now paints only its covered
extent instead of the segment's full length, so admitting one costs less than it
did when 0.7 was chosen.

**The gate bucket itself is tiny and is not a gate problem.** 4 passes / 179 m
over 44 rides, and **not one of the four has a majority of its pass's fixes in
the rejected run** -- 2/5, 2/18, 4/15, 4/10, max 40%. The run spans are 0 m, 6 m,
18 m and 18 m, so no threshold recovers two of them at all. `#25830`
Chamberlain is the closest near-miss in the archive: 18 m of a 26 m segment,
**coverage 0.692 against a 0.7 gate**, missed by 0.008.

**WHAT WOULD SETTLE IT:** a witness with a floor below the gate. Concretely,
re-run the sweep with `findPasses` at `minPassM = 15` (`RETRACE_M`'s own floor,
the lowest value that still finds anything) while `MIN_SPAN_M` stays at 25, so
the witness is independent of the thing being swept. Until then the gate is
**open on the evidence, not closed**, and a change to it needs a full
`rebuild-model` -- which is why none was made on a measurement this unstable.

#### Defects in the measurement itself, recorded so they are not repeated

- **The bridging test was near-vacuous.** It required a bridging pass to be
  CONTAINED in `[prev.endedMs − 1000, cur.startedMs + 1000]`, a 3-12 s window,
  while a pass needs 25 m of sweep and starts ~25 m before the rider arrives. It
  fired once in 213. The line "212 genuinely unreachable" was an artefact of an
  unsatisfiable filter. The right test is temporal OVERLAP, not containment.
- **The hop graph is a superset of the matcher's.** `adjacencyOf` omits the
  `realEnd` suppression at `segmentMatcher.ts:404`/`:438`, so middle cap-slices
  get spurious edges. More edges means fewer unconnected pairs, so **the 10.1% is
  understated** against the matcher's own view. Checked against every capped
  family behind the 12 gate cases: it moves no classification, because each lost
  segment is the LAST piece of its family.
- **`on_touching > 0` is a one-fix threshold.** `#14361` was called a 55 m
  greedy wrong turn on 2 claimed fixes of 5, with 3 drawn nowhere and a 0 m span.
  In 5 of 12 cases `nowhere` is the largest bucket and the verdict ignores it. A
  share threshold matching `NEXT_DOOR_SHARE` would be consistent with the project.
- **`inPass` is built from raw samples while `drawnFix` is keyed on
  post-spike-rejection samples**, so `nowhere` conflates "matched nowhere" with
  "never offered to the matcher".
- **Run order is not a clean sequence.** Session 42 reports a `gap_s` of −4:
  two qualifying runs overlapping in time are one stretch described twice, not a
  transition. Both the 2114 and the 213 carry an unknown number of these.
- **The published hop table used `<= 10` while the text said "under 10 s".**
  Strict `< 10` gives 91 and 13 for the 2-hop and 3-hop rows rather than 95 and
  15. The `>4` row is 47 either way, so the headline is robust to the boundary.
- **The denominator is inherited, not re-measured.** 224.74 km comes from the
  `eval:heading` derived row of 2026-09-30. It is the right KIND of denominator
  (directed drawn metres against directed pass metres, same arm, same 42 rides),
  but `traceSession` already returns `coveredM` and the script ignores it. One
  accumulator would have made it self-contained.
- **Unmeasured, and the one number worth adding:** how many segments the rider
  rode produced ZERO runs and are absent from the ledger entirely. `touched` is
  built from the matcher's own runs. The structural argument says the missing
  class is parallel-line loss rather than fork loss — at a real fork the branches
  diverge past 25 m and a short run starts on the right segment, which is the
  `gate` signature already counted, and the matcher's own example confirms it
  ("becomes 29 m", not "vanishes"). That is reasoning, not measurement.

#### The call, corrected

**Do not build Viterbi.** Its measured upper bound is 28 m of genuine fork, the
graph it would depend on has no edge at 45 of the 47 places the rider demonstrably
moved, and on that graph a transition term makes the map worse rather than better.

**Order of work, cheapest and highest-value first:**

1. ~~**Repair segment connectivity.**~~ **BUILT AND MEASURED 2026-10-03, and it
   is not worth shipping on its own.** It closes a third of the unconnected
   transitions and moves the map by 70m in 225km. It is also NOT a pipeline bug:
   OSM genuinely holds two nodes 4m apart at these junctions and the importer
   reproduces it faithfully. See "Lever 1 was BUILT and MEASURED" below.
2. **Direction.** Closed on 2026-10-04, then **REOPENED the same day.** The
   matcher already accepts the heading or its reverse (`segmentMatcher.ts:294`),
   so that half was never the problem. Hairpins are 1 of 23 and the bearing
   tolerance is strictly worse at every width, both still dead. **The third
   explanation was wrong**: "the tangent window trades wrong-dir for gate at a
   net 38 m" came from a mislabelled `gate` column; with the classifier fixed,
   14 m is **286 m better** than the shipped 10 m. See "Lever 2, direction:
   closed on 2026-10-04, then REOPENED the same day" below, and item 5 of
   "NEXT, IN ORDER".
3. ~~**Sweep the traversal gate**, ~196 m.~~ **ATTEMPTED 2026-10-04 and it is a
   NON-RESULT.** The ~196 m was wrong twice over: the gate can only hand back a
   run's own extent, not the witness's, and 9 of the 12 cases behind the
   figure were already drawn next door. The sweep itself cannot be read, because
   its witness cannot see a line shorter than 25 m and every candidate is
   shorter than 25 m. See "The gate sweep: ATTEMPTED".
4. **Viterbi: only after 1**, and only if the residual still looks like
   unrevisable turns. Or sooner if the project ever wants routing, which is the
   other thing that pays for a graph search.

#### Lever 1 was BUILT and MEASURED on 2026-10-03: it repairs the graph, not the map

`endpointSnapM` in `segmentMatcher.ts`, off by default, swept through the real
code path over the 42 pinned sessions. **The control reproduced 23/12 first.**

| snap | unconnected | wrong-dir | gate | buckets | covered km | lines | phantom |
|---|---|---|---|---|---|---|---|
| **0 (shipped)** | 213/2093 (10.2%) | 23 (1073m) | 12 (722m) | 14676 | 224.74 | 2062 | 20 |
| 2 | 204 (9.7%) | 23 (1073m) | 12 (722m) | 14674 | 224.75 | 2062 | 20 |
| 5 | 187 (8.9%) | 23 (1073m) | 12 (722m) | 14678 | **224.81** | 2062 | 20 |
| 10 | **138 (6.6%)** | **24 (1116m)** | 12 (722m) | 14692 | 224.88 | **2059** | 20 |

**Unconnected transitions fall by 35% and the map does not move.** wrong-dir and
gate are identical at 2m and 5m, drawn lines are identical, phantom lines are 20
in every arm, and covered distance moves 70m in 225km. At 10m it goes backwards:
wrong-dir 23 → 24, three lines lost, four swapped.

**Why, and this is the part worth keeping.** This document already contained the
answer, in "The matcher has no idea the network is connected": *the teleport is
not the damage, what it costs is the ground underneath it.*
`DISCONNECT_PENALTY_M` is 6m and a tiebreaker, so new edges change which
candidates carry the penalty without often changing which one wins. The matcher
was already landing on the right segments. The graph was mis-DESCRIBING the
resulting sequence as impossible, which means the 10.2% was mostly measuring OSM
node bookkeeping rather than matcher behaviour.

**So the corrected order of work is shorter than the one above.** Lever 1 is
built, is correct, and is not worth a rebuild on its own. Lever 2 (direction by
tangent-or-reverse) is now the only lever with a plausible case, and it is aimed
at the 1073m that four attempts have failed to move. Lever 3 (the gate sweep) was run on
2026-10-04 and came back unreadable, and lever 2 is REOPENED by the same fix.
See "The gate sweep: ATTEMPTED" and the re-run table under "Lever 2".

**Keep `endpointSnapM` at 0.** If something else ever forces a full rebuild,
take 5m with it: largest radius where nothing regresses, and it makes the
impossible-transition metric honest for whatever comes next. The risk it was
expected to carry did not materialise -- the `realEnd` guard held and no paint
was invented at any radius.

**Three guards in it, each verified by mutation rather than by assumption:**
- `realEnd` suppression, so a mid-run 150m cut cannot acquire a neighbour and
  the coverage clamp cannot paint to a join the rider never crossed.
- An ACCEPTANCE bound, `!(apart <= snap)`. A rejection bound admits a
  non-finite distance, which would invent an edge from corrupt geometry. Two
  `Infinity` corners share a grid cell and reach the comparison, so the case is
  reachable and the test kills the mutant.
- The grid cell is `snap / 70_000` degrees, not `/ 86_680`. A cell must be at
  least the radius wide in BOTH axes or a pair can sit two cells apart and the
  3x3 lookup misses it. Longitude is the tight axis: at `/86_680` the cell is
  `snap * 1.284 * cos(latitude)` metres, which drops under the radius above
  **38.8N** -- and this network spans 38.71-38.97N, so the northern two thirds
  of the city sat just inside the failure.

**The test for that last one took three attempts, and the reasons are the
lesson.** First it swept north-south, the axis that cannot fail. Then it used a
4.9m gap, which is INSIDE the bad cell and so can never miss -- the failing
window is only (4.9868m, 5.0m], 13mm wide. Then it placed the gap by hand with
`metres / (111194.93 * cos(lat))`, an approximation wrong by millimetres against
the haversine distance the matcher actually measures, which pushed pairs past the
radius where they were then CORRECTLY rejected: the test was measuring its own
fixture error. It works now with `turf.destination`, a 4.99m gap and 1.3mm
steps, and it was confirmed by flipping the divisor back and watching it go red.

#### Lever 2, direction: closed on 2026-10-04, then REOPENED the same day

**Three explanations tested, three dead.** wrong-dir is 23 passes and 1073 m,
60% of all lost ground, and four previous attempts had failed to move it. It is
now closed rather than open, and the class is also smaller than the number looks.

**1. Hairpins defeating the tangent window: 1 of 23.** This document said
wrong-dir was "almost all on switchback trails where `TANGENT_WINDOW_M`'s 10 m
spans a hairpin and the tangent it averages points nowhere useful". Measured per
pass: **only one pass (68 m) has a tangent that swings 90° or more across it.**
The stated cause covers 6% of the class.

**2. The tangent window, re-swept with the derived heading.** The 2026-09-30
sweep that cleared it was measured with the DEVICE heading (its shipped row
reads 39 wrong-dir, not 23), so the hypothesis "a narrower tangent reads a
hairpin better" had been tested against a heading that was itself over 90° wrong
on 1.42% of fixes. Re-run with derived:

| tangent | wrong-dir | gate | real loss | covered km | lines | phantom |
|---|---|---|---|---|---|---|
| 0 (chord) | 40 (1554m) | 58 (4007m) | 5561 | 218.62 | 2141 | 35 |
| 3 | 24 (1180m) | 12 (696m) | 1876 | 224.33 | 2057 | 22 |
| 5 | 24 (1164m) | 11 (667m) | 1832 | 224.40 | 2057 | 22 |
| 7 | 25 (1200m) | 11 (667m) | 1867 | 224.56 | 2059 | 22 |
| **10 (shipped)** | 23 (1073m) | 12 (722m) | **1795** | 224.74 | 2062 | 20 |
| 14 | **18 (777m)** | 16 (980m) | 1757 | 225.05 | 2067 | 24 |

**Narrower is worse at every value.** 14 m cuts wrong-dir by 296 m but adds
258 m to `gate`, so total lost ground moves 38 m and phantom lines go 20 → 24.
Reclassification between two buckets, not recovery. **Not shipped.**

**REOPENED THE SAME DAY. The 38 m was an artifact of the `gate` column, and the
`gate` column was wrong.** 9 of 12 `gate` losses were ground already drawn on
the neighbouring segment (`9c13174`). The wrong-dir column is untouched by that
fix and reproduces to the metre, so the WIN at 14 m was real all along; only the
offset that cancelled it was fake. Re-run `npm run eval:tangent` under the fixed
classifier, 44 rides:

| tangent | wrong-dir | gate | lost ground | discard | buckets | covered km | lines |
|---|---|---|---|---|---|---|---|
| 3 m | 25 (1226 m) | 4 (153 m) | 1379 m | 11.7% | 15282 | 234.13 | 953 |
| 5 m | 25 (1210 m) | 4 (153 m) | 1363 m | 12.2% | 15294 | 234.21 | 953 |
| 7 m | 26 (1246 m) | 4 (153 m) | 1399 m | 12.3% | 15310 | 234.39 | 955 |
| **10 m shipped** | 24 (1119 m) | 4 (179 m) | **1298 m** | 12.6% | 15313 | 234.57 | 956 |
| 14 m | 21 (894 m) | 3 (118 m) | **1012 m** | 14.0% | 15329 | 235.00 | 956 |
| 20 m | 22 (911 m) | 2 (81 m) | **992 m** | 15.2% | 15323 | 235.36 | 962 |

**14 m is 286 m better than shipped, not 38 m**, with MORE covered ground
(234.57 → 235.00 km), MORE buckets, and the same line count (+4 / −4). 20 m is
306 m better again. The only thing that gets worse is the discard rate
(12.6% → 14.0%), and covered distance rises anyway, so nothing was lost to it.

**STILL NOT SHIPPED, and the reason is not the number.** +4 / −4 lines means the
map changes in eight places, which needs the `eval:heading-lines` treatment
rather than a total; a move needs a full `rebuild-model`; and this is one
measurement taken the same afternoon that four others in this file turned out
wrong. **It is the strongest open lever in the matcher** and it should be the
first thing re-measured once the sub-25 m witness exists.

**3. `MAX_BEARING_DELTA_DEG`, the last unswept matcher constant. Swept, and
strictly worse at every width** -- see its doc comment for the table. Lost ground
rises 1795 → 2583 m from 45° to 75°, covered distance falls, and each arm breaks
about twice as many passes as it fixes. The 45° window is doing real work
rejecting cross-traffic. **Parameterised as `maxBearingDeltaDeg` and left at 45**,
the same disposition as `positionFilter` and `endpointSnapM`.

#### And the class is smaller than 1073 m

Per-pass, from the same diagnostic:

| | passes | metres |
|---|---|---|
| heading within 90° of travel along the line, label still wrong | 14 | 720 |
| heading disagrees with travel along the line (real geometry) | 2 | 71 |
| **no interior fix, so nothing was judged either way** | **7** | **286** |

**12 of the 23 passes rest on 4 or fewer fixes** (481 m), because `findPasses`
needs only `MIN_PASS_M` = 25 m of projection sweep to call a pass, and several
sit at 21-25 m median offset, at the edge of the 25 m corridor. So an unknown
part of this 1073 m is the same detector generosity the cold review found inside
the gate class, not matcher error.

**TWO DEFECTS IN THAT DIAGNOSTIC, both mine, both worth keeping.**

- **Its two buckets covered 16 of 23 and the summary did not say so.** The
  classifier only examines INTERIOR fixes -- it needs a neighbour either side to
  get a signed movement along the line -- so a 2-fix pass contributes nothing and
  lands at agree 0 / disagree 0. Seven passes, 286 m, were silently credited as
  classified. That is the `no-witness` mistake this project has already paid for
  twice, in the linker's phantom count and in the barometer instrument's
  `unmeasured` verdict. It now prints three buckets and asserts they cover the
  input.
- **It tested agreement at ±90° while the matcher decides at ±45°.** A fix 70°
  off the travel direction counted as "the heading agrees" while actually failing
  the matcher's test in BOTH senses, which rejects the segment outright. So the
  720 m never meant "the matcher had the right information and chose wrong", and
  the inference built on it (widen the tolerance) was falsified by the sweep.

#### What is left for the matcher

**One instrument, then two open levers that wait on it**, and a third that was
swept and closed the same day. This was "the gate sweep, and then done" until
the sweep was run. **It is item 5 of "NEXT, IN ORDER"**: the bug fixes come
first.

**Build first: a witness that can see under 25 m.** `findPasses` at
`minPassM = 15`, `MIN_SPAN_M` left at 25, so the witness is independent of
whatever is being swept. `findPasses` already takes the threshold as an option,
so this is a measurement, not a change. Everything below is unjudgeable without
it:
1. **The traversal gate.** Open, see above. Needs a `rebuild-model` if moved.
2. **`TANGENT_WINDOW_M`.** Reopened: 14 m is 286 m better than the shipped 10 m
   once the `gate` column is correct. Needs a `rebuild-model` if moved.
3. ~~**`STITCH_WINDOW_S`.**~~ **SWEPT AND CLOSED 2026-10-04** — the one of the
   three that did not need the new witness, because its cost shows up as
   uncorroborated metres on lines that already exist. 90 s does buy +249 m, but
   +214 m of it has no witness and the line count never moves. Its stated basis
   was overstated (the empty band is 45-60 s, not 45-90 s) and 45 is at the edge
   of a real trough. **Left at 45.** See note 26.

**All three are the same shape**: a constant whose cost side is a phantom line,
measured by a detector that cannot see lines that short.

**"Riding a segment both ways can draw only one direction"** is probably this
same defect seen from the other end, so it does not survive independently.

**The one thing never measured:** how many segments the rider rode produced ZERO
runs and so never appear in the ledger at all. `touched` is built from the
matcher's own runs. The structural argument says the missing class is
parallel-line loss rather than fork loss, but that is reasoning, not measurement.

**The only untested idea for direction** is the structural one: collapse runs on
segment alone, then take direction from the order of matched positions and split
at a retrace, which is what `findPasses` already does. That is a core rewrite
with no constant to sweep, and on the evidence above the prize it is chasing is
well under 1073 m.

#### The lesson, and it is the fourth of this shape in four days

**This measurement produced a clean, confident, wrong answer twice.** First the
bigint-as-text bug turned the street network into disconnected fragments and
reported "Viterbi recovers nothing" with no error anywhere. Then, with that
fixed, it reported "Viterbi recovers 500 m" by counting continuations of one
street and parallel corridors as wrong turns — and by applying its own
braided-corridor rule to three cases while exempting the flagship.

**Both were caught by checking the output against facts already in this
document**, and the second only by a cold review that went and measured the
geometry instead of trusting the classification. 10-01 counted the wrong thing,
10-02 graded a nine-minute blackout as a pass, 10-03 sized a guard by reasoning,
10-03 again classified by proxy instead of by geometry. **Same failure every
time: a number produced by argument, with nothing checking the case where it
should have said no.** The cure is the same every time too: go and measure the
real thing.

### What landed on 2026-10-04

**A day of four closures and no features.** Every one of them came from
measuring something this file already asserted, and every one of them found the
assertion wrong.

1. **`endpointSnapM`** (`cb1092f`) -- join segment ends that meet on the ground
   without sharing an OSM node. 89 canonical pairs meet within 1 m sharing no
   node; Palmer Point `#75376`/`#75377` are the same OSM way 4 m apart. **Built,
   swept, left off**: it cuts impossible transitions 35% and moves the map 70 m
   in 225 km. NOT a pipeline bug -- OSM genuinely holds two nodes there.
2. **Direction closed** (`288dc96`). Three explanations tested, three dead.
   Hairpins are 1 of 23, not "almost all". The tangent window trades wrong-dir
   for gate at a net 38 m. `MAX_BEARING_DELTA_DEG` is strictly worse at every
   width -- parameterised and left at 45. **[Corrected later the same day: the
   38 m was an artifact of a mislabelled `gate` column, and direction is
   REOPENED -- 14 m is 286 m better. See item 6 below.]**
3. **The tunnel item was a misread label** (`28aed51`). `find-holes` printed
   "covered segments", meaning ROOFED, and a later session read it as RIDDEN.
   The real defect is 55 m on Gold Camp Road, not 2,344 m. Fixed the label, not
   the map.
4. **The matcher's full ledger, with a reproduced control every time**: 35
   passes and 1795 m drawn nowhere, which is 0.32% of covered ground with no
   line at all plus 0.48% drawn in one of two directions ridden.

5. **The gate sweep was attempted, and the ledger it rested on was wrong**
   (`9c13174`). `traceSession` tried `gate` before the next-door share and
   fired on the existence of a 1-fix run: **9 of 12 `gate` losses, 605 m of
   784 m, were already drawn on the neighbouring segment.** The script got its
   first 20 tests; restoring the original order fails 4 of them. Backend suite
   267 → 287. The bucket is now 4 passes / 179 m, and **not one of the four has
   a majority of its pass's fixes in the rejected run.**
6. **Three "closed" things reopened by that one fix**, and one of the three
   closed again the same day. The gate: the witness cannot see under 25 m, so
   the sweep's cost side was counting its silence as proof. The tangent window:
   14 m is 286 m better, not a 38 m wash. The stitch window: its stated basis
   was overstated, but a proper sweep shows 90 s adds 249 m of which 214 m has
   no witness, with the line count unmoved, so it **stays at 45**.
   **Nothing was shipped and no constant moved.** The two still open are
   measured by an instrument that cannot see the lines they turn on.

**THE LESSON, and it is the same one five days running.** On 10-01 the dry run
counted the wrong thing. On 10-02 the ride-grading instrument passed a
nine-minute blackout. On 10-03 a guard sized by reasoning would have
reintroduced the error it was built to prevent. On 10-04 four separate numbers
in this file were wrong when re-measured, and **one of them was wrong because of
a single ambiguous word in a diagnostic's own output**.

**Every one was a number produced by argument, with nothing checking the case
where it should have said no.** And the cure was the same every time: go and
measure the real thing before building anything on top of it.

**A SECOND LESSON, about my own measurements.** Four of them produced clean,
confident, WRONG answers before being caught:
- a bigint arriving as text silently turned the street network into
  disconnected fragments, and reported "Viterbi recovers nothing"
- a classifier whose two buckets covered 16 of 23 cases printed as though they
  covered all 23
- an agreement test at +/-90 degrees stood in for a decision made at +/-45
- a grid test took three attempts to become capable of failing at all, and in
  between, a sloppy backup/restore left the bug being compared against itself

- a sweep's cost side counted a witness's silence as a denial, when the witness
  is structurally incapable of speaking about anything in the swept set, and the
  guard written against that very mistake checked the SEGMENT's length instead
  of the ground the rider covered
- a test for "would a wider stitch window help" asked for cases with more than
  one surviving fragment, after the same script had established there are none,
  so it returned 0 whatever the data said
- the flag added to separate "drawn on the next piece of the same street" from
  "drawn on the neighbour" used `> 0` and fired on 202 passes, which is the same
  one-fix threshold being fixed in the same commit, reintroduced one function
  later by the person fixing it

**What caught them**: facts already written in this file, a cold review that
went and measured geometry instead of trusting a classification, mutation
testing, and twice a number that was simply too big to be the thing claimed.
**What did not catch them**: reading the code and thinking carefully.

**AND THE SHAPE OF THE ERROR IS ALWAYS THE SAME.** Six of the nine are one
pattern: **a check that cannot fail, reported as a check that passed.** A
tautological filter, a guard aimed one level off its target, a threshold of one,
an agreement test standing in for a decision test. That is the same class four
independent reviews rejected the drift anchor for. It is the house defect of this
project, and a measurement is not finished until someone has asked what input
would make it say no.

### What is next after the matcher

**Superseded as a queue by "NEXT, IN ORDER" at the top of this file**, which
sets the order. This section keeps the detail behind each item.

What remains is small, and splits into three honest groups.

**Real latent bugs, all concrete:**
- **A 9 m barometric outlier survives spike rejection** (session 84,
  19:35:04Z). `rejectElevationSpikes` charges deviation against the shorter
  horizontal leg at a 100% grade limit, and at riding speed 9 m reads as an
  ordinary hill. One fix in 1367. **The fix worth doing is not the filter, it is
  persisting `readingCount` and `meanOffsetMs`** from `altitudeAtFix`, so the
  next one is diagnosable after the ride instead of needing eyes on the status
  line during it. Small migration, two doubles per sample.
- **A buffered fix from an ended session is attributed to the next one.**
  Session 83's last fix landed in session 84, 21 s before session 84 began.
- ~~**`SessionVerdict.id` is typed `number` and arrives as a string.**~~
  **FIXED 2026-10-04** (paid-for #30), with `bad_share` alongside it. The
  wider class -- nine more fields, joined to each other -- is an open decision,
  see Open items.

**Test and doc debt:**
- **The linker's own measuring tools have no tests**, flagged by the third cold
  review and still true.
- **`context/architecture.html` is over a month stale.**

**Feature ideas, none of them measured, and today says measure first:**
weight buckets by source and accuracy; two directions on one path; a named path
beside a road still drawing its own line.

**And one number nobody has measured**, which the cold review named as the single
most valuable thing to add: **how many segments the rider rode produced ZERO
runs**, and so never appear in any ledger on this page. `touched` is built from
the matcher's own runs, so the ledgers cannot see that class at all. The
structural argument says it is parallel-line loss rather than fork loss, but
that is reasoning, and reasoning has lost five times this week.

### What landed on 2026-10-03

The hardware corrected the code, and then a ride confirmed the whole thing.

1. **`957c8fb`** — `MAX_EVENT_AGE_MS` 5 s → 1 hour and `RING_CAPACITY` 1024 →
   4096, both sized to the Pixel's measured 3000-event FIFO instead of to a
   guess. The 5 s value had been set the previous day answering a cold review,
   and it would have collapsed every FIFO flush onto one instant. See "The
   barometer: shipped, installed, verified" for the full reasoning.
2. **The release APK is built and on the phone** (`lastUpdateTime 08:38:01`).
   `assembleRelease` signs with the debug keystore out of the box here, so no
   keystore setup is needed.
3. **Wireless debugging was ruled out on this network, with measurements**, after
   it was tried properly: different subnets behind carrier-grade NAT, phone
   unreachable by ICMP and TCP, `adb mdns services` empty with the pairing dialog
   open. USB is the route. Written into the barometer section so nobody spends
   another hour on it.
4. **The test ride happened, and it passed.** Session 84: verdict `alive`, 1366
   of 1367 fixes barometric, across two deliberate screen locks and a stretch
   with the app backgrounded for video. **This closes the only item in the
   project that could not be checked from this machine.** See "The ride that
   proved it".

**The lesson, and it is the third of this shape in three days.** On 10-01 the
rebuild dry run counted buckets but not lines, so a change's only visible effect
was found by querying the live API afterwards. On 10-02 the instrument that
grades the test ride passed a nine-minute blackout, with a test defending it. On
10-03 a guard sized by reasoning rather than by measurement would have
reintroduced the exact error the feature exists to prevent.

Every one of them is the same failure: **a number chosen by argument instead of
by measurement, with nothing checking the case where it should have said no.**
The cure each time was cheap and the same -- go and read what the real thing
actually does. Thirty seconds of `adb shell dumpsys sensorservice` was worth more
than a day of careful reasoning about batching.

### What landed on 2026-10-02

One thing shipped, and it is the first change in this project that **cannot be
verified from this machine** -- see "The barometer, shipped 2026-10-02" above.

1. **`mobile/modules/ride-barometer`** (`4f0038d`), a local Expo module that
   holds the pressure sensor against the process instead of the activity. The
   backend deployed (`builtAt 2026-10-03T00:33:14.010Z`) because the commit
   touched `backend/`, and the live API was re-queried afterwards: **745
   segments / 951 lines, unchanged.** Nothing in this work touches the matcher
   or the model, and that was confirmed rather than assumed.
2. **`mobile/` has a test lane for the first time** (54 tests, `tsx` +
   `node:test`, matching `backend/`), a mutation harness
   (`npm run mutate:barometer`), and a pre-commit gate (`902e5c8`). The decision
   logic was deliberately pushed into two import-free modules so that any of it
   could be tested at all without a phone.
3. **`npm run verify-barometer`** -- the instrument that grades the test ride,
   with the whole archive's pre-change baseline as its control.

**The lesson that cost the most, and it is the same shape as 2026-10-01's.**
That day the dry run reported buckets but not lines, so the speed limit's only
visible effect was found by querying the live API afterwards. This time the
instrument that will grade the test ride reported `alive` for a barometer
blackout of any length that happened to contain one GPS fix -- and a test I had
written was defending that behaviour. Both are the same failure: **the
measurement was not checked against a case where it should have said no.** A
cold review found the second one by constructing that case. Build the failing
case first, and make sure the instrument fails on it, before trusting a pass.

### What landed on 2026-10-01

Three things shipped, each verified by `builtAt` and a live query, never by
deploy status:

1. **The derived heading** (`builtAt 01:32:09.613Z`, then a rebuild). The cause
   of out-and-backs drawing one direction. Lost passes **63 → 35**, discards
   **18.4% → 12.8%**. Cost enumerated first: **2 lines and 63 m** of real
   ground against **13 phantom lines and 594 m** of paint never earned.
2. **A speed limit on the data** (`builtAt 01:53:50.539Z`, then a rebuild).
   `MAX_PLAUSIBLE_MPS = 20`, drops 16 of 29,597 fixes. The device had been
   reporting 352 km/h.
3. **`npm run verify-rebuild`** — the rebuild dry run, which does the real
   rebuild in a rolled-back transaction. `rebuild-model` cannot be undone, and
   `--dry-run` only lists which rides qualify.

**Two measured rejections**, both worth not repeating: the cross-track position
filter (works alone, **redundant** once the derived heading lands — 23 → 23 on
top of it) and folding paths into named trails.

**The lesson that cost the most to learn.** My rebuild dry run reported buckets
and heights but not line counts, so the speed limit's only visible effect —
lines 956 → 951 — was found by querying the live API **after** the irreversible
step. A bucket total cannot see a line disappear: a line losing its last bucket
and a line losing one of twelve are the same number in a sum. Fixed in
`547fa6c`. If you add a measure to that script, ask what it would miss.

### What landed on 2026-09-30

Four things shipped to production, in order, each verified before the next:

1. **The tunnel flag.** 73 of 66,684 segments carry `is_tunnel`. Of 173 interior
   bucket gaps, exactly **1** is under a structure. 67 covered segments draw
   nothing at all and never will. The load was proved a pure column fill by an
   md5 over every other column, identical across it.
2. **The coverage clamp.** A line now reaches a join the rider provably crossed.
   Unpainted line ends **6,885 → 4,403 m**; ends over 3 m, 445 → 122. The
   rebuild left the elevation model **byte-identical**: 6,098 buckets, 0 moved.
3. **A correction.** Interior bucket gaps do **not** render as blanks — the
   renderer spans them. An earlier note said they did; it was inferred, never
   checked, and contradicted a correct note in this same file.
4. **The out-and-back cause**, traced to the device heading (above).

Two measured rejections, both worth not repeating: folding paths into named
trails, and every tangent window from 0 to 20 m.

- **Two directions on one path** (deferred). Roads get two ±4 m offset lines,
  as intended. Unresolved for genuine single paths, and coupled to putting
  lines exactly *on* a trail: removing the offset makes both directions overlap.
- ~~**Keep the barometer alive with the screen off.**~~ **DONE and VERIFIED
  2026-10-03.** Session 84 scored `alive` with 1366 of 1367 fixes barometric
  across two deliberate screen locks. The third route below is
  the one that shipped, as predicted: a native module holding the
  `SensorEventListener` against the process. See "The barometer: shipped,
  installed, verified" for what was built, the two defects a cold review
  caught in it, the Pixel's measured sensor limits, and the ride that closed it.
  The original note is kept below because its reasoning is why the third route
  was chosen.
  The measured 2× slope-error
  penalty applies to every screen-off ride, silently. Three routes, cheapest
  first: `expo-keep-awake` while tracking, so the activity never backgrounds
  (two lines, works today, costs battery and leaves the screen exposed);
  patching out `OnActivityEntersBackground` (minimal, unsupported, and the
  pressure sensor is typically non-wake so delivery may stop when the CPU
  suspends anyway); or a native module holding the `SensorEventListener`
  against the foreground service rather than the activity, as expo-location
  does for GPS. Only the last makes screen-off rides as good as screen-on.
  Session 64 makes this **less urgent than it looked** — the sensor comes back
  by itself on wake, so this is a quality loss proportional to screen-off time,
  not a ride that silently records on the wrong sensor throughout. It still
  bites hardest on exactly the rides that matter most: a long trail descent
  with the phone pocketed.
  **Route one shipped 2026-08-30**: `expo-keep-awake` is held for the length of
  a ride, keyed on `isTracking` like the barometer subscription. It defeats the
  *idle timeout* only — pressing the power button still backgrounds the
  activity and still costs the sensor until the next wake. So a mounted phone
  is now covered and a pocketed one is not. The native-module route is what
  closes the remainder, and nothing cheaper will.
  **The native module shipped 2026-10-02 and was verified 2026-10-03** — see
  "The barometer: shipped, installed, verified" for what it does, the two
  defects a cold review caught in it, what not to attempt, and the ride that
  closed it. Nothing on this item is outstanding.
- **One barometric reading in session 84 is 9 m low, and spike rejection lets
  it through.** At 19:35:04Z, on a steady climb: 2070.58 m, then −9.14 m over a
  25 s gap, then +9.28 m over the next 11 s, then smooth again.
  `rejectElevationSpikes` (`elevationSmoothing.ts:174`) charges the deviation
  against the **shorter horizontal leg** at a 100% grade limit, and at riding
  speed an 11 s leg is tens of metres, so 9 m reads as an ordinary hill and the
  fix reaches a bucket. One fix in 1367, inside the minute 51-52 throttle.
  **The shape fits one mechanism, and it is the one the per-fix window exists to
  prevent**: the rider was climbing, so 25 s earlier they were about 9 m lower,
  and a window filled from the START of a FIFO flush rather than its end reads
  the height from 25 s back.
  **It is NOT mass timestamp repair.** That would produce many such fixes and
  repeated heights; `baro-rpt` is 0.0% and 1366 of 1367 heights are distinct,
  and the verdict would have read `degraded` rather than `alive`.
  **UNVERIFIED, and this is what would settle it.** `altitudeAtFix` already
  computes `readingCount` and `meanOffsetMs` (`barometerWindow.ts:34-42`) and the
  native module counts repaired timestamps, but `session_samples` has a column
  for none of the three, so all are discarded at upload. Two doubles per sample
  makes this answerable after any ride instead of needing eyes on the status
  line during one.
- **A buffered fix from an ended session is attributed to the next one.**
  Session 83, a 13-second false start, ran 18:42:55–18:43:13. Session 84's
  `started_at` is 18:43:35 yet its first sample is timestamped 18:43:14, one
  metre from session 83's last fix. Harmless here, one GPS fix at the right
  place, but in principle a fix from minutes earlier and somewhere else lands in
  a new ride the same way.
  Separately and **by design**: the two sessions report 1895.60 m and 1883.58 m
  at the same spot 20 s apart, because each anchors its barometric series to its
  own first GPS altitude. The per-ride DEM anchor removes that level difference,
  which is the whole reason only differences are ever used.
- ~~**Reverse the roughness quarantine.**~~ Replaced 2026-08-30, and **not** by
  reversing it — that would have been wrong. Sessions 45, 46 and 50 really do
  contain impossible data (45: `1971.0 → 1984.1 → 1962.9` across 4.4 m of
  ground). But the test was incoherent: measured by the share of steps implying
  a gradient past 100%, it excluded session 46 (3.8%) and 50 (3.2%) while
  keeping session 54 at **6.6%**, twice as bad. And its stated premise —
  detecting GPS-altitude rides — is false, because GPS quantises and holds its
  value and so reads *smoother* than a barometer (GPS session 56: 0.259 m;
  barometer session 62: 0.564 m). The old bands sorted rides by terrain, not by
  sensor.
  Now `rejectElevationSpikes()` drops individual fixes that cannot be reconciled
  with the fixes either side — compared against the straight line *between*
  neighbours, since comparing to the previous fix alone blames both ends of a
  step and cannot say which moved. It runs before the EMA, because smoothing an
  impossible reading smears it across its neighbours instead of deleting it.
  The session-level guard survives as `MAX_IMPLAUSIBLE_STEP_SHARE = 0.15`,
  catching a ride that *is* spikes rather than one with spikes in it: session 45
  sits at 20.7% with a median implied gradient of 41.5%, the next worst is 6.6%.
  Result: 23 → 26 sessions, 117 impossible fixes dropped (**91 of them from
  session 54**, which the old test never touched), model 2,884 → 2,895 buckets
  across 409 segments, 0 implausible. The volume gain is small; the point was
  correctness.
- ~~**Barometer oversampling.**~~ Done 2026-08-30. `setUpdateInterval` went
  1000 ms → 200 ms, and `recordBarometerAltitude()` now sums into an
  accumulator that `elevationFor()` drains as a mean instead of overwriting a
  single variable. A 1–4 s fix interval collects 5–20 readings, so noise falls
  by roughly √n — 2.2× at the floor, 4.5× at the ceiling. Two details worth
  keeping: the last mean is retained so a *batch* of locations in one task
  invocation all read the same elevation rather than the first draining the
  accumulator and the rest falling back to GPS; and the mean is centred on the
  middle of the window, so elevation lags position by half a fix interval —
  harmless, because `TARGET_SPACING_M` holds that gap near-constant in distance
  and a constant shift along a segment cancels out of a slope.
- **Weight by source/accuracy** — a barometer reading and a GPS altitude count
  equally. Note `altitude_accuracy_m` is now recorded and is a finer signal than
  the binary source. Design risk: down-weighting GPS makes the smoothed trace
  *coast* through a screen-off stretch, recording a near-flat climb — a
  different wrong answer. Treating a GPS fix like a bracketing fix (position
  counts, height ignored) reuses an existing precedent and is more honest.
- ~~**Within-ride barometric drift.**~~ **Closed 2026-09-23 by removing the
  feature**, not by fixing it. Three rounds, five adversarial reviews, all
  rejected for the same defect class; it reached two rides in thirty-seven. Read
  "What the drift anchor taught us" before reopening this — the obvious
  approaches are the ones already tried, the settled design for a fourth attempt
  is recorded there, and fitting the drift term against the DEM specifically is
  dead for a reason that is not fixable.
- ~~**Use the out-and-back revisits too.**~~ Moot: it was the next lever for the
  sliding anchor, and there is no anchor to feed. Its hard half **did** get
  solved on the way and is worth keeping: `smoothElevations` was a causal EMA
  whose lag pointed backwards along the direction of travel, so an out-and-back
  pair was displaced in opposite directions along the ground — error
  `2 × lag × grade`, about 1.2 m on a 6% street, not cancelling even at
  identical speeds and signed by gradient rather than random. The zero-phase
  smoother shipped 2026-09-24 removes it. If opposite-direction comparisons are
  ever wanted for something else, the remaining work is only realigning the
  bucket grid (forward `d` against backward `lengthM - d`).
- **`context/architecture.html` is a month stale.** Last touched `61e48fa` on
  2026-08-28, so it predates the zero-phase smoother, the removal of the sliding
  anchor, Stage 1 connectivity and the sidewalk fold — four of the five things
  that changed how a ride becomes a line. 3,138 lines. A targeted correction
  pass beats a rewrite: fix what is now false, leave the rest.
- **The linker's own measuring tools have no tests.** The third cold review
  predicted where the next gap would be and it was right twice, so this is
  written down rather than discovered: `backend/src/scripts/evalLinkerFold.ts`
  and `.githooks/pre-commit` are both untested. Neither can put wrong data on
  the map — the eval only reads and the hook only refuses commits — so a bug
  there gives wrong *numbers* or a gate that silently stops gating. Lower stakes
  than anything above it, and the honest next place to look. The hole finder was
  the third such tool and it did get tests when it was promoted out of
  `tmp-find-holes.mjs` on 2026-09-29: the gap rule is
  `backend/src/services/interiorHoles.ts` (12 tests) and the grouping is
  `holesByLine` in `backend/src/scripts/findHoles.ts` (12 tests). Its first run
  reproduced the recorded 173 holes / 140 lines / 966 lines exactly, which is
  what made the old SQL window function safe to retire.
- **A *named* path running beside a road still draws its own line.** That is
  deliberate — it is what keeps Shooks Run and the Greenway intact — but it
  means a named sidepath would double up on its street. None do so far.
- **`segment_dem_elevations` is populated lazily** by `/end`, one bounded burst
  of API calls per ride against OpenTopoData's public instance (~1000 calls/day,
  a ride costs ~4). Only OSM centreline coordinates are sent, never ride traces.
  If it ever needs to scale, download the 3DEP tile and sample locally.
- ~~**Singletrack discards ~33% of runs.**~~ Largely fixed 2026-08-30 by the
  chord→tangent change: trail discard 31.6% → 27.2% measured across the archive,
  and on recent rides 5–6 discards against 44–46 merged runs, all 1–2 fixes
  spanning 0–7 m. What remains is OSM coverage, not matching — ~31% of session
  43's fixes were more than 25 m from any mapped way.
- ~~**NEXT: fold the 2,643 sidewalks the linker missed.**~~ Done 2026-09-27,
  applied and deployed 2026-09-29 — see "The sidewalk fold". The count was wrong
  and so was the framing; what shipped folds 744 paths on a frontage test and
  closes the Hancock hole.
- **140 of 966 drawn lines have a bucket gap in the middle** (14.5%, 173 gaps,
  30–90 m each), and **it is a resolution loss, not an unpainted stretch.**
  Measured by `npm run find-holes`, caused out by `npm run diagnose-holes`.
  **CORRECTION, 2026-09-30: an earlier version of this note said these render
  as unpainted stretches between two coloured ones. That was wrong, it was
  never checked, and it contradicted the stitching note below, which had it
  right all along.** `gradientBuilder.ts` builds one span per *pair of
  consecutive buckets* and the app paints every span, so a gap between two
  buckets becomes one wide painted piece. Verified live on North Weber `#8100`
  backward, whose 45→105 m gap is the stop at fraction 0.3101 running to
  0.7260: 41.6% of the line, painted, one colour. What a gap costs is
  resolution — 60 m carrying one averaged slope instead of four — plus
  `slopeAt`'s ±2-bucket window silently spanning a longer baseline than the
  60 m its comment claims.
  **Causes, from replaying all 42 usable rides through the real matcher, gate
  and bucketiser** (the replay reproduces the stored 173/140 exactly, which is
  the control): **170 of 173 were crossed by two consecutive fixes of one run**,
  median 4 s apart over 23 m of ground, p90 34 m, max 86 m. **0 were dropped
  fixes and 0 were fixes matched to another segment.** 3 are spanned by no run.
  So nothing is being thrown away: fix spacing at the wide end simply exceeds
  the 15 m grid. Note 18's `MIN_COVERAGE` is **not** implicated and neither is
  stitching.
- ~~**6,885 m of drawn segment is unpainted at the ENDS of lines, and
  3,951 m of that is in the middle of a block.**~~ Fixed 2026-09-30 by the
  coverage clamp, 6,885 → 4,403 m; the rest is deliberate. This is the gap a
  rider sees, and Julian's screenshot of South Weber Street on 2026-09-30 is
  what forced it to be measured properly.
  **Why it looks mid-block.** The map is not one line per street. It is one
  line per segment per direction, each clipped to its own `segment_coverage`,
  so every blank is *between* two lines rather than inside one. And
  `split_ways.mjs` cuts any chunk over `MAX_SEGMENT_M` into equal pieces, so
  those boundaries land wherever 150 m happens to fall. **Every piece of a
  sliced chunk carries the chunk's two end nodes**, so node ids say nothing
  about where a piece ends — classifying these by node called every cut a
  junction and got the answer wrong the first time. Piece `i` of `n` has an
  artificial start whenever `i > 0` and an artificial end whenever `i < n-1`;
  that is exact.
  **The split, 604 blank line ends over 0.5 m:**
  **249 ends / 3,951 m at an artificial cut with no junction** (median 5.9 m;
  190 over 3 m, 137 over 5 m, 64 over 10 m, **48 over 20 m**), and 355 ends /
  2,934 m at a real OSM node (median 5.1 m; 28 over 20 m).
  **Two mechanisms, not one.** The small ones (median ~5 m, at every boundary
  of either kind) are the matcher's `SWITCH_MARGIN_M` hysteresis holding a run
  on its old segment for a fix or two past the boundary: the new run's
  bracketing fix is then already *inside* the new segment, so
  `Math.max(0, minDistance)` starts coverage there instead of at 0. Seen end to
  end on South Weber, where every one of eight consecutive boundaries loses
  1–8 m. The large ones are mostly singletrack pieces only partly covered —
  Palmer Point 110 m of 138 m, Gold Camp `#18801` 108.7 m of 134 m, Ladders,
  Ridge Trail, Sinuosa, Culebras.
  **Fixed 2026-09-30 by the coverage clamp.** `passageFor` +
  `clampCoverageToPassage` in `elevationAggregator.ts`: if the fix immediately
  before a run was on a segment that touches this one at the end the rider
  entered through, and the two fixes are within `ANCHOR_MAX_GAP_S`, coverage
  extends to that end. Same for the exit. Measured read-only by
  `npm run eval:coverage` before applying: **6,893 m → 4,403 m, closing 2,490 m
  (36.1%)**, and by count of line ends —

  | over | >1 m | >3 m | >5 m | >10 m | >20 m |
  |---|---|---|---|---|---|
  | before | 568 | 445 | 320 | 133 | 76 |
  | after | 137 | 122 | 110 | 91 | 72 |

  442 lines grow, none shrinks. The control is that the replay reproduces the
  stored 6,098 buckets / 749 segments / 966 lines **exactly**, so nothing about
  which fixes match which segments moved and the whole difference is the clamp.
  The `>20 m` column barely moves (76 → 72) because those are lines the rider
  genuinely only part-covered, which is honest and stays.
  **Three design points worth keeping.** The gate still judges the raw span, so
  the clamp can widen a drawn line but can never turn a rejected run into a
  drawn one. `reachByKey` also keeps the raw extent, because it answers "was
  this rejected run a fragment of a real traversal", which is a question about
  where the fixes were. And `buildEndAdjacency` gives a **middle cap slice no
  node-shared neighbours at all** — its node ids are the run's ends, up to
  150 m away, so recording a cross street against them would paint a line to a
  join the rider never crossed, from the wrong end of the slice.
  Biggest single growth is Stratton Springs `#6439` forward, +36.7 m: the next
  fix after the run was on a connected segment past the far end, so ≥36.7 m in
  ≤15 s, which is ≥8.8 km/h. Defensible, and the largest claim the rule makes.
  **Applied and deployed 2026-09-30** (`builtAt` 01:26:51.543Z → 02:12:41.700Z),
  then `rebuild-model`. The rebuild matched the prediction to the metre:
  **6,893 m → 4,403 m, 469 lines grew, 0 shrank** (the eval said 442 because it
  counted growth over 0.5 m; the diff counts over 0.01 m). **The elevation model
  is byte-identical across the rebuild: 6,098 buckets, 0 new, 0 gone, 0 moved,
  max change 0.0000 m** — so only the extent changed, which is the whole claim.
  Snapshot and the 469-row before/after CSV were written to the scratchpad, so
  they are gone; re-derive with `npm run eval:coverage` if it is ever
  questioned. Verified on the live map on the street from Julian's screenshot:
  every South Weber piece now draws 100% in both directions, `#10246` forward
  from 50 m of 75 m to 75.1 m, and walking the whole street leaves **one** blank
  — `#1844`, which has no data at all and should be blank.
- ~~**The tunnel flag is not imported.**~~ Done, applied and verified
  2026-09-29. OSM tags tunnels `tunnel=yes` and `segments`
  did not carry it, so the map could not tell a tunnel from a lost run. Gold Camp
  Road was the known case — Julian identified the unpainted stretch at
  38.79434/−104.89812 as the old railroad tunnels, and the flag lands on OSM way
  `99568977`, whose first vertex is 38.79411/−104.89826, about 30 m away.
  What shipped:
  `osm-pipeline/scripts/lib/tags.mjs` holds `classify` (moved out of
  `split_ways.mjs`, which had no tests) and the new `isTunnel`, which reads
  `tunnel` set to anything but `no`/`false`, plus `covered=yes`. `layer=-1` is
  deliberately **not** read: 283 ways in the extract carry a layer tag and
  almost all are the lower road at a grade separation, open sky either side.
  73 of 66,684 segments are flagged (34 footway, 23 cycleway, 16 road, 2,344 m).
  **The load is a pure column fill, and that was proved twice — before and
  after.** Before: the new split produces 66,684 features against the
  database's 66,684 rows with **zero keys added or removed**, and among shared
  keys `kind`, `is_sidewalk`, `street_name`, `length_m` and `bearing_deg` all
  moved zero rows. After: an md5 over every column `load` overwrites except
  `is_tunnel`, plus the ones it must not touch, is **identical across the load**
  — `6714697467229ce5c76451396087e89c`, 66,684 rows, 46,271 canonical / 20,413
  folded, 6,098 buckets / 749 segments / 966 coverage rows / 2,228 matches, all
  unchanged. The only difference in the whole table was `flagged: 0 → 73`. The
  upsert never touches `canonical_segment_id`, so the 744 folds survived.
  **Run order, all three authorised individually:**
  `npm run migrate -- src/db/migrations/002_segment_is_tunnel.sql --apply`,
  then `npm run prune` (dry, reported **0 orphans / 0 with buckets / 0
  canonical**, which is the key-by-key proof against the live table), then
  `npm run load`. `link` was not re-run and did not need to be: nothing was
  added or removed, so no fold decision changed. `rebuild-model` was not run
  either — no column the model reads moved.
  A checksum like that is the cheap way to make a 66k-row upsert auditable.
  `backend/tmp-segment-digest.mjs` is the script; it is throwaway by the
  `tmp-*.mjs` rule, but the query is worth rewriting the next time a bulk
  upsert claims to be a no-op.
- ~~**67 of the 69 canonical covered segments draw nothing at all.**~~
  **DROPPED 2026-10-04. The item was a misreading of `find-holes`'s own output,
  and the real defect is 55 m, not 2,344 m.**
  **The root cause is one ambiguous word.** That census line read "covered
  segments", where **covered meant ROOFED, not RIDDEN**. A later session read it
  as "segments with ride coverage that draw nothing", and wrote this item
  claiming 2.3 km of road was missing from the map. Every number in the census
  was correct; only the label was ambiguous. It now reads "segments UNDER A
  STRUCTURE (roofed, not ridden) ... drawing nothing at all (expected: no fix
  under a roof)", and the comment above it carries this whole story.
  **Measured 2026-10-04.** 73 tunnel segments / 2,344 m exist, 69 canonical, 2
  with elevation data, 67 without (2,165 m). Of those 67, **exactly one has
  drawn neighbours at BOTH ends** — Gold Camp Road `#49704`, 55 m — and that is
  the only arrangement in which a rider sees paint, break, paint. The other 66
  (2,110 m) have no drawn neighbour at all, so they render like any other street
  nobody has ridden: invisible, not misleading. Also measured: **0** canonical
  segments have coverage rows but no buckets, so nothing is being excluded from
  `/segments` for that reason either.
  **The proposed fix was also at odds with the route it would change.**
  `/segments` deliberately returns only segments that have buckets, because the
  network spans a whole city and dataless rows would be "tens of thousands of
  unusable rows per viewport" (its own comment). Painting tunnels means
  returning dataless segments, which is a design change, for 55 m.
  **And the half of this that was genuinely worth having already exists.**
  `findHoles.ts` splits holes into "under a structure (physics, leave alone)"
  and "everything else (defects to explain)", so `is_tunnel` is already doing
  the job it was imported for. Nothing on the request path needs it.
  **LEFT, only if someone wants it:** 55 m of Gold Camp Road.
- ~~**`SessionVerdict.id` is typed `number` and arrives as a string.**~~
  **FIXED 2026-10-04**, as paid-for #30, along with a second field the same
  interface was lying about (`bad_share`), found by measuring every field at
  runtime rather than reading the interface. **Not by either route this entry
  proposed**: a global pg parser would change every query's runtime types and
  the `/segments` wire format at once (see the next item for why that is a
  contract change), and a SQL `::int` cast cannot be tested without a
  database. Converting at the TypeScript boundary can be, against pg's own
  parser output.
- **Nine more database numbers are typed `number` and arrive as text.**
  Measured at runtime 2026-10-04, and the first count of six was wrong -- a cold
  review found the join partners. In `types/index.ts`: `Segment.id`,
  `osmWayId`, `startNodeId`, `endNodeId`; `SessionSample.id`, `sessionId`;
  `MatchedRun.segmentId`; `ElevationBucket.segmentId`;
  `SegmentCoverage.segmentId`. On the phone, `mobile/src/services/api.ts:45`
  types the session id `number` and receives "84". `/segments` sends segment
  `id` as numeric text.
  **Nothing gives a wrong answer from them today.** There is no ordering
  comparison on any id in the backend (text ids sort as words, "10" < "9"),
  every comparison is between ids that all came from pg, and the phone uses
  segment ids only as Map keys. The phone's session id is used in URLs AND
  persisted to device storage (`useTrackingSession.ts:399`, `adoptSession` ->
  `setActiveSession`, and copied into the unsaved-ride record), but it is never
  compared by value anywhere in `mobile/src`, only null-checked. (A cold review
  reported "only used in URLs"; the persistence was found checking that claim.)
  **What makes them dangerous is the tests**: every matcher test builds
  segments with NUMERIC ids, so production runs on a type the tests never
  exercise.
  **READ THIS BEFORE FIXING ANY OF THEM: they are joined, so they move
  together or not at all.** `routes/segments.ts` builds `bucketsBySegment`
  keyed by `ElevationBucket.segmentId` and `coverageBySegment` keyed by
  `SegmentCoverage.segmentId`, then looks both up with `Segment.id`. All three
  are text today, so it works. **Convert `Segment.id` alone and every lookup
  misses: every street ships with an empty profile, the map draws no gradient
  anywhere, and nothing throws.** The same holds for `MatchedRun.segmentId`
  against `Segment.id` throughout the matcher.
  **And it is a contract change with the phone, in two places.**
  `MapScreen.tsx:113-114` merges segments across fetches by `id`, so across a
  deploy a segment fetched as "123" and again as 123 would be drawn twice. And a
  session id persisted as "84" before the change survives it as text: harmless
  while nothing compares it by value, and a trap for the first thing that does.
  **Options:** (a) convert all nine in their load paths and the route, and ship
  backend and app together; (b) a guarded global int8 parser in `db/pool.ts` --
  one line, covers every query including ones nobody remembers, same wire
  change; (c) type them honestly as `string` and convert nowhere, which keeps
  the wire format and makes the compiler find every mixed comparison, but
  leaves the numeric-id tests exercising the wrong type until they are
  rewritten. **Julian's call.**
- **Riding a segment both ways can draw only one direction.** Measured
  2026-09-02 by projecting fixes along the segment over time (no bearings): of 8
  genuine out-and-back visits, 3 segments lost a direction reproducibly across
  both rides, while Ridgeway Trail handled its out-and-backs correctly. One case
  is a genuine duplicate pair — unnamed `6432` beside named Chamberlain `10433`,
  each drawing the opposite direction, so the two passes split across two ways.
  **CORRECTION 2026-09-30: that pair is not a pair, and folding into trails does
  not fix this.** `#6432` runs alongside Chamberlain for **0.0662** of its length
  against a 0.60 gate, and widening the offset limit from 20 m to 35 m does not
  move the number — they are not parallel, they touch and diverge (Hausdorff
  67.9 m). The wider parent rule was built and measured anyway, then **dropped
  2026-10-01** along with its branch. The numbers are kept here because they are
  the whole value of that work: it folds **195 real duplicates** (unnamed
  footways at frontage 1.000 along Pikes Peak Greenway, Templeton Gap and 163
  other trails — the walking half of a shared path mapped twice), 0 folds lost,
  0 reparents, but `eval:linker` over all 42 rides moved **every** measure the
  wrong way: impossible transitions **7.1% → 7.9%**, merged 2228 → 2223,
  discards 18.4% → 18.7%, buckets 14,710 → 14,701, covered 225.10 → 224.91 km,
  **4 lines lost and none gained**. Hiding a path did not move its fixes onto
  the parent trail, it lost them.
  **Its blind spot is the reason it could come back**: 191 of the 195 folds
  (97.9%) are on paths nobody has ridden, so the replay could not see them. The
  rule was one SQL clause, `not (${eligibleSql("r")})` in place of
  `r.kind = 'road'` as the fold parent in `linkPlan.mjs`, reachable at
  `c3e919f` if it is ever wanted. Worth re-measuring once those trails have been
  ridden, not before — and the 42-ride replay is the gate it has to pass.
  **The cause is now measured.** `npm run trace-passes`
  (`traceOutAndBack.ts`) finds what the rider did from the projected fixes and
  the clock alone — `findPasses` in `services/segmentPasses.ts`, no headings, no
  candidates, no gate — then compares that against a full replay of the matcher.
  Across all 42 rides: **419 segments ridden both ways in one session, 215
  (51%) drawing both.** 411 passes are not drawn on the segment the rider made
  them on, but **344 of those (84%) are drawn next door** — 100% of their fixes
  land in a qualifying run on a neighbouring line. That is the detector being
  generous rather than the map losing the ride: `findPasses` has no bearing test
  by design, so on a braided trail it reports a pass on every line inside the
  25 m corridor whose projection sweeps.
  **The real defect is 63 passes, 3,218 m, drawn nowhere**, in two mechanisms:
  - **wrong-dir, 39 passes, 1,756 m.** The matcher drew the OTHER direction over
    the same ground at the same time. Almost all on switchback trails — Culebras
    `#97198`, Palmer Point `#50579`, Ute Valley Upper `#127906`, Ladders
    `#79705`, Penrose `#23873`, Triple Treat `#47441` — where
    `TANGENT_WINDOW_M`'s 10 m spans a hairpin and the tangent it averages points
    nowhere useful. **South Weber `#10247` backward is the exception and the
    interesting one: a straight road.**
  - **gate, 24 passes, 1,462 m.** A run existed and covered 0–18% of the
    segment, so `MIN_SPAN_M` / `MIN_COVERAGE` rejected it: span 21 m of 140 m on
    Gold Camp `#13308`, 0 m twice, 7–19 m elsewhere. The traversal was
    fragmented and the pieces were not stitched. **So `MIN_COVERAGE` IS
    implicated here**, unlike the interior holes where it was cleared.
  `no-run` (2) and `dropped` (2) are negligible — nothing is being thrown away.
  **The tangent window is NOT the lever. Swept 2026-09-30, `npm run eval:tangent`.**
  The obvious reading of "wrong-dir concentrated on switchbacks" is that
  `TANGENT_WINDOW_M`'s 10 m averages across a hairpin, so a narrower window
  would read it better. Measured through the real matcher at 0, 3, 5, 7, 10, 14
  and 20 m:

  | window | wrong-dir | gate | both drawn | merged | discard | buckets | covered km | lines |
  |---|---|---|---|---|---|---|---|---|
  | 0 m (chord) | 44 (1932 m) | **85 (6166 m)** | 253/433 | 2338 | 25.4% | 13601 | 218.96 | 998 |
  | 3 m | 38 (1763 m) | 23 (1423 m) | 213/419 | 2220 | 17.1% | 14679 | 224.56 | 961 |
  | 5 m | 38 (1684 m) | 23 (1423 m) | 214/419 | 2220 | 17.6% | 14686 | 224.59 | 963 |
  | 7 m | 38 (1677 m) | 22 (1398 m) | 214/419 | 2224 | 17.6% | 14709 | 224.83 | 965 |
  | **10 m shipped** | 39 (1756 m) | 24 (1462 m) | 215/419 | 2228 | 18.4% | 14710 | 225.10 | 966 |
  | 14 m | 36 (1662 m) | 24 (1492 m) | 221/418 | 2240 | 19.4% | 14722 | 225.77 | 971 |
  | 20 m | 41 (1848 m) | 34 (1882 m) | 223/418 | 2249 | 20.8% | 14730 | 226.42 | 972 |

  **wrong-dir is flat at 36–41 across every value from 3 m to 20 m.** The best
  arm (14 m, 36) beats the shipped one by three cases out of 39, which is noise
  at this sample size, and buys it with discards 18.4% → 19.4%. Nothing here is
  worth changing, and the direction of the effect is wrong for the hypothesis:
  *narrower* does not help.
  **The 0 m arm is a useful control and confirms the 2026-08-30 chord→tangent
  change was right**: gate errors 24 → 85, buckets 14,710 → 13,601. (Its line
  count is *higher* at 998 because chord matching scatters a ride across more
  segments, which is the fragmentation the change fixed, not coverage gained.)
  **THE CAUSE IS THE DEVICE HEADING. Confirmed 2026-09-30, `npm run eval:heading`.**
  The matcher compares `sample.headingDeg` against the tangent. The tangent half
  is cleared above; this is the other half, and it is the one.
  **Part 1, do they even disagree?** Over 29,597 fixes, the device reports a
  heading on **100%** of them. Against a heading derived from where the rider
  actually moved (`deriveHeadings`, central difference, `MIN_DERIVE_M` 6 m,
  null on 2.1% where the rider was stationary): median gap **5.9°**, p75 12.5°,
  p90 24.2°, **p99 115.2°**. **410 fixes (1.42%) are more than 90° apart** —
  that is the tail that flips a direction, and it is where the defect lives.
  **Part 2, does it matter?** Replayed through the real matcher:

  | heading | wrong-dir | gate | both drawn | merged | discard | buckets | covered km | lines |
  |---|---|---|---|---|---|---|---|---|
  | **device, shipped** | 39 (1756 m) | 24 (1462 m) | 215/419 | 2228 | 18.4% | 14710 | 225.10 | 966 |
  | derived | **23 (1073 m)** | **12 (722 m)** | 224/418 | 2208 | **12.8%** | 14676 | 224.74 | 956 |

  **The real defect falls 63 passes / 3,218 m → 35 / 1,795 m, a 44% cut**, and
  the discard rate falls 18.4% → 12.8%, which is the biggest single move any
  change has made to that number. Buckets are flat (−0.23%) and covered distance
  is flat (−0.16%).
  **The cost looked like 36 drawn lines lost against 26 gained, net −10.**
  Enumerated 2026-09-30 with `npm run eval:heading-lines`, and the net line
  count turned out to be the wrong number entirely: **the real cost is 2 lines
  and 63 m of ground**, against 13 phantom lines and 594 m of paint the rider
  never earned. See "The 36 lines, enumerated" for the full ledger, the
  threshold sweep, and why a device-heading fallback cannot recover the 63 m.
  Shipping still needs a full rebuild, since every bucket on the map was matched
  with the device heading.
- **Stitched runs can have a hole in the middle.** Rejoined fragments contribute
  only their own samples; whatever was between them matched elsewhere or
  nowhere. Endpoints and coverage are right, but interior buckets may be
  missing, which renders as one long colour span. Pulling the intervening
  samples in would mean re-running the match, so it was left alone.
- **No position smoothing. Measured 2026-10-01, `npm run diagnose-spikes`.** The
  smoother only touches elevation; nothing looks at where a fix sits relative to
  its neighbours, only at the accuracy it claims.
  **The claim is true.** Over 29,513 measurable fixes the implied ground speed
  reaches **97.9 m/s (352 km/h)**, and **180 fixes exceed 16 m/s of which 171
  pass the 30 m accuracy filter**. The device reports these confidently and the
  pipeline takes them at face value.
  **The cost is small, and it took one more step to see that.** Existing is not
  the same as mattering: a fix 12 m off its chord inside a 25 m corridor still
  matches the same street. So the measure is how many spikes **move the match** —
  nearest centreline at the reported position versus at the position the chord
  between the neighbours implies. At cross ≥ 10 m and a cross-to-chord ratio of
  0.5: **100 spikes, 25 move the match, 9 of those land on another 150 m slice
  of the SAME OSM way** (a bucket-boundary shuffle, not a wrong street).
  **16 fixes, 0.054%, land on a different way.** South Weber is two of them,
  which is the location the note originally named: fix 4908 moves East Cimarron
  `#687` → South Weber `#10247`, and fix 4961 moves `#10246` → `#687`.
  **Split the same-way cases by `osmWayId`, never by street name.** `#113884` →
  `#113890` are both "Ute Valley Regional Trail" and are different ways, so name
  matching would have called a real cross-street move a harmless shuffle.
  **`isSpike` needs both of its conditions.** A right-angle turn at speed also
  sits far off its chord; what makes a spike is covering no ground while doing
  it. At 15 m off the chord, a 40 m chord is a corner and a 5 m chord is a
  spike. Deviation alone would clip every corner on the map.
  **Built as `positionFilter` on `MatchOptions`, defaulting to `null`, then
  measured and REJECTED — `npm run eval:spikes`.** The control row reproduces
  the shipped numbers exactly (39 / 24 / 215/419 / 2228 / 18.4% / 14,710 /
  225.10 / 966), so the comparison is not against a moving baseline.

  | rule | wrong-dir | gate | both drawn | discard | buckets | covered km | lines |
  |---|---|---|---|---|---|---|---|
  | off (shipped) | 39 (1756 m) | 24 | 215/419 | 18.4% | 14,710 | 225.10 | 966 |
  | spikes 8 m / 0.3 | 31 (1444 m) | 24 | 213/418 | 18.2% | 14,594 | 224.56 | 959 |
  | spikes 12 m / 0.5 | 36 (1655 m) | 24 | 215/419 | 18.4% | 14,696 | 225.02 | 965 |
  | **derived heading** | **23 (1073 m)** | **12 (722 m)** | 224/418 | **12.8%** | 14,676 | 224.74 | 956 |
  | derived + spikes 8 / 0.3 | 23 (1096 m) | 12 | 221/417 | 12.1% | 14,578 | 224.31 | 954 |
  | derived + spikes 12 / 0.5 | 21 (1011 m) | 12 | 223/418 | 12.7% | 14,669 | 224.69 | 956 |

  **It is redundant, which is a different verdict from "too small".** On its own
  it works: 8 wrong-direction passes recovered. But the derived heading attacks
  the same counter nearly twice as hard, also halves `gate`, and is the change
  already queued. **Stacked on the derived heading the aggressive setting buys
  nothing** (23 → 23, metres UP 1,073 → 1,096) and costs 98 buckets, 0.43 km
  and three out-and-backs. The cautious setting gains 2 passes / 62 m for one
  lost out-and-back, which is inside the noise band `eval:tangent` already
  established at this sample size.
  `gate` is **unmoved at 24 under every spike arm**, so the filter is purely a
  direction effect and touches nothing the traversal gate rejects.
  **The underlying defect stays unfixed, deliberately.** 171 fixes claim over
  16 m/s and pass the accuracy filter. If it is ever worth fixing, an
  implied-speed rule is the better tool: one threshold instead of two, and it
  caught 8 of the 16 cross-street movers on its own with no geometry to tune.
  The option is kept switched off, with these numbers in its doc comment, for
  the same reason `tangentWindowM` and `disconnectPenaltyM` are kept — so the
  alternative is re-measurable through the real code path rather than
  re-implemented.
  **What DID ship for this, 2026-10-01: a speed limit on the data.**
  `rejectImpossibleSpeeds` in `positionSpikes.ts`, called from
  `sessionProcessor.ts` immediately before `rejectElevationSpikes` and for a
  reason — the height test scales a fix's deviation by the distance to its
  neighbours, so a fix claiming to be 300 m away corrupts the judgement of the
  fixes either side of it before its own height is considered.
  **`MAX_PLAUSIBLE_MPS = 20` (72 km/h), and the threshold rests on the device's
  own speedometer rather than on a kink in the data.** Doppler-derived reported
  speed over 30,342 fixes: median 11.9 km/h, p90 24.3, p99 35.0, p99.9 48.7,
  **max 62.4 (17.3 m/s), and zero fixes above 20 m/s**. On roads the median is
  15.8 and the max 52.7; on trails 11.3 and 55.0. So 20 m/s sits above
  everything the device has ever claimed, which is the property that matters:
  **the limit cannot reject real riding.**
  **There is no cliff to find**, which is why the safety argument is doing the
  work. Dropped fixes by limit: 12 m/s 91 (16 rides), 14 → 43, 16 → 25,
  18 → 20, **20 → 16 (6 rides)**, 25 → 12, 30 → 5, 40 → 1, 60 → 0. A smooth
  decay, no natural boundary. 12 m/s is only 43 km/h and would delete ordinary
  descents, so anything at or below the device's 17.3 m/s maximum is unsafe by
  construction.
  **Both directions, and that is the design.** A spike is impossible to reach
  AND impossible to leave. The good fix right after a spike is impossible to
  reach but ordinary to leave, and a backward-only test would reject it, then
  the next, until enough time had passed to make the distance plausible — on a
  1 km opening spike, about fifty discarded fixes. The backward comparison is
  against the last fix KEPT so a burst cannot drag the reference; the forward
  one is against the raw next fix. First and last fix are always kept.
  **Cost, measured by `verify-rebuild` against the live heading-fixed model:**
  16 of 29,597 fixes (0.054%) across 6 of 42 rides, worst ride 2.07%. Buckets
  6,080 → 6,069. Only **7.4%** of buckets move at all (the heading change moved
  86%), median 0.0 mm, p99 6.3 cm, max 1.08 m.
  **It also cost 6 drawn lines and gained 1, net −5 (956 → 951), and the dry run
  did not predict that.** `verifyRebuild.ts` reported buckets and heights but no
  line count, so the only visible change was found by querying the live API
  afterwards. A bucket total cannot see a line disappear: a line losing its last
  bucket and a line losing one of twelve look identical in a sum. The script now
  reports lines, segments, and which segments go blank.
  **Nothing went blank:** each of the 6 is one direction of a segment that still
  draws the other. They are `#29053/54/55 forward` South El Paso (78/78/82 m),
  `#22331 backward` and `#30951 backward` Shooks Run Trail, and `#10505 forward`
  North Weber — whose backward direction was the one gained, so that is a flip.
  **Four were lines the derived heading had just gained**, all classified
  `next-door` (the same ground the device drew on a neighbour), so the speed
  limit reverted part of that consolidation rather than removing ground.
- ~~**Coverage gaps at block ends.**~~ Largely fixed 2026-09-30 by the coverage
  clamp — the first of the two fixes this note proposed, "clamp coverage to the
  full segment when a run has bookend fixes on both sides". 6,893 m → 4,403 m,
  ends over 1 m 568 → 137. The second proposal, bridging a sub-10 m gap at draw
  time, is no longer worth doing: only 137 ends exceed 1 m now, and the ones
  that remain are mostly genuine part-coverage rather than an artifact.
  **What is left is deliberate.** 4,403 m of line end stays blank, 72 of those
  ends over 20 m, because the rider only covered part of that piece. Julian's
  call on 2026-09-30: ground that has not been ridden should stay blank. Do not
  "fix" this by painting it.
- ~~**A failed map refresh reports as a failed save, and lies about it.**~~
  Fixed 2026-09-02. `saveRide()` runs `uploadSamplesInChunks → endSession →
  discardBuffered → reloadSegments`, and `reloadSegments` is *last* — so a
  `/segments` timeout threw after the ride was uploaded, matched, merged and
  dropped from the phone, and the alert then said "The ride is safe on this
  phone" and pointed at a "Finish saving ride" button `discardBuffered()` had
  just removed. The one moment that reassurance is guaranteed to be false was
  the only moment it appeared. Seen for real on session 59.
  `reloadSegments` now has its own try/catch, so every failure that still
  reaches the save path's error handler happens *before* `discardBuffered()`
  and its message is finally true. On failure it also clears
  `loadedBbox.current`: `loadSegments` only sets that on success and
  `handleRegionDidChange` skips refetching while the viewport sits inside what
  it believes is loaded, so without clearing it the ride just saved would stay
  invisible until the rider panned somewhere new. **Tradeoff:** that path now
  shows no message at all, and the new lines appear on the next pan rather than
  immediately.
- ~~**The barometer is never re-subscribed after a process restart.**~~ Fixed
  2026-08-30. `startBarometer()` was only ever called from `start()`, so the
  reconciliation effect restored a ride after Android recycled the JS context
  but left the sensor dead for the rest of it. The subscription is now an effect
  keyed on `isTracking`, so every route into a tracking state subscribes because
  there is only one. On resume the relative baseline is re-established where the
  rider is and re-anchored to the next GPS altitude, so the series stays
  continuous across the restart rather than stepping.
- ~~**Saving a ride intermittently times out, and succeeds on retry.**~~
  **Believed fixed; not seen since.** The halving this note proposed shipped in
  `b65d118` — `UPLOAD_CHUNK` is **125** in `mobile/src/services/api.ts:89`, not
  250 — and Julian reported on 2026-09-30 that he has not hit it in a long
  while. An earlier version of this note still listed the halving as pending,
  which was wrong: it had already shipped. **Not proof.** The absence of a
  complaint is not the absence of a fault, and the instrumentation below is
  what would settle it — grep the Railway logs for `ABORTED-BY-CLIENT` on
  `/samples`. Until someone does, this is "no reports", not "fixed".
  Original measurement,
  2026-08-30 against the live API with the same 250-sample chunk the app sent
  (51.1 KB of JSON): `/health` 622 ms, `POST /sessions` 1190 ms, `/samples`
  1151 ms cold and 794–975 ms warm. The pool's `idleTimeoutMillis` of 30 s does
  mean every save opens a fresh Supabase connection, but that costs ~0.3 s, not
  the 19 s that would be needed. The failing call is `/samples` while
  `POST /sessions` — sent seconds earlier in the same save — succeeds, so the
  link is alive and the difference is payload: ~50 bytes against 51 KB. For
  51 KB to miss a 20 s budget the uplink has to be under ~20 kbit/s, which is
  an ordinary bad cellular link at a trailhead. Retrying is safe by
  construction and was verified: a verbatim re-upload took 797 ms and deduped
  on `on conflict (session_id, recorded_at) do nothing`.
  **Instrumented 2026-08-30.** `index.ts` now logs method, path, status,
  duration and content-length for every request except `/health` (excluded
  because Railway polls it and it would bury the ride traffic). Registered
  *before* `express.json()`, because a stalled upload stalls inside the body
  parser; and logging on `close` rather than `finish` so an abandoned request
  is recorded, with `writableFinished` false printing as `ABORTED-BY-CLIENT`.
  Verified locally against a deliberately slowed upload:
  `POST /sessions/999/samples 500 ABORTED-BY-CLIENT 1003ms 270177B`.
  **How to read the next occurrence:** `ABORTED-BY-CLIENT ~20000ms ~52000B`
  means the upload stalled in flight and the uplink is the problem; a clean
  `204` at the same moment the phone reported failure means the server finished
  and the reply was lost. Those need opposite fixes, which is why this had to
  come first.
  **Still to do:** halve `UPLOAD_CHUNK` 250 → 125 in
  `mobile/src/services/api.ts` — each chunk then needs half the throughput, and
  since `onChunkUploaded` drops landed samples a retry resumes instead of
  restarting. Needs an APK, so it was held. A longer timeout is not the fix; it
  only delays the same failure.
- ~~**A failed upload dumped the whole ride into the logs.**~~ Fixed
  2026-08-30, found while testing the access log. `body-parser` attaches the
  entire unparsed payload to its errors as `err.body`, and the error handler
  logged the error *object* — so one malformed upload wrote 260 KB on a single
  line, a rider's complete GPS trace, and buried everything else in the
  retention window. The handler logs the message and stack only.
- ~~**The app abandoned most of the requests it made.**~~ Fixed 2026-09-02, and
  found only because the access log existed. The server log showed **420
  `ABORTED-BY-CLIENT` against 69 completed** — 86% — every one a `/segments`
  fetch, with viewports differing in the *eighth decimal place*.
  `loadSegments` wrote `loadedBbox.current` only when a fetch **completed**, and
  `handleRegionDidChange` tested only that. So while requests were in flight the
  guard read stale state, `covers()` kept failing, and every region event during
  a camera animation started another fetch. `requestSeq` was doing its job —
  stopping a stale *response* overwriting a fresh one — but nothing stopped the
  redundant *requests*.
  Now a `pendingBbox` ref records what is already being asked for, and the guard
  checks it too. It is cleared in a `finally` so a timeout cannot block an area
  permanently, and only by the request that still owns the slot
  (`seq === requestSeq.current`) — a straggler settling late must not clear a
  newer claim, or the burst it was suppressing restarts.
- **A ride that records zero fixes is discarded silently.** `handleStop()`
  returns early on `finalSamples.length === 0`, showing no breadcrumb, no saving
  spinner and no message — indistinguishable from a normal stop. Happened once;
  cause unknown, and the logs had rotated before it could be read.

## Committed / deployed

**`origin/main` is `8a1b8e0`, and production is serving it.** Verified by
`builtAt` = `2026-09-24T01:46:26.360Z`, never by status — Railway reports the
service Online from the OLD container during a rollout.

**Everything is merged.** `main` sat at `9727a28` from 2026-09-06 until
2026-09-24, when the whole September elevation stack landed at once
(`9727a28..7708224`, nine commits): the zero-phase smoother, the eval harness,
and the removal of the sliding drift anchor. The model was rebuilt onto the new
smoother immediately after.

**Loose ends Julian owns, neither of them blocking:**
- Draft PRs #1 and #2 are still open and now contain nothing `main` lacks — #1
  already contained #2 via the `0be4344` merge, so they were never independent.
- Six merged branches still exist: four `jzavala5114/*`, plus `fix-eval-gates`
  and `strip-the-ramp`.

- `5745ac6` — record which sensor measured each sample's elevation
- `61e48fa` — least-squares, gap/window, stitching and the trail backlog docs
- `83b57e7` — document migrations and deploys in the backend README
- `65450fd` — barometer findings, save-timeout trail, Railway wiring
- `026c4a9` — stop discarding trails the map marks as bike-legal
- `6b05b86` — compare a rider's heading against the trail, not the chord
- `9174a62` — reject impossible fixes, not whole rides
- `f028d16` — stop a failed map refresh reporting as a failed save
- `b65d118` — smaller upload chunks, and stop re-asking for the same map
- `cee0ad9` — record the connectivity finding and the matcher decision
- `48224eb` — let the matcher see that the network is connected (Stage 1)

**A push now deploys the backend** (GitHub → Railway, root directory `backend`,
watching `backend/**`). Verified by a real push moving `builtAt` and the access
log appearing. A `mobile/` or `context/` commit deliberately deploys nothing.

APK rebuilt and installed 2026-09-02 08:41, verified by `lastUpdateTime` on the
device rather than by `adb` printing Success. It carries: barometer keyed to
`isTracking`, `expo-keep-awake`, 5 Hz oversampling, the save-path fix and the
`/segments` request-storm fix. **Anything in Open items that touches `mobile/`
needs another APK cycle**; backend-only work does not.

Docs, both published as Artifacts, and **both now behind the code**:
- `context/architecture.html` — full system walkthrough. Its "Picking the right
  street" section describes the *chord* bearing test, and its switchback diagram
  illustrates a bug that has since been fixed; line ~2368's claim about what the
  matcher compares against is no longer true. It also predates spike rejection,
  oversampling and the trail import. The largest piece of documentation drift.
- `context/backlog.html` — six open questions on recording mountain trails. Its
  slope-window figures hold; its framing of GPS altitude as the weak source is
  **superseded**.

Throwaway diagnostic scripts live in `backend/tmp-*.mjs` (gitignored). Several
are worth keeping in mind rather than rewriting: `tmp-impossible.mjs` measures
unconnected run transitions, `tmp-outandback.mjs` detects out-and-back
traversals without using bearings, `tmp-carriageway.mjs` tells a divided
highway from a genuine gap, and `tmp-noise.mjs` compares elevation noise across
every session.

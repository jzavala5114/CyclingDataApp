# CyclingDataApp — project context

Working notes for picking this project back up. Covers what exists, why it's
built the way it is, and the failure modes already paid for.

Last updated 2026-10-25.

**Read the four blocks below before anything else.** They are the authoritative
queue and state. Everything after them is evidence and history: where a section
further down disagrees with these blocks, these blocks win and that section is
stale.

## NEXT, IN ORDER

**IN FLIGHT, 2026-10-25: the database backup's fixes. Start here.** Branch
`database-backup` at `2b698a9` (pushed, not merged; one commit on
`70c805b`): `backend/src/scripts/backupFormat.ts`, `backupDatabase.ts`,
`restoreDrill.ts`, `backupFormat.test.ts`, the README's "Backups",
`package.json`'s `backup` and `backup:restore-test`. Continue on that
branch (`git switch database-backup`), not a new one from `main`: the
fixes are this task's.

- **Julian's calls, 2026-10-25.** He ran the cold review (it FAILed the
  backup's judge, below) and then answered "update the session md, clear the
  context then run this" to the choice whose recommended option was **fix
  every finding but F7, then merge**: that is the plan, unless he says
  otherwise. **No second review**: each finding's own reproduction must flip
  from bad to good instead. **Merge and deploy approved** once the fixes
  pass (`backend/` changes, so Railway redeploys; the server's own code is
  unchanged; watch `/health`'s builtAt only during the rollout, then one
  `GET /segments`). **No schedule** for the backup ("Not now").
- **Where it stands.** Two good backups in `Documents/CyclingDataApp-backups`
  (16:50 and 16:55 UTC, both `restoreTest.passed`; the reviewer rebuilt the
  16:55 one with the README's commands and it matched production's manifest,
  8 tables and 4 sequences). Tools in `%LOCALAPPDATA%/CyclingDataApp/pgsql-17`.
  The review cost 239k against an estimate of 100k; the task stood at about
  420k with it, against 150k first estimated.
- **The review**: FAIL, 1 high, 5 medium, 4 low, at `2b698a9`. Verdict, with
  each reproduction's exact commands and output: `C:/Users/Julian/AppData/Local/Temp/claude/c--Users-Julian-Documents-GitHub-CyclingDataApp/e24d4bb5-018e-46b7-89ee-9dee82f392bf/scratchpad/backup-tools/critique/verdict.md`. Its harness,
  `fakeprod.sh`, builds a stand-in production on 127.0.0.1:54329 (PostgreSQL
  17.11 + PostGIS 3.6.2, TLS on, self-signed) and needs no production at all.
  Its ride-data copies were deleted at Julian's OK, so first copy
  `cyclingdataapp-2026-10-25T16-55-26Z.dump` and its `.json` from
  `Documents/CyclingDataApp-backups` into `critique/copies/`, then
  `bash fakeprod.sh init` (prints 36266), and point `DATABASE_URL` at
  `postgresql://prod@127.0.0.1:54329/appdb` for every `npm run backup`
  (each run's first line must say PostGIS 3.6.2, not Supabase's 3.3.7). Run
  F1's second reproduction last: it moves the tables.
- **The fixes**, as the verdict asks (F7 waits for the `pool.ts` TLS fix):
  - **F1, high: a backup of nothing is called PASS, and a table outside
    `public` is silently left out.** Fail when a schema the dump does not
    cover holds tables (exempt pg_catalog, information_schema, pg_toast and
    Supabase's own: auth, storage, realtime, extensions, graphql,
    graphql_public, vault, pgsodium, net, supabase_functions,
    supabase_migrations, cron, pgbouncer); fail on zero tables; fail when a
    table `src/db/schema.sql` creates is missing; fail when a table the
    previous manifest held is gone. A unit test each.
  - **F2: a ride saving mid-backup FAILs a good archive**: sequences are
    outside every snapshot. Record the values the archive holds (its
    `setval` lines, in the `--data-only` text already read); check each is
    at or above the max of its column in the snapshot; the restore test
    compares restored with archived. Unit-test the parser; correct the
    README's "exactly what was measured".
  - **F3: the restore test checks data, not schema** (a mutant dropping 19
    INDEX, FK CONSTRAINT and DEFAULT entries passes). Add a schema measure
    per table (columns with `format_type`, not null and `pg_get_expr`
    default; `pg_get_constraintdef`; `pg_get_indexdef`; triggers; policies;
    row security), recorded and compared; test `restorableList` on a list
    with INDEX, FK CONSTRAINT, DEFAULT, TRIGGER and POLICY lines.
  - **F4: a failed backup keeps a good one's name.** `.dump` only after the
    restore test passes; `.untested` before that and under
    `--no-restore-test`; `.failed`, archive and manifest together, on
    failure. The default archive is the newest that passed.
  - **F5: the measuring connection (`pool.ts`) is not encrypted**, though
    the README says so. Set `process.env.PGSSLMODE = "no-verify"` at the top
    of `main()` (node-postgres reads it; `childEnv` keeps it from the tools)
    and correct the README.
  - **F6: nothing pins pg_dump to TLS.** `libpqEnv` always returns
    `require` (drop the parameter); the existing test then pins it.
  - **F8, low: a killed restore test leaves its server up with `trust`
    auth.** Clean up on SIGINT, SIGTERM and exit; at start, stop and remove
    stale `cyclingdataapp-restore-test-*` folders; initdb with
    `-A scram-sha-256 --pwfile` and a random password; a README line.
  - **F9, low: the shell's PG* settings reach the restore test's own
    connection**, and a failure overwrote a recorded pass. Delete PG* from
    its `process.env` before importing `pool.ts`, `?sslmode=disable` on the
    throwaway URL, keep a history of results.
  - **F10, low: the README's restore commands call `pg_restore`, not on
    PATH.** Use `"$PG/pg_restore.exe"` with `PG=$LOCALAPPDATA/CyclingDataApp/pgsql-17/bin`;
    say only a manifest with `restoreTest.passed: true` is a backup;
    mention `--no-restore-test`.
  - **F7, deferred: pg_dump's `require` accepts any certificate.**
    `verify-full` with Supabase's CA, done with the `pool.ts` TLS fix
    (step 5).
- **Done when** each reproduction flips (F1's two, F2's `ride-writer.sql`,
  F3's mutant killed, F4's `probe-newest.ts`, F5's and F6's server-log lines
  showing SSL on both connections, F8's `probe-kill.sh` leaving nothing,
  F9's `PGSSLMODE=require` run passing with the history kept), the backend
  suite passes, a real `npm run backup` PASSes, the branch is merged and the
  deploy verified, and these notes say so. About 100k.

Rewritten 2026-10-21, after the lag's trace and the profile scrub. Closed
work keeps its evidence below the STATE block: "CLOSED 2026-10-16 and -17"
(the mixing artefact and option A) and "CLOSED 2026-10-10 and -11" (the old
items 1 to 4).

**Where things stand.** Press and hold on a segment is shipped: phase 1, the
server (`GET /segments/path`, 2026-10-17), and phase 2, the app (2026-10-18,
first on the phone from `d7204c3`). Julian on 2026-10-18: "pretty amazing so
far", the functionality "feels great". The lag is mostly fixed and live
(deployment `93563c1c`, `9a0058a`, builtAt 2026-10-18T18:51:27.630Z): a
press from this PC takes about 0.45s warm and 0.47s after 40s quiet, against
1.4s and 3.0s before. What is left of it is the free database going cold
(below). The profile scrub (drag the card's height profile, a dot follows on
the map) is on the phone, and Julian on 2026-10-21: "it works", with one
change, made the same day (`17ae9d0`, on the phone since 19:21): the path's
start and end are reached before the finger gets to the screen's edge (step
1). Production's server is unchanged since 2026-10-18.

**Julian's decision, 2026-10-20: no Supabase Pro yet.** Pro is $25 a month;
he will take it when the app opens to more users. Until then he is the only
user, testing, and the lag's last case is managed on the free plan (step 4).

**Next, in order:**

1. **Julian tries the scrub's new reach** (free). His verdict on the
   first install, 2026-10-21: "it works", the only change wanted that
   "you have to scroll all the way to the edge of the screen to reach the
   end or the beginning of the trail". Now (`17ae9d0`, installed 19:21
   phone clock, cold start clean) the start is read with the finger 60dp
   (9.6mm) from the screen's left and the end 60dp from its right, clear of
   Android's 29.7dp back-gesture strip; near the ends the profile's cursor
   runs ahead of the finger by up to 36dp. If 60dp feels wrong, it is one
   constant, `SCRUB_EDGE_REACH` in `mobile/src/services/profileScrub.ts`.
   Not reported either way: the readout at a large font size. Details:
   "2. **App**", "The profile scrub".
2. **Three phase-2 behaviours never tried on the phone**, free, on a ride:
   hold just behind the start of a selection (it leads in); grow a selection
   to a fork and look at the branches; hold the very end of a selection (it
   carries on).
3. **A line the map may not draw** (about 15k, read-only). On the two
   starts after the 2026-10-21 install of `54c4365`, warm and cold, the app
   logged `MapLibre Native [WARN] ... Invalid geometry in line layer`
   (`adb logcat`, tag `ReactNativeJS`) about 130ms after "Running main",
   before any press. MapLibre skips a feature it calls invalid, so some line
   may be missing from the map. Not the profile scrub: its only map change
   is one circle layer on its own source. The cold start after the
   `17ae9d0` install logged no such line in its first 4s; whether the
   screen was on, so that the map drew at all, is unknown. Whether older
   APKs did it is unknown too, since the phone's log keeps only minutes. To
   find it: start the app with the screen on and read `logcat` (once more
   whether it happens), then list the line features the map loads at start
   and find the one MapLibre rejects (a guess, unverified: a line with fewer
   than two distinct points).
4. **The lag's last case, on the free plan.** The database runs on Nano
   compute (`t3a.nano`, 0.5GB of RAM) with about 400MB in swap, so after
   about 6 minutes with no press the first press takes 0.8s on the server
   (1.2s from this PC), and the first downtown press is often 1.4 to 1.9s.
   Free fixes, each a deploy on Julian's go-ahead, measured with
   `eval:latency`, the 11-minute pause press and `npm run
   split:access-log` (all in "2. **App**", "Next, in order", step 1):
   - **Keep the database warm while Julian rides** (about 50k): the server
     repeats the last press's reads every 2 minutes, only for 30 minutes
     after the last press. Presses during a ride stay fast; the first of a
     session still pays.
   - **Keep the ride order in the server's memory** (about 50k): 266KB, the
     same for every press, read fresh on every request; refreshed when a
     ride is added. Saves 60 to 110ms a press and about a third of what each
     press pulls from the database.
   Recommended order: the first, then the second. Before measuring,
   Julian runs `railway login` in `backend/` (it opens a browser): the
   CLI's login had lapsed by 2026-10-21 ("Unauthorized"), and `npm run
   split:access-log` reads `railway logs --json`. Deploys need no CLI (a
   push to `main` touching `backend/` deploys), and `/health`'s builtAt
   verifies one.
5. **Protect the data**:
   - **Backups: built and proven 2026-10-25; its judge failed review, and
     the fixes are in flight (the block at the top).** `npm run backup` in
     `backend/` (README, "Backups"; `src/scripts/backupDatabase.ts`,
     `restoreDrill.ts`, `backupFormat.ts`) takes about a minute and only
     reads production: one read-only transaction exports a snapshot, every
     app table's rows and fingerprint (md5 of its rows' sorted md5s) are
     measured in it, and pg_dump (`--snapshot`, TLS) dumps that same
     snapshot; the archive is read back (`pg_restore --list`, every row
     counted out of it) before it is named a backup; then the restore test
     restores it into a throwaway PostgreSQL on this PC (127.0.0.1, a temp
     folder, deleted after) and compares every table's rows, fingerprint
     and sequence with the manifest. Files: `Documents/CyclingDataApp-backups`,
     never inside the repo. Two backups so far, 16:50 and 16:55 UTC, both
     PASS: 9.5MB each, 8 tables, 136,780 rows (52 sessions, 36,266 fixes);
     the two snapshots' fingerprints are identical, table by table. The
     instrument says no: a manifest claiming one row fewer and other
     contents FAILs naming both, and an archive with one byte flipped FAILs
     on its sha256 and on pg_restore's own check. Tools: EDB's PostgreSQL
     17.11 portable zip and the PostGIS 3.6.2 bundle, unpacked into
     `%LOCALAPPDATA%/CyclingDataApp/pgsql-17` (417MB; nothing installed,
     nothing running; EDB's programs are unsigned and its zip has no
     published checksum, PostGIS's md5 matched). Not yet: a schedule (it
     runs when Julian runs it), a copy off this PC, a restore into a real
     Supabase project.
   - **The backend's database connection is not encrypted** (found
     2026-10-25, about 30k to fix, a deploy on Julian's OK). `pool.ts` sets
     no `ssl` and `DATABASE_URL` has no `sslmode`, so node-postgres
     connects in the clear: from this PC with the same settings, the socket
     is a plain `Socket`, not TLS. The pooler logs in by SCRAM
     (`require_auth`: `scram-sha-256` connects, `password` and `md5` are
     refused), so the password never crosses in usable form; every query
     and row does, GPS fixes included, between Railway and Supabase.
     Unchecked: whether Railway's environment sets `PGSSLMODE` (the CLI is
     logged out). The fix is `ssl` in `pool.ts` against Supabase's root
     certificate, since its pooler's certificate is signed by Supabase's
     own CA.
   - **Supabase's security warnings: real, unused, checked 2026-10-25
     read-only; the fix waits on Julian's OK** (about 60k with its test and
     check). Supabase also emails them ("Issues as of 03 Oct 2026").
     - **What they are.** Supabase's own rules (splinter `0013` and
       `0023` from github.com/supabase/splinter, run read-only against the
       database) find 11. "RLS Disabled in Public": the app's 8 tables and
       PostGIS's `spatial_ref_sys`.
       "Sensitive Columns Exposed": `session_samples` and
       `session_segment_matches`, matched only by the column name
       `session_id` (its list means a login session; here it is a ride).
       The dashboard counted 11 issues too (recorded 2026-10-21); that they
       are the same 11 is unchecked.
     - **Real all the same.** `anon` and `authenticated` may select,
       insert, update, delete and truncate every app table and use its 4
       sequences; no table has row level security or a policy; and
       `postgres`'s default privileges grant the same on any table made
       later. So anyone holding the project's anon key could read every
       ride's fixes (`lat`, `lon`, `recorded_at`: where Julian's rides
       start and end) through the Data API, and delete everything, with no
       backup to restore. The anon key is public by design: Supabase
       expects it in apps, with row level security doing the guarding.
     - **Not used, nothing leaked.** `pg_stat_statements` (kept since
       2026-08-12, 0 evicted) holds no statement run as `anon` or
       `authenticated`; the API's role, `authenticator`, only loaded its
       schema map (33 loads); `service_role`'s 39 calls look like the
       dashboard's own (an API docs read and a Storage bucket list).
       Auth has 0 users. No Supabase key or client library is anywhere in
       the code or its git history; `backend/.env` holds only
       `DATABASE_URL` and `PORT`. There is no GraphQL endpoint (`pg_graphql`
       is not installed).
     - **Safe to fix.** Every statement on an app table (784 statements,
       454,962 calls, the live path route's 2,221 among them) runs as
       `postgres`, the tables' owner, which also bypasses row level
       security; enabling it changes nothing for the backend.
     - **The fix, recommended.** (1) A migration: enable row level security
       on the 8 tables, revoke `anon` and `authenticated`'s grants on
       them and their sequences, and change `postgres`'s default
       privileges so later tables and sequences get none. (2) A gate test
       that every table a migration creates enables row level security. (3)
       A read-only check running the two rules: PASS at no findings but
       `spatial_ref_sys`. (4) `eval:latency` and `eval:selection` live
       after it. (5) Julian turns the Data API off (Integrations, Data API,
       Overview, "Enable Data API"; per Supabase's "Hardening the Data API"
       page, no REST endpoint then answers, whatever the grants): the app
       never uses it, and it also closes `spatial_ref_sys` and the 744
       PostGIS functions the API offers `anon`. `spatial_ref_sys` stays
       listed: `supabase_admin` owns it and made its grants, so
       `postgres` can change neither. Scripts and output: the scratchpad
       of session `e24d4bb5`, `supabase-rls/`.
     - **Part (5) done 2026-10-25: the Data API is off.** Julian switched it
       off at 16:31 UTC. Verified read-only: its process (PostgREST 14.5)
       restarted at 16:31:35 and has not loaded its map of tables since
       (each schema-cache statement still at 33 loads, as before the
       switch); its new attempts read its settings and abort. It stays
       connected, so a vanished connection is not the sign to look for.
       The backend is untouched: the same four pooler connections, and
       `GET /segments` answers 200 from the database. Parts (1) to (4),
       the migration, still wait on Julian's OK.
6. **Whether the card's numbers are right** (about 60k): a check against
   something independent, which nothing does yet. The one comparison so far
   put our climb 38% below a terrain model's on 69 Ladders and Gold Camp
   Road, unexplained ("2. **App**", "Open: whether the card's numbers are
   right").
7. **Grade ride 89** (about 20k, read-only): it landed 2026-10-11 and is
   still ungraded: `npm run verify-barometer` in `backend/`; a pass is
   `alive` ("HOW TO REBUILD THE APK, AND HOW A RIDE IS GRADED"). No ride has
   landed since.
8. **The numbered items below**: the zero-run census first.

**Free plan limits to keep in mind.** Supabase pauses a free project after
about a week with no activity (restore it from the dashboard). Its monthly
egress allowance (5GB when last known; the organisation's Usage page has the
real cap): each path request pulls about 0.75 to 0.95MB from the database,
and a press with holds makes 1 to 3 requests. Pressing a lot is fine for the
database itself, which sits about 98% idle.

Item 1, the zero-run census (read-only, about 40k), can run any time, and it
also sizes the gaps the feature has to bridge. Items 2 to 5 follow.

**Re-estimate anything large before starting it**: the last large read-only
tasks ran 2 to 3 times over budget (STATE, "How work is sized"), and option A's
one cold critic took 181k on a 1,400-line diff against an 80k ask.

### 1. The zero-run census

How many segments a rider rode produce no run at all, and so appear in no
ledger. Every loss measured so far (wrong-dir, gate, both matcher levers) is
counted over segments where the matcher made a run, because `traceSession`
projects only onto the segments its runs touched. The most valuable unmeasured
number; read-only, about 40k tokens. The witness is ready: `traceSession`'s
`minPassM` at 15 (`RETRACE_M`). Two traps to design around: projecting every
fix onto every segment in a ride's bbox is the whole cost of `trace-passes`, so
filter by the 25 m corridor first; and a parallel street inside that corridor
shows a pass too, so count a pass as lost only when its fixes are drawn on no
line at all, the next-door rule. See "What is left for the matcher".

### 2. The barometer strip prints a 95-99% minute as `10`

`sourceStrip` in `verifyBarometer.ts`, seen in rides 70, 71, 79 and 88. Display
only: no verdict reads the strip. Cap the digit at 9, with a test; about 10k.
See "HOW TO REBUILD THE APK, AND HOW A RIDE IS GRADED".

### 3. `npm run eval:smoothing` exits 1

It did on `main` before the int8 change too: seen 2026-10-06 in the int8
before/after run, byte-identical output both sides. The zero-phase smoother
loses on its isolated within-ride measure, **1.461 m -> 1.579 m (+0.118 m)**,
while winning on shape error against terrain (-0.512 m) and cross-ride
disagreement (-0.052 m). Unexamined: whether that measure already failed when
the smoother shipped on 2026-09-24, with fewer rides. If it did, the smoother
shipped against a failing measure and the notes should say why; if not, more
rides moved it.

### 4. The same-way class

196 next-door passes / 11.3 km drawn mostly on another piece of the same OSM
way, almost all on switchback trails. Two explanations tried, both wrong.
Flagged in `trace-passes` output, not claimed as a defect. Open-ended: worth
starting only when a line on the map points at it.

### 5. Debt

The linker's measuring tools have no tests. `context/backlog.html` (artifact
"Trail Fidelity Backlog") is still behind the code: its framing of GPS altitude
as the weak source is superseded. The comment above `RING_CAPACITY` in
`RideBarometerModule.kt` says 4,096 readings is "about 2.7 minutes of history at
the 5Hz"; it is 13.7 minutes (4096 / 5 = 819 s). Comment only: fix it with the
next `mobile/` change, which needs an APK cycle anyway. The slope palette has
two weak spots that predate the darker reds, found by the dataviz validator on
2026-10-14 and left alone: yellow `#eab308` (0 to 3% climbs) has 1.75:1
contrast on the basemap's cream `#f8f4f0`, under the 2:1 a light end needs, and
orange `#f97316` against red `#dc2626` is ΔE 14.9 for normal vision, just under
the floor of 15. The app has no colour key for its eight colours (an app change).
Option A's review left three (2026-10-16). No gate test runs SQL: the gate
tests mock the database, so the route's pass query is guarded only by
`eval:mixing` calling the route end to end; PGlite as a devDependency would
run the route's and the save path's SQL at commit, a new dependency for Julian
to decide. The pass query returns one row per pass per bucket (17,634 through
ride 89, 2.9 a bucket), so it grows with rides rather than road: 300 rides over
one commute is about 182k rows for a 100-segment viewport (synthetic, 0.9 s on
PGlite); when the table nears 100k rows or /segments slows, fit the slopes at
merge time instead. And `processSession` has no gate test of its own: deleting
its call to `mergeRuns` fails nothing.
The read-only guard in the eval scripts, `pool.on("connect", (c) => void
c.query("set default_transaction_read_only = on"))`, works only because pg
queues a query sent while another runs: pg 8 warns that this is deprecated and
pg 9 removes it (cold review of 2026-10-17). `evalMixing.ts` and `evalPath.ts`
use it; give the guard a form that waits before any pg upgrade.
(`context/architecture.html` lags: it has the 3rd edition of 2026-10-11 and the
colour bands of 2026-10-14 but not option A, whose Parts 5 and 6 Julian
deferred on 2026-10-17, nor press and hold's `GET /segments/path`, shipped the
same day; its artifact page lags by all three.)

### Press and hold on a segment, designed 2026-10-17

Design settled with Julian on 2026-10-17. It replaces the placeholder of
2026-10-14, whose two facts still hold: each drawn piece knows its street, and
the band edges live only in `SLOPE_STOPS`.

**Phase 1, the server: built, reviewed and deployed 2026-10-17** (`5ccbc35`,
`builtAt 2026-10-18T01:40:59.257Z`). `GET /segments/path` and its core (`pathGrowth.ts`, `pathData.ts`,
`pathResponse.ts`); the map's line drawing extracted, not changed
(`drawnExtent`, `offsetTravelSlice`, `drawLine`): all 751 drawn segments hash
identical to `main`'s, and `eval:mixing` finds all 751 arriving as drawn.
`npm run eval:path` through ride 89: at 810 forks rides took, each ride left
out of its own history, the rule picks the way the ride went 85.3% of the time,
against 75.1% with no history and 67.7% for the least turn. Grown from every
drawn line, 0.5% of the ground has no data and 1.4% reads the other
direction's; the 5 m snap takes dead ends from 292 to 168 of 958 (counted
before the review's fix below, which moved 145 stops back to their own
reasons). The route end to end in-process from this PC, 20 presses: median
326 ms, p95 543 ms, 54 KB, loading only the network near drawn lines (loading
the whole 2 km box took 0.3 to 2.2 s by itself). 504 backend tests.
**One cold critic: FAIL**, 176k tokens, one blocking finding and four
should-fix, each reproduced and fixed, and each fix shown by the critic's own
reproduction: trimming the unmeasured tail of a path had overwritten its stop
with `gap` on 145 of 958 growths (54 forks lost their branches, 2 limits read
as final), and now the stop keeps its reason and says how far ahead it lies
(`aheadM`); the eval passed with the history rule deleted, and now must also
beat the rule without history; five one-line mutants survived the tests, and
none does now. No second round, on Julian's say. He approved the deploy and the turn rule's
refinement (after the table) on 2026-10-17. The deploy check passed: `builtAt`
moved and held, no ride landed in between, live `/segments` hashed identical
to before on all four viewports, and a press on Ladders 19475 answered with a
path (36 pieces, 4.95 km, stopping with limit; 2.0 s cold, then a median of 1.5 s over five warm presses, against 0.22 s for /health from this PC, so about 1.3 s of it is the server's round trips to the database, which phase 2 should hide by asking at finger-down, before the long press registers).

**What it does.** Long-press a drawn line: a selection starts under the finger
and flows ahead in that line's direction of travel while the finger stays down;
lifting it stops. A card at the top shows the selection's stats, updating live
while it grows. Tap a selected line: it and everything after it fade and a
panel under the card asks "Remove 340 ft?"; confirming trims. Hold any line
near the selection's end to connect to it and keep growing from it. A flip
button swaps the selection onto the other direction's lines of the same
streets; the close button (or Android back) clears it.

**Julian's four decisions:**

| question | decision | why |
|---|---|---|
| which way it grows | **ahead only**, in the pressed line's direction of travel | each line sits on the right-hand side of its own travel: forward at +`OFFSET_M`, and a positive turf offset is to the right. So the press names the direction. "forward"/"backward" are per OSM way, not compass directions |
| a fork | **ride history** from the incoming line, then **the same street name**, then **the least turn** (60 degrees or under), **else stop** at the fork and mark the branches to hold | his history idea first; stopping beats a blind guess. The eval below scores each rule |
| the highlight | **same colours, wider, white casing, every other line faded** to about 35% | colour is grade here; brightening a colour moves it toward its neighbouring band |
| tapping a selected line | **trim from it to the end**, after a preview and one confirm | a wrong branch is several lines long, and a hole in the middle leaves no single distance or climb |

**A refinement of the fork rule, approved by Julian on 2026-10-17.** As built, the turn rule
takes a branch with data before one without, then the least turn, both within
the 60 degrees: a drawn branch at 45 degrees beats an undrawn one straight on.
Through ride 89 that rule decides 49 of the 810 forks ridden, picks
differently from the plain least turn at 4, and is right at all 4 (34 right
against 30). He kept it because it measured better; undoing it is one line,
`byData` to `byTurn` in `pickNext`.

**The card.** Street names in order ("Ridge Trail -> Ladders"); distance in ft
below half a mile (2,640 ft), else mi to two decimals; climb and descent in ft;
average grade (net change over distance); the steepest 100 m (330 ft); a height
profile with one bar per bucket coloured by band, and each band's share of the
distance under it, which is the colour key the app lacks (NEXT item 5); "built
from N to M rides, last ridden <date>"; and, when a gap was bridged, "N ft with
no data". Releasing fits the camera to the selection and turns camera follow
off; the compass moves below the card.

**Where the work lives.**
- **Server: a new route, `GET /segments/path`**, additive, so an older APK never
  calls it. In: the pressed line (segment id, direction, distance along it),
  optionally a line to connect to. Out: the path as pieces, each with the
  offset geometry `/segments` draws for it, on its travelled side; the profile
  as `spans`, the exact stretches the map colours, each with its slope,
  colour, rides, rise, and height above the path's start; the band table built
  from `SLOPE_STOPS` so the app holds no second copy; and why growth stopped
  (end, fork with each branch's data and first 30 m, gap, loop, limit), with
  `aheadM`, how far past the selection's end that lies on unmeasured ground.
  Built differently from this paragraph's first draft, and why: spans rather
  than samples every 15 m, so nothing is resampled; heights relative to the
  start, summed from the slopes, because the means' levels differ ride to
  ride; and pieces with no data on the travelled side rather than the
  centreline, so the highlight does not jog 4 m sideways at every gap. It belongs on the
  server because the phone receives only drawn segments, and bridging a gap
  needs the undrawn ones, the ride order and the pass rows.
- **The graph is `buildEndAdjacency`** (`segmentMatcher.ts`) over canonical
  segments in a box around the start, **with `endpointSnapM` at 5 m**. The
  node graph has no edge at 1,987 canonical pairs within 5 m of each other
  ("Does the matcher need Viterbi?"), and growth would stop dead at each. The
  matcher stays at 0: for a selection a false edge costs one wrong hop, a
  missing one ends it.
- **History** is consecutive match rows within each session, ordered by the
  `recorded_at` of their first fix, counted as line A to line B where B is
  entered at A's exit end. The whole table per request: 2,618 rows.
- **Slopes come from `pieceSlopesPct`**, so the card agrees with the map. The
  profile integrates those slopes and never plots the bucket means: rides sit
  at different levels (the mixing artefact), so plotted means would draw a
  cliff at every join and inflate the climb.
- **Gaps.** Growth runs on through undrawn segments, and through the undrawn
  head or tail of a partly covered one, for up to 150 m in a row: drawn dashed
  grey, counted in distance. Where the other direction is drawn there, its
  slopes are used negated (the same ground, measured). Elsewhere the change is
  interpolated between the heights at both ends, and the card marks it as
  estimated. Over 150 m, growth stops with reason `gap`.
- **The phone.** `Map.onLongPress`, then `queryRenderedFeatures` over a box
  around the finger, then the nearest piece by distance to its geometry; the
  line features gain `segmentId` and `direction` properties, which the
  `/segments` response already carries. MapLibre has no "finger lifted"
  event, so release comes from `onTouchEnd`/`onTouchCancel` on a wrapper
  `View`. **That is unproven on the phone: spike it first.** Fallback: a press
  selects up to the first stop, with no hold. Growth speed is set in screen
  points per second, about 120 rising to 400 after 2 s, converted through the
  zoom, with a 150 ms pause at each fork. The selection has its own source and
  layers: casing, coloured line, dashed gap, and chevrons (a line-placed
  symbol) showing the direction. Stats are computed on the phone from the
  profile, so they update every frame without a round trip. Haptics (a buzz
  when the hold registers, a tick at each fork) need `expo-haptics`, a new
  dependency for Julian to approve; v1 works without it.

**Bugs it inherits, and the v1 workaround for each.**
- Touching trail pieces with no shared node: the 5 m snap above.
- Ridden ground with no line (gate, wrong-dir, unmeasured zero-run): the
  gap bridge. The real fix starts with the census, NEXT item 1.
- Level differences between rides: the integrated profile.
- Switchbacks (the same-way class, NEXT item 4) can send history picks back
  and forth: growth stops on revisiting a line, reason `loop`.
- The two lines of a street are 8 m apart: 17 px at zoom 17, the app's
  default, and 4 px at zoom 15. The nearest line to the finger wins, chevrons
  show which way the selection runs, and the flip button fixes a wrong pick.

**The outcome, measured.** `npm run eval:path`, read-only, whose first run is
step 0 of the build, before any app code:
- Leave-one-ride-out: at every fork a ride passed, whether the rule picks the
  branch that ride took. Reported for history-first, name-first and
  straightest-only. **Passes when history-first beats straightest-only and
  the same rule without history.** The second half was added after the
  review: without it the eval passed with the history rule deleted, since names
  and turns alone beat the least turn (608 against 548 of 810).
- Growth started from every drawn line: stops counted by reason, and bridged
  metres per 10 km grown, a measure of gaps from the rider's side to compare
  after the census.
- Climb against the terrain model on Ladders and Gold Camp Road, and the
  route's p95 latency.

**Tests.** Backend gate: synthetic graphs for straight on; a fork decided by
history, by name, by turn; a fork with nothing (stop); a loop (stop); the twin
never taken; a 3 m snapped join followed; a capped run's slices joined by
`piece_index`; a gap under and over 150 m; partial coverage; twin data
negated; a profile continuous across a level step. Route parameters and shape
with the mocked pool. App gate (`tsx --test`): stats over synthetic profiles
(cut mid-piece, estimated flags, band shares, steepest 100 m), unit formatting
either side of 2,640 ft, the nearest-line pick between two offset lines,
cutting the path at a grown distance.

**Phases, each on Julian's go-ahead.**
1. **Server**, about 200k: the eval's step 0, then the route, its tests and
   the eval, one cold critic, deploy (additive; verified by `builtAt`, live
   `/segments` hashing unchanged). **Built, reviewed and deployed 2026-10-17
   for about 360k, the critic alone 176k.** The deploy check
   is a scratch script (`verify-path-live.mts`, baseline taken at `builtAt
   2026-10-17T14:28:03.555Z`, ride 89): four `/segments` viewports must hash
   unchanged, no ride may land in between, and a press on Ladders 19475 must
   come back as a path. Run against the old server it failed, as it must;
   after the deploy it passed.
   **Stated limits, from the review:** a connection is not held to the 150 m
   budget (it is the rider's own request to cross a gap) and near its 2 km cap
   can miss a way that exists; it can only cross ground within about 215 m of
   a drawn line, the loader's reach; the network and the line data are read in
   separate statements, so a ride merged between them leaves a piece
   estimated until the next request; `avoid` takes at most 500 ids; and the
   eval's read-only guard rides on pg's deprecated query queueing, as
   `eval:mixing`'s does.
2. **App: shipped 2026-10-18**, merged into `main` from `press-hold-app`
   (built 2026-10-17, reviewed twice and fixed 2026-10-18). About 800k in all,
   against 250k first planned and a 710k re-estimate; the two cold critics
   alone cost 236k and 176k, each over its brief's budget (150k, 100k).
   - **Touch spike: PASS.** Injected touches on the Pixel 10 Pro: MapLibre's
     `onLongPress` at about 400ms, then `onTouchEnd` on the wrapper `View`
     when the finger lifts (+2502ms on a 2.5s hold), no `onPress` after a long
     press, and with `dragPan` off from the long press a drag does not move the
     map. `queryRenderedFeatures` in a 44-point box takes 9 to 16ms and returns
     both lines of a street, 17 points apart at zoom 17. Julian then used it
     with his own finger on 2026-10-18 and it held up.
   - **Built:** `selectionController.ts` (the hold as a state machine, no React),
     `pathSelection.ts` (joins, cuts, the card's numbers, map features, units),
     `holdGesture.ts` (line pick, travel metres, preview, speed, hit priority),
     `flipSelection.ts`, `selectionStatus.ts`, `SelectionLayers.tsx`,
     `SelectionCard.tsx`, the wiring in `MapScreen.tsx`, `fetchPath` with
     caller cancellation in `api.ts`. The `RING_CAPACITY` comment is fixed.
     How each choice works is in `mobile/README.md`, "Press and hold on a line".
   - **Choices made in building, for the review to judge:** the server is asked
     150ms after finger-down if the finger stays put, not at once, so taps and
     pans cost it nothing; a hold within 250m of the selection's end connects to
     it (within 250m of its start, it leads in), further away it starts afresh;
     the flip asks connections along the other direction's lines in chunks
     under 1,800m and checks each answer's streets, splitting a chunk that
     comes back on others; a trim ends the selection with a `cut` stop, which
     never grows; the steepest 330 ft skips windows over a quarter estimated;
     street names covering under 20m of a selection (junction links) stay out
     of its title.
   - **Checks:** 114 app tests (58 new); 10 of 11 code mutants killed, the
     survivor equivalent (`<` against `<=` at exactly 2,640 ft). `npm run
     eval:selection` (new, read-only, 16 live presses): PASS, every answer
     tiles, adds up and cuts cleanly, and 16 of 16 flips land on the same
     streets; it fails with heights not carried across a join, and with the
     flip's street check removed, where 2 of the 16 real flips took a shortcut
     (trail 13136, downtown 9270). Its first run checked each map feature's
     metres against the path's and failed 34 trail features by design: round a
     switchback the line drawn 4m aside is metres longer, so it now checks
     shares of each piece.
   - **On the phone, driven over adb:** hold, release, hold the selection to
     carry on, the camera following the tip, tap to trim and confirm, flip,
     Android back, hold a line near the end to join it, the first-run hint.
     Not seen on the phone: leading in from near the start, a fork's branches.
   - **Found on the phone: the first answer is slow, and Julian sees it too.**
     Holds waited 3 to 5 seconds at the end of the pressed line, against a
     median 1.15 to 1.38s from this PC with the server warm. **Measured
     2026-10-18, read-only**, from the backend's own access log
     (`railway logs --service cyclingdataapp-backend --deployment --json`;
     `--http` returns nothing on this plan). Server time for
     `GET /segments/path` by the quiet before it: under 5s, 147 requests,
     median 1170ms (p90 1559); 5 to 30s, 7, median 1386ms; 30s or more, 11,
     median 2840ms (p90 4052, max 4890). Every press after 36s or more of
     quiet took 2405 to 4890ms, every one after 6 to 19s 1075 to 1686ms: the
     step sits at the pool's `idleTimeoutMillis: 30_000`
     (`backend/src/db/pool.ts`), which closes idle connections. Julian's
     presses were 27 to 448s apart, so nearly all paid it (median 2698ms on
     the server alone). Also found: the phone's whole-world `GET /segments` on
     opening the app answers 304 in 3272 to 3500ms, running the whole query
     to say "not modified"; and nothing listens for `pool.on("error")`, so an
     idle connection the pooler drops is an uncaught `error` event, a crash,
     whose window a longer idle timeout widens. The database is Supabase's
     session-mode pooler (`aws-0-us-west-2.pooler.supabase.com:5432`). Not
     measured yet: where the warm 1.17s goes, and how the cold 1.7s splits
     between connecting and a cold Postgres backend.
   - **Open: whether the card's numbers are right.** Every number on the card
     agrees with the server's spans (the eval checks that on live data), so the
     card can be no more wrong than the map's colours, but nothing checks either
     against the ground. The one comparison so far is phase 1's `eval:path`
     terrain report, on the 69 Ladders and Gold Camp Road lines: net change
     differs from the terrain model's by 3.96m a line on average, and the climb
     sums to 264.7m from our slopes against 429.7m from the terrain model, 38%
     lower. Unexplained. The likely cause is the slope fit (SLOPE_WINDOW, about
     60m) smoothing out ups and downs that a terrain model sampled along an OSM
     centreline inflates with its own bumps, but neither number is known to be
     the true one.
   - **The review, 2026-10-18.** Round 1: FAIL, three blocking and two
     should-fix. Holding the tip of a run let go part grown, as the card says
     to, went round the block or replaced the selection: the growing run was
     not hit-tested, so the finger found the line under it and asked for a
     connection to a point behind the end. A tap during a flip crashed the
     app (a trim index into a changed selection), and during a lead-in
     trimmed the wrong place. A "more" answer landing during a connection grew
     on, and the connection then joined at the wrong end. A trim while
     something was awaited left the spinner turning for good. A lead-in cut
     the selection's end. Fixed with one rule, one answer awaited at a time
     (`supersede()` on every hold that asks, every trim, flip and close, with
     a hold's intent worked out again at the long press if an answer landed
     since the finger came down), taps refused while anything is awaited, the
     growing layers hit-tested, and a hold on the selected stretch of the
     selection's own line, same direction, carrying it on. Round 2: FAIL,
     nothing blocking, all five confirmed fixed; an unreachable answer after
     letting go emptied the selection (present since `ea7cf8b`; now the
     selection stays and the card says why), the eval's hold check passed
     while a resume grew nothing, the stretch rule could lose its direction
     check unseen, and two nits. All fixed. Every finding was reproduced by
     its probe before the fix; the critiques, probes and mutants are in the
     scratchpad of session `e24d4bb5`, `press-hold-app/critique/` and
     `press-hold-app/fix-round-{1,2}/`.
   - **Checks at ship:** 131 app tests, the new controller tests each failing
     on the code before its fix; 21 mutants of the fixes killed, four guards
     with no reachable trigger surviving by design. `npm test` runs with
     `--test-timeout=5000`: a mutant made a test wait forever, which would
     have frozen the pre-commit hook. `eval:selection` gained a `hold` check
     that drives the real controller over each live answer (the tip
     hit-tested as the selection; holds through the line under it carry on
     and grow; 25m ahead joins straight along; the street's other line
     asks), a band check summed from the spans by colour, and `--record` /
     `--replay`, so a mutant is judged on a recorded live run with no
     traffic. Live, builtAt 2026-10-18T01:40:59.257Z: PASS, 16 presses, 75 of
     75 resumes, 16 of 16 flips. A 2m slack past the selected stretch turned
     out unneeded on real lines (travel metres line up exactly); it stays as
     rounding margin. Not seen on the phone: leading in, a fork's branches,
     and the tip hold through the device's own query (the eval rebuilds the
     query from the layer list).
   - **The profile scrub, 2026-10-20** (Julian's ask, after Trailforks'
     elevation chart). Drag along the card's profile: a dot (dark with a
     white ring, the growth tip's dot inverted) marks the point on the map,
     a line marks it on the profile, and the numbers row reads how far in,
     the height from the start and the grade ("no data" on unmeasured
     ground), drawn over the totals so the card keeps its height. Julian's
     choices: height from the start (the server sends no absolute height),
     the dot hides on lift, graph to map only (the line on the map answers
     taps and holds), solo with one critic. `services/profileScrub.ts`
     holds the arithmetic, the readout, the cursor and the gesture
     (`createScrubGesture`: only the finger that started it moves it, a
     move never starts one, and release, termination or a new profile ends
     it, the last so a profile gone mid-scrub cannot leave it running); the card only
     feeds it responder events, and the map's dot (`ScrubDot`) is drawn
     last. The readout's height is `profileAt`, the function the profile's
     bars use. **The cold review: FAIL** (161k), two medium: a second finger
     drove the dot on Android (every finger's moves reach the responder,
     each with its own identifier), and six broken scrubs passed every test.
     Both fixed (`04484a4`), the reproductions re-run; 23 mutants, 23
     killed. `eval:selection` gains a `scrub` check, judged without the
     scrub's code: live PASS, 16 of 16 presses. Merged; nothing deployed.
     **Installed 2026-10-21** from `54c4365` (cold start clean). Julian:
     "it works"; the one change asked for was the reach. **The reach,
     `17ae9d0`, 2026-10-21.** The profile's edges were 24dp from the
     screen's sides (the card's 10dp margin and 14dp padding), 3.9mm on his
     Pixel 10 Pro (1080px at density 420, so 411.4dp; 0.160mm a dp), with
     the fingertip at the glass's edge and over the back-gesture strip
     (78px, 29.7dp, from `dumpsys window`). Now `scrubBand` reads the
     path's ends 60dp from the window's sides (`SCRUB_EDGE_REACH`): each
     profile edge brought in to 60dp when nearer, a profile already clear
     not stretched, the profile's edges when the window is unmeasured or too
     narrow. The card passes `useWindowDimensions`' width. `eval:selection`'s
     scrub check sweeps a finger across the phone every 0.5dp on each press;
     replay PASS 16 of 16. 13 mutants, 13 killed (the old 24dp reach reads
     "24.5dp from the left reads 6.5m in"). One cold review: PASS, three low
     findings fixed, its two surviving mutants killed by a test where the
     fallback and the band differ. Installed 19:21 (phone clock), cold start
     clean. Evidence: the scratchpad of session `e24d4bb5`,
     `profile-scrub/` (`critique-reach/`, `mutants-reach-2.out.txt`).
   - **Next, in order.**
     1. **The lag: mostly fixed, live 2026-10-18; the rest waits on Julian.**
        - **Cause, found in three passes.** (a) The backend ran in Railway's
          Amsterdam region (never chosen), about 150ms from its database in
          Oregon. (b) The pool closed idle connections after 30s. (c) Found by
          the request trace: the database's first statements after a quiet
          spell run slow (below).
        - **Done, three deploys, each on Julian's go-ahead.** The region moved
          to `us-west2` (Railway GraphQL `serviceInstanceUpdate`,
          `multiRegionConfig {"us-west2": {"numReplicas": 1}}`, then
          `deploymentRedeploy` with `usePreviousImageTag`, deployment
          `71bdbb69`; a same-image move keeps builtAt, so it was verified by
          region and status). `bab6a91` (`a2fef8a2`): keepalive, idle
          connections kept 10 minutes, an `error` listener. `ff76d26`
          (`698f2cac`): a trace on every request (`routes/requestTrace.ts`):
          the pool as the request found it (idle/total/waiting), the
          connections it opened, each stage's span from arrival, and when the
          answer was handed over, appended to the access log line
          (`routes/accessLog.ts`) and sent by GET /segments/path as a
          `Server-Timing` header that `eval:latency` prints per press. `npm
          run split:access-log -- <file>` reads a `railway logs
          <deploymentId> --json` file back (run the CLI from `backend/`,
          the folder linked to the service). `9a0058a` (`93563c1c`, builtAt
          2026-10-18T18:51:27.630Z): the pool keeps `min: 4`, opened as the
          server starts (`db/warmPool.ts`; its log line "database: opened 4
          connection(s) in 208ms").
        - **Measured on `93563c1c`** (57 requests; `eval:latency` PASS, its
          verdict now: every request 200, warm median at most 1000ms, every
          press after 40s quiet at most 1200ms): from this PC, warm median
          456ms, after 40s quiet 464, 620 and 457ms. On the server, warm
          median 222ms (n=50, was 1170ms), after 40s quiet 262 to 281ms; on
          `698f2cac`, 11 of 11 after 40s within 251 to 356ms. Delivery to
          Railway's proxy 0 to 3ms, so gzip would not move the server's time.
          `eval:selection` PASS, its 16 press summaries identical to a run
          before all three changes (compared line by line), 43 path requests
          at a median 0.36s, p95 0.47s from this PC.
        - **The review's findings, acted on.** F2 fixed (`judge()` in
          `evalLatency.ts`; the review's own TLS stub, rebuilt: the old eval
          PASS, the new one FAIL naming all six warm 500s and the 6009ms
          press). F3 fixed (`keepAliveInitialDelayMillis` pinned above 0 and
          at most 30s). F4 fixed (`timePath.ts` says its EXPLAIN figure was a
          one-off). F1 attributed, below. 24 mutants over the two commits, 24
          killed.
        - **What is left: the database goes cold during quiet.** With four
          connections waiting and none opened, three presses on `93563c1c`
          were slow: the container's first (963ms on the server), the first
          downtown (1947ms, `network` 1837ms), and one after 11 minutes with
          no request (852ms: rideOrder 448, network 581, lines 192, against
          about 45 to 140ms each warm). On the traced deployments every press
          after 40s was fast; 6.4 and 11 minutes were not (796ms on
          `a2fef8a2`, 852ms here). Before the trace, `a2fef8a2` also had two
          slow presses after 40 to 50s (1023, 762ms), unexplained. `9a0058a`
          kept the connections as designed (4 of 4 waiting after 11 minutes)
          but did not keep that press fast: opening the four took 208ms at
          once, and the rest of a cold stage is the database's first
          statements, so its commit message's "a new connection cost 400 to
          850ms" counts those statements too. Its gain is the connect, on the
          first press after 10 minutes. Evidence it is the database server,
          not a session: pg_stat_statements (read-only) shows the network
          statement's execution from 5.7 to 1911ms with 0 blocks read in 571
          calls, the whole database (77MB) inside 224MB of shared_buffers,
          JIT off. On four fresh sessions (`lag/f1/per-session.mts`),
          EXPLAIN ANALYZE of the downtown statement ran 1233ms on the first
          session's first run, then 98 and 96ms, and 94 to 109ms on every
          other session, one of them as new as the first. The downtown
          statement touches 26,069 buffers when quiet (101ms: a full scan of
          46,271 segments for the family join, and 262 overlapping map-index
          probes giving 20,947 rows for 1,609 families), the trail's 5,481
          (25ms). Supabase's dashboard (Observability, Database, the last 3
          hours on 2026-10-18) shows why: the database runs on the free
          plan's Nano compute (`t3a.nano`, 0.5GB of RAM) with about 400MB in
          swap in every sample, and 1.19GB of memory committed, near its
          limit of about 1.3GB, while the CPU sits about 98% idle. So the
          first statements after quiet read their pages back from swap, and
          the CPU is not it. The page faults themselves are not observed:
          the dashboard's per-minute disk charts are too coarse to show a
          one-second burst.
        - **Decision for Julian:** a bigger Supabase compute (the Pro plan;
          costs money monthly; fixes the cause for every route, and the
          memory limit; Micro's 1GB may still swap a little against 1.19GB
          committed, Small's 2GB should not; per Supabase's plans it also
          brings daily backups, which the project has none of), or a keep-warm statement every 2 to 3 minutes touching the
          route's pages (cheap, treats the symptom, a deploy), or a smaller
          working set for the downtown statement (the family join through
          `segments_way_start_end_idx`, distinct grid cells for the probes;
          each changes what the route reads, so `eval:selection --record`
          then `--replay` must show the same answers; about 60 to 100k with
          a deploy). Every measurement is in the scratchpad of session
          `e24d4bb5`, `lag/f1/`.
     2. **The numbers against the ground.** A read-only eval: for selections on
        stretches with a known answer, the card's net change and climb against
        the terrain model, and against a reference Julian trusts (a climb's
        published figures, or his own ride on another app), so the 38% gap
        above gets a cause and the card a stated accuracy. About 60k to design
        and run; what it finds may move the slope fit, which is server work.
   As first planned, about 250k: the touch spike, then selection, card, trim, flip,
   back, a first-run hint ("Hold a line to measure it"), tests, one cold
   critic, the APK. The `RING_CAPACITY` comment fix rides along. CLAUDE.md
   asks for a variant tournament on a new feature; the proposal, for token
   cost, is one only for the card layout, two variants, or none on his say.
   **What phase 1 hands it (2026-10-17):**
   - **Julian's phone must be connected for the touch spike**, the first step:
     it settles whether `onTouchEnd` on a wrapper `View` arrives after
     MapLibre's long press, and so whether hold-to-grow can be built at all.
   - **Ask at finger-down, not when the long press registers.** Live, the
     route answers in a median of 1.5 s warm (2.0 s cold) against 0.22 s for
     `/health` from this PC, about 1.3 s of it the server's round trips to the
     database. Ask on touch-down and animate along the pressed line, which the
     phone already holds, until the path arrives.
   - **Reading the answer**, every field documented in
     `backend/src/services/pathResponse.ts`: draw `pieces[].geometry`, already
     in travel order on the line's own side; the card's climb and descent sum
     `spans[].riseM`, the profile plots `spans[].heightM` (metres above the
     path's start), and "built from" reads `spans[].rides`; the colour key is
     `bands`. On `limit` ask again from the tip; on `fork` mark
     `stop.branches` from their own 30 m `geometry` (an undrawn branch has no
     line on the map) and say how far ahead the fork lies from `stop.aheadM`.
   - **The three requests.** A press sends the pressed line and point. A hold
     past the end sends the end as `segmentId`, `direction` and `atM`, with
     the held line as `toSegmentId`, `toDirection`, `toLon` and `toLat`. A
     hold behind the start sends the held line, with the start as the `to`
     point, `toAtM` and `grow=false`. Send the selection's segments as
     `avoid`, at most 500. An `unreachable` answer starts a new selection.

**Later, not in v1.** A one-direction mode (Julian's arrow buttons): one line
per street in a chosen direction, which also halves the clutter, since the
two lines measure the same ground. A fixed on-screen gap between the two lines
at every zoom, via `line-offset`. Each ride's own profile over a selection
(pass rows), the rider's time on it per ride (each match row's first and last
fix), saved selections, a climb finder.

### Parked: measured, decided, and what would reopen each

- **Timestamps arrive as `Date` and `Date.parse()` drops their milliseconds:
  measured NEGLIGIBLE on 2026-10-10, left unfixed by Julian's decision.** pg
  parses `timestamptz` into a `Date` while the code types `recordedAt`,
  `endedAt` and two columns in `pruneEmptySessions.ts` as `string`, so
  `Date.parse(date)` reads every fix time cut to the whole second (the
  census's 11 lies). Replaying production's speed filter
  (`rejectImpossibleSpeeds`, `sessionProcessor.ts:173`) over all 50 rides,
  34,866 fixes, exact times against today's: **2 verdicts change**, one fix
  each in sessions 15 and 42, both wrongly rejected today (control: 0). Of
  34,816 gaps, 3,549 are under 1 s and 245 read as 0 s, which the filter
  treats as no evidence; 7 cross the matcher's 15 s anchor limit and 1 its
  45 s stitch window (consecutive fixes, a rough indicator). Small because
  every limit sits far from a second: the filter rejects only above 20 m/s
  both in and out. `measurePositionSpikes`, where a 0 s gap becomes an
  infinite speed, runs only in diagnostic scripts: production passes no
  `positionFilter`. Script: `backend/tmp-measure-timestamps.mjs` (gitignored,
  local). If ever built: a global `timestamptz` parser returning the ISO
  string, the int8 pattern with JSON byte-identical, about 80k tokens, no
  rebuild needed. **Lesson:** it sat at NEXT 1 for five days on how alarming
  the mechanism sounded; the 30-minute measurement CLAUDE.md now requires
  would have ranked it here.
- **`TANGENT_WINDOW_M` stays 10 and the traversal gate stays 25 / 0.7** (old
  item 4, Julian's call). Reopen the tangent only with the extent-level effect
  of 14 m, +0.47 km summed over rides, from a dry-run model diff; the gate only
  with a per-line look at 18 / 0.7's 8 next-door lines.
- **40 barometric excursions of 3-6 m** (old item 3): 35 pass the spike filter
  and lie inside stored matches. Their effect after smoothing and averaging is
  unmeasured.
- **A ride's first fix keeps its GPS height** (old item 2). The elevation
  filter keeps a first fix by construction and nothing in the pipeline reads
  `elevation_source`; it matches the barometer to 0.1 m on rides 68, 82, 84 and
  87, and sits 19.2 m high on ride 73.
- **Session 29's `started_at`** is 23.2 h after its fixes (old item 2); the
  recovery path (bug 22) would fit.
- **Two code debts left on purpose:** `endpointSnapM`'s table carries gate
  numbers from before `9c13174`, annotated rather than re-measured; and
  `enumerateHeadingLines`' `device` / `derived` slots also hold tangent arms,
  explained in a comment rather than renamed.

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
| every bigint (ids, uncast `count(*)`) arriving as text | **Fixed at the driver** in `6d6b174`: `db/pgTypes.ts`, one parser for every process. Live `/segments` byte-identical apart from the id's type | "What landed on 2026-10-10" |
| checking the code's row types against the database | **`npm run eval:query-types`**: Parse + Describe, executes nothing. 82 sites, 0 numeric lies, 0 untyped reads | `backend/README.md` |
| whether a docs-only push deploys | **No.** Railway watches `backend/**`; tested 2026-10-04 | commit `4b028c8` |
| the barometer | **Finished.** Session 84 graded `alive`, 1366 of 1367 fixes barometric | "The barometer: shipped, installed, verified" |
| the traversal gate | **Swept with a 15 m witness 2026-10-11, keep 25 / 0.7.** Most runs a lower span admits are ridden, but the new lines are worth 72-306 m and turn on next-door duplicate paint | old NEXT item 4, `npm run eval:gate` |
| `TANGENT_WINDOW_M` | **Keep 10.** 14 m wins 298-407 m at ride level but drops 80 m of real lines and draws no new ground | old NEXT item 4 |
| the colour bands | **Climbs step at 0, 3, 6, 9 and 12%, the darkest open-ended, separate and not blended** (2026-10-14). A 15% step would colour 220 m on 7 trail lines, mostly noise; a blend would show the 0.8-point slope error as flicker | STATE, "The colour bands" |
| the press-and-hold fork rule | **Ride history, then the same street name, then the least turn within 60 degrees with measured ground first, else stop** (Julian, 2026-10-17; the measured-ground refinement approved the same day). Leave-one-ride-out through ride 89: right at 85.3% of 810 ridden forks, against 75.1% with no history and 67.7% for the least turn | "Press and hold on a segment, designed 2026-10-17" |
| joining ends within 5 m for a selection | **Yes for the path's graph (`PATH_SNAP_M`), still 0 for the matcher** (2026-10-17). It takes dead ends from 292 to 168 of 958 growths; for the matcher an invented edge draws paint, for a selection it costs one hop the rider can trim | the same section |
| the slope a piece is drawn with | **Each pass's own slope** (2026-10-17, option A): the mean of each pass's least-squares slope over the window, weighted by its bucket count, from passes covering two buckets or more, clamped after; the means' slope only where a window's passes are not all on file. Pooled least squares tied and lost on a rule set before the first run | "CLOSED 2026-10-16 and -17" |

## OPEN: genuinely undecided, do not treat as closed

- **The same-way class.** Unexplained. NEXT item 4.

## STATE, 2026-10-17

`main` is the base, and every task branch is merged into it. The ten from
2026-10-10/11 were deleted on 2026-10-11, locally and on origin;
`stale-eval-columns`, `state-after-stale`, `next-whats-left`,
`refresh-architecture-doc`, `session-notes-compact`, `darker-red-bands`,
`state-after-colours`, `mixing-artefact-notes`, `option-a-plan`,
`option-a-state`, `per-pass-slopes` and `option-a-live` are merged and safe
to delete, and so are `press-hold-plan`, `path-route`, `path-route-live`,
`notes-after-phase1`, `press-hold-app`, `apk-install-notes`, `lag-notes`,
`path-lag-fix`, `lag-trace-notes`, `lag-swap-notes`, `profile-scrub`,
`next-steps-notes`, `install-profile-scrub` and `scrub-reach-inset`.
**In flight: the database backup's fixes**, branch `database-backup`
(`2b698a9`, not merged; "NEXT, IN ORDER", the IN FLIGHT block). Also
waiting: Julian's try of the scrub's reach (`17ae9d0`, app only, on the
phone since 2026-10-21; "NEXT, IN ORDER", step 1).
`path-lag-fix` is merged (`9a0058a`) and live as
`93563c1c` (builtAt 2026-10-18T18:51:27.630Z); the lag's last case waits on
Julian ("2. **App**", "Next", step 1). No running job.
The phone runs the release APK built from `17ae9d0` (installed 2026-10-21 at
19:21, phone clock).
Last code change `17ae9d0` (2026-10-21): the scrub's ends reached 60dp
short of the screen's sides, app only, nothing deployed. Before it,
`54c4365` (2026-10-20): the profile scrub, app only, nothing deployed.
Before it, `9a0058a` (2026-10-18): the pool keeps four connections
through any pause, opened as the server starts; deployed. Before it, `ff76d26`
(2026-10-18): a trace on every request, `eval:latency` judging every request,
and `split:access-log`; deployed. Before it, `bab6a91` (2026-10-18): the
database pool keeps idle connections 10 minutes, with keepalive and an error
listener; deployed, with the backend moved to `us-west2` the same day. Before
it, `d7204c3`
(2026-10-18): phase 2 of press and hold, the app
half, merged with its two reviews' fixes; app only, so nothing deployed.
Before it, `5ccbc35` (2026-10-17): `GET /segments/path`, phase 1 of
press and hold. Additive: nothing calls it until the app's phase 2, and the
map's line drawing moved into helpers without changing a byte. Before it,
`26f4620` (2026-10-17): option A, each pass's own slope,
which changes what the map draws and adds `segment_pass_buckets` (17,634
rows) beside the model, whose means did not move. Before it, `a7c6a85`
(2026-10-14), the colour bands. Production serves
`builtAt 2026-10-18T01:40:59.257Z`, the `5ccbc35` deploy, verified by the timestamp moving
and holding, by live `/segments` hashing identical to before on four
viewports, and by a press on Ladders answering with a path. **This PC's clock runs about 80 s
ahead of Railway's** (measured 2026-10-11 against the HTTP `Date` header), so
a fresh `builtAt` can read earlier than the local push time without being a
stale build. Live model **746 segments / 953 lines** at the int8 deploy, which
changed nothing in it: the whole `/segments` response hashes the same as
before, ids now numbers. **504 backend tests, 56 app tests**; `mobile/`
has a gate lane. **45 usable rides** counted on 2026-10-05. Rides 85 to 88 are
graded `alive` (2026-10-10). 88 landed that afternoon, so 51 sessions hold
34,965 fixes; the timestamp measurement earlier the same day saw 50 and
34,866. **Ride 89 landed on 2026-10-11**, during the doc rewrite: 52 sessions,
36,266 fixes, 49 usable, model 6,114 buckets / 751 segments / 958 lines. Not
yet graded with `verify-barometer`. `npm
run eval:query-types` fails on 12 timestamp lies, by design (the 12th since
2026-10-17, `evalMixing.ts`'s copy of the samples query): measured
negligible on 2026-10-10 (NEXT, "Parked"). A deploy failed once on 2026-09-30, see note 29,
before adding anything to `backend/` that imports outside it.

**`context/architecture.html` is the 3rd edition (2026-10-11)**, rewritten for
feature designers as well as coders and republished to its artifact ("Gradient
Field Manual", version 9). Its live numbers are pinned through ride 89. Every
number in it was checked by a throwaway read-only script against the code and the
data: 105 checks, kept as `backend/tmp-doc-check.ts` (gitignored) for the next
revision. One cold critic round (FAIL, 3 blocking and 15 minor, all reproduced
and fixed); no second round, on Julian's call. The task ran at about 2.7 times its
token budget, mostly the critic reading a 250 KB page.

**The colour bands (2026-10-14, `a7c6a85`, deployed).** Climbs above 9%
draw dark red `#881337` and above 12% near-black red `#450a0a`; red `#dc2626`
now covers 6 to 9%. Drawing only: colours are computed on every request, so no
rebuild. Recounted through ride 89 with the server's own code, read-only: 126 of
5,218 colour stops change, 1.53 km red to dark red and 0.63 km red to near-black,
and nothing else moves. Above 12% is 17 lines, all trail; no road passes 10.2%
(Gold Camp Road). Why these edges: Garmin ClimbPro steps at 3, 6, 9 and 12%, and
every bike computer checked (Garmin, Hammerhead Karoo, Wahoo) uses separate
steps, not a blend; above 15% is 220 m on 7 trail lines; slope error is about
0.8 points against 3-point bands. Shades come from the dataviz validator against
the basemap's cream `#f8f4f0` and park `#d8e8c8`: Tailwind red-800 and red-900
each failed the normal-vision floor beside red or red-950 (14.4, 14.5); rose-900
and red-950 clear it (18.7 and 16.8; colour-blind 14.9 and 12.6, floor 8).
`gradientBuilder.test.ts` pins every band edge from both sides; it failed on the
old table at 9.01% before the change. The repo's `architecture.html` has the
bands; its artifact page ("Gradient Field Manual", version 9) does not yet:
Julian chose to republish it with the next doc change.

**How every measurement here is run, each rule learned by breaking it:**
- **Pin the control to a fixed ride list.** New rides arrive mid-task.
- **Before trusting a check, run the input that should make it say no.**
- **Count what a fix would change, not what it touches.** The timestamp defect
  touched 99.9% of fix times and changed 2 of 34,866 verdicts; it sat at NEXT 1
  for five days on the first number.
- **Run the code on the case before writing down what it does.** old NEXT item 3
  sat for a week on "the spike filter lets it through", reasoned from an assumed
  riding speed. Run on the stored ride, the filter rejected it: the rider was
  nearly stopped.
- **A witness with a floor cannot speak below it.** `findPasses` needs 25 m, so
  its silence about anything shorter is not evidence.
- **Verify a deploy by `builtAt` moving, never by status**, and if a timestamp
  looks unexplained, suspect the recorded baseline before the deploy trigger.
- **Compare before and after from FROZEN copies** (`git archive` of `main`, a copy
  of the branch), back to back, with a data fingerprint around each pair.
  Running from the working tree lets a later edit leak into an earlier run.
- **A Windows junction in a scratch copy points INTO the repo.** Delete the link
  itself (`[System.IO.Directory]::Delete(path, $false)`); never recurse into it.

**The house defect**, shared by six of the nine errors made on 2026-10-04: **a
check that cannot fail, reported as a check that passed.**

**How work is sized since 2026-10-10.** CLAUDE.md is untracked by design, so
this is the record of what changed in it and why. Every triage block carries a
token Budget line, so Julian can veto an expensive run before it starts.
Critic rounds are capped, medium one and large two, and stop early after two
rounds of only nits; more rounds run only on Julian's say. A finding blocks
shipping only with a plausible path to it, and only once the builder has
re-run its reproduction. A fix whose payoff is unknown gets a 30-minute
read-only measurement first. Why: the int8 review ran six rounds, rounds 4 to
6 found only code nobody here would write at about 200k tokens a round, and
the timestamp item measured negligible after five days at the top of the
queue. **Calibrated 2026-10-11:** the architecture-doc rewrite was budgeted at
250k and cost about 600k, plus 246k for one cold critic, and the 1.5x stop was
missed. A cold critic reads the whole artifact (about 1k tokens per KB, plus its
own exploring); republishing an artifact in place means Reading every line of
the live page first, in chunks under 25k (about 70k for 200 KB); and live counts
move mid-task, so pin them to a named ride. Check the running total at every
phase boundary against 1.5 times the estimate. **Calibrated 2026-10-17:** press
and hold's phase 1 was noted at 200k, re-estimated to about 400k before it
started (the last cold critic alone had cost 181k), and cost about 520k: step 0
(the tested core and the eval's first run) 155k against 120k, then the route,
faster loading, the review's fixes and the deploy about 190k, plus 176k for one
cold critic on a 2,500-line diff. Re-estimating before starting, and stopping
at the checkpoint between the two, kept each stage within 1.5 times its own
estimate.

Where to start depends on what you came for:

| you want to | read |
|---|---|
| know what the app is and how a ride becomes a coloured line | `context/architecture.html` (3rd edition, the full walkthrough, written for feature designers too), then "What it is", "Layout", "Data flow" here |
| design a feature | `context/architecture.html` Part 6: what each kind of change costs, the limits every feature inherits, ideas already tried, open problems |
| change anything in the backend | "Bugs already paid for" — 33 failure modes, each one paid for once already |
| run a measurement before changing anything | `npm run` in `backend/`: `find-holes`, `diagnose-holes`, `trace-passes`, `eval:coverage`, `eval:tangent`, `eval:heading`, `eval:heading-lines`, `diagnose-spikes`, `eval:spikes`, `verify-rebuild`, `eval:linker`, `eval:query-types` |
| touch the importer or the matcher | "Operational gotchas", then the pipeline sections |
| pick up the next piece of work | **"NEXT, IN ORDER"** at the top of this file, the only copy of the queue (this row used to repeat it, and went stale) |
| understand why there is no drift correction | "What the drift anchor taught us" |
| see the branch and deploy state | "Where things stand", immediately below |

## CLOSED 2026-10-16 and -17: the mixing artefact, fixed by option A

**Found 2026-10-16, FIXED 2026-10-17 by option A, deployed and rebuilt (next
heading): passes at different levels made cliffs where they covered different
stretches.** From Julian's
screenshot, the Ridgeway trailhead lot (38.7953,-104.8585) drew near-black;
terrain says 3 to 6%, and the map drew +19.5% (`28973/backward`), +25% at the
cap (`28974/backward`) and -25% (`19410/backward`). Replayed read-only through
`evalModelQuality.ts`'s steps, which reproduced all 21 stored buckets: each
ride's own profile is smooth, but after the one-offset-per-ride anchor the rides
sit at different levels (ride 54 on terrain, 84 about +10 m, 81 +16 m at its
start and +31 m at its end). Ride 81 read 12.4 m higher at the same spot 3 h
apart: barometer drift a constant anchor cannot follow. Where rides cover
different stretches of a line, the running mean changes membership from one
bucket to the next, and their level differences become steps that the 75 m fit
reads as 19 to 25%. City-wide, 48 rides replayed and 6,059 of 6,114 buckets
reproduced: mixing moves the colour more than one band (3 points) on 2.26 km of
the 90.8 km it can judge, on 66 of 958 lines. 63% of that has a pass from a
ride's first or last 5 minutes in the window, which is why trailheads show it.
It is 44% of the near-black climbs (0.28 of 0.63 km) and 13% of the dark red
(0.20 of 1.53 km). On those pieces the median distance from terrain is 4.9
points for the drawn slope and 2.9 for the passes' own slopes. Control: Ladders
`19475/forward`, the near-black Julian confirmed as right, is clean (drawn
15.3%, passes 13.7%, terrain 20.6%). Pre-existing since merging began; the
darker reds of 2026-10-14 made it visible, and `28974/backward` was that day's
25%-cap piece, put down then as a bad reading without being chased. Tools,
local and gitignored: `backend/tmp-mixing-census.ts` (the census),
`tmp-replay-lines.ts` (each ride's own heights for chosen lines) and
`tmp-slope-vs-terrain.ts`. Three fixes were weighed: align each new pass to
the model's level where they overlap (fails where passes do not overlap, the
lot's west path); anchor each pass to terrain instead of each ride (leans on the
terrain model's level everywhere, and sits close to the drift anchor, see "What
the drift anchor taught us"); or keep each pass's heights and draw each pass's
own slope. **Julian chose the last, option A, on 2026-10-16: the plan is the
next heading.**

### Done 2026-10-17: draw each pass's own slope (option A), deployed and rebuilt

**Shipped 2026-10-17, every check passed.** Each step ran on Julian's go-ahead
and passed its check before the next began:
- **(a) The table.** Migration 003 applied; the live table has the declared
  columns, the key, the cascading foreign key and 0 rows. `eval:query-types`
  now lists 12 timestamp lies: the 12th is `evalMixing.ts`'s copy of
  `processSession`'s samples query, the known class; every new statement was
  described, 93 of 93.
- **(b) The deploy.** `per-pass-slopes` rebased and merged (`26f4620`);
  `builtAt 2026-10-17T14:28:03.555Z`, stable over five reads. With no pass
  rows yet, live `/segments` hashed identical to before on three viewports
  (the lot, Ladders, the city), and `SEGMENTS_URL` `eval:mixing` matched
  all 751 segments. Live map requests ran 1.3 to 3.2 s that morning, but
  `/health` alone took 0.5 to 1.0 s: the network. In-process from this PC
  the old route had a 527 ms median and the new one 493 ms, byte-identical.
- **(c) The rebuild**, 14:35 to 14:53 UTC, 18.1 minutes (2.7 rides a
  minute; the estimate was 10 to 12). Snapshot first, 9,690 rows. After it:
  6,114 buckets unchanged (largest height change 0.000 m), 958 coverage rows
  unchanged, 2,618 match rows, 17,634 pass rows, every bucket's rows equal to
  its pass count and its mean. The map: 7.85 km of 94.59 changed colour, as
  previewed, 1.12 km of it by two bands or more. Largest flows: purple to blue
  1.09 km, yellow to green 1.06, green to blue 0.98. Mixing faked descents as
  well as climbs.
- **(d) The evals**, in-process and against production: PASS. 17,634 of
  17,634 stored rows reproduce the replay; the route matches on all 751
  segments; each pass's own slope draws 93.27 km and the means 1.32 km (pieces
  no pass covers two buckets of). The lot draws +2.1 / -0.0 / -3.8%, and its
  view's near-black stops went from 5 to 0; Ladders stays near-black at 13.7%.
  Breaking the route's pass query locally (`and false`) made the eval refuse:
  180 of 751 segments differed.

Left: step 7, `architecture.html` Parts 5 and 6 and the artifact republish,
deferred by Julian on 2026-10-17. A nit for the next backend change: when the
route check fails, `eval:mixing`'s REFUSED header counts it as one colour
stop. The rebuild's report, CSV and progress log were written to the session
scratchpad and may not outlive it; the numbers above are the record.


**Where it stood, 2026-10-16, before shipping.** Steps 1 to 5 below are done on branch
`per-pass-slopes` (`0312447`, then `1b53982` from the review), pushed and
NOT merged: merging deploys, and that code fails every ride save and every map
request until the table exists. Julian held the production steps ("not yet")
and kept this task to the notes. Left: step 6, then step 7, each on his
go-ahead. The plan as written follows this block; where they differ, this
block is what was built.

- **The eval (step 1).** `npm run eval:mixing`, `src/scripts/evalMixing.ts`
  on the branch. With the speed filter, all 6,114 of 6,114 stored buckets
  reproduce: the 55 were the filter, not old code. Through ride 89, median
  |slope - terrain| in points, the means then each pass: 2.09 and 2.01 on all
  93.27 judged km; 2.38 and 2.25 on pieces two or more passes cover; 4.91 and
  2.87 where mixing moved the colour. Within one band of terrain on the
  multi-pass km: 57.9% to 60.2%. The lot draws +2.1 / -0.0 / -3.8% (terrain
  +5.8 / +3.2 / -8.3); Ladders stays near-black at 13.7%. A rebuild repaints
  7.85 km of 94.59, 2.26 km of it by more than one band. Its preview hands the
  new server code the replay's passes and checks all 5,218 stops against its
  own each-pass slope; with the server made to ignore them it refuses (452
  stops). It also calls GET /segments end to end, in-process once the table
  exists, or at `SEGMENTS_URL`: against production before the migration, all
  751 segments matched. Every connection it opens is read-only.
- **The estimator.** Count-weighted, as planned. The alternative, pooled least
  squares (one slope, a level per pass), tied: the rule written before the
  first run settled 2.25 against 2.26 for count-weighting.
- **The table (step 2).** `003_pass_buckets.sql`: `segment_pass_buckets
  (match_id, distance_m, elevation_m)`, keyed on (match_id, distance_m),
  cascading from `session_segment_matches`. Normalised rather than the plan's
  copy of segment and direction, so nothing can disagree: the route joins the
  match rows, whose index serves it. Run on PGlite, an in-memory Postgres:
  applied twice, the save path, the route's query, both cascades.
- **Save and draw (steps 3 and 4).** As planned; the merge loop is now
  `mergeRuns`. The route sends its three id queries together, so the fourth
  costs no extra round trip (live /segments took 1.0 to 1.9 s).
- **Tests (step 5).** 463 backend tests on the branch, 446 on main. 19 of 19
  mutants killed, among them today's behaviour, which fails THE LOT.
- **Review.** One cold critic: PASS, at 181k tokens against an 80k ask.
  Fixed from it: a NaN guard (an overflowing average threw in
  `colorForSlope` and failed the whole map), full-precision heights in the
  save test (rounding to the centimetre survived), and the route end to end in
  the eval. Left, in item 5: no gate test runs SQL; the pass query grows with
  rides, not road; `processSession` has no gate test (pre-existing). The
  critic's mutant scripts in the scratchpad restore files from copies taken
  during its run, so running one after an edit reverts the edit; it did once.

**To finish (step 6, done 2026-10-17), in this order, each on Julian's go-ahead.** About 60k
tokens. (a) `npm run migrate -- src/db/migrations/003_pass_buckets.sql`, read
it, then the same with `--apply`; check `select
to_regclass('segment_pass_buckets')` is not null. (b) Rebase
`per-pass-slopes` on main, merge, push; verify `builtAt` moves; then
`SEGMENTS_URL=<production> npm run eval:mixing` must report every segment
matching and the means drawn on all 94.59 km. (c) The rebuild, under
"Background jobs and backfills", with four gitignored tools in `backend/`,
each tested read-only on 2026-10-16: `npx tsx tmp-rebuild-rides.ts` (49
rides; the model holds 48, and the 49th, ride 10, has 2 fixes and no runs);
`npx tsx tmp-rebuild-snapshot.ts <dir>` (6,114 / 958 / 2,618 rows); `npm run
rebuild-model -- --dry-run`; the real run, its output to a log, with `node
tmp-rebuild-monitor.mjs <log> <file holding the start time in ms>
<progress.log>` every few minutes; then `npx tsx tmp-rebuild-report.ts
<snapshot dir> <csv>` for the model and the map before and after, with a
per-stop CSV (`tmp-rebuild-diff.mjs` beside them is the 2026-09-29 rebuild's
diff, superseded by it). About 10 to 12 minutes in one transaction (44 ms a round trip
from this PC). **Julian must not save a ride while it runs.** Expected: every
bucket unchanged, 7.85 km repainted. (d) `npm run eval:mixing`: every bucket's
passes on file, stored rows equal to the replay, the route matching, the lot
fixed; then break the route's pass query locally (`and false` on its `where`)
and see the eval refuse, since only now can that check fail. Never drop the
table while this code is deployed.

**What it changes.** Today a piece's slope is the least-squares fit over the
MEAN heights of its window (`slopeAt` in `gradientBuilder.ts`), so passes at
different levels covering different stretches make steps. After: the slope is
the mean of each pass's OWN least-squares slope over the same window, weighted
by how many of the window's buckets the pass covers, from passes covering at
least two; clamp to ±25% after averaging. Level differences between passes then
cannot reach the slope at all. The window stays buckets i-2..i+3 by index, as
today, and each pass contributes its rows at those distances.

**Outcome to measure, written before building.** Success is judged by terrain,
not by the mixing figure: once the slope IS the passes' slope, "drawn minus
passes" is 0 by construction, the house defect if reported as a pass. Targets,
pinned to a named ride: on the pieces mixing moved more than one band (2.26 km
through ride 89), median |drawn - terrain| from 4.9 points to about 2.9; the
whole judged map's median |drawn - terrain| no worse than before (it must be
measured first, it is not in the notes); the Ridgeway lot's three lines go from
+19.5 / +25 / -25% to roughly +2 / 0 / -4%; and the control, Ladders
`19475/forward`, stays near-black (passes 13.7%).

**Steps, in this order.**
1. **The eval first, on `main`.** Promote `backend/tmp-mixing-census.ts` to
   `src/scripts/evalMixing.ts` with `npm run eval:mixing`. Add the speed
   filter its replay skipped (`rejectImpossibleSpeeds`, exported from
   `positionSpikes.ts`, which `processSession` runs first), then see whether
   that closes the 55 of 6,114 buckets it did not reproduce; if not, say why
   (rides merged under older code would be a rebuild question). Report
   merged-height slope, per-pass slope and terrain slope per piece, the targets
   above, the lot and the control. Run it on `main` and record the baseline.
2. **Migration `003_pass_buckets.sql`**, idempotent like 002, and the same
   table in `schema.sql`: `segment_pass_buckets (match_id bigint not null
   references session_segment_matches(id) on delete cascade, segment_id bigint
   not null references segments(id) on delete cascade, direction text not null
   check (direction in ('forward', 'backward')), distance_m integer not null,
   elevation_m double precision not null, primary key (match_id, distance_m))`,
   plus an index on (segment_id, direction). One row per merged pass per
   bucket: 17,634 rows through ride 89, the sum of today's pass counts.
   Additive only. The cascade means
   `rebuildModel.ts`'s `delete from session_segment_matches` (line 54) clears
   it with no new code there: check that before relying on it.
3. **Save path.** In `processSession`'s merge loop (`sessionProcessor.ts`,
   about lines 355-371), make the `session_segment_matches` insert
   `returning id` and insert that run's buckets into the new table with the
   SAME anchored heights `mergeBuckets` was given (the `anchorM == null`
   branch included). Test: the stored rows equal what was merged.
4. **Draw path.** `routes/segments.ts` gets a fourth query (pass rows for the
   viewport's segments); `segmentsWithLines` joins them (extend
   `segmentsResponse.test.ts`: the bigint join trap that file documents applies
   to `match_id` too); `buildDirectionalGradientLines` takes them as an
   optional fourth argument defaulting to none, so every existing caller and
   test is unchanged. **Use the pass rows only when they account for every
   merged pass**: for every bucket in the window, rows at that distance equal
   its `sampleCount`. Otherwise fall back to today's `slopeAt`. That makes the
   deploy a no-op until the rebuild (no rows yet), and stops a new ride's rows
   from outvoting the older passes that only the mean holds.
5. **Tests, each seen failing first where it can.** The lot as a fixture,
   `28974/backward` from the replay (ride 54 at 60-90 m on terrain, 84 about
   +12 m at 75-90, 81 about +31 m at 75-105, 84's other pass about +9 m at
   105-135): +25% today, near 0 after, and the test fails on today's code. A
   single pass draws exactly today's slope. Passes covering the same buckets at
   different levels draw exactly today's slope (least squares is linear in the
   heights, so the mean of slopes equals the slope of the mean). Rows short of
   `sampleCount` fall back to exactly today's slope. A pass covering one bucket
   of a window adds nothing. The clamp holds after averaging. The `/segments`
   response shape is unchanged, so no APK.
6. **Production, each step only on Julian's go-ahead.** (a) Apply the migration
   BEFORE merging the code: `npm run migrate -- src/db/migrations/003_pass_buckets.sql`
   prints it, `--apply` runs it. The code writes to and reads from the table,
   so deploying first would fail every ride save and every map request.
   (b) Merge and deploy; verify by `builtAt` moving; live `/segments` for a
   viewport must hash the same as before, the fallback with no rows yet. (c) The
   rebuild is a production write: run the "Background jobs and backfills"
   protocol (snapshot buckets, coverage and matches first: 6,114, 958 and 2,618
   rows through ride 89, well under 100k; progress log; before/after report and
   CSV). Run `npm run rebuild-model -- --dry-run` first, then the real run.
   The rebuild also replays every ride under
   today's code, so the report has to separate that from the slope change:
   after it, the eval can show the merged-height slope and the per-pass slope
   side by side on the same rebuilt data. (d) `eval:mixing` and
   `eval:quality` against the targets; Julian reopens the app at the lot.
7. **Docs.** `architecture.html` Part 5 (merging) and Part 6 (limits, open
   problems; "Ideas already tried" gets the two rejected fixes above), and
   republish its artifact page, which already lags by the colour bands of
   2026-10-14.

**Size and cost.** Large: a schema change, the save path, the draw path and a
rebuild. About 150k to 250k tokens with the tests and one cold critic, scoped to
the slope maths, the fallback rule and the migration order, rather than a
fan-out. Re-estimate before starting, and check the running total at each step
against 1.5 times the estimate. The pass rows also give the planned press and
hold (below) each line's pass count and per-ride detail for free.

## CLOSED 2026-10-10 and -11: the old NEXT items 1 to 4

Kept for the record and for the references into it ("old NEXT item 3" and the
like). Nothing here is queued.

### Old item 1. ~~Grade session 85~~ DONE 2026-10-10: rides 85 to 88 all `alive`

Graded together with rides 86, 87 and 88, which landed after it. Results and a
display defect found on the way are under "HOW TO REBUILD THE APK, AND HOW A
RIDE IS GRADED".

### Old item 2. ~~A fix from an ended ride is filed under the next one~~ CLOSED 2026-10-10: measured, nothing to build

Counted over every stored ride (`backend/tmp-close-items.mjs`, gitignored,
read-only). 34 of the 50 rides with an ordinary `started_at` hold exactly one fix
stamped before it, their first, half of them 2.4 s early or less. 84's 21.0 s is the only one
over 10 s and the only one that matches the ride before (1 m from 83's last fix,
the control, reproduced). It is on the map, as the first fix of a stored run,
but harmlessly: a place the rider passed 22 s before 84's own fixes began, 91 m
back at 4.1 m/s, its height equal to the next barometric one. Eight other first
fixes sat 30-175 m from where their ride's own fixes begin; none reached the
map. "Recorded while the previous ride ran", judged by `ended_at` (10, 12, 14,
84), is not evidence: `ended_at` is the server's `/end` time, which can lag the
Stop. The mechanism behind 84's was never located, and one harmless fix in 50
rides does not justify locating it. Two facts found on the way, neither claimed
as a defect:
- `rejectElevationSpikes` keeps a ride's first fix by construction
  (`elevationSmoothing.ts:147`), and nothing in the pipeline reads
  `elevation_source`, so a first fix's GPS height is merged like a barometric
  one. In 68, 82, 84 and 87 it equals the next barometric height to 0.1 m; in
  73 (2026-09-07) it sits 19.2 m above a barometric fix 114 s later, which could
  be terrain or GPS error.
- Session 29's `started_at` is 23.2 h after its first fix, so all 791 of its
  fixes predate it: the row was created long after the ride. Cause unverified;
  the recovery path (bug 22) would fit.

### Old item 3. ~~The 9 m barometric outlier~~ CLOSED 2026-10-10: the filter already removes it

**The premise was wrong.** `rejectElevationSpikes` DOES reject session 84's
19:35:04Z fix, run on the stored ride through production's own filters
(`backend/tmp-close-items-2.mjs`, `-3.mjs`): the rider was nearly stopped, 3.1 m
in 25 s and 3.6 m in 11 s, so 9.21 m over the shorter leg is a 296% grade
against the 100% limit. The notes below reasoned "at riding speed an 11 s leg is
tens of metres" and never ran it; the filter has not changed since 2026-10-02.
The fix never reached a bucket. Across every ride it is the only one 9 m or
more off the line between its barometric neighbours, 1 in 24,157, so the
migration, app change and APK rebuild that would diagnose it are not worth
building.
Smaller single-fix excursions are a different thing: 40 fixes sit 3 m or more
off (13 of 4,605 since the 2026-10-03 APK, 27 of 19,552 before it, ride 62
among them), often in twos and threes around one bad reading. 35 of the 40 pass
the filter and all lie inside stored matches. Their effect after smoothing and
averaging is unmeasured.

### Old item 4. ~~The matcher's two open levers~~ MEASURED 2026-10-10 and -11: keep both as shipped

**The instrument:** `traceSession` takes `minPassM`, the witness's floor, and
`npm run eval:heading-lines -- --tangent A,B --witness 15` and
`npm run eval:tangent -- A,B --witness 15` run at it, `MIN_SPAN_M` untouched.
With no flags both print what they always printed (control: `eval:heading-lines`
byte-identical to `main` over 48 rides). A floor below `RETRACE_M` is refused,
because `findPasses` cannot see a shorter leg and the report would claim a
witness that never ran. 7 new tests; 5 mutants, all killed.

- **`TANGENT_WINDOW_M`: measured, and the case for moving it got WEAKER.
  Recommendation: leave it at 10; Julian's call.** 48 rides. Lost ground (wrong-dir + gate),
  10 m against 14 m: 1419 -> 1012 m at the default floor, 2212 -> 1914 m at
  15 m, so 14 m still wins by 298-407 m (0.11% of 260 km covered), all of it
  wrong-dir; gate is 22 m worse at 15 m. Covered +0.47 km summed over rides,
  buckets +20, discard 12.1% -> 13.4%. **But the lines:** 14 m draws 3 and
  drops 4, and at the 15 m floor 3 of the 4 dropped are real ground, 80 m drawn
  nowhere: `#7560` Red Rock Rim 39 m, `#50577` Palmer Point 28 m, and `#60243`,
  a 17 m Palmer Point footway whose street goes blank. At the 25 m floor that
  was 28 m: `#60243` was `no-witness`, and `#7560` gains a second, short pass
  whose fixes go nowhere. The 3 it draws are 2 consolidations and a 9 m stub:
  **no new ground, no phantom removed.** So 14 m's win is ride-level, passes
  feeding the right direction of lines drawn anyway (harmless to the gradient,
  since buckets hold heights at physical positions), and its cost is lines
  that disappear. Outputs: `lines-t10-14-w15.txt` and siblings, scratchpad of
  session e24d4bb5.
- **The traversal gate: swept with the 15 m witness (`npm run eval:gate`,
  2026-10-11). The old conclusion is reversed at run level and the trade is
  too small to act on at line level. Recommendation: keep 25 / 0.7.** The rule
  is now one function, `qualifiesAt` (`elevationAggregator.ts`), which
  production and the sweep both call, with its first direct tests. Controls:
  the witness never moves with the gate (22,806 pass comparisons, 0
  disagreements), no looser arm draws less, and the shipped arm reproduces
  `eval:tangent`'s 10 m row exactly (962 lines, 260.27 km, 12.1%). 48 rides:

  | gate | runs admitted | witnessed | denied (near floor) | new lines: real | next door | phantom |
  |---|---|---|---|---|---|---|
  | 22 / 0.7 | 19 | 12 (284 m) | 7 (0) | 3 (72 m) | 2 (47 m) | 1 (23 m) |
  | 20 / 0.7 | 29 | 20 (453 m) | 9 (0) | 3 (114 m) | 5 (110 m) | 1 (23 m) |
  | 18 / 0.7 | 45 | 32 (681 m) | 13 (4) | 6 (171 m) | 8 (206 m) | 2 (41 m) |
  | 15 / 0.7 | 71 | 54 (1043 m) | 17 (8) | 14 (306 m) | 14 (320 m) | 3 (59 m) |
  | 25 / 0.5 | 55 | 37 (563 m) | 0, 18 unjudgeable | 4 (113 m) | 12 (159 m) | 3 (55 m) |
  | 22 / 0.5 | 72 | 47 (797 m) | 7, 18 unjudgeable | 6 (161 m) | 14 (206 m) | 4 (78 m) |

  **Runs:** most of what a lower span admits is ridden ground, 0.31-0.58
  denied per witnessed, against the 2.75 phantoms per real the 25 m witness
  reported. The known cases come back as real: `#25830` Chamberlain (the 0.692
  near-miss), `#18849` South Wahsatch (once a phantom by 1.1 m), `#37523`
  Brenner Place. **Lines:** the gain is 72-306 m of new ground (0.03-0.12% of
  260 km), and the sign depends on "next door": here it is ground the shipped
  gate already draws, painted on a SECOND line, which is duplicate paint, not
  the wash it is in `eval:heading-lines`. Ride 88's corner turn onto Vermijo
  (`#17778` backward, 20 m) is one. Counting it neutral, 18 / 0.7 nets
  +130 m; counting it as cost, -76 m. The coverage door (0.5) is worse on
  every line measure (0.67-0.75 phantoms per real, 6 lines unjudgeable).
  Moving the gate needs a `rebuild-model`; at these stakes it is not worth one.
  What would change the answer: a per-line look at 18 / 0.7's 8 next-door
  lines, to sort duplicate paint from short connectors the neighbour only
  brushes. Outputs: `gate-sweep-w15.txt`, scratchpad of session e24d4bb5.
See "What is left for the matcher".

## Where things stand

**Current state is in "STATE" at the top.** This section keeps the
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
orange → red → dark red → near-black red (steepest climb).

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
   - `rejectImpossibleSpeeds()`: drop a fix only when reaching it AND leaving it
     would both need more than 20 m/s, which is a signal off a building
   - `rejectElevationSpikes()`: drop fixes whose height implies a grade over
     100% against their neighbours, BEFORE smoothing, since smoothing an
     impossible reading smears it across its neighbours instead of deleting it
   - `smoothElevations()`: zero-phase (forward then backward) filter over the
     elevation series, so it damps noise without the lag a one-pass EMA has
   - `matchSamplesToSegments()`: heading derived from the fixes either side,
     against the segment's local tangent (10 m either side), with hysteresis and
     a 6 m disconnect penalty → runs; `stitchFragmentedRuns()` rejoins runs on
     one segment+direction under 45 s apart
   - `assessRun()`: **discard runs that only clipped the segment** (the gate,
     `qualifiesAt`), then project onto the line and bucket by 15 m of
     distance-along-segment; `clampCoverageToPassage()` extends a kept run's
     drawn extent to a join the rider came through
   - `ensureDemElevations()` + `fitAnchor()` — **anchor the whole ride to
     the terrain model with one median offset**
   - `mergeBuckets()` — **upsert a running mean**
   - write `session_segment_matches` for the runs that were merged
4. `GET /segments?minLon&minLat&maxLon&maxLat` → `buildDirectionalGradientLines()` (windowed-regression
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
    13 of 13 mutants die. **Then fixed at the driver** (built from 2026-10-05,
    shipped 2026-10-10, `6d6b174`):
    `db/pgTypes.ts` makes every int8 a number in every process, int8 arrays
    too, so the nine fields in the shared types and every uncast `count(*)`
    became true at once, join partners together. `npm run eval:query-types`
    now asks the database for every query's column types and checks them
    against the declared row types; it found two lies the hand search had
    missed, and the timestamp one, measured negligible on 2026-10-10 (NEXT, "Parked"). **Rule: the row type on a
    query is an assertion. Only the database can check it.**
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

32. **Tidying a result overwrote why it ended.** `growPath` drops the
    unmeasured tail of a path, so a selection never ends where nobody rode,
    and its first version then replaced the stop with `gap`. A fork 40 m past
    the last data lost the branches the rider was meant to hold, and a
    `limit` there read as final, so the phone would never have asked again
    from the tip: **145 of 958 growths through ride 89 stopped for the wrong
    reason (54 forks, 2 limits)** with all 22 core tests green, caught by the
    cold review running an untrimmed copy on live data. Fixed in `5ccbc35`:
    the stop keeps its reason and branches, and `aheadM` says how far ahead
    it lies. **Rule: a step that changes what a result holds must not change
    why it ended; carry the reason through, and add a field for the distance
    between the two.**

33. **The eval judging the history rule passed with the history rule
    deleted.** `eval:path` passed when "history first" beat the least turn,
    the design's own wording, but names and turns alone beat the least turn
    (608 against 548 of 810 forks), so `DEFAULT_RULES` without `"history"`
    still printed PASS: the house defect again, a check that cannot fail on
    the change it exists to catch. Fixed in `5ccbc35`: it must also beat the
    same rule without history, and with history removed it exits 1. **Rule:
    an eval of one part must be shown to fail with that part removed, not
    only with everything swapped for a baseline.**

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

The release APK on the phone is from `54c4365` (`lastUpdateTime 2026-10-21
18:47:33`). To rebuild and reinstall after a change:

```
cd mobile/android && ./gradlew :app:assembleRelease
"$ANDROID_HOME/platform-tools/adb.exe" install -r \
  app/build/outputs/apk/release/app-release.apk
```

**From Git Bash on this PC** (2026-10-17): the shell has no `ANDROID_HOME`,
and gradle then fails with "SDK location not found"; give it per command,
`ANDROID_HOME='C:\Users\Julian\AppData\Local\Android\Sdk' ./gradlew
:app:assembleRelease`, and adb is
`/c/Users/Julian/AppData/Local/Android/Sdk/platform-tools/adb.exe`. A first
build takes about 3 minutes, a rebuild after JS changes under one. To try a
gesture without Julian's hands: `adb shell input swipe X Y X Y 2500` is a
2.5s hold at pixel X,Y (dp times 2.625 on the Pixel 10 Pro), `input tap` a
tap, `input keyevent KEYCODE_BACK` back; screenshot with `adb shell
screencap -p /sdcard/x.png` then `adb pull` with `MSYS_NO_PATHCONV=1`, or
Git Bash rewrites `/sdcard` into a Windows path. The screen locks after 10
minutes; `adb shell svc power stayon usb` keeps it on while plugged in, only
with Julian's OK, and `svc power stayon false` puts it back (it was 0).

**To check an APK carries a commit** (2026-10-21), by content, since two
quick checks mislead. The bundle is Hermes bytecode: `grep` without `-a`
prints one "Binary file matches" line whatever the string, and Hermes stores
a string that is the start of another inside it (`selection-scrub` has no
copy of its own beside `selection-scrub-dot`). File times mislead too: a
branch switch rewrites them. Instead, compare the sha256 of the APK's
`assets/index.android.bundle` (`unzip -p`) with
`android/app/build/generated/assets/react/release/index.android.bundle`,
then each app file's `sourcesContent` in
`android/app/build/generated/sourcemaps/react/release/index.android.bundle.map`
(paths written `/src/...`) with the committed file. On 2026-10-21: 19 of 19
identical, and `04484a4`'s `SelectionCard.tsx` differs, so the comparison
can say no. After `adb install -r` the system restarts the app at once, so
`am start -W` reports WARM; for a cold start, `am force-stop` first (no ride
recording), then `am start -W -n
com.anonymous.cyclingdataapp/.MainActivity` and `logcat -d --pid=` the new
process.

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

**Graded 2026-10-10: rides 85 to 88, all `alive`.** Each has exactly one GPS
fix, its first, the same as 84, and none after it. Every ride was ended
(`ended_at` set), and no session 89 existed.

| ride | date (UTC) | fixes | barometric | minutes | unseen | verdict |
|---|---|---|---|---|---|---|
| 85 | 10-04 | 2689 | 2688 | 127.0 | 12.2 min (10%), longest gap 165 s | alive |
| 86 | 10-08 | 252 | 251 | 11.1 | 0.7 min (6%), 39 s | alive |
| 87 | 10-08 | 212 | 211 | 10.3 | none | alive |
| 88 | 10-10 | 99 | 98 | 5.3 | 1.1 min (21%), 68 s | alive |

**What this does not show:** nothing records whether the screen was locked
(`session_samples` has no such column), so these clear the barometer wherever
fixes arrived, and 84 is still the only ride graded with known deliberate locks.

**The per-minute strip misprints a 95-99% minute as `10`, two characters.**
`sourceStrip` in `backend/src/scripts/verifyBarometer.ts` prints
`Math.round(share * 10)`, so 27 of 28 barometric becomes `10`, every later
minute shifts one column, and ride 88's strip `10BBBBB` reads as "10%, then
0%". Also in the strips of 70, 71 and 79. Verdicts never read the strip, so no
verdict was wrong; the fix is capping the digit at 9, with a test. NEXT item 2.

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

**[Re-run 2026-10-11 with the 15 m witness this section asks for: `npm run
eval:gate`. Run level reversed (most admitted runs are ridden ground); line
level too small to act on. Kept at 25 / 0.7. See old NEXT item 4.]**

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
   closed on 2026-10-04, then REOPENED the same day" below, and item 4 of
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

**[Re-measured 2026-10-10 with a 15 m witness: still ahead on lost ground, but
it drops 80 m of real lines and draws no new ground. Left at 10. See NEXT
item 4.]**
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
the sweep was run. **It was old NEXT item 4, measured 2026-10-10 and -11: both levers kept as
shipped.**

**Build first: a witness that can see under 25 m.** `findPasses` at
`minPassM = 15`, `MIN_SPAN_M` left at 25, so the witness is independent of
whatever is being swept. `findPasses` already takes the threshold as an option,
so this is a measurement, not a change. Everything below is unjudgeable without
it:
1. **The traversal gate.** [Swept 2026-10-11 with the 15 m witness: keep
   25 / 0.7, see old NEXT item 4.] Open, see above. Needs a `rebuild-model` if moved.
2. **`TANGENT_WINDOW_M`.** [Measured 2026-10-10 with the 15 m witness: leave at
   10, see old NEXT item 4.] Reopened: 14 m is 286 m better than the shipped 10 m
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

### What landed on 2026-10-10

**Every bigint now arrives as a number, and there is a check that the code's
row types match the database.** Item 1 of the 2026-10-05 handoff, built on
`global-int8-parser` from 2026-10-05 to 10-10 and merged at `6d6b174`, with
several stops on the way (the account's session limit, context saves, and a
stop at Julian's request), each saved by a commit.

1. **`db/pgTypes.ts`** replaces node-postgres's int8 parser, and its int8-array
   parser, with `bigintId`; `db/pool.ts`, which builds the only Pool, imports
   it, so the server and every script get it before their first query. An id past 2^53
   fails that query with the value in the message: pg catches a throwing parser
   and rejects the query, it does not crash (pinned against pg's own `Query`
   in `pgTypes.test.ts`). `numeric` stays text.
2. **`npm run eval:query-types`**, new: walks the TypeScript program for every
   query call, describes each statement on the live database (Parse + Describe
   + Sync inside `BEGIN READ ONLY`, a savepoint per statement: nothing is bound
   or executed, not even an `INSERT ... RETURNING`), and judges the declared
   row type against what the configured driver delivers. **Run on `main`'s
   code and driver it reports 56 lies, 44 of them ids declared `number`
   arriving as text, plus 3 untyped sites**, so it can fail. On the branch: 82
   sites, **0 numeric lies, 0 untyped reads**, and 11 timestamp lies, measured
   negligible (NEXT, "Parked"). A call counts as pg's by the declaration it RESOLVES to, however it
   is spelled. It FAILS on a statement it cannot read when the code reads the
   result (a wrapper's parameter is named outright), on rows typed `any` that
   the code reads, on a Submittable other than its own, on an unquoted
   camelCase alias, and on finding no queries at all. The one module it cannot
   see into, osm-pipeline's `linkPlan.mjs`, is named in its report.
3. **Fallout fixed:** `findHoles.ts` would have crashed (`padStart` on a
   number; now `String()`, with a test whose fixture comes from the driver's own
   parser); seven row fields declared int columns as `string`; six `Number()`
   wrappers had become no-ops, one under a comment saying ids arrive as text;
   and `evalLinkerFold.ts`'s header still argued its cross-directory import could
   not affect the deploy, the reasoning note 29 records as having broken one.
4. **The handoff spec was wrong twice, both found by checking it, not by
   trusting it.** "No test imports pool.ts": six do, through the script each
   tests. "Five row types declare a bigint as `string`": the census found
   seven lies, including `evalLinkerFold`'s `parent` and a count typed
   `string` that was wrong under both drivers.
5. **The census had blind spots, found by its own tests and a cold review.**
   It matched on pg's declaration, so a client typed as `{ query(text) }`
   (`verifyRebuild`, `traceOutAndBack`) was invisible. The review then found it
   skipped, IN SILENCE, a bound copy of `query`, element access, a plain client
   given a variable, a config object, a choice of constants, and every column of
   an index-signature row; and 13 of the review's 14 mutants survived, because
   the verdict and the read-only guard lived in `main`, where no test reached.
   All fixed and tested. Two pieces of code proved dead under mutation and are
   gone: a span-by-span template reader (TypeScript 5.9 folds a template of
   constants into one string literal type in every context) and an explicit
   `getApparentType`. And one statement failing to describe would have aborted
   the transaction and failed every describe after it: shown against the live
   database with a control, and fenced with savepoints.
6. **The join this whole change protects had no gate test.** The review moved
   the route's bucket lookup onto a text id and all 371 tests passed. The join
   now lives in `services/segmentsResponse.ts`, moved unchanged out of the
   route, and its test feeds it rows from the configured driver: the bucket
   lookup must colour the line and the coverage lookup must set its extent.
7. **The cold critic's round 2 (2026-10-06) failed it, and was right.** The
   census passed rows typed `any` that the code read, the findHoles crash among
   them. Production's driver could round past 2^53 with every test green,
   because only "84" was checked. And the census's own `main()` was untested:
   two plausible edits, executing instead of describing and dropping READ ONLY,
   would have run `rebuildModel`'s three DELETEs against the production model
   in autocommit, with every test green. Also: the census's scope was never
   checked on the real program, Submittables were dropped in silence, "only one
   Pool" was a comment, and the routes' wire contracts were untested. Fixed on
   2026-10-08. Untyped reads fail. `runCensus` holds the command, and a
   recording fake pins every message it sends. `pool.test.ts` pins exactness
   and scans the source for a second Pool, a parser override or a stray
   `setTypeParser`. Route tests pin both ids as JSON numbers over HTTP.
8. **Round 3 (2026-10-08) confirmed all of that closed and failed it on pg's
   own switch.** `pg.defaults.parseInt8 = true` installs int4's parseInt
   (rounds past 2^53) and `= false` puts pg's text parser back; one line in
   `src/index.ts` did either with every test green. Fixed twice over. A
   `CheckedPool` in `db/pool.ts` asks, on every checkout (which every
   `pool.query` is), whether the int8 and int8[] parsers are still the ones
   `pgTypes.ts` registered, and fails the query with the reason if not: every
   spelling, every process. And the source scan flags `parseInt8` and every
   spelling of a second Pool it was shown. Also: an argument typed `any` now
   counts as a possible callback or Submittable; code the census cannot read
   fails it unless `ACCEPTED_OUTSIDE` says why it is safe (linkPlan.mjs is the
   one entry); and the command's wiring runs over the real program in a test.
9. **Round 4 (2026-10-08) confirmed that closed and failed it on minor
   findings only.** A Pool given `types` of its own got past a tripwire that
   read only the registry, because pg asks a client's own types first; and the
   callback checkout that every `pool.query` uses had no healthy-path test.
   Fixed: each checkout also checks the client it hands out, through pg's own
   lookup, refuses a binary client, and releases a refused client with the
   error so pg-pool drops it; a healthy query is tested both ways.
10. **Round 5 (2026-10-09) confirmed that closed and failed it on minor
    findings and nits.** The failed-connection path had no test (two one-line
    slips would have hung every request through an outage, or crashed the
    server); `binary ||= 1` got past a check for `=== true`; per-query
    parsers under a computed key, `{ ["types"]: t }`, got past the scan; a
    callback cast `as unknown as any[]` passed the census. Fixed: a
    failed-connection test; binary judged by truthiness, as pg judges it; the
    scan rewritten so each name counts as an identifier in listed places and as
    a string or template literal anywhere; the census treats a cast argument as
    opaque and reads callbacks and statements by the value under the cast.
11. **Round 6 (2026-10-10) confirmed that closed and failed it on two more
    spellings the scan's comment claimed**, a TypeScript import alias (`import
    P = pgx.Pool`) and a constructor parameter property `types`, plus five
    nits. All seven fixed in `9b68a1f`. **Then Julian stopped the review loop
    (2026-10-10)**: rounds 4 to 6 each found only unusual spellings at the edge
    of what a scan that reads syntax claims, at about 200k tokens a round. So
    this shipped without a critic PASS, on his decision. The scan's comment
    (`db/pool.test.ts`) now says it reads syntax, lists every spelling it
    catches, and calls anything else beyond it; the checkout refuses the
    Pool-level ones in production whatever their spelling. A test pins
    `db/pool.ts`'s exports to the pool alone.

**Verified, each against a control that could fail:**
- **14 read-only scripts**, each run from a frozen copy of `main` and then of
  the branch, back to back, with a data fingerprint around every pair
  (unchanged for all 14): **13 byte-identical**, and `prune-sessions` differs
  only in printing `'5'` as `5`. Includes `trace-passes`, the pinned replay the
  spec asked for, and every eval that keys a Map or a Set on an id.
  `eval-smoothing` exits 1 on BOTH sides: its own verdict on the smoother, not a
  crash (it runs all 45 rides and every number matches); see NEXT item 3.
- **Live `/segments`, rehearsed before the deploy** by running the branch's
  server locally against the same database: 745 segments, 951 lines, 5,181
  colour stops, the hash of the whole response `0a2be04de99909af` identical to
  production's, ids now numbers. **The control**, the same server with the
  bucket lookup handed a text id: status 200, 745 segments, **0 lines, 0 colour
  stops**, exactly the silent failure the spec warned of, and the hash moved.
  Repeated after the join moved into its own module: the same hash. **Repeated
  on 2026-10-08 for the checkout tripwire**, after rides 86 and 87 had landed:
  production and the branch both `ba5cd316e15be6e4` (746 segments, 953
  lines), and main and the branch re-run on that data for `find-holes`,
  `verify-barometer` and `prune-sessions`, with the same result as before.
  Repeated on 2026-10-09 for the per-client check: production, the branch and
  production again, all `ba5cd316e15be6e4`.
- **After the deploy**: `builtAt` moved to `2026-10-10T15:14:32.196Z`, and production's
  `/segments` matched its own probe from just before the merge: same hash,
  746 segments, 953 lines, 5,194 colour stops, ids numbers.
- The production build in a copy of `backend/` with no siblings, as note 29
  requires, and the compiled `pool.js` under plain `node` (round 2); then
  production itself on 2026-10-10.
- **196 mutants**, each run against the whole gate suite and, when the suite
  missed it, the typecheck: 192 killed, every critic survivor among them, and 4
  equivalent controls survive by design (the import's position in `pool.ts`,
  `findHoles.test.ts`'s redundant import, the pass-through parser check, and a
  join keyed by `String()`, the hardening a deleted test used to block). An
  earlier "54 mutants, all as expected" had not been re-run after a change;
  round 2 caught it. Round 2's "equivalent" S14 (int8[] syntax read by the int4[]
  parser) was not: its refusal names a rounded value, and the new pool test
  catches it. Round 5's runs found three new mutants surviving: two (CB6, CB7)
  for want of a fixture line, since added, and one (R33) because the code it
  broke had become dead, since removed. The harness is
  `backend/tmp-mutate-int8.mjs`, gitignored; it and every run's output are in
  `/tmp/int8-parser/critique/`.
- **Cold critic:** round 1 was cut off by the account's rate limit before its
  verdict, and its evidence drove item 6 and most of item 5. Rounds 2 to 6
  each failed it (items 7 to 11), rounds 4 to 6 on minor findings and nits
  only; it shipped without a pass, on Julian's decision (item 11). Round 6's report: `/tmp/int8-parser/critique/round6/critic/critic-round-6.md`.
- 429 backend tests (328 before), 56 app tests, typecheck clean.

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
- **[WRONG, corrected 2026-10-10: the filter rejects it; the rider was nearly
  stopped. See old NEXT item 3.]**
  **A 9 m barometric outlier survives spike rejection** (session 84,
  19:35:04Z). `rejectElevationSpikes` charges deviation against the shorter
  horizontal leg at a 100% grade limit, and at riding speed 9 m reads as an
  ordinary hill. One fix in 1367. **The fix worth doing is not the filter, it is
  persisting `readingCount` and `meanOffsetMs`** from `altitudeAtFix`, so the
  next one is diagnosable after the ride instead of needing eyes on the status
  line during it. Small migration, two doubles per sample.
- **A buffered fix from an ended session is attributed to the next one.**
  **[Measured 2026-10-10: harmless, one case in 50 rides. See old NEXT item 2.]**
  Session 83's last fix landed in session 84, 21 s before session 84 began.
- ~~**`SessionVerdict.id` is typed `number` and arrives as a string.**~~
  **FIXED 2026-10-04** (paid-for #30), with `bad_share` alongside it. The
  wider class -- nine more fields, joined to each other -- **fixed at the
  driver, shipped 2026-10-10** (`6d6b174`).

**Test and doc debt:**
- **The linker's own measuring tools have no tests**, flagged by the third cold
  review and still true.
- ~~**`context/architecture.html` is over a month stale.**~~ Rewritten
  2026-10-11 (3rd edition).

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
  it through.** **[WRONG, corrected 2026-10-10: it does not. 9.21 m over a 3.1 m
  leg is a 296% grade, rejected. See old NEXT item 3.]** At 19:35:04Z, on a steady climb: 2070.58 m, then −9.14 m over a
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
  **[Measured 2026-10-10: harmless, one case in 50 rides. See old NEXT item 2.]**
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
- ~~**`context/architecture.html` is a month stale.**~~ **Rewritten 2026-10-11
  as the 3rd edition**, a full pass rather than the targeted one suggested
  here, because its audience widened to feature designers. Last touched `61e48fa` on
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
- ~~**Nine more database numbers are typed `number` and arrive as text.**~~
  **FIXED by option (b), at the driver, shipped 2026-10-10** (`6d6b174`,
  "What landed on 2026-10-10"). The join-partner warning below is why it had to be (b): one
  parser moved all nine together. Kept for the record.
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

  **[Re-run 2026-10-11, 48 rides, the current classifier: the `gate` column above
  predates `9c13174` and is superseded.** The derived row is now the shipped one
  and reproduces `eval:gate`'s shipped row exactly.

  | heading | wrong-dir | gate | both drawn | merged | discard | buckets | covered km | lines |
  |---|---|---|---|---|---|---|---|---|
  | device | 43 (1941 m) | 4 (141 m) | 251/479 | 2553 | 18.0% | 17034 | 260.49 | 973 |
  | **derived, shipped** | **26 (1240 m)** | 4 (179 m) | 259/478 | 2535 | **12.1%** | 17014 | 260.27 | 962 |

  The conclusion stands and all of the gap is now wrong-dir: lost passes
  47 / 2,082 m -> 30 / 1,419 m (36% / 32%, against 44% / 44% before), discard
  18.0% -> 12.1%. "It also halves `gate`" was the old classifier's; gate is 4
  under both. Over 34,220 fixes the headings still split 1.32% of the time by
  more than 90 degrees. **]**

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

  **[Re-run 2026-10-11, 48 rides, the current classifier, every arm on the shipped
  derived heading. The `gate` column above predates `9c13174`, and the three
  "derived" rows were dropped from the script: once derived shipped they were
  copies of the shipped arm and two filter arms.** The `off` row reproduces
  `eval:gate`'s shipped row exactly.

  | rule | wrong-dir | gate | both drawn | discard | buckets | covered km | lines |
  |---|---|---|---|---|---|---|---|
  | off (shipped) | 26 (1240 m) | 4 | 259/478 | 12.1% | 17,014 | 260.27 | 962 |
  | spikes 8 m / 0.3 | 26 (1263 m) | 4 | 256/477 | 11.4% | 16,891 | 259.75 | 960 |
  | spikes 10 m / 0.5 | 23 (1146 m) | 4 | 258/478 | 11.8% | 16,984 | 260.21 | 962 |
  | spikes 12 m / 0.5 | 24 (1178 m) | 4 | 258/478 | 12.0% | 17,005 | 260.21 | 962 |
  | spikes 15 m / 0.5 | 23 (1150 m) | 4 | 259/478 | 12.0% | 17,011 | 260.26 | 962 |

  The verdict stands: the best arm recovers 3 passes / 94 m (0.04% of 260 km)
  and no line, and the aggressive one now LOSES 23 m and 0.51 km. Gate is 4
  under every arm, so the filter still touches only direction. **]**

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

Docs, both published as Artifacts:
- `context/architecture.html`: the full system walkthrough, **rewritten
  2026-10-11 as the 3rd edition** for feature designers as well as coders and
  republished to the "Gradient Field Manual" artifact. Every number in it was
  checked against the code and the live data that day. It goes stale the way
  the 2nd edition did: when a threshold, a stage of the save path, or the
  worked example's data (segment 12555) changes.
- `context/backlog.html`, **still behind the code**: six open questions on recording mountain trails. Its
  slope-window figures hold; its framing of GPS altitude as the weak source is
  **superseded**.

Throwaway diagnostic scripts live in `backend/tmp-*.mjs` (gitignored). Several
are worth keeping in mind rather than rewriting: `tmp-impossible.mjs` measures
unconnected run transitions, `tmp-outandback.mjs` detects out-and-back
traversals without using bearings, `tmp-carriageway.mjs` tells a divided
highway from a genuine gap, and `tmp-noise.mjs` compares elevation noise across
every session.

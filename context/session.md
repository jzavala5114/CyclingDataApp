# CyclingDataApp — project context

Working notes for picking this project back up. Covers what exists, why it's
built the way it is, and the failure modes already paid for.

Last updated 2026-09-23. **Start with "The sliding anchor is gone"** — that
decision is made and the code is deleted. Everything in this file about the
ramp being live, parked, or awaiting a decision is history, kept for the failure
modes it records. Nothing else here has changed.

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
   - `smoothElevations()` — EMA over the elevation series
   - `matchSamplesToSegments()` — nearest segment + bearing + hysteresis → runs
   - `profileRun()` — **discard runs that only clipped the segment**, then
     project onto the line and bucket by 15m of distance-along-segment
   - `ensureDemElevations()` + `fitDemOffset()` — **anchor the whole ride to
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

*(as of 2026-09-13)*

- **Network**: 66,684 segments over 38.71–38.97 N, −104.90 to −104.75 W —
  central Colorado Springs plus the northwest suburbs and Ute Valley Park.
  47,015 canonical; 17,020 pavements and unnamed sidepaths folded into parent
  roads. Every road stays canonical. **2,643 more are tagged
  `is_sidewalk` and were never folded** — see the Stage 1 section.
- **Model**: **5,953 buckets across 739 segments**, 946 coverage rows, 1,792
  matched runs, 0 implausible. Rebuilt 2026-09-24 onto the zero-phase smoother —
  see "The merge and the rebuild". Lines are clipped to what was ridden. These
  carry the single-number anchor, which is now the only anchor there is — the
  sliding version was deleted on 2026-09-23 after four reviews. See "The sliding
  anchor is gone".
- **Rides**: **39 usable**, measured by `eval:quality` on 2026-09-23 (36 on
  09-16, 34 on 09-13; the total session count was not re-measured). **Sessions 5 and 6
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
    `STITCH_WINDOW_S = 45`. **The window is measured, not chosen**: fragments
    cluster at 0–45 s (49 of 51) and separate crossings of the same block at
    90 s+, with nothing between — that gap is the whole basis for the number,
    so re-measure before changing it. Discards 169 → 94, fragments 75 → 2,
    while genuine clips held at 94 → 92, which is the proof that no phantom
    lines came back. No threshold moved.
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
  `rebuild-model` in `backend/`. `link` depends on `is_sidewalk`, which `split`
  populates — running it against segments from an older `split` silently
  absorbs nothing. `prune` must sit between `load` and `link`; see #27.
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
  single offset per ride cannot remove it; a drift term could, at the risk of
  absorbing real terrain.
- Every directional line currently comes from exactly one session, so
  **anchoring has not changed any rendered colour yet**. It is preventative: it
  pays the first time a street is ridden twice.

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

**Topology is already in the schema and unused.** Every one of the 47,015
canonical segments carries `start_node_id` and `end_node_id`; 23% are 150 m
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
`link_canonical.mjs` exists precisely to stop that. **2,643 of 19,663 tagged
sidewalks were never folded** (13.4%), because the linker's parallel test uses
`bearing_deg` — the chord — with a 20° tolerance, and `#23278` misses Hancock by
**one degree**. Forcing the road to win instead needs a 10m+ penalty, which is
what breaks Ladders. Fix the linker, not the number.

New scripts: `tmp-connect-sweep.mjs` (penalty sweep, reproduces the 10.1%
baseline at penalty 0 — check that before believing any other row),
`tmp-residual.mjs` (splits teleports from gate artefacts by hop count),
`tmp-connect-diff.mjs` (per-line gained/lost), `tmp-connect-detail.mjs`
(per-session, per-direction, for one street), `tmp-claim.mjs` (which segment
claimed these fixes, before vs after), `tmp-chain.mjs` (is a street's own chain
connected). All restrict to the sessions `rebuildModel` uses — measuring over
every session counts rides the model throws away.

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

Everything below this line is the history of the feature, kept for the failure
modes it records. **It describes code that no longer exists.**

---

## History: the sliding anchor after three rounds and four reviews

**Status 2026-09-19 — superseded by the section above. The code described here
was deleted on 2026-09-23.**

Four independent adversarial reviews have now rejected this feature. Every one
found the same class of defect in a new place: **evidence that is not
independent counted as a quorum, and a check that cannot fail reported as a
check that passed.** Round three's own fixes were three fresh instances of it.
That recurrence, not any single defect, is the finding worth carrying forward.

### Where the code is

| branch | state |
|---|---|
| `jzavala5114/fix-elevation-drift-b7815212` | PR #1, draft. 64/64 green. Round-1 defects fixed, lag fix merged in, ramp off. The reviewable baseline. |
| `jzavala5114/fix-elevation-lag-805d4615` | PR #2, draft. Zero-phase smoother, annotated as folded into #1. |
| `jzavala5114/drift-round3-wip-8f13d5f2` | Parked mid-round-three with 5 tests deliberately red. Superseded; kept as the record of what was parked and why. |
| `jzavala5114/drift-round3-13eeb398` | Round three, finished: `c1a250a`, pushed, no PR opened. 77 tests, typecheck clean. |
| **`fix-eval-gates`** | **Step 1 of the parked plan: the eval harness, 2026-09-20.** Off round three, not off main - `evalAnchorDrift.ts` does not exist on main. 126 tests, typecheck clean. The fit is untouched. |

Nothing is merged. `origin/main` is `9727a28` and has not moved. `allowRamp`
still defaults to false and `processSession` still never asks for a ramp, so no
saved ride is affected by any of it: the eval reports **8742/8742 untouched
buckets bit-for-bit identical** against an independent transcription of main's
`fitDemOffset`.

Full text of both reviews: `~/Desktop/DriftAnchor-Reviews-3-and-4.pdf`, 19
pages, technical report plus a plain-language translation.

### What round three fixed

The second review returned eleven findings. The parked WIP commit fixed the
three most severe and left five tests red, labelled "asserting rules this commit
replaces, they need rewriting". **Three of those five were right and the code
was wrong.** Round two's fix for "one comparison, one vote" had reintroduced
self-certification three times in fifty lines:

- The contradiction veto's allowance was anchored to what the ramp **claims**,
  so the bigger the claim the wider its own gate: a ramp asserting 12.39m
  against an observed 1.6m was allowed 7.19m of disagreement *because* it
  asserted 12.39m. Now the smaller of claim and observation.
- `collapseToObservations` dropped any pair whose interval matched a chain of
  two others without checking that its **rise** matched their sum. A pair that
  disagrees with a chain contradicts it rather than restating it, and it is the
  most valuable row in the set. Derivability now requires the arithmetic to
  hold to within `MIN_MEANINGFUL_RISE_M`.
- `netObservedRiseM` walked the chain greedily and took one observation's rise,
  handing the veto back to a single outlier row — the exact bug
  `LONGEST_OBSERVATION_TOLERANCE` exists to prevent, one branch over.

**And one defect no test in that file could have seen.** The chain selected its
joint set with `lateAtMs >= furthest * TOLERANCE` on **absolute timestamps**.
Every fixture in the suite starts its ride at `atMs 0`, where that line is
correct; on production epoch milliseconds a 5% band spans 85 years and admits
everything. Reach is a duration from where the chain stands now, and
`REGRESSION: the fit is shift-invariant` runs the same fixtures at four epochs.
**Generalise this**: any rule written as a ratio of two timestamps is invisible
to a suite whose fixtures all start at zero.

Also in round three: `largestCoveredBlock` maximises duration rather than member
count (member count was the currency the row-inflation defect was minted in);
`MIN_POINTS_FOR_ANCHOR` and `MAX_PLAUSIBLE_OFFSET_M` pinned with literals
instead of fixtures built from the constant under test; the ramp-end offset
check given its first test; `runElevationSource` exported and both it and
`siteKeyFor` covered for the first time; and the eval given a third outcome,
exit 2 `INCONCLUSIVE`, because it previously exited 0 having certified nothing.

`npm run eval:anchor` now exits 2 by design. Production would ramp **1 of 36**
usable rides; the eval, which withholds half of each ride's revisits, treats
**0**.

### What the fourth round of review found

Two reviewers, neither seeing the other, neither shown any build reasoning.
Both returned REJECT.

**Reviewer A, the tilt logic.** Three findings that let bad rides through:

1. **The chain overrides the veto and never consults evidence off its own path.**
   Verified by hand. Three revisits: `[0,60] +6`, `[20,120] -3`, `[55,115] +6`.
   The middle one watched 100 of the window's 120 minutes and measured the
   barometer going *down* 3m. The fit tilts the ride *up* 12m and reports the
   contradiction as **0.0000**. The dissent is excluded at
   `Math.abs(r.earlyAtMs - here) <= tol` because its start is 20 minutes in.
   General form: the chain's links come from the same members whose median set
   the rate, so `contradictionM ≈ 0` for any data whenever the majority is on
   the path. **Setting `chainRiseM = null`, deleting the whole 40-line branch,
   leaves all tests green and correctly refuses this fixture** — round two's fix
   is strictly weaker than the branch it overrides.
2. **The collapse invents a row nobody measured.** Two rows on one street at
   `[0,120] rise 1` and `[0,70] rise 8.5` overlap 0.583 of their union, so they
   cluster, and the endpoints and rise are medianed *independently* into
   `[0,95] rise 4.75`. That is 3 m/h exactly, agreeing with the majority, so the
   only observation with a claim on the whole window is gone and a correct
   refusal becomes a 6m ramp. The comment claiming a nested pair is not
   swallowed is false for every nested pair covering half the union, which given
   the 30-minute floor is every one inside a pass of 60 minutes or less.
3. **`allowedM` is still anchored to the observation in the direction that
   matters.** When the ramp over-claims, `Math.min` returns `|observed|`, so the
   ramp may always claim up to `1m + 1.5 ×` whatever the ride saw. The round-three
   comment claiming the minimum "closes both directions at once" is wrong: it
   closes the harmless one. Verified case applies +14.5m where the ride's own
   chain reports +9m.

Two more in the safe direction: a chain of 10+ equal links is walked taking
every other link, so a perfectly tiled ride is refused on a half-sized total
(and the code comment asserting this cannot arise is wrong on both its claims);
and the one-outlier fix only applies when competing passes fall inside a 5%
band. Two more on counting: `isDerivable` catches two-link sums only, so three
increments plus their total vote four times; and the quorum counts **places**
and never **moments**, so three rows sharing both endpoints satisfy a rule
written for three independent observations, on which shape `contradictionM ≡ 0`
by algebra.

**Eleven mutants of behavioural lines leave all 45 anchorFit tests green**,
including deleting the chain branch entirely. Three tests pass for a reason
other than the one they name.

**Reviewer B, the eval harness.** Three critical, all verified by execution:

1. **The safety proof can verify zero buckets and print as a pass.** Nothing
   asserts `untouchedChecked > 0`, so when every bucket has a treated
   contributor it prints `verified identical: 0/0` and exits 0. The reassuring
   8742/8742 and a vacuous 0/0 are indistinguishable to the gate. This is the
   NaN-comparison defect relocated: not "the comparison is always false" but
   "the loop body never runs".
2. **The verdict reads only the median.** `mean`, `p90`, `worst`, `worsened` and
   `worst_regression_m` are all computed and printed, and none is gated. Six
   comparisons improving 0.10m against five regressing **40m** exits 0.
3. **`inconclusive` asks "were there comparisons", not "could any have moved".**
   A scenario shifting every observation of a treated ride by 5m reports
   improved 0 / worsened 0 / unchanged, six PASSes, exit 0.

Also: `crossRideDisagreements` computes the **range** while its comment claims
it models the running mean the map actually draws, so it is blind to a
non-extreme ride moving; it has no held-out filter and is the only measure whose
value depends on the level; the eval re-implements `runElevationSource` instead
of importing it, which is the guard that caught session 76; and `siteKeyFor`
is unnormalised for case, so one OSM name variant splits a site and hands the
quorum a free vote.

Reviewer B confirmed the `previousAnchor` control is genuinely independent
(20,000 random point sets, 0 disagreements, and it diverges when either constant
is moved), and that main's `fitDemOffset` is faithfully transcribed. The knife
is sharp; the finding is that it can be pointed at nothing.

### The decision this is parked on

The plan agreed before compaction, in order:

1. **Fix the eval harness first.** **DONE 2026-09-20** on `fix-eval-gates`. It
   took two rounds, not the estimated hour, because a cold critic rejected the
   first. See "The eval harness, fixed" below.
2. **Then strip the ramp**, keeping what stands on its own: the instrument rule
   (a GPS pass against a barometric one measures the offset between two sensors,
   not drift — this caught session 76 asking to tilt a real ride 20m with every
   other guard passing it), the zero-phase smoother, the terrain-shape eval
   measure, `usableSessions.ts`, the gate lane and the mutation harnesses.

**The case for stripping is not that the code is bad.** It is that the archive
does not hold the evidence the feature needs, so every honest round of fixes
shrinks its reach: it now reaches one ride in thirty-six, and reviewer A's
closing line is a prediction that a fifth review finds the same pattern in a
fifth place.

## The eval harness, fixed, and the archive moved under it

**2026-09-20, branch `fix-eval-gates` off `drift-round3-13eeb398`.** Step 1 of
the plan above. **The fit is untouched**: `allowRamp` still defaults to false,
`processSession` still never asks for a ramp, step 2 has not started.

### First, a correction to the status above

**"`npm run eval:anchor` now exits 2 by design ... the eval treats 0 rides" is
stale.** It exits **0** and treats **session 77**. Verified by running the
*unmodified* `325f166` eval as a control: it does the same, so the archive
changed, not the code. Sessions 77 and 78 arrived after 2026-09-16; 77 has six
revisits over half an hour and ramps at -6.12m. Production would ramp 2 (74, 77).

Do not read that green exit as the ramp being vindicated. It says: on the one
ride this archive can treat, the ramp improved all three measures on every gate.
Reviewer A's findings are about the *fit*, are untouched by this work, and
describe shapes the archive does not contain.

### What the harness looks like now

`services/evalMeasures.ts` holds the three measures, the untouched-bucket proof,
the pairing and the verdict rule, taking `heldOutKeys` as an argument instead of
closing over a module global. `scripts/evalAnchorDrift.ts` loads rides, fits
anchors and prints; it decides nothing. **That extraction is the load-bearing
change** - none of the rest could ship with a test while importing the module ran
the eval against the production database.

`evalMeasures.test.ts`: 49 tests. `tmp-mutate-evalmeasures.mjs`: 40 mutants, 38
defects all killed, 2 controls both survive. Backend suite 77 -> 126.

Five gates where there was one (`after.median <= before.median`):

| gate | catches |
|---|---|
| non-finite | a value the harness cannot read. Checked FIRST, because NaN silences the rest |
| median | the typical comparison getting worse |
| mean | "helped many a little, hurt a few enormously" - total error must fall |
| count | more comparisons hurt than helped while the aggregates hold |
| worst regression | one impossible movement drowned in a good aggregate |

Plus INCONCLUSIVE when a treated-scope measure had no power, and the proof
reporting vacuity both globally and per ride.

### Two rounds, because a cold critic rejected the first

Round one fixed reviewer B's F1-F7, F9 and F10. A critic with no sight of the
build reasoning returned REJECT with eleven findings, and it was right. **The
pattern recurred for the fifth time**, in four fresh places:

- **One NaN disabled two gates.** `Math.max(NaN, 293.5)` is NaN and `NaN > 15`
  is false, so a single unreadable comparison switched the mean and
  worst-regression gates off *for the whole measure* - while the sign test's
  `else` filed it as a regression, padding the count gate in the passing
  direction. Harm that disables the alarm and then pads the register. History
  defect 2 relocated out of the untouched proof, where it had just been fixed,
  into the verdict function written in the same commit.
- **The proof's coverage is per bucket; its premise is about rides.** A bucket
  with a treated contributor is skipped whole, so an untreated ride sharing
  every bucket with a treated one is never checked, while another ride's private
  buckets keep the printed count affirmative. That ride was then also filtered
  out of the treated measures and lived only in the whole-archive line, which is
  never gated. It could be 40m out and exit 0. Now reported as
  `uncheckedSessions`.
- **"Held out on every contributor" was `some` in disguise.** `heldOut` is a
  pure FNV hash of the bucket key and takes no session, so for any key either
  every contributor held it out or none did: 18,000 keys, zero disagreements,
  `every` keeps exactly what `some` would. The comment claimed a cost never
  paid, and the test pinning it built a state the script cannot produce. **The
  deeper half: the filter does not make the measure out of sample at all.** Only
  the *rate* is withheld. `points` is built from every bucket and both modes
  consume it unfiltered, so the **level** is fit in sample, and cross-ride is the
  one measure whose value carries the level.
- **`medianChangeM` took the upper of two middles.** A balanced set of changes
  printed a positive number by construction: fifty comparisons worse by 9m
  against fifty better by 10m read `median_change_m: 9.00` when the honest
  answer is -0.50 and total error had *fallen* 50m. Fixed the estimator rather
  than gating it, and recorded why: after the fix, a median-of-changes gate
  cannot fire anywhere the mean and count gates have not already.

Also: the proof could not see a bucket present only in `after`, which is the
direction it was written for; `improved === 0 && worsened === 0` let one
comparison in ten thousand license a verdict over the 9,999 that could not move,
a quorum of one; and the eval imported the two constants its own comment spends
ten lines arguing must never be imported.

**And one the critic did not find, which running the thing did.** The
frozen-majority rule fired on the whole-archive scope, where most comparisons
are untreated and identical *by construction* - that fixed unchanged mass is
exactly what the untouched proof exists to establish. It reported the design as
a defect on every run. The rule is scoped to the treated population now.

### What this cost the measures, measured on the real archive

| | before | after | why |
|---|---|---|---|
| self-consistency comparisons | 269 | 162 | revisit gap 300s -> 1800s, matching the fit |
| cross-ride comparisons | 2146 | 1077 | held-out filter, ~50% as the hash predicts |
| terrain shape comparisons | 5338 | 5338 | untouched, and therefore the control |
| treated cross-ride frozen | **54 of 465** | **0 of 253** | the range was blind to non-extreme rides |

That 54 is F4 measured rather than argued: under `max - min` between per-ride
means, 54 treated comparisons could not respond to the treatment at all.

### Known and deliberate, not oversights

- **No measure here sees a uniform level change.** Self-consistency cancels the
  level between two passes, terrain shape subtracts each ride's own median, and
  cross-ride is mean absolute deviation, which is translation invariant. The
  drawn value can move 15m with all three reading unchanged. Tolerable because
  setting the level *is* the anchor's job. If the level ever becomes the
  question it needs a fourth measure - per-bucket drawn value, before against
  after - not an edit to cross-ride, which would stop answering what it is named
  for.
- **The worst-regression bounds are tripwires, not gates.** Derived for
  self-consistency and terrain shape: the reverse triangle inequality bounds a
  comparison's movement by the ride's own drift, which `fitDriftRate` caps at
  `MAX_TOTAL_DRIFT_M`. A judgement at 2x for cross-ride, which spans two rides
  and has no such derivation. No legitimate fit comes near either; they fire on
  the impossible, and the mean and count gates are what catch ordinary harm.
- **F8's `siteKeyFor` case and whitespace normalisation is NOT fixed.** It is
  production fit logic, not measuring logic, and changing it moves which rides
  get ramped, so it belongs to step 2. The mutants `name:${name.toLowerCase()}`
  and `?? ""` after trim both survive today. Under-normalising splits one road
  into two sites, which is the quorum-inflation class this feature has been
  rejected for three times.
- **The eval never fetches terrain**, while a rebuild calls
  `ensureDemElevations`, which does. So the eval refuses rides production would
  anchor, biasing `treated` down. Read a small treated count as partly an
  artefact of the harness rather than purely as the feature's reach.

**If the ramp is wanted anyway**, round four is a simplification rather than an
addition, and the design is settled: replace the chain walk, the joint veto and
the minimum-allowance rule with a single check comparing the ramp against
**every** member over that member's own interval,
`|rate × gap_r − rise_r| <= leak allowance`, with the allowance taken from the
measured leak model (a few tenths of a metre; `MIN_MEANINGFUL_RISE_M` is the
floor) rather than from either side of the comparison. That deletes
`netObservedRiseM` and kills findings 1, 3, 4 and 5 at once. It also needs the
collapse to cluster on **both endpoints matching** rather than on overlap
fraction (kills finding 2), derivability generalised to N links, and a gate
requiring more than one distinct time increment.

### Getting back into this

The work is in a session worktree, not the shared checkout:

```
C:\Users\Julian\.claude-worktrees\CyclingDataApp-1347402229\13eeb398
```

A worktree carries tracked files only, so bootstrap before the first test run:
copy `backend/.env` from the shared checkout and junction `backend/node_modules`
and `mobile/node_modules` to it (`New-Item -ItemType Junction`). The pre-commit
hook is opt-in per clone and is now enabled here
(`git config core.hooksPath .githooks`); it runs typecheck and the gate tests on
any commit touching `backend/`.

**The `.env` points at the live Supabase database**, shared with every other
session and with production. `eval:quality` is read-only (verified: no
insert/update/delete anywhere in it, and the one function that writes,
`ensureDemElevations`, is not imported). `PORT=3000` is a single-writer handle,
so do not start the server twice.

**The worktree instructions above are obsolete.** CLAUDE.md now sets
`git config claude.mode solo`: one session at a time, branches in the shared
checkout, no worktrees and no PRs. Restore the worktree protocol before running
two sessions at once.

### Tools worth not rewriting

One mutation harness, in `backend/` and gitignored with the other `tmp-*.mjs`.
It patches a copy, runs the suite, restores, and reports which test died. It
normalises CRLF before matching, which is why its patches apply at all on this
checkout.

- `tmp-mutate-evalmeasures.mjs` — the three quality measures. 21 mutants: 19
  defects killed, 2 controls survive, and one expected survivor
  (`passes.length < 2`, dominated by the revisit-gap check and documented at the
  line). Every mutant restores a defect a review actually found, so a survivor
  is a test that does not test what its name says. When its patterns go stale it
  reports SKIP rather than a false pass — preserve that if you rewrite it.

**Three others are gone**, and their absence is not an accident.
`tmp-mutate-anchor.mjs`, `tmp-sweep-constants.mjs` and `tmp-mutate-mapping.mjs`
all targeted the sliding anchor: its eight round-three fixes, its eighteen
constants, and `runElevationSource`/`siteKeyFor`. All of that code was deleted
on 2026-09-23, and the harnesses went with the worktree they lived in. Do not
recreate them expecting them to apply.

---

## The sliding anchor: five defects fixed, and it STILL does not ship

**Status 2026-09-14 — superseded by the section above; kept as history.**

All five defects are fixed on `jzavala5114/fix-elevation-drift-b7815212`, which
now also contains the zero-phase smoothing fix merged from
`jzavala5114/fix-elevation-lag-805d4615`. 64 gate tests, every fix mutation
tested, every guard constant pinned on both sides. `npm run eval:anchor` exits 0.

**And the ramp is switched off.** `allowRamp` defaults to `false` in
`anchorFit.ts`, and `processSession` calls `fitAnchor` without it, so every ride
saved through `POST /sessions/:id/end` gets the single number exactly as before.
That default IS the verdict; a verdict that lived only in prose would have
shipped the feature on the next ride saved.

Why it is off: with the gates corrected the eval treats **no rides at all**, and
production would treat **one** (session 74) out of 38. An earlier round, with
only four of the five fixed, treated two rides and made both worse on all three
measures. The feature is starved rather than subtly wrong — the evidence it needs
is close to absent in this archive.

The fifth defect is the one worth carrying forward: **a revisit that compares a
GPS-altitude pass against a barometric one measures the offset between two
sensors, not drift.** Session 76 read −3.49m at the head of Culebras Trail and
−17.96m at its end while every time gap was 31 to 32 minutes, which no drifting
barometer can produce. Its first lap fell inside a GPS stretch and its second was
barometric. Every other guard passed it and it asked to tilt the ride 20m.

Two things changed that are true regardless of whether the ramp ever ships:
`collectRevisits` now requires both passes on the barometer, and "distinct sites"
counts street names rather than segment ids (a segments row is one OSM way split
at every junction, so session 76's "15 distinct sites" were 15 pieces of one
trail).

Next lever, now unblocked by the zero-phase smoother: opposite-direction
revisits, 21 long ones declined against 30 kept. Needs the bucket index flipped
and its own measurement.

---

### History: the review that rejected the first version

**Status 2026-09-13 (superseded by the section above).** It passed 31 gate tests
and its eval exited 0, and it was still wrong. An adversarial review found
defects that the tests and the eval were both structurally unable to see. The
numbers below are real but they do not mean what they look like. All of them are
fixed now; kept because the failure modes are worth recognising again.

### The three that block it

**1. The ramp is applied across time nobody observed.** `fitDriftRate` sets the
window to `min(earlyAtMs)`..`max(lateAtMs)` — the *union* of the pairs, which
need not overlap or tile. Three 31-minute observations at 0, 100 and 209 minutes
produce a four-hour ramp. The rate is scale-free, so the per-pair leak is
multiplied by `window / gap`: rises of 1.6m each (the file's own quoted "median
disagreement 1.57m") yield a **12.39m** correction spanning −6.17 to +6.22m. The
code comment claiming the ramp is "linear only between the first and last moment
the drift was actually observed" is false for disjoint observations. Related: the
median of per-pair *rates* gives a 31-minute pair and a 4-hour pair equal weight,
so a pair that directly measured the applied window can be outvoted by short
ones — constructed case asserts a 15.5m slide over a span its own evidence says
moved 1.0m.

**2. The quorum of three is not three independent comparisons.** `collectRevisits`
emits every *pair* of readings in a cell, so N passes over one 15m cell yield
N(N−1)/2 pairs from only N−1 independent increments. Three passes over a single
bucket on a single street clear a quorum meant to need three independent
observations — the exact failure the code's own comment says it prevents, moved
up one level from buckets to passes. The sign gate is defeated at the boundary
too: rises of +2, +1, −1 give agreement of exactly 2/3, and `2/3 < 2/3` is false,
so it is accepted. **`sessionProcessor.test.ts` asserts this as correct
behaviour**, which is how it survived.

**3. The EMA lag is a same-signed bias that clears the floor on exactly the rides
this fires on — and the archive is worse than the code assumed.** The lag is
~2.3 samples; the question is whether it varies with speed. Measured across
17,092 steps: fixes arrive on a near-fixed **~2s time interval** (2.04s slow,
1.85s fast), so spacing tracks speed — **median 4.77m under 3 m/s against 11.83m
at 6 m/s and over**, and the same on both treated rides (73: 4.62/11.69,
74: 5.14/14.33). So a fast pass and a slow pass over the same ground differ by
~16m of lag, worth **~0.96m on a 6% grade and ~1.9m on 12%** — at or above
`MIN_MEANINGFUL_RISE_M`. `MIN_SIGN_AGREEMENT` is no defence because the bias is
same-signed by construction. And the rides that produce three same-direction
revisits 30+ minutes apart are hill repeats and loop laps: steep, with the rider
slowing as they tire. **The leak is maximally correlated with the population the
feature reaches.** A constructed ride with *zero* real drift, three steep streets
ridden twice with the rider slower the second time, yields a 6.30m ramp.

Note this also contradicts "Decisions made": the speed-derived GPS interval is
documented as holding fixes ~11m apart, and it does not — median spacing is
6.35m and it varies 2.5× with speed.

### The evidence was not evidence

**The headline safety proof is a tautology.** "6,346 of 6,346 untouched buckets
bit-for-bit identical" compares `fitAnchor(allowRamp:false)` against
`fitAnchor(allowRamp:true)` *after the latter fell back* — the same `flat()` in
the same function. It proves `flat() === flat()`, not agreement with the deleted
`fitDemOffset`. Its float comparison also scores a *missing* after-observation as
identical, since `Math.abs(x - NaN) > 1e-9` is false.

**The held-out split does not hold out what is fitted.** It splits by bucket key,
but the rate is learned from *pairs of passes*: the held-out cell and the fitting
cell are the same two barometer readings minutes apart. It removes cell noise,
not pass-level signal. `selfDisagreements` then scores the widest pair — the one
most likely to be ≥30 minutes and therefore in the fit. The "out of sample"
claim does not hold.

**Neither measure looks at the terrain model.** Both are self-agreement, so a
ride tilted 12m at its ends by defect 1 moves *away* from the DEM while its
self-consistency improves, and the eval cannot see it. The level is fitted to the
DEM and the DEM never grades the result.

Two tests also assert less than they claim: *"a real hill cannot be absorbed"*
never calls `collectRevisits` and passes against an implementation that pairs
opposite directions or different segments, and *"every rejection path returns
exactly the old single number"* compares the new code with itself.

### What is worth keeping regardless

`usableSessions.ts` (so anything measuring the model agrees with the model about
which rides count), the `npm test` gate lane, `.githooks/pre-commit`, and the
eval's paired before/after breakdown. Those stand on their own.

### The fork that needs deciding

Defect 3 is not a threshold to retune. Either the lag comes out of the signal —
a non-causal forward/backward smoothing pass, which changes every number in the
model and is its own task — or a revisit must require both passes at a similar
speed, which shrinks a population that is already two rides and may reach zero.
The measurements below were taken before any of this was known; they are kept
because they are real, not because they justify shipping.

## What the branch measured, before the review



Built 2026-09-13. The ride's correction used to be one number for the whole
ride; it is now a level plus a slope. The level still comes from the DEM. **The
slope deliberately does not** — see the struck-through open item above for the
measurement that killed that idea. It comes from *revisits*: places one ride
covered twice, where the ground and the DEM's error at that spot both cancel and
most of what is left is the instrument sliding.

`anchorFit.ts` holds the fit, `collectRevisits` in `sessionProcessor.ts` finds
the pairs, `evalAnchorDrift.ts` measures it, and 31 gate tests cover it in
0.5 s with no database.

**Measured over the 34 usable sessions:**

| | before | after |
|---|---|---|
| treated / self-consistency, median | 1.22 m | **0.89 m** |
| treated / self-consistency, p90 | 8.12 m | **4.78 m** |
| treated / cross-ride, median | 2.95 m | **2.63 m** |
| treated / cross-ride, p90 | 7.23 m | **5.18 m** |
| whole archive / cross-ride, median | 1.86 m | 1.87 m |

Self-consistency is scored **out of sample**: half of each ride's revisited
buckets are withheld from its own drift fit, because fitting on revisits and
then scoring on the same revisits is arithmetic, not evidence.

**Three things in that table need saying rather than glossing.**

**It reaches two rides out of 34.** Sessions 73 and 74, at −4.94 and −1.59 m/h.
The other 32 keep the single number and 0 are unanchored. That is not timid
guards, it is how seldom a ride measures its own drift — a revisit must be the
same segment, same direction and same 15 m cell at least half an hour apart.
`rebuildModel.ts` now prints the ramp/constant split for exactly this reason: a
run where nothing ramps is how this change would silently become a no-op.

The eval fits on half of each ride's revisits and scores on the other half, so
the rides it ramps are a *floor* on the rides production ramps, not the same
set — and the identical-bucket proof below would then cover less than it looks
like it does. So the eval reports both: fitting on every revisit the way
production does gives the same two rides, 73 and 74. Measured, not assumed.

**The whole-archive cross-ride median moved the wrong way, by 0.01 m, and that
is not noise.** If every changed comparison had weakly improved, no quantile
could rise — the sorted array would sit pointwise below the old one. A quantile
that rises is proof that individual comparisons got *worse*. So the eval now
pairs every comparison with itself before and after instead of leaving that to
be waved at: **cross-ride 201 improved / 153 worsened, median change −0.22 m,
worst regression +1.69 m; self-consistency 57 improved / 48 worsened, median
change −0.42 m, worst regression +3.68 m.** It helps most comparisons and hurts
some. The median of the *moved* comparisons sitting at −0.42 m rather than near
zero is what distinguishes real signal from added noise that happened to average
out favourably; a summary median alone could not have told those apart. Do not
let this metric acquire an unexplained floor the way the Stage 1 one did.

**Session 54 — the ride this was justified by — is not one of the two.** Its
7.36 m disagreement over 51 minutes is the number in `anchorFit.ts`'s opening
comment, and the shipped mechanism cannot see it: session 54's long revisits are
out-and-backs, 3 opposite-direction returns at up to 72 minutes against 1
same-direction. That is now written into the code comment rather than left to be
discovered, and the open item above says what it would take to reach them.

**Blast radius, proved rather than argued.** Every rejection path in `fitAnchor`
returns exactly the old single number, and the eval checks it: **6,346 of 6,346
buckets on untreated rides came out bit-for-bit identical.** That is what makes
"rides the change touched" an honest scope rather than a convenient subset.

Verification: typecheck clean, 31/31 gate tests in 0.53 s, eval exit 0. The
guards were mutation-tested — removing the ramp clamp, dropping the quorum from
3 pairs to 1, and zeroing the meaningfulness floor each failed exactly the tests
written for them, and nothing else.

New: `npm test` (gate tests) and `npm run eval:anchor`, both documented in
`backend/README.md`, plus `.githooks/pre-commit` running typecheck and gate
tests on any commit touching `backend/`. It is opt-in per clone:
`git config core.hooksPath .githooks`.

## Open items

- **Two directions on one path** (deferred). Roads get two ±4 m offset lines,
  as intended. Unresolved for genuine single paths, and coupled to putting
  lines exactly *on* a trail: removing the offset makes both directions overlap.
- **Keep the barometer alive with the screen off.** The measured 2× slope-error
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
- **Within-ride barometric drift.** Still open, and now **parked on a decision**
  rather than on work: three rounds built, four independent reviews, all
  rejected, same defect class each time. Read "The sliding anchor after three
  rounds and four reviews" before touching any of it — the obvious approaches
  are the ones already tried, and the last two rounds of fixes each introduced
  fresh instances of the bug they were fixing. This bullet's own suggestion,
  fitting the drift term against
  the DEM, was built and measured and is dead: it made each ride more consistent with
  itself and *less* consistent with other rides (cross-ride median 1.86 m →
  1.93 m), because within one ride where you are is correlated with when you
  are, so the line absorbs the DEM's own place-dependent error and tilts the
  ride to match it. Two rides crossing the same ground in opposite order then
  get opposite tilts. The slope comes from revisits instead. See the sliding
  anchor section below.
- **Use the out-and-back revisits too.** The named next lever for the sliding
  anchor, and it is not a matter of flipping an index. 21 of the archive's 51
  long revisits are declined because the two passes ran in opposite directions,
  against 30 kept — and one of the 21 is session 54, the ride the whole change
  was justified by. Realigning the bucket grid (forward `d` against backward
  `lengthM - d`) is the easy half. The hard half is that `smoothElevations` is a
  causal EMA whose lag points backwards along the *direction of travel*, so an
  out-and-back pair is displaced in opposite directions along the ground: the
  error is `2 × lag × grade`, about 1.2 m on a 6% street, it does not cancel
  even at identical speeds, and it is signed by gradient rather than random. It
  would read as drift on exactly the hilly rides this is meant to help. Using
  these pairs means removing the lag first — a non-causal (forward-backward)
  smoothing pass would do it, and would change every existing number in the
  model, so it is its own task.
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
- **NEXT: fold the 2,643 sidewalks the linker missed.** See the Stage 1 section
  below — this is now the biggest single lever, and it is a pipeline fix, not a
  matcher one. `link_canonical.mjs` tests "parallel" with `bearing_deg`, the
  chord, which this project already proved meaningless on anything that bends.
  **The risk is documented and severe**: the first geometric attempt at this
  chopped Shooks Run (−57), Midland (−35) and the Pikes Peak Greenway (−10) into
  disconnected pieces. Any change here needs the same before/after per-line diff
  the matcher changes get, and a check that no named trail loses segments.
- **Riding a segment both ways can draw only one direction.** Measured
  2026-09-02 by projecting fixes along the segment over time (no bearings): of 8
  genuine out-and-back visits, 3 segments lost a direction reproducibly across
  both rides, while Ridgeway Trail handled its out-and-backs correctly. One case
  is a genuine duplicate pair — unnamed `6432` beside named Chamberlain `10433`,
  each drawing the opposite direction, so the two passes split across two ways.
  Stage 1 should help; a cheaper partial fix is extending `link_canonical.mjs`
  to fold an *unnamed* path into a parallel named **trail**, not only into a
  road, which would resolve 8 of the 37 duplicate pairs. The other 29 are
  named-vs-named and no naming rule can touch them.
- **Stitched runs can have a hole in the middle.** Rejoined fragments contribute
  only their own samples; whatever was between them matched elsewhere or
  nowhere. Endpoints and coverage are right, but interior buckets may be
  missing, which renders as one long colour span. Pulling the intervening
  samples in would mean re-running the match, so it was left alone.
- **No position smoothing.** The EMA only touches elevation. A lateral multipath
  spike downtown (seen clearly on South Weber) passes straight through if it is
  inside the 30m accuracy filter. A jump filter rejecting physically impossible
  sideways movement would clip these cheaply.
- **Coverage gaps at block ends.** Coverage starts where the first fix landed,
  which on segment 12555 is 8.9m in — an honest 8.9m of unpainted road. 30% of
  canonical segments are under 30m and 3,883 are artificial 150m-cap slices, so
  there are many block ends and therefore many small gaps. Two fixes: clamp
  coverage to the full segment when a run has bookend fixes on *both* sides
  (it passed through), and bridge a gap under ~10m at draw time.
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
- **Saving a ride intermittently times out, and succeeds on retry.** Measured
  2026-08-30 against the live API with the same 250-sample chunk the app sends
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

Pushed through `48224eb` as of 2026-09-06. `origin/main` is current at
`9727a28`.

**Four branches are pushed and unmerged**, all of the drift-anchor work. None of
it reaches production: the ramp is off in code and `processSession` never asks
for it. See "The sliding anchor after three rounds and four reviews" for which
branch is which and what is blocking. Do not merge PR #1 or #2 without reading
it — both are draft, both are green, and both are rejected on substance rather
than on tests.

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

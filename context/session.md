# CyclingDataApp — project context

Working notes for picking this project back up. Covers what exists, why it's
built the way it is, and the failure modes already paid for.

Last updated after sessions 13–14 (the first rides to go from Stop button to
rendered gradient with no manual intervention).

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

- **Network**: 30,994 segments over ~11 × 9.5 km of central Colorado Springs
  (38.78–38.88 N, −104.88 to −104.77 W). 19,668 canonical; 11,326 pavements and
  unnamed sidepaths folded into parent roads. Every road stays canonical.
- **Model**: 767 buckets across 134 segments, **0 implausible**. 164 directional
  lines, from 206 merged runs (54 of 260 discarded as touches). Lines are
  clipped to what was ridden; the average one covers 0.96 of its segment.
- **Rides**: 15 sessions, 2,104 samples. Sessions 11–15 are good.
  **Sessions 5 and 6 are permanently corrupt** — `rebuildModel.ts` excludes
  them automatically by elevation scale (below).
- **DB**: 40 MB of Supabase's 500 MB.
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
    apiece off 0–8m of travel. A run now has to span 25m **or** 35% of the
    segment. Measured over 147 runs the populations barely overlap: touches
    span a median of 0m, real traversals 60m+. Costs 41 of 147 runs.
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

## Operational gotchas

- **Pipeline order is `fetch → split → load → link`.** `link` depends on
  `is_sidewalk`, which `split` populates — running it against segments from an
  older `split` silently absorbs nothing.
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

## Open items

- **Two directions on one path** (deferred). Roads get two ±4 m offset lines,
  as intended. Unresolved for genuine single paths, and coupled to putting
  lines exactly *on* a trail: removing the offset makes both directions overlap.
- **Record the elevation source.** `expo-sensors` has no background delivery, so
  a screen-off ride may be silently falling back to GPS altitude (±10–20 m
  vertical). Adding `elevation_source` + `altitude_accuracy_m` to
  `session_samples` would measure whether the battery work cost precision.
  Deferred once already; it also gates the two items below.
- **Barometer oversampling.** `recordBarometerAltitude()` overwrites and the
  task reads only the newest value, so most readings are discarded. Sampling at
  ~5 Hz and averaging is roughly a 4× noise cut for negligible power — but
  worthless if the sensor isn't running in the background, which is exactly
  what the item above would establish.
- **Weight by source/accuracy** — a barometer reading and a ±15 m GPS altitude
  currently count equally.
- **Within-ride barometric drift.** Anchoring fits one offset per session, which
  leaves the 3.52 m of drift across a ride untouched. A linear drift term fit
  against the DEM would take most of it, at the risk of absorbing real terrain
  on a ride that is genuinely uphill throughout.
- **A *named* path running beside a road still draws its own line.** That is
  deliberate — it is what keeps Shooks Run and the Greenway intact — but it
  means a named sidepath would double up on its street. None do so far.
- **`segment_dem_elevations` is populated lazily** by `/end`, one bounded burst
  of API calls per ride against OpenTopoData's public instance (~1000 calls/day,
  a ride costs ~4). Only OSM centreline coordinates are sent, never ride traces.
  If it ever needs to scale, download the 3DEP tile and sample locally.
- **Uncommitted**: DEM anchoring, speed-derived GPS interval, the traversal
  gate, `sessionProcessor.ts`/`rebuildModel.ts`,
  canonical linking (`link_canonical.mjs`, `is_sidewalk`), rendering fixes,
  regression slope, plus last session's crash fix, resume/orphan-task logic,
  viewport fetching, batched loader and Overpass fix.

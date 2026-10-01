# CyclingDataApp — project context

Working notes for picking this project back up. Covers what exists, why it's
built the way it is, and the failure modes already paid for.

Last updated 2026-09-27.

**Nothing is mid-flight.** The sidewalk fold is applied, rebuilt, merged and
deployed as of 2026-09-29 — see "The sidewalk fold". 744 paths folded, the
model rebuilt to 6,098 buckets across 749 segments, `main` at `8deb8fb`,
production serving `builtAt 2026-09-29T02:31:31.559Z`. Hancock `#17973` draws
15–90 m of its 91 m where it drew nothing, verified through `/segments` rather
than from the database alone. The first deploy attempt failed; see note 29,
which is worth reading before adding anything to `backend/` that imports
outside it.

Where to start depends on what you came for:

| you want to | read |
|---|---|
| know what the app is and how a ride becomes a coloured line | "What it is", "Layout", "Data flow" |
| change anything in the backend | "Bugs already paid for" — 29 failure modes, each one paid for once already |
| run a measurement before changing anything | `npm run` in `backend/`: `find-holes`, `diagnose-holes`, `trace-passes`, `eval:coverage`, `eval:tangent`, `eval:heading`, `eval:heading-lines`, `eval:linker` |
| touch the importer or the matcher | "Operational gotchas", then the pipeline sections |
| pick up the next piece of work | "Open items" — the `NEXT:` bullet, currently **the derived-heading ship decision**: measured, recommended, awaiting a call |
| understand why there is no drift correction | "What the drift anchor taught us" |
| see what is built, measured and waiting on a decision | "Branches awaiting a call", immediately below |

## Branches awaiting a call

Three branches are committed, tested and **not merged**. All three are
read-only or behaviour-neutral; none has touched the database or the deploy.
They stack: `enumerate-heading-lines` sits on `trace-out-and-backs`.

| branch | head | what it is |
|---|---|---|
| `fold-unnamed-into-trails` | `c3e919f` | Lets a named trail be a fold parent. **Measured and rejected** — 195 real duplicates found, but the matcher replay lost 4 lines, gained none and raised impossible transitions 7.1% → 7.9%. Ships switched off as `TRAIL_PARENTS_SQL`; the candidate query is byte-identical to `main`. Merge to record the negative result, or drop. |
| `trace-out-and-backs` | `a198b9d` | The pass detector, the trace, and three sweeps. **Adds no behaviour**: `headingSource` defaults to `"device"` and the device arm reproduces the pre-refactor numbers exactly (39 / 24 / 215/419 / 2228 / 18.4% / 14710 / 225.10 / 966). Merging deploys a no-op change and unlocks `npm run trace-passes`, `eval:tangent`, `eval:heading`. |
| `enumerate-heading-lines` | (this branch) | On top of `trace-out-and-backs`. `npm run eval:heading-lines`: names every line the two headings disagree about and gives each a verdict from the bearing-free witness. **Read-only, adds no behaviour.** This is the measurement the ship decision rests on. |

`main` is `e8b7a4d`. **`e8b7a4d` was committed directly on `main` rather than
through a task branch** — a slip, docs-only, left in place rather than
force-pushing a shared branch.

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
- **Model**: **6,098 buckets across 749 segments**, 0 implausible, rebuilt
  2026-09-29 after the fold. **54.6% of buckets are blended from more than one
  pass** — see the note under "Elevation accuracy", because that is the
  threshold where anchoring stops being preventative and starts setting rendered
  colours. Rebuilt onto the zero-phase smoother on 2026-09-24 (5,953 buckets
  then) and again after the fold. Lines are clipped to what was ridden, and
  **140 of the 966 drawn lines have a hole somewhere in the middle** — the
  current `NEXT:`, see "Open items". These carry the single-number anchor, which
  is now the only anchor there is; the sliding version was deleted on 2026-09-23
  after five reviews. See "The sliding anchor is gone".
- **Rides**: **41 usable** of 44 recorded, measured by `eval:quality` on
  2026-09-26 (39 on 09-24, 36 on 09-16, 34 on 09-13). **Sessions 5 and 6
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

### The 36 lines, enumerated — DONE, and the answer is ship it

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
discard rate. The answer is robust: sweeping the next-door share from 0.3 to 0.7
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

**If it ships** it needs a full `rebuild-model`: every bucket on the map today
was matched with the device heading. One line changes:
`segmentMatcher.ts` `headingSource = "device"` → `"derived"`.

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
- **67 of the 69 canonical covered segments draw nothing at all** — the other
  half of the tunnel story, and a different problem from the holes above. These
  are absent lines rather than gaps in lines: Union Boulevard Underpass, the
  Carefree underpasses, three pieces of Gold Camp Road, Sinton and Templeton Gap
  and Cottonwood Creek where they duck under a road. 2,344 m in total. They are
  physics and should stay unpainted, but the map has no way to say so, so they
  read as coverage still to be earned. Cheapest honest fix is to expose
  `is_tunnel` on `/segments` and have the app draw them in a flat "no data
  possible" colour. Nothing reads the column today.
- **`SessionVerdict.id` is typed `number` and arrives as a string.**
  `usableSessions.ts:52` declares `id: number`, but `sessions.id` is `bigserial`
  and node-postgres returns bigint as text. Found 2026-09-28 when
  `evalLinkerFold.ts` compared a session id against a `Set` of numbers, matched
  nothing, and printed `n/a` for its headline metric instead of a wrong number.
  Coerced with `Number()` at that call site only; **the type is still wrong and
  anything else comparing a session id has the same bug.** The fix is the type
  plus a pg parser or an explicit cast in the query, and it wants a test that a
  verdict's id equals the session it came from.
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
  67.9 m). The wider parent rule was built and measured anyway: it folds 195
  real duplicates but the full-matcher replay lost 4 lines, gained none, and
  raised impossible transitions 7.1% → 7.9%. Not shipped; see
  `TRAIL_PARENTS_SQL` on branch `fold-unnamed-into-trails`.
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
- **No position smoothing.** The EMA only touches elevation. A lateral multipath
  spike downtown (seen clearly on South Weber) passes straight through if it is
  inside the 30m accuracy filter. A jump filter rejecting physically impossible
  sideways movement would clip these cheaply.
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

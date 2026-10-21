# mobile

Expo (React Native + TypeScript) app: live map, start/stop tracking button,
GPS + barometric elevation recording that continues with the screen off.

## Important: this needs a native build, not Expo Go

`@maplibre/maplibre-react-native`, `expo-location`'s background task, and
`expo-task-manager` are all native modules, so the app can't run in the stock
Expo Go app. Build it once:

```
npm install
npx expo prebuild --platform android
npx expo run:android --variant release   # phone connected via USB or wireless debugging
# or
npx expo run:ios                         # requires a Mac + Xcode
```

A **release** build is what you want for actually riding: it bakes the JS
bundle into the APK, so the app runs with no connection to a Metro dev server
(and therefore no dependence on your computer being on). A debug build fetches
its JS from Metro at launch and shows "Unable to load script" away from your
network. The trade-off is that changing app code means rebuilding.

## Android permissions

Three of the entries in `app.json` are load-bearing and easy to remove by
accident:

- **`RECEIVE_BOOT_COMPLETED`** — not obviously about location, but
  `expo-task-manager` schedules a *persisted* JobScheduler job to deliver
  background fixes, and Android throws
  `IllegalArgumentException: Requested job cannot be persisted without holding
  android.permission.RECEIVE_BOOT_COMPLETED` the moment a fix arrives without
  it. Because the location task outlives the app, that crashes the app on
  every launch, not just once. Neither the `expo-location` nor
  `expo-task-manager` config plugin adds it.
- **`isAndroidBackgroundLocationEnabled`** — adds `ACCESS_BACKGROUND_LOCATION`.
- **`isAndroidForegroundServiceEnabled`** — adds the foreground-service
  permissions. Android requires a visible notification while recording; that
  notification is not optional.

On the phone, "Allow all the time" usually can't be granted from the in-app
prompt — go to Settings → Apps → CyclingDataApp → Permissions → Location.

## Before running

1. The app points at the deployed backend in `src/config.ts`. To run against a
   local `../backend` instead, set `API_BASE_URL` to your computer's reachable
   IP (not `localhost` — the request comes from the phone).
2. Segment data must be loaded first; see `../osm-pipeline`.

## What's here

- `src/screens/MapScreen.tsx` — the map, gradient rendering, and the
  start/stop tracking button
- `src/services/backgroundLocationTask.ts` — the `TaskManager` task that keeps
  recording with the screen off, the AsyncStorage sample buffer, the
  cruise/turn GPS power modes, and the barometer-to-GPS elevation anchoring
- `src/hooks/useTrackingSession.ts` — session lifecycle on top of that task,
  including resuming a ride that outlived the app and shutting down an
  orphaned task
- `src/services/gradientRendering.ts` — turns a segment's per-direction color
  stops into short colored `LineLayer` features for MapLibre
- `src/services/api.ts` — talks to the backend

## Press and hold on a line

Hold any coloured line to measure it. A selection starts under your finger
and grows ahead in that line's direction of travel (each line sits on the
right-hand side of the street for its direction) for as long as the finger
stays down; lift it to stop. The card at the top shows the streets, the
distance (feet under half a mile, miles from there), the climb and descent,
the average grade, the steepest 330 ft, a height profile in the map's own
colours with each band's share of the distance, how many rides the numbers
are built from, and what to do next.

- **Hold the selection** to carry it on from where you let go.
- **Hold another line near the end** to join it: the gap between is bridged
  at once, and growth carries on from the line you held. Near the start, it
  leads into the selection instead. With no way to the line from the end,
  holding on starts a new selection there; let go first, and the selection
  stays as it was and the card says so. The other way along a street is
  another line: holding it beside the selection joins it, never carries the
  selection on.
- **At a fork** growth stops and marks the ways on; hold the one you want.
- **Tap the selection** to remove that piece and everything after it, after
  one confirm. While the card shows a spinner a tap does nothing: the
  selection is about to change, and the piece with it.
- **⇄** turns it round: the same streets, on the other direction's lines,
  with that direction's own rides.
- **Drag along the height profile** to find a point on the map, as
  Trailforks' elevation chart does: a dark dot with a white ring marks the
  spot on the selection, a line marks it on the profile, and the card's
  numbers read how far in it is, its height from the start of the selection
  and the grade there ("no data" on unmeasured ground). Lift your finger and
  the dot goes and the totals come back. Only the finger that started the
  drag moves the dot; another finger on the screen does not. The profile does
  not answer while a finger is holding the map to grow the selection, and
  dragging on the map's line does not scrub (that line answers taps and
  holds). Heights are from the start, not above sea level: the server sends
  no absolute height.
- **×** or Android back clears it.

One answer is awaited at a time. A new hold that asks the server, a trim, a
flip or × calls off whatever the card was waiting on, and an answer that
arrives for something since replaced is dropped. An answer that lands after
you have panned or pinched the map fills in the numbers but leaves the camera
where you put it; a tap leaves it free to frame the selection.

The design, and why each choice was made, is in `../context/session.md`,
"Press and hold on a segment, designed 2026-10-17"; the server half is
`GET /segments/path` (`../backend/README.md`).

Where it lives:

- `src/services/selectionController.ts`: the hold as a state machine with no
  React and no map in it; the screen feeds it touches and draws its snapshots
- `src/services/pathSelection.ts`: joining, cutting and adding up a path; the
  card's numbers; the map's features
- `src/services/holdGesture.ts`: which line the finger is on, where along it,
  the stand-in drawn while the server answers, growth speed, and the layers a
  touch is tested against (`SELECTION_HIT_LAYERS`, which the layers are named
  from)
- `src/services/flipSelection.ts`: the flip, checked street by street
- `src/services/selectionStatus.ts`: the card's line saying what to do next
- `src/components/SelectionLayers.tsx` and `src/components/SelectionCard.tsx`:
  the selection on the map, and the card

Checking it:

- `npm test` runs the gate tests, synthetic paths and every gesture's flow
  against a fake clock and a fake server.
- `npm run eval:selection` runs the same logic over real answers from the
  live server, read-only, and passes only if every answer tiles, adds up and
  cuts cleanly and at least 90% of flips land on the same streets. It sends
  about 45 requests; don't run it while the backend is deploying.

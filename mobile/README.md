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

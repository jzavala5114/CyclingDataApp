# mobile

Expo (React Native + TypeScript) app: live map, start/stop tracking button,
GPS + barometric elevation recording.

## Important: this needs a custom dev client, not Expo Go

`@maplibre/maplibre-react-native` is a native module, so the app can't run
in the stock Expo Go app on your phone. You need to build a dev client once:

```
npm install
npx expo prebuild
npx expo run:android   # phone/emulator plugged in via USB with dev options on
# or
npx expo run:ios       # requires a Mac + Xcode
```

After that first native build, `npx expo start` and the Expo dev-client app
(or the build you just installed) work like normal for fast-refresh
iteration — you only need to repeat `prebuild`/`run:*` when native deps
change.

## Before running

1. Start `../backend` (see its README) so `POST /sessions` etc. are
   reachable, and load segment data via `../osm-pipeline`.
2. Edit `src/config.ts` — `API_BASE_URL` must be your computer's LAN IP
   (e.g. `http://192.168.1.23:3000`), not `localhost`, since the request is
   coming from your phone.

## What's here

- `src/screens/MapScreen.tsx` — the map, gradient rendering, and the
  start/stop tracking button
- `src/hooks/useTrackingSession.ts` — GPS (`expo-location`) + barometric
  altitude (`expo-sensors`) recording for one session
- `src/services/gradientRendering.ts` — turns a segment's per-direction
  color stops into short colored `LineLayer` features for MapLibre
- `src/services/api.ts` — talks to the backend

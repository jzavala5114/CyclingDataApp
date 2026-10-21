import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Dimensions,
  type GestureResponderEvent,
  Pressable,
  StatusBar as NativeStatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  Camera,
  type CameraRef,
  GeoJSONSource,
  Layer,
  type LngLatBounds,
  // Aliased: the unqualified name shadows the global Map constructor.
  Map as MapView,
  type MapRef,
  UserLocation,
  useCurrentPosition,
} from "@maplibre/maplibre-react-native";
import {
  type Bbox,
  deleteSession,
  endSession,
  fetchPath,
  fetchSegments,
  startSession,
  uploadSamplesInChunks,
} from "../services/api";
import { MIN_SAVEABLE_EXTENT_M, rideExtentM } from "../services/rideStats";
import { buildColoredLineFeatures } from "../services/gradientRendering";
import { useTrackingSession } from "../hooks/useTrackingSession";
import { describeBarometer, verdictFor } from "../services/barometerHealth";
import { dropBufferedSamples, readBufferedSamples } from "../services/backgroundLocationTask";
import { hitFromFeatures } from "../services/holdGesture";
import { pointOnPath } from "../services/pathSelection";
import { SelectionController } from "../services/selectionController";
import { createScrubStore } from "../services/profileScrub";
import { SELECTION_HIT_LAYERS, ScrubDot, SelectionLayers } from "../components/SelectionLayers";
import { SelectionCard } from "../components/SelectionCard";
import { MAP_STYLE_URL } from "../config";
import type { SegmentWithGradients, TrackedSample } from "../types";

const INITIAL_CENTER: [number, number] = [-104.8199104, 38.8266852];

// Press and hold on a line (context/session.md, "Press and hold on a segment,
// designed 2026-10-17"). The finger is tested against a box this many points
// either side of it: the two lines of a street sit 17 points apart at zoom 17.
const HIT_PT = 22;
// A finger that moves further than this before the long press is panning.
const MOVE_SLOP_PT = 10;
// Every other line fades to this while something is selected.
const FADED_OPACITY = 0.35;
// Letting go frames at least this much ground, so a short selection is not
// framed at street-furniture zoom.
const MIN_FRAME_M = 160;
// While a selection grows, the camera follows its tip once it is this close
// to the edge of the screen, as a share of the screen.
const FOLLOW_EDGE_SHARE = 0.18;
const HINT_SEEN_KEY = "pressHoldHintSeen";

// Grows bounds to at least `minM` on each side's span, about their middle.
function framedBounds([west, south, east, north]: [number, number, number, number], minM: number) {
  const midLat = (south + north) / 2;
  const halfLat = Math.max((north - south) / 2, minM / 2 / 111_320);
  const halfLon = Math.max((east - west) / 2, minM / 2 / (111_320 * Math.cos((midLat * Math.PI) / 180)));
  const midLon = (west + east) / 2;
  return [midLon - halfLon, midLat - halfLat, midLon + halfLon, midLat + halfLat] as LngLatBounds;
}

// Fetch a bit beyond the visible bounds so panning doesn't immediately expose
// blank streets, and don't refetch until the view has actually moved somewhere
// the last response didn't already cover.
const VIEWPORT_PAD = 0.2;

function paddedBbox([west, south, east, north]: LngLatBounds): Bbox {
  const padLon = Math.abs(east - west) * VIEWPORT_PAD;
  const padLat = Math.abs(north - south) * VIEWPORT_PAD;
  return {
    minLon: Math.min(east, west) - padLon,
    maxLon: Math.max(east, west) + padLon,
    minLat: Math.min(north, south) - padLat,
    maxLat: Math.max(north, south) + padLat,
  };
}

function covers(outer: Bbox, inner: Bbox): boolean {
  return (
    outer.minLon <= inner.minLon &&
    outer.maxLon >= inner.maxLon &&
    outer.minLat <= inner.minLat &&
    outer.maxLat >= inner.maxLat
  );
}

export function MapScreen() {
  const [segments, setSegments] = useState<SegmentWithGradients[]>([]);
  const [isFollowing, setIsFollowing] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const cameraRef = useRef<CameraRef>(null);
  const loadedBbox = useRef<Bbox | null>(null);
  const {
    isTracking,
    sessionId,
    startedAt,
    samples,
    unsavedRide,
    barometer,
    start,
    stop,
    adoptSession,
    discardBuffered,
  } = useTrackingSession();
  const currentPosition = useCurrentPosition();

  // ---- Press and hold ----
  const mapRef = useRef<MapRef>(null);
  const zoomRef = useRef(16);
  const viewRef = useRef<LngLatBounds | null>(null);
  const cardBottomRef = useRef(0);
  const [cardBottom, setCardBottom] = useState(0);
  const [hintSeen, setHintSeen] = useState(true);
  const segmentsById = useMemo(() => new Map(segments.map((s) => [s.id, s])), [segments]);
  const segmentsRef = useRef(segmentsById);
  segmentsRef.current = segmentsById;
  const topInset = (NativeStatusBar.currentHeight ?? 24) + 8;

  // The controller outlives every render; what it calls back into is read
  // through refs, so it always reaches the current camera and state.
  const fitRef = useRef<(bounds: [number, number, number, number]) => void>(() => {});
  fitRef.current = (bounds) => {
    setIsFollowing(false);
    cameraRef.current?.fitBounds(framedBounds(bounds, MIN_FRAME_M), {
      // Clear of the card above, and of Recenter and Start Tracking below.
      padding: { top: cardBottomRef.current + 24, bottom: 200, left: 44, right: 44 },
      duration: 600,
    });
  };
  const [controller] = useState(
    () =>
      new SelectionController({
        fetchPath,
        // One clock for both: a frame's time and `now` are compared.
        now: () => performance.now(),
        frame: (step) => {
          const id = requestAnimationFrame(() => step(performance.now()));
          return () => cancelAnimationFrame(id);
        },
        later: (run, ms) => {
          const id = setTimeout(run, ms);
          return () => clearTimeout(id);
        },
        fit: (bounds) => fitRef.current(bounds),
        onFirstHold: () => {
          setHintSeen(true);
          AsyncStorage.setItem(HINT_SEEN_KEY, "1").catch((err) => console.warn("failed to save the hint", err));
        },
      }),
  );
  const selectionMode = useSyncExternalStore(controller.subscribe, controller.getMode);
  // The point a finger on the card's profile picks, shared by the card and the map's dot.
  const [scrub] = useState(createScrubStore);

  useEffect(() => {
    AsyncStorage.getItem(HINT_SEEN_KEY)
      .then((seen) => setHintSeen(seen !== null))
      .catch(() => setHintSeen(false));
  }, []);

  // Android back closes the trim question, then the selection, before the app.
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => controller.back());
    return () => subscription.remove();
  }, [controller]);

  // A hold takes the camera off the rider, so it cannot jump mid-selection;
  // and while the selection grows, the camera keeps its tip on screen.
  useEffect(() => {
    if (selectionMode !== "holding") return;
    setIsFollowing(false);
    let lastMoveAt = 0;
    return controller.subscribe(() => {
      const { selection, grownM, mode } = controller.getSnapshot();
      const view = viewRef.current;
      if (mode !== "holding" || !selection || !view || Date.now() - lastMoveAt < 500) return;
      const tip = pointOnPath(selection, grownM);
      if (!tip) return;
      const [west, south, east, north] = view;
      const { height } = Dimensions.get("window");
      const top = north - ((cardBottomRef.current / height) + FOLLOW_EDGE_SHARE) * (north - south);
      const inside =
        tip.lon > west + FOLLOW_EDGE_SHARE * (east - west) &&
        tip.lon < east - FOLLOW_EDGE_SHARE * (east - west) &&
        tip.lat > south + FOLLOW_EDGE_SHARE * (north - south) &&
        tip.lat < top;
      if (inside) return;
      lastMoveAt = Date.now();
      cameraRef.current?.easeTo({ center: [tip.lon, tip.lat], duration: 450 });
    });
  }, [selectionMode, controller]);

  // What the finger is on: the lines in a box around it, and where it is.
  const resolveHit = useCallback(
    async (x: number, y: number) => {
      const map = mapRef.current;
      if (!map) throw new Error("the map is not ready");
      const [lngLat, features] = await Promise.all([
        map.unproject([x, y]),
        map.queryRenderedFeatures(
          [
            [x - HIT_PT, y - HIT_PT],
            [x + HIT_PT, y + HIT_PT],
          ],
          { layers: ["gradient-lines-layer", ...SELECTION_HIT_LAYERS] },
        ),
      ]);
      return hitFromFeatures(features, [lngLat[0], lngLat[1]], zoomRef.current, segmentsRef.current, (index) =>
        controller.getSnapshot().selection?.stop.branches[index],
      );
    },
    [controller],
  );

  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const handleTouchStart = useCallback(
    (e: GestureResponderEvent) => {
      // A second finger is a pinch, not a hold.
      if (e.nativeEvent.touches.length > 1) {
        touchStart.current = null;
        controller.touchMoved();
        return;
      }
      const { locationX: x, locationY: y } = e.nativeEvent;
      touchStart.current = { x, y };
      const id = controller.touchStarted();
      resolveHit(x, y)
        .then((hit) => controller.touchResolved(id, hit))
        .catch((err) => console.warn("could not tell what was under the finger", err));
    },
    [controller, resolveHit],
  );
  const handleTouchMove = useCallback(
    (e: GestureResponderEvent) => {
      const start = touchStart.current;
      if (!start) return;
      const dx = e.nativeEvent.locationX - start.x;
      const dy = e.nativeEvent.locationY - start.y;
      if (e.nativeEvent.touches.length > 1 || dx * dx + dy * dy > MOVE_SLOP_PT * MOVE_SLOP_PT) controller.touchMoved();
    },
    [controller],
  );
  const handleTouchEnd = useCallback(
    (e: GestureResponderEvent) => {
      // Another finger lifting is not this one.
      if (e.nativeEvent.touches.length > 0) return;
      touchStart.current = null;
      controller.touchEnded();
    },
    [controller],
  );
  const handleTouchCancel = useCallback(() => {
    touchStart.current = null;
    controller.touchEnded();
  }, [controller]);

  // Shown only while tracking, and coloured only when something is wrong, so
  // the ordinary case is one quiet line and the failure case is not.
  const barometerIsBad = ["silent", "offline", "patchy", "slow", "absent"].includes(
    verdictFor(barometer),
  );

  // While the camera follows the rider, region changes fire continuously and
  // several fetches can be in flight at once. Without ordering, a slower
  // earlier response lands after a newer one and replaces the lines with a
  // stale, smaller set -- which is why gradients flickered in and out during a
  // ride. Only the newest request is allowed to write.
  const requestSeq = useRef(0);

  // What the in-flight request is asking for. `loadedBbox` is only written when
  // a fetch *completes*, so during a burst of region events it stays stale,
  // `covers()` below keeps failing, and every event starts another fetch.
  // `requestSeq` stops a stale *response* overwriting a fresh one, but nothing
  // stopped the redundant *requests*: the server log showed 420 abandoned
  // against 69 completed, viewports differing in the eighth decimal place.
  // Remembering what is already being asked for collapses a camera-follow burst
  // to one request per real move.
  const pendingBbox = useRef<Bbox | null>(null);

  const loadSegments = useCallback(async (bbox: Bbox) => {
    const seq = ++requestSeq.current;
    pendingBbox.current = bbox;
    try {
      const { segments: fetched } = await fetchSegments(bbox);
      if (seq !== requestSeq.current) return;
      loadedBbox.current = bbox;
      // Merge rather than replace. Each response only describes its own bbox, so
      // replacing wholesale made every line outside the newest one vanish -- and
      // while the camera follows a rider, region events fire mid-animation with a
      // viewport that is briefly much tighter than the real one. Keyed by id, so
      // a re-fetched segment updates in place after a ride is saved.
      setSegments((previous) => {
        const merged = new Map(previous.map((s) => [s.id, s]));
        for (const segment of fetched) merged.set(segment.id, segment);
        return [...merged.values()];
      });
    } finally {
      // Only the newest request owns the pending slot. A straggler settling
      // later must not clear a newer request's claim, or the burst it was
      // suppressing starts again. Cleared on failure too, so a timeout cannot
      // block fetching that area for good.
      if (seq === requestSeq.current) pendingBbox.current = null;
    }
  }, []);

  // Refetch after the ride is saved, for wherever we're currently looking.
  const reloadSegments = useCallback(async () => {
    if (loadedBbox.current) await loadSegments(loadedBbox.current);
  }, [loadSegments]);

  const handleRegionDidChange = useCallback(
    (bounds: LngLatBounds, userInteraction: boolean) => {
      if (userInteraction) setIsFollowing(false);
      const bbox = paddedBbox(bounds);
      // The padding means small pans usually stay inside what's already
      // loaded, so this only hits the network when the view genuinely moves
      // onto streets we don't have yet.
      if (loadedBbox.current && covers(loadedBbox.current, bbox)) return;
      // Already on its way. A camera animation fires dozens of these with
      // near-identical viewports, and one request answers all of them.
      if (pendingBbox.current && covers(pendingBbox.current, bbox)) return;
      loadSegments(bbox).catch((err) => console.warn("failed to load segments", err));
    },
    [loadSegments],
  );

  // Starting is now a purely local operation -- permissions, sensors, and the
  // OS location task, with no server call on the critical path. Anything that
  // fails here is a real problem with this phone, not with the network.
  const handleStart = useCallback(async () => {
    try {
      await start();
    } catch (err) {
      Alert.alert("Couldn't start tracking", err instanceof Error ? err.message : String(err));
    }
  }, [start]);

  // Uploads whatever is buffered for `id`, dropping each chunk from the phone
  // as the server acknowledges it, then matches the ride. Safe to call again
  // after a failure: what already landed is gone from the buffer, and the
  // server ignores anything it has seen before.
  const saveRide = useCallback(
    async (id: number, rideSamples: TrackedSample[]) => {
      await uploadSamplesInChunks(id, rideSamples, (uploaded) => dropBufferedSamples(uploaded));
      await endSession(id);
      await discardBuffered();

      // Everything above is the ride. This is only the map catching up, and it
      // runs *after* the ride has been uploaded, matched, merged into the model
      // and cleared from the phone -- so a failure here says nothing about
      // whether the ride was saved.
      //
      // It used to throw into the save path's error handler, which then told
      // the rider their ride was still on the phone and pointed at a "Finish
      // saving ride" button that discardBuffered() had just removed. The one
      // moment the reassurance is guaranteed to be false is the only moment it
      // appeared. Seen for real on session 59.
      //
      // Forgetting the loaded bbox rather than only logging: handleRegionDidChange
      // skips refetching while the viewport sits inside what it believes is
      // already loaded, so without this the ride just saved would stay invisible
      // until the rider happened to pan somewhere new.
      try {
        await reloadSegments();
      } catch (err) {
        console.warn("ride saved; refreshing the map failed", err);
        loadedBbox.current = null;
      }
    },
    [discardBuffered, reloadSegments],
  );

  // Gives the ride a server session if it doesn't have one yet, then uploads
  // and matches it. The id is persisted the instant it is issued, so a retry
  // after a failure reuses it rather than minting a second session and folding
  // the same ride into the running means twice.
  const commitRide = useCallback(
    async (id: number | null, rideSamples: TrackedSample[]) => {
      const resolvedId = id ?? (await startSession(startedAt ?? undefined)).id;
      if (id == null) await adoptSession(resolvedId);
      await saveRide(resolvedId, rideSamples);
    },
    [startedAt, adoptSession, saveRide],
  );

  const runSave = useCallback(
    async (id: number | null, rideSamples: TrackedSample[]) => {
      setIsSaving(true);
      try {
        await commitRide(id, rideSamples);
      } catch (err) {
        // The buffered samples are deliberately left in place so the ride isn't
        // lost -- release builds have no LogBox, so this alert is the only way
        // a failure here becomes visible.
        Alert.alert(
          "Couldn't save ride",
          `Your ride is still stored on this phone, but saving it to the server failed: ${
            err instanceof Error ? err.message : String(err)
          }\n\nTap "Finish saving ride" to try again.`,
        );
      } finally {
        setIsSaving(false);
      }
    },
    [commitRide],
  );

  // Throws the ride away locally, and removes the server session too if one was
  // ever created. The server refuses with 409 once a ride has been merged into
  // the elevation model, so this cannot delete a session whose numbers are
  // already baked into the buckets.
  const discardRide = useCallback(async () => {
    if (sessionId != null) {
      try {
        await deleteSession(sessionId);
      } catch (err) {
        console.warn("failed to delete session on the server", err);
      }
    }
    await discardBuffered();
  }, [sessionId, discardBuffered]);

  const handleStop = useCallback(async () => {
    let finalSamples: TrackedSample[];
    try {
      finalSamples = await stop();
    } catch (err) {
      Alert.alert("Couldn't stop tracking", err instanceof Error ? err.message : String(err));
      return;
    }

    // Nothing was recorded. No session was ever created for this ride, so
    // there is nothing on the server to tidy up either.
    if (finalSamples.length === 0) {
      await discardRide().catch((err) => console.warn("failed to discard", err));
      return;
    }

    // A ride that never went anywhere is a mis-tap, or a test of the start
    // button. Ask rather than decide: this phone holds the only copy, and a
    // heuristic that silently deletes rides is only ever noticed once it has
    // thrown away one that mattered.
    const extentM = rideExtentM(finalSamples);
    if (extentM < MIN_SAVEABLE_EXTENT_M) {
      Alert.alert(
        "Nothing much to save",
        `This ride never got more than ${Math.round(extentM)} m from where it started, ` +
          `so it looks like the bike didn't move. Discard it?`,
        [
          { text: "Save anyway", onPress: () => void runSave(sessionId, finalSamples) },
          {
            text: "Discard",
            style: "destructive",
            onPress: () => {
              discardRide().catch((err) => console.warn("failed to discard", err));
            },
          },
        ],
      );
      return;
    }

    await runSave(sessionId, finalSamples);
  }, [stop, sessionId, runSave, discardRide]);

  // Retry for a ride that was recorded but never reached the server.
  const handleResumeSave = useCallback(async () => {
    if (!unsavedRide) return;
    setIsSaving(true);
    try {
      await commitRide(unsavedRide.sessionId, await readBufferedSamples());
    } catch (err) {
      Alert.alert(
        "Still couldn't save",
        `The ride is safe on this phone. ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setIsSaving(false);
    }
  }, [unsavedRide, commitRide]);

  // For a ride already known to be on the server -- a save that timed out after
  // the server had in fact finished. Without this the phone keeps offering to
  // upload it and there is no way to say no.
  const handleDiscardRide = useCallback(() => {
    Alert.alert(
      "Discard this ride?",
      "Only do this if the ride already shows on the map. It will be deleted from this phone and cannot be recovered.",
      [
        { text: "Keep", style: "cancel" },
        {
          text: "Discard",
          style: "destructive",
          onPress: () => {
            discardRide().catch((err) => console.warn("failed to discard", err));
          },
        },
      ],
    );
  }, [discardRide]);

  const handleRecenter = useCallback(() => {
    setIsFollowing(true);
    if (currentPosition) {
      cameraRef.current?.easeTo({
        center: [currentPosition.coords.longitude, currentPosition.coords.latitude],
        zoom: 17,
        duration: 300,
      });
    }
  }, [currentPosition]);

  // Memoized: a growing selection re-renders the screen's map children, and
  // re-slicing every line on the map each time would cost more than the frame.
  const gradientFeatures = useMemo(() => buildColoredLineFeatures(segments), [segments]);
  const liveTrackFeature = {
    type: "Feature" as const,
    properties: {},
    geometry: {
      type: "LineString" as const,
      coordinates: samples.map((s) => [s.lon, s.lat]),
    },
  };

  return (
    <View style={styles.container}>
      {/* MapLibre has no event for a finger lifting, so the hold reads the raw
          touches around the map (the touch spike of 2026-10-17 showed they
          still arrive after its long press). */}
      <View
        style={styles.map}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchCancel}
      >
      <MapView
        ref={mapRef}
        style={styles.map}
        mapStyle={MAP_STYLE_URL}
        // Held, the finger grows the selection; it must not drag the map too.
        dragPan={selectionMode !== "holding"}
        compassPosition={selectionMode !== "idle" && cardBottom > 0 ? { top: cardBottom + 8, right: 10 } : undefined}
        onLongPress={() => controller.longPressed()}
        onPress={() => controller.tapMap()}
        onRegionIsChanging={(event) => {
          zoomRef.current = event.nativeEvent.zoom;
          viewRef.current = event.nativeEvent.bounds;
        }}
        onRegionDidChange={(event) => {
          zoomRef.current = event.nativeEvent.zoom;
          viewRef.current = event.nativeEvent.bounds;
          handleRegionDidChange(event.nativeEvent.bounds, event.nativeEvent.userInteraction);
        }}
      >
        <Camera
          ref={cameraRef}
          initialViewState={{ center: INITIAL_CENTER, zoom: 16 }}
          trackUserLocation={isFollowing ? "course" : undefined}
          zoom={17}
        />
        <UserLocation accuracy heading minDisplacement={2} />

        <GeoJSONSource id="gradient-lines" data={gradientFeatures}>
          <Layer
            id="gradient-lines-layer"
            type="line"
            layout={{ "line-cap": "round" }}
            paint={{
              "line-color": ["get", "color"],
              "line-width": 4,
              "line-opacity": selectionMode === "idle" ? 1 : FADED_OPACITY,
            }}
          />
        </GeoJSONSource>

        <SelectionLayers controller={controller} />

        {samples.length > 1 && (
          <GeoJSONSource id="live-track" data={liveTrackFeature}>
            <Layer
              id="live-track-layer"
              type="line"
              paint={{ "line-color": "#6b7280", "line-width": 3, "line-dasharray": [2, 2] }}
            />
          </GeoJSONSource>
        )}

        {/* Last, so it is drawn above every line. */}
        <ScrubDot scrub={scrub} />
      </MapView>
      </View>

      {selectionMode === "idle" && !hintSeen && (
        <View style={[styles.hint, { top: topInset + 4 }]} pointerEvents="none">
          <Text style={styles.hintText}>Hold a line to measure it</Text>
        </View>
      )}
      <SelectionCard
        controller={controller}
        scrub={scrub}
        top={topInset}
        onHeight={(bottom) => {
          cardBottomRef.current = bottom;
          if (Math.abs(bottom - cardBottom) > 1) setCardBottom(bottom);
        }}
      />

      {!isFollowing && (
        <Pressable style={styles.recenterButton} onPress={handleRecenter}>
          <Text style={styles.recenterButtonText}>Recenter</Text>
        </Pressable>
      )}

      <View style={styles.controls}>
        {unsavedRide && !isTracking && !isSaving && (
          <View style={styles.resumeRow}>
            <Pressable style={styles.resumeButton} onPress={handleResumeSave}>
              <Text style={styles.resumeButtonText}>
                Finish saving ride ({unsavedRide.sampleCount} points)
              </Text>
            </Pressable>
            <Pressable style={styles.discardButton} onPress={handleDiscardRide}>
              <Text style={styles.discardButtonText}>Discard</Text>
            </Pressable>
          </View>
        )}
        <Pressable
          style={[styles.button, isTracking && styles.buttonStop, isSaving && styles.buttonSaving]}
          onPress={isTracking ? handleStop : handleStart}
          disabled={isSaving || (unsavedRide != null && !isTracking)}
        >
          {isSaving ? (
            <View style={styles.savingRow}>
              <ActivityIndicator color="white" size="small" />
              <Text style={styles.buttonText}>Saving ride…</Text>
            </View>
          ) : (
            <Text style={styles.buttonText}>{isTracking ? "Stop Tracking" : "Start Tracking"}</Text>
          )}
        </Pressable>
        {isSaving && <Text style={styles.savingHint}>Keep the app open until this finishes</Text>}
        {isTracking && !isSaving && (
          <Text style={[styles.savingHint, barometerIsBad && styles.barometerBad]}>
            {describeBarometer(barometer)}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
  controls: { position: "absolute", bottom: 40, left: 0, right: 0, alignItems: "center" },
  button: { backgroundColor: "#16a34a", paddingVertical: 14, paddingHorizontal: 32, borderRadius: 999 },
  buttonStop: { backgroundColor: "#dc2626" },
  buttonSaving: { backgroundColor: "#6b7280" },
  buttonText: { color: "white", fontSize: 16, fontWeight: "600" },
  savingRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  barometerBad: { color: "#b91c1c", fontWeight: "600" },
  savingHint: {
    marginTop: 8,
    color: "#111827",
    backgroundColor: "rgba(255,255,255,0.9)",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    fontSize: 12,
  },
  recenterButton: {
    position: "absolute",
    bottom: 110,
    alignSelf: "center",
    backgroundColor: "white",
    paddingVertical: 8,
    paddingHorizontal: 18,
    borderRadius: 999,
    elevation: 4,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  recenterButtonText: { color: "#111827", fontSize: 14, fontWeight: "600" },
  resumeRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 },
  discardButton: {
    backgroundColor: "rgba(255,255,255,0.95)",
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 999,
    elevation: 4,
  },
  discardButtonText: { color: "#b91c1c", fontSize: 15, fontWeight: "600" },
  resumeButton: {
    backgroundColor: "#f97316",
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 999,
    elevation: 4,
  },
  resumeButtonText: { color: "white", fontSize: 15, fontWeight: "600" },
  hint: {
    position: "absolute",
    alignSelf: "center",
    backgroundColor: "rgba(17,24,39,0.82)",
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 999,
  },
  hintText: { color: "white", fontSize: 14, fontWeight: "600" },
});

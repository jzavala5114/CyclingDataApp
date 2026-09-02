import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import {
  Camera,
  type CameraRef,
  GeoJSONSource,
  Layer,
  type LngLatBounds,
  // Aliased: the unqualified name shadows the global Map constructor.
  Map as MapView,
  UserLocation,
  useCurrentPosition,
} from "@maplibre/maplibre-react-native";
import {
  type Bbox,
  deleteSession,
  endSession,
  fetchSegments,
  startSession,
  uploadSamplesInChunks,
} from "../services/api";
import { MIN_SAVEABLE_EXTENT_M, rideExtentM } from "../services/rideStats";
import { buildColoredLineFeatures } from "../services/gradientRendering";
import { useTrackingSession } from "../hooks/useTrackingSession";
import { dropBufferedSamples, readBufferedSamples } from "../services/backgroundLocationTask";
import { MAP_STYLE_URL } from "../config";
import type { SegmentWithGradients, TrackedSample } from "../types";

const INITIAL_CENTER: [number, number] = [-104.8199104, 38.8266852];

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
    start,
    stop,
    adoptSession,
    discardBuffered,
  } = useTrackingSession();
  const currentPosition = useCurrentPosition();

  // While the camera follows the rider, region changes fire continuously and
  // several fetches can be in flight at once. Without ordering, a slower
  // earlier response lands after a newer one and replaces the lines with a
  // stale, smaller set -- which is why gradients flickered in and out during a
  // ride. Only the newest request is allowed to write.
  const requestSeq = useRef(0);

  const loadSegments = useCallback(async (bbox: Bbox) => {
    const seq = ++requestSeq.current;
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

  const gradientFeatures = buildColoredLineFeatures(segments);
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
      <MapView
        style={styles.map}
        mapStyle={MAP_STYLE_URL}
        onRegionDidChange={(event) =>
          handleRegionDidChange(event.nativeEvent.bounds, event.nativeEvent.userInteraction)
        }
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
            paint={{ "line-color": ["get", "color"], "line-width": 4 }}
          />
        </GeoJSONSource>

        {samples.length > 1 && (
          <GeoJSONSource id="live-track" data={liveTrackFeature}>
            <Layer
              id="live-track-layer"
              type="line"
              paint={{ "line-color": "#6b7280", "line-width": 3, "line-dasharray": [2, 2] }}
            />
          </GeoJSONSource>
        )}
      </MapView>

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
});

import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import {
  Camera,
  type CameraRef,
  GeoJSONSource,
  Layer,
  Map,
  UserLocation,
  useCurrentPosition,
} from "@maplibre/maplibre-react-native";
import { endSession, fetchSegments, startSession, uploadSamples } from "../services/api";
import { buildColoredLineFeatures } from "../services/gradientRendering";
import { useTrackingSession } from "../hooks/useTrackingSession";
import { MAP_STYLE_URL } from "../config";
import type { SegmentWithGradients } from "../types";

// Cascade Ave to Wahsatch Ave, Vermijo Ave to Rio Grande St -- matches the
// bbox already loaded by osm-pipeline for the reference neighborhood.
const INITIAL_BBOX = { minLon: -104.8269104, minLat: 38.8206852, maxLon: -104.8129104, maxLat: 38.8326852 };
const INITIAL_CENTER: [number, number] = [-104.8199104, 38.8266852];

export function MapScreen() {
  const [segments, setSegments] = useState<SegmentWithGradients[]>([]);
  const [isFollowing, setIsFollowing] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const sessionId = useRef<number | null>(null);
  const cameraRef = useRef<CameraRef>(null);
  const { isTracking, samples, start, stop, discardBuffered } = useTrackingSession();
  const currentPosition = useCurrentPosition();

  const reloadSegments = useCallback(async () => {
    const { segments } = await fetchSegments(INITIAL_BBOX);
    setSegments(segments);
  }, []);

  useEffect(() => {
    reloadSegments().catch((err) => console.warn("failed to load segments", err));
  }, [reloadSegments]);

  const handleStart = useCallback(async () => {
    try {
      const session = await startSession();
      sessionId.current = session.id;
      await start();
    } catch (err) {
      Alert.alert("Couldn't start tracking", err instanceof Error ? err.message : String(err));
    }
  }, [start]);

  const handleStop = useCallback(async () => {
    setIsSaving(true);
    try {
      const finalSamples = await stop();
      const id = sessionId.current;
      if (id == null || finalSamples.length === 0) return;

      await uploadSamples(id, finalSamples);
      await endSession(id);
      sessionId.current = null;
      await discardBuffered();
      await reloadSegments();
    } catch (err) {
      // The buffered samples are deliberately left in place so the ride isn't
      // lost -- release builds have no LogBox, so this alert is the only way
      // a failure here becomes visible.
      Alert.alert(
        "Couldn't save ride",
        `Your ride is still stored on this phone, but saving it to the server failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      setIsSaving(false);
    }
  }, [stop, discardBuffered, reloadSegments]);

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
      <Map
        style={styles.map}
        mapStyle={MAP_STYLE_URL}
        onRegionDidChange={(event) => {
          if (event.nativeEvent.userInteraction) setIsFollowing(false);
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
      </Map>

      {!isFollowing && (
        <Pressable style={styles.recenterButton} onPress={handleRecenter}>
          <Text style={styles.recenterButtonText}>Recenter</Text>
        </Pressable>
      )}

      <View style={styles.controls}>
        <Pressable
          style={[styles.button, isTracking && styles.buttonStop, isSaving && styles.buttonSaving]}
          onPress={isTracking ? handleStop : handleStart}
          disabled={isSaving}
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
});

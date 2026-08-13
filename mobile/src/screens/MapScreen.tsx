import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Camera, GeoJSONSource, Layer, Map, UserLocation } from "@maplibre/maplibre-react-native";
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
  const sessionId = useRef<number | null>(null);
  const { isTracking, samples, start, stop } = useTrackingSession();

  const reloadSegments = useCallback(async () => {
    const { segments } = await fetchSegments(INITIAL_BBOX);
    setSegments(segments);
  }, []);

  useEffect(() => {
    reloadSegments();
  }, [reloadSegments]);

  const handleStart = useCallback(async () => {
    const session = await startSession();
    sessionId.current = session.id;
    await start();
  }, [start]);

  const handleStop = useCallback(async () => {
    const finalSamples = stop();
    const id = sessionId.current;
    if (id == null || finalSamples.length === 0) return;

    await uploadSamples(id, finalSamples);
    await endSession(id);
    sessionId.current = null;
    await reloadSegments();
  }, [stop, reloadSegments]);

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
      <Map style={styles.map} mapStyle={MAP_STYLE_URL}>
        <Camera initialViewState={{ center: INITIAL_CENTER, zoom: 16 }} trackUserLocation="course" zoom={17} />
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

      <View style={styles.controls}>
        <Pressable
          style={[styles.button, isTracking && styles.buttonStop]}
          onPress={isTracking ? handleStop : handleStart}
        >
          <Text style={styles.buttonText}>{isTracking ? "Stop Tracking" : "Start Tracking"}</Text>
        </Pressable>
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
  buttonText: { color: "white", fontSize: 16, fontWeight: "600" },
});

import { useMemo, useSyncExternalStore, type ComponentProps } from "react";
import { GeoJSONSource, Layer } from "@maplibre/maplibre-react-native";
import type { DataDrivenPropertyValueSpecification, FilterSpecification } from "@maplibre/maplibre-gl-style-spec";
import type { Feature, FeatureCollection, LineString, Point } from "geojson";
import {
  NO_DATA_COLOR,
  featureCollection,
  growingFeature,
  pointOnPath,
  type SelectionFeatureProps,
} from "../services/pathSelection";
import { SELECTION_LAYER } from "../services/holdGesture";
import type { ScrubStore } from "../services/profileScrub";
import type { SelectionController } from "../services/selectionController";

// The selection on the map: the same colours as every other line (colour is
// grade here, so a brighter colour would read as a different grade), wider,
// on a white casing, with chevrons showing which way it runs. Everything else
// is faded by the screen. Unmeasured ground is dashed grey. The design is
// context/session.md, "Press and hold on a segment, designed 2026-10-17".
//
// Growth is drawn without resending the selection every frame: the features
// are built once per answer and filtered on how far each reaches, and the one
// still growing comes from a source of its own, a single short line.

/** Layers a touch is tested against, as the screen queries them. */
export { SELECTION_HIT_LAYERS } from "../services/holdGesture";

type SourcePress = NonNullable<ComponentProps<typeof GeoJSONSource>["onPress"]>;

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };
const CASING_COLOR = "#ffffff";
const ROUND = { "line-cap": "round", "line-join": "round" } as const;

export function SelectionLayers({ controller }: { controller: SelectionController }) {
  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const { selection, features, grownM, trimFrom, mode, busy } = snap;

  const all = useMemo(() => featureCollection(features), [features]);
  const growing = growingFeature(features, grownM);
  const growingData = growing ? featureCollection([growing]) : EMPTY;

  // Shown: every run that has fully grown. The one part grown is the growing source's.
  const grown: FilterSpecification = ["<=", ["get", "endM"], grownM + 0.001];
  const measured: FilterSpecification = ["==", ["get", "noData"], false];
  const unmeasured: FilterSpecification = ["==", ["get", "noData"], true];

  // A tap previews a trim: the tapped piece and everything after it fade.
  const trimAtM = trimFrom !== null ? (selection?.pieces[trimFrom]?.atM ?? null) : null;
  const opacity: DataDrivenPropertyValueSpecification<number> =
    trimAtM === null ? 1 : ["case", [">=", ["get", "startM"], trimAtM - 0.001], 0.25, 1];

  // At a fork the growth has reached, the lines to hold to go on, each its first 30m.
  const atFork = selection && !snap.preview && selection.stop.reason === "fork" && grownM >= selection.lengthM - 0.01;
  const branches = useMemo<FeatureCollection<LineString, { kind: "branch"; index: number }>>(
    () => ({
      type: "FeatureCollection",
      features: atFork
        ? selection!.stop.branches.map((b, index) => ({
            type: "Feature" as const,
            geometry: b.geometry,
            properties: { kind: "branch" as const, index },
          }))
        : [],
    }),
    [atFork, selection],
  );

  // While an answer is awaited, a dot at the tip says the growth is waiting, not stuck.
  const waiting = mode === "holding" && (busy === "path" || busy === "connect" || busy === "more");
  const tip = waiting && selection ? pointOnPath(selection, grownM) : null;
  const tipData: FeatureCollection<Point> = tip
    ? { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [tip.lon, tip.lat] }, properties: {} }] }
    : (EMPTY as FeatureCollection<Point>);

  // A tap on any of the selection, the part-grown run included, asks to trim there.
  const onPress: SourcePress = (event) => {
    const hit = event.nativeEvent.features.find((f) => f.properties?.kind === "selection") as
      | Feature<LineString, SelectionFeatureProps>
      | undefined;
    if (!hit) return;
    event.stopPropagation();
    controller.tapSelection(hit.properties.piece);
  };

  return (
    <>
      <GeoJSONSource id="selection" data={all} onPress={onPress}>
        <Layer
          id="selection-casing"
          type="line"
          filter={grown}
          layout={ROUND}
          paint={{ "line-color": CASING_COLOR, "line-width": 11, "line-opacity": opacity }}
        />
        <Layer
          id={SELECTION_LAYER.line}
          type="line"
          filter={["all", grown, measured]}
          layout={ROUND}
          paint={{ "line-color": ["get", "color"], "line-width": 7, "line-opacity": opacity }}
        />
        <Layer
          id={SELECTION_LAYER.gap}
          type="line"
          filter={["all", grown, unmeasured]}
          layout={{ "line-join": "round" }}
          paint={{ "line-color": NO_DATA_COLOR, "line-width": 5, "line-dasharray": [1.4, 1.2], "line-opacity": opacity }}
        />
        <Layer
          id="selection-chevrons"
          type="symbol"
          filter={grown}
          layout={{
            "symbol-placement": "line",
            "symbol-spacing": 64,
            "text-field": "›",
            "text-font": ["Noto Sans Bold"],
            "text-size": 17,
            "text-keep-upright": false,
            "text-rotation-alignment": "map",
            "text-allow-overlap": true,
            "text-ignore-placement": true,
          }}
          paint={{ "text-color": "#ffffff", "text-halo-color": "rgba(17,24,39,0.6)", "text-halo-width": 1.2, "text-opacity": opacity }}
        />
      </GeoJSONSource>

      <GeoJSONSource id="selection-growing" data={growingData} onPress={onPress}>
        {/* Let go mid-run, the last run stays part grown, so it fades with a trim too. */}
        <Layer
          id="selection-growing-casing"
          type="line"
          layout={ROUND}
          paint={{ "line-color": CASING_COLOR, "line-width": 11, "line-opacity": opacity }}
        />
        <Layer
          id={SELECTION_LAYER.growingLine}
          type="line"
          filter={measured}
          layout={ROUND}
          paint={{ "line-color": ["get", "color"], "line-width": 7, "line-opacity": opacity }}
        />
        <Layer
          id={SELECTION_LAYER.growingGap}
          type="line"
          filter={unmeasured}
          paint={{ "line-color": NO_DATA_COLOR, "line-width": 5, "line-dasharray": [1.4, 1.2], "line-opacity": opacity }}
        />
      </GeoJSONSource>

      <GeoJSONSource id="selection-branches" data={branches}>
        <Layer
          id="selection-branch-casing"
          type="line"
          layout={ROUND}
          paint={{ "line-color": "#111827", "line-width": 10, "line-opacity": 0.55 }}
        />
        <Layer
          id={SELECTION_LAYER.branchLine}
          type="line"
          layout={ROUND}
          paint={{ "line-color": "#ffffff", "line-width": 5, "line-dasharray": [1, 1.4] }}
        />
      </GeoJSONSource>

      <GeoJSONSource id="selection-tip" data={tipData}>
        <Layer
          id="selection-tip-dot"
          type="circle"
          paint={{ "circle-radius": 7, "circle-color": "#ffffff", "circle-stroke-color": "#111827", "circle-stroke-width": 2.5 }}
        />
      </GeoJSONSource>
    </>
  );
}

// Where the finger on the card's profile is, on the map (services/profileScrub.ts):
// dark with a white ring, the growth tip's dot inverted, so the two never read
// as one. The screen draws it last, above every line. It takes no taps: it is
// not one of the layers the hold's hit test names, and its source has no onPress.
export function ScrubDot({ scrub }: { scrub: ScrubStore }) {
  const point = useSyncExternalStore(scrub.subscribe, scrub.get);
  const data = useMemo<FeatureCollection<Point>>(
    () =>
      point
        ? { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [point.lon, point.lat] }, properties: {} }] }
        : (EMPTY as FeatureCollection<Point>),
    [point],
  );
  return (
    <GeoJSONSource id="selection-scrub" data={data}>
      <Layer
        id="selection-scrub-dot"
        type="circle"
        paint={{ "circle-radius": 8, "circle-color": "#111827", "circle-stroke-color": "#ffffff", "circle-stroke-width": 3 }}
      />
    </GeoJSONSource>
  );
}

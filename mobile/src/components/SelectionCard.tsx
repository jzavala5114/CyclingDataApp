import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from "react-native";
import {
  NO_DATA_COLOR,
  formatBand,
  formatDistance,
  formatFeet,
  formatGrade,
  formatRideDate,
  formatRides,
  profileColumns,
  selectionStats,
  type ProfileColumn,
} from "../services/pathSelection";
import { createScrubGesture, cursorLeft, scrubProfile, scrubReadout, type ScrubStore } from "../services/profileScrub";
import type { SelectionController, Snapshot } from "../services/selectionController";
import { statusFor } from "../services/selectionStatus";

// The card at the top of the map while something is selected: where it runs,
// how far, how much it climbs and how steep it gets, its height profile in
// the map's own colours with each band's share of the distance under it (the
// colour key the map otherwise lacks), what the numbers are built from, and
// what to do next. The design is context/session.md, "Press and hold on a
// segment, designed 2026-10-17".

// The card redraws at most this often while a selection grows, rather than
// every frame: the numbers cannot be read faster, and the map's own frames
// matter more.
const REDRAW_MS = 100;
const PROFILE_COLUMNS = 64;
const PROFILE_HEIGHT = 44;
// A profile spans at least this much height, so a flat street draws flat
// rather than its noise stretched to fill the box.
const MIN_PROFILE_RANGE_M = 10;
// Bands under this share of the distance stay in the bar but out of the words.
const LEGEND_MIN_SHARE = 0.05;
const CURSOR_WIDTH = 2;

function useSnapshot(controller: SelectionController): Snapshot {
  const [snap, setSnap] = useState(controller.getSnapshot);
  const last = useRef(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const update = () => {
      timer = null;
      last.current = Date.now();
      setSnap(controller.getSnapshot());
    };
    const unsubscribe = controller.subscribe(() => {
      const next = controller.getSnapshot();
      // A change of mode, or anything but growth, shows at once.
      if (next.mode !== "holding" || Date.now() - last.current >= REDRAW_MS) {
        if (timer) clearTimeout(timer);
        update();
      } else if (!timer) {
        timer = setTimeout(update, REDRAW_MS - (Date.now() - last.current));
      }
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [controller]);
  return snap;
}

// The profile's bars, which a scrub never redraws.
const ProfileBars = memo(function ProfileBars({ columns, low, range }: { columns: ProfileColumn[]; low: number; range: number }) {
  return (
    <>
      {columns.map((column, i) => (
        <View
          key={i}
          style={[
            styles.bar,
            {
              height: 3 + ((column.heightM - low) / range) * (PROFILE_HEIGHT - 3),
              backgroundColor: column.noData ? NO_DATA_COLOR : column.color,
              opacity: column.noData ? 0.45 : 1,
            },
          ]}
        />
      ))}
    </>
  );
});

// The line on the profile under the finger.
function ScrubCursor({ scrub, lengthM, width }: { scrub: ScrubStore; lengthM: number; width: number }) {
  const point = useSyncExternalStore(scrub.subscribe, scrub.get);
  const left = point ? cursorLeft(point, lengthM, width, CURSOR_WIDTH) : null;
  if (left === null) return null;
  return <View pointerEvents="none" style={[styles.cursor, { left }]} />;
}

// While a finger is on the profile, the numbers row reads the path under it:
// how far in, the height from the start, and the grade. Drawn over the
// totals rather than in place of them, so the card keeps its height; one
// line that shrinks to fit at a large font size rather than run off the card.
function ScrubReadout({ scrub }: { scrub: ScrubStore }) {
  const point = useSyncExternalStore(scrub.subscribe, scrub.get);
  if (!point) return null;
  const readout = scrubReadout(point);
  return (
    <View pointerEvents="none" style={styles.readout}>
      <Text numberOfLines={1} adjustsFontSizeToFit style={styles.readoutText}>
        <Text style={styles.distance}>{readout.distance}</Text>
        <Text style={styles.figure}>{`   ${readout.height}   ${readout.grade}`}</Text>
      </Text>
    </View>
  );
}

export function SelectionCard({
  controller,
  scrub,
  top,
  onHeight,
}: {
  controller: SelectionController;
  scrub: ScrubStore;
  top: number;
  onHeight: (height: number) => void;
}) {
  const snap = useSnapshot(controller);
  const { selection, grownM, preview, mode, busy, trimFrom } = snap;
  const stats = useMemo(() => (selection && !preview ? selectionStats(selection, grownM) : null), [selection, preview, grownM]);
  const columns = useMemo(
    () => (selection && !preview ? profileColumns(selection, grownM, PROFILE_COLUMNS) : []),
    [selection, preview, grownM],
  );
  // What the profile draws, and so what a scrub reads.
  const profile = useMemo(() => scrubProfile(selection, grownM, preview), [selection, preview, grownM]);

  // Scrubbing the profile: the gesture's rules are services/profileScrub.ts's
  // createScrubGesture; the card only feeds it the responder's events.
  const scrubbable = !!profile && profile.lengthM > 0 && columns.length > 0 && mode !== "holding";
  const latest = useRef({ profile, scrubbable });
  latest.current = { profile, scrubbable };
  const widthRef = useRef(0);
  const [profileWidth, setProfileWidth] = useState(0);
  const [gesture] = useState(() =>
    createScrubGesture(scrub, () => ({ profile: latest.current.profile, scrubbable: latest.current.scrubbable, width: widthRef.current })),
  );
  // A new answer, a flip, a trim or a close hides the point until the finger
  // next moves, which reads the new profile: the old point was on the old one.
  useEffect(() => () => scrub.set(null), [scrub, profile]);
  const canScrub = () => gesture.canStart();
  const never = () => false;
  const keepScrub = () => false;
  const startScrub = (e: GestureResponderEvent) => gesture.grant(e.nativeEvent);
  const moveScrub = (e: GestureResponderEvent) => gesture.move(e.nativeEvent);
  const endScrub = () => gesture.end();
  const measureProfile = (e: LayoutChangeEvent) => {
    widthRef.current = e.nativeEvent.layout.width;
    setProfileWidth(e.nativeEvent.layout.width);
  };

  const status = statusFor(snap);
  if (!selection && !snap.error) return null;

  const names = stats?.streetNames.length
    ? stats.streetNames.join(" → ")
    : selection?.pieces[0]?.streetName ?? (selection ? "Unnamed way" : "Press and hold");
  const heights = columns.map((c) => c.heightM);
  const low = Math.min(...heights);
  const range = Math.max(MIN_PROFILE_RANGE_M, Math.max(...heights) - low);
  const measuredShares = stats?.bands.filter((b) => b.lengthM > 0) ?? [];
  const noDataShare = stats && stats.distanceM > 0 ? stats.noDataM / stats.distanceM : 0;
  const legend = measuredShares.filter((b) => b.share >= LEGEND_MIN_SHARE);
  const trimAtM = trimFrom !== null ? (selection?.pieces[trimFrom]?.atM ?? null) : null;
  const canFlip = !!selection && !preview && mode !== "holding" && busy === null;

  return (
    <View style={[styles.wrap, { top }]} onLayout={(e) => onHeight(e.nativeEvent.layout.y + e.nativeEvent.layout.height)}>
      <View style={styles.card}>
        <View style={styles.titleRow}>
          <Text style={styles.title} numberOfLines={2}>
            {names}
          </Text>
          {selection && (
            <Pressable
              style={[styles.iconButton, !canFlip && styles.disabled]}
              onPress={() => void controller.flip()}
              disabled={!canFlip}
              accessibilityLabel="Flip to the other direction"
              hitSlop={6}
            >
              <Text style={styles.iconText}>{"⇄"}</Text>
            </Pressable>
          )}
          <Pressable style={styles.iconButton} onPress={() => controller.clear()} accessibilityLabel="Close" hitSlop={6}>
            <Text style={styles.iconText}>{"×"}</Text>
          </Pressable>
        </View>

        {selection && (
          <View>
            <View style={styles.numbers}>
              <Text style={styles.distance}>{formatDistance(stats ? stats.distanceM : grownM)}</Text>
              {stats && (
                <>
                  <Text style={styles.figure}>{`↑ ${formatFeet(stats.climbM)}`}</Text>
                  <Text style={styles.figure}>{`↓ ${formatFeet(stats.descentM)}`}</Text>
                  {stats.averageGradePct !== null && <Text style={styles.figure}>{`${formatGrade(stats.averageGradePct)} avg`}</Text>}
                </>
              )}
            </View>
            <ScrubReadout scrub={scrub} />
          </View>
        )}
        {stats?.steepest && (
          <Text style={styles.secondary}>{`steepest 330 ft  ${formatGrade(stats.steepest.gradePct)}`}</Text>
        )}

        {columns.length > 0 && (
          <View
            style={styles.profile}
            pointerEvents="box-only"
            onLayout={measureProfile}
            onStartShouldSetResponder={canScrub}
            onMoveShouldSetResponder={never}
            onResponderTerminationRequest={keepScrub}
            onResponderGrant={startScrub}
            onResponderMove={moveScrub}
            onResponderRelease={endScrub}
            onResponderTerminate={endScrub}
            accessibilityLabel="Height profile. Drag along it to see where each point is on the map."
          >
            <ProfileBars columns={columns} low={low} range={range} />
            <ScrubCursor scrub={scrub} lengthM={profile?.lengthM ?? 0} width={profileWidth} />
          </View>
        )}

        {stats && stats.distanceM > 0 && (
          <>
            <View style={styles.shareBar}>
              {measuredShares.map((b) => (
                <View key={b.color} style={{ flex: b.share, backgroundColor: b.color }} />
              ))}
              {noDataShare > 0 && <View style={{ flex: noDataShare, backgroundColor: NO_DATA_COLOR, opacity: 0.45 }} />}
            </View>
            <View style={styles.legend}>
              {legend.map((b) => (
                <View key={b.color} style={styles.legendItem}>
                  <View style={[styles.swatch, { backgroundColor: b.color }]} />
                  <Text style={styles.legendText}>{`${formatBand(b)} ${Math.round(b.share * 100)}%`}</Text>
                </View>
              ))}
            </View>
            <Text style={styles.secondary}>
              {[
                stats.rides ? formatRides(stats.rides) : "no rides measured here",
                stats.lastRiddenAt ? `last ridden ${formatRideDate(stats.lastRiddenAt)}` : null,
                stats.noDataM > 0 ? `${formatDistance(stats.noDataM)} with no data` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          </>
        )}

        {status && trimAtM === null && (
          <View style={styles.statusRow}>
            {status.waiting && <ActivityIndicator size="small" color="#374151" />}
            <Text style={[styles.status, status.tone === "error" && styles.statusError]}>{status.text}</Text>
          </View>
        )}
      </View>

      {trimAtM !== null && selection && (
        <View style={styles.trim}>
          <Text style={styles.trimText}>
            {trimAtM <= 0.5 ? "Remove the whole selection?" : `Remove ${formatDistance(grownM - trimAtM)}?`}
          </Text>
          <Pressable style={styles.trimCancel} onPress={() => controller.cancelTrim()}>
            <Text style={styles.trimCancelText}>Cancel</Text>
          </Pressable>
          <Pressable style={styles.trimRemove} onPress={() => controller.confirmTrim()}>
            <Text style={styles.trimRemoveText}>Remove</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", left: 10, right: 10 },
  card: {
    backgroundColor: "white",
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 12,
    elevation: 6,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
  },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  title: { flex: 1, fontSize: 15, fontWeight: "600", color: "#111827" },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#f3f4f6",
  },
  iconText: { fontSize: 20, color: "#111827", lineHeight: 24 },
  disabled: { opacity: 0.35 },
  numbers: { flexDirection: "row", alignItems: "baseline", flexWrap: "wrap", columnGap: 14, marginTop: 2 },
  distance: { fontSize: 26, fontWeight: "700", color: "#111827" },
  figure: { fontSize: 15, fontWeight: "600", color: "#111827" },
  secondary: { fontSize: 12, color: "#6b7280", marginTop: 4 },
  profile: {
    flexDirection: "row",
    alignItems: "flex-end",
    height: PROFILE_HEIGHT,
    marginTop: 8,
    backgroundColor: "#f3f4f6",
    borderRadius: 6,
    overflow: "hidden",
  },
  bar: { flex: 1 },
  cursor: { position: "absolute", top: 0, bottom: 0, width: CURSOR_WIDTH, backgroundColor: "#111827" },
  readout: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    marginTop: 2,
    backgroundColor: "white",
  },
  readoutText: { color: "#111827" },
  shareBar: { flexDirection: "row", height: 6, borderRadius: 3, overflow: "hidden", marginTop: 8 },
  legend: { flexDirection: "row", flexWrap: "wrap", columnGap: 10, rowGap: 2, marginTop: 5 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  swatch: { width: 8, height: 8, borderRadius: 4 },
  legendText: { fontSize: 12, color: "#374151" },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 },
  status: { flex: 1, fontSize: 13, color: "#1f2937", fontWeight: "500" },
  statusError: { color: "#b91c1c" },
  trim: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 8,
    backgroundColor: "white",
    borderRadius: 14,
    paddingVertical: 8,
    paddingLeft: 14,
    paddingRight: 8,
    elevation: 6,
  },
  trimText: { flex: 1, fontSize: 15, fontWeight: "600", color: "#111827" },
  trimCancel: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, backgroundColor: "#f3f4f6" },
  trimCancelText: { fontSize: 14, fontWeight: "600", color: "#111827" },
  trimRemove: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, backgroundColor: "#dc2626" },
  trimRemoveText: { fontSize: 14, fontWeight: "600", color: "white" },
});

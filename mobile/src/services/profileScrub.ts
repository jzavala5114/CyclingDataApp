import { cutAt, formatDistance, formatGrade, formatRise, pointOnPath, profileAt, type Selection } from "./pathSelection";

// Scrubbing the card's height profile, as Trailforks' elevation chart does
// (asked for 2026-10-20): a finger on the profile picks a distance along the
// selection; the card's numbers read the path there, a cursor marks it on the
// profile, and a dot marks it on the map. Graph to map only: the selected line
// on the map already answers taps (trim) and holds (grow). The dot shows only
// while the finger is down. Heights are from the start of the selection, as
// the profile draws them: the server sends no height above sea level.

export interface ScrubPoint {
  /** Metres along the selection. */
  atM: number;
  /** Height from the start, the profile's own number at `atM`. */
  heightM: number;
  /** The grade there, or null on ground nothing measured. */
  gradePct: number | null;
  lon: number;
  lat: number;
}

/**
 * How near either side of the screen, in dp, a finger reads the path's start
 * and end (asked for 2026-10-21: reaching them took the finger to the
 * screen's edge). A touch is read at the middle of the fingertip, and the
 * profile's own edges are 24dp in (the card's margin and padding), where the
 * fingertip reaches the glass's edge, partly off it, and is over Android's
 * back-gesture strip, 29.7dp wide on Julian's Pixel 10 Pro. 60dp is that
 * strip and about half a fingertip more: 9.6mm on that phone, the whole
 * fingertip on the glass and clear of the strip. The profile still draws the
 * whole path from edge to edge, so near the ends its cursor runs ahead of
 * the finger, by up to 36dp.
 */
export const SCRUB_EDGE_REACH = 60;

/** Where on the screen (page x, dp) a finger reads the path's start and its end. */
export interface ScrubBand {
  from: number;
  to: number;
}

/**
 * The band for a profile `width` wide with its left edge at `edgeX`, on a
 * window `windowWidth` wide: the profile's own edges, each brought in to
 * SCRUB_EDGE_REACH from the window's side when nearer to it than that. A
 * profile already clear of the sides is not stretched. A window too narrow
 * to leave a band, or not yet measured, falls back to the profile's edges.
 * A stated limit: with the profile 24dp in, the band is the window less
 * 120dp, so it grows short below about 200dp of window and shrinks to
 * nothing at 120dp, where the fallback takes over. The app is portrait only
 * and phones are 320dp wide or more.
 */
export function scrubBand(edgeX: number, width: number, windowWidth: number): ScrubBand {
  const from = Math.max(edgeX, SCRUB_EDGE_REACH);
  const to = Math.min(edgeX + width, windowWidth - SCRUB_EDGE_REACH);
  return to > from ? { from, to } : { from: edgeX, to: edgeX + width };
}

/** Metres along a profile `lengthM` long for a finger at `pageX`: the band's ends read the path's, and past them the nearest end. */
export function scrubMetres(pageX: number, band: ScrubBand, lengthM: number): number {
  if (!(band.to > band.from) || !(lengthM > 0) || !Number.isFinite(pageX)) return 0;
  return Math.max(0, Math.min(1, (pageX - band.from) / (band.to - band.from))) * lengthM;
}

/**
 * The point `atM` metres along `profile`: the selection cut to what the
 * profile draws (cutAt), so the point never falls past the grown part. Its
 * place on the map comes from the same piece geometry the map draws the
 * selection with, so it sits on the drawn line.
 */
export function scrubAt(profile: Selection, atM: number): ScrubPoint | null {
  if (!Number.isFinite(atM)) return null;
  const m = Math.max(0, Math.min(profile.lengthM, atM));
  const at = profileAt(profile.spans, m);
  const place = pointOnPath(profile, m);
  if (!at || !place) return null;
  return {
    atM: m,
    heightM: at.heightM,
    gradePct: at.span.source === "none" ? null : at.span.slopePct,
    lon: place.lon,
    lat: place.lat,
  };
}

/** What the profile draws, and so what a scrub reads: the selection cut to what has grown; nothing while it is a preview. */
export function scrubProfile(selection: Selection | null, grownM: number, preview: boolean): Selection | null {
  return selection && !preview ? cutAt(selection, grownM) : null;
}

/** The card's readout for a point: how far in, the height from the start, and the grade. */
export function scrubReadout(point: ScrubPoint): { distance: string; height: string; grade: string } {
  return {
    distance: `${formatDistance(point.atM)} in`,
    height: formatRise(point.heightM),
    grade: point.gradePct === null ? "no data" : formatGrade(point.gradePct),
  };
}

/** The cursor's left edge on a profile `width` wide, centred on the point and kept inside; null before the profile is measured. */
export function cursorLeft(point: ScrubPoint, lengthM: number, width: number, cursorWidth: number): number | null {
  if (!(lengthM > 0) || !(width > 0)) return null;
  return Math.max(0, Math.min(width - cursorWidth, (point.atM / lengthM) * width - cursorWidth / 2));
}

/** The fields of a React Native responder event the scrub reads. */
export interface ScrubTouch {
  pageX: number;
  locationX: number;
  /** Which finger: React Native types it a string, and only equality matters. */
  identifier?: string | number;
}

/** What the card holds now: its profile, the profile's measured width, the window's, and whether a scrub may run. */
export interface ScrubState {
  profile: Selection | null;
  width: number;
  windowWidth: number;
  scrubbable: boolean;
}

/**
 * The finger on the profile, fed React Native's responder events. The grant
 * is a touch's start on the profile, which takes touches itself (box-only),
 * so its locationX is from the profile's left edge; the edge's place on the
 * screen is kept from it, and every touch reads only pageX, against the band
 * (scrubBand) that puts the path's ends short of the screen's sides; a finger
 * past either end of the band, on the profile or off it, reads that end, and
 * the band is worked out afresh each time, from the card as it is then. Only
 * the finger that started it moves it: on Android every finger's moves reach
 * the responder, each with its own identifier and pageX (a cold review,
 * 2026-10-20, found a second finger on the map dragging the dot). A move
 * never starts a scrub, since a move's locationX is measured against
 * whatever view the finger is over; the card's onMoveShouldSetResponder says
 * no. Release or termination ends it, whichever finger lifted: React Native
 * may let the responder go when any finger lifts, and a scrub left running
 * with no responder would leave the dot on the map.
 */
export function createScrubGesture(store: ScrubStore, now: () => ScrubState) {
  let active = false;
  let owner: string | number | undefined;
  let edgeX = 0;
  const to = (pageX: number) => {
    const { profile, width, windowWidth, scrubbable } = now();
    store.set(profile && scrubbable ? scrubAt(profile, scrubMetres(pageX, scrubBand(edgeX, width, windowWidth), profile.lengthM)) : null);
  };
  return {
    /** Whether a touch starting on the profile takes it. */
    canStart: () => !active && now().scrubbable,
    grant(touch: ScrubTouch) {
      active = true;
      owner = touch.identifier;
      edgeX = touch.pageX - touch.locationX;
      to(touch.pageX);
    },
    move(touch: ScrubTouch) {
      if (!active || touch.identifier !== owner) return;
      to(touch.pageX);
    },
    end() {
      active = false;
      owner = undefined;
      store.set(null);
    },
  };
}

// The point under the finger, kept apart from the selection's own state: a
// move redraws only what reads it (the card's readout and cursor, and the
// map's dot), not the card's profile or the map's other layers.
export interface ScrubStore {
  get(): ScrubPoint | null;
  set(point: ScrubPoint | null): void;
  subscribe(listener: () => void): () => void;
}

export function createScrubStore(): ScrubStore {
  let point: ScrubPoint | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => point,
    set: (next) => {
      if (next === point) return;
      point = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

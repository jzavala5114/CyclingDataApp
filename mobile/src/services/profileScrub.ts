import { pointOnPath, profileAt, type Selection } from "./pathSelection";

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

/** Metres along a profile `lengthM` long, for a finger `x` from its left edge on a profile `width` wide. */
export function scrubMetres(x: number, width: number, lengthM: number): number {
  if (!(width > 0) || !(lengthM > 0) || !Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x / width)) * lengthM;
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

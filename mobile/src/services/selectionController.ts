import * as turf from "@turf/turf";
import type { Position } from "geojson";
import { RequestCancelled, type PathPoint, type PathRequest } from "./api";
import { FlipFailed, flipSelection } from "./flipSelection";
import { FORK_PAUSE_MS, growthSpeedPtPerS, heldTravelM, metresPerPoint, previewSelection } from "./holdGesture";
import {
  appendPath,
  cutAt,
  fromResponse,
  pointOnPath,
  prependPath,
  selectionBounds,
  selectionFeatures,
  selectionSegmentIds,
  type Selection,
  type SelectionFeature,
} from "./pathSelection";
import type { Direction, DirectionalGradientLine, PathBranch, PathResponse, SegmentWithGradients } from "../types";

// Press and hold on a line, as a state machine with no React and no map in
// it: the screen feeds it touches and what was under them, and draws whatever
// snapshot it publishes. The design is context/session.md, "Press and hold on
// a segment, designed 2026-10-17"; the touch spike of the same day showed that
// the phone sees the finger lift after MapLibre's long press.
//
// A touch goes: down (the screen finds the lines under the finger), then
// after ASK_AFTER_MS still down and unmoved, the server is asked, before the
// long press registers at about 400ms; a tap or a pan before then is called
// off. The long press starts the hold: growth runs along the pressed line,
// which the phone already draws, while the answer is on its way, and on along
// the answer once it lands. Lifting the finger ends the selection where the
// growth reached.

/** What the screen found under a finger. */
export interface Hit {
  lonLat: Position;
  zoom: number;
  /** The drawn line nearest the finger, with what the map draws for it. */
  line: { segment: SegmentWithGradients; drawing: DirectionalGradientLine } | null;
  /** The selection's piece under the finger, if the finger is on the selection. */
  piece: number | null;
  /** A fork's branch under the finger. */
  branch: PathBranch | null;
}

/** idle: nothing selected. holding: a hold registered and the finger is down. shown: a selection, finger up. */
export type Mode = "idle" | "holding" | "shown";

/** What the controller is waiting on: the first answer, a connection, more path past a limit, or a flip. */
export type Busy = "path" | "connect" | "more" | "flip" | null;

export interface Snapshot {
  mode: Mode;
  selection: Selection | null;
  /** The selection as map features, rebuilt only when the selection changes. */
  features: SelectionFeature[];
  /** The selection is the stand-in along the pressed line: no numbers yet. */
  preview: boolean;
  /** How much of the selection is selected: everything past it is fetched but not shown. */
  grownM: number;
  busy: Busy;
  /** Whether holding the selection carries it on: false once trimmed, or stopped for good. */
  canGrow: boolean;
  /** The piece a tap asked to trim from, awaiting confirmation. */
  trimFrom: number | null;
  error: string | null;
}

export interface ControllerDeps {
  fetchPath: (request: PathRequest, signal?: AbortSignal) => Promise<PathResponse>;
  now: () => number;
  /** Runs `step` on the next animation frame; returns a cancel. */
  frame: (step: (now: number) => void) => () => void;
  /** Runs `run` after `ms`; returns a cancel. */
  later: (run: () => void, ms: number) => () => void;
  /** Frames the camera on a selection the rider has let go of. */
  fit: (bounds: [number, number, number, number]) => void;
  /** The first hold that selected something, so the screen can retire its hint. */
  onFirstHold?: () => void;
}

// Asking only once the finger has stayed put this long filters out taps and
// pans, each of which would otherwise cost the server a whole path, and still
// leaves about 250ms of head start before the long press at about 400ms.
export const ASK_AFTER_MS = 150;
// A hold this close to the selection's end (or start), in a straight line,
// joins it; further away it starts a new selection. A bridged gap is under
// 150m by design (MAX_NO_DATA_M), and a fork lies at most that far ahead.
export const NEAR_END_M = 250;

type Intent =
  | { kind: "new"; request: PathRequest; hit: Hit }
  | { kind: "extend"; request: PathRequest; to: PathPoint & { atM: number }; hit: Hit }
  | { kind: "prepend"; request: PathRequest; hit: Hit }
  | { kind: "resume" };

interface Touch {
  id: number;
  startedAt: number;
  hit: Hit | null;
  intent: Intent | null;
  longPressed: boolean;
  ended: boolean;
  /** The request asked for this touch, once asked. */
  asked: { abort: AbortController; answer: PathResponse | null; failed: unknown } | null;
  cancelAsk: (() => void) | null;
  /** The selection generation the hold belongs to: an answer for an older one is dropped. */
  generation: number;
}

const FORK_RULES = new Set(["history", "name", "turn"]);
const GROWABLE_STOPS = new Set(["limit", "joined"]);

const distanceM = (a: Position, b: Position) => turf.distance(turf.point(a), turf.point(b), { units: "meters" });

/** Where along an answer it reaches `to`: where a connection ends and growth from the held line begins. */
export function connectionEndM(response: PathResponse, to: { segmentId: number; direction: Direction; atM: number }): number {
  for (const piece of response.pieces) {
    if (piece.segmentId !== to.segmentId || piece.direction !== to.direction) continue;
    if (piece.fromM - 0.01 <= to.atM && to.atM <= piece.toM + 0.01) {
      return piece.atM + Math.max(0, Math.min(piece.lengthM, to.atM - piece.fromM));
    }
  }
  return 0;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class SelectionController {
  private readonly deps: ControllerDeps;
  private listeners = new Set<() => void>();
  private snapshot: Snapshot;

  private mode: Mode = "idle";
  private selection: Selection | null = null;
  private features: SelectionFeature[] = [];
  private preview = false;
  private grownM = 0;
  private busy: Busy = null;
  private trimFrom: number | null = null;
  private error: string | null = null;

  private touch: Touch | null = null;
  private touchCount = 0;
  // Bumped whenever the rider replaces or clears the selection, so an answer
  // to an older one is dropped rather than written over the new.
  private generation = 0;
  private pendingAbort: AbortController | null = null;

  private holdStartedAt = 0;
  private lastFrameAt = 0;
  private pausedUntil = 0;
  private pausedAt = new Set<number>();
  private metresPerPt = 0;
  private cancelFrame: (() => void) | null = null;
  private firstHoldDone = false;

  constructor(deps: ControllerDeps) {
    this.deps = deps;
    this.snapshot = this.build();
  }

  // ---- for the screen to read ----

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;

  getMode = () => this.snapshot.mode;

  private canGrow(): boolean {
    // A trim ends the selection with a `cut` stop, which never grows: the fork
    // rule would only pick the trimmed branch again.
    if (!this.selection || this.preview) return false;
    return this.grownM < this.selection.lengthM - 0.01 || GROWABLE_STOPS.has(this.selection.stop.reason);
  }

  private build(): Snapshot {
    return {
      mode: this.mode,
      selection: this.selection,
      features: this.features,
      preview: this.preview,
      grownM: this.grownM,
      busy: this.busy,
      canGrow: this.canGrow(),
      trimFrom: this.trimFrom,
      error: this.error,
    };
  }

  private emit() {
    this.snapshot = this.build();
    for (const listener of this.listeners) listener();
  }

  private setSelection(selection: Selection | null, preview = false) {
    this.selection = selection;
    this.preview = preview;
    this.features = selection ? selectionFeatures(selection) : [];
  }

  // ---- touches ----

  /** A single finger came down on the map. */
  touchStarted(): number {
    this.dropTouch();
    this.touchCount += 1;
    this.touch = {
      id: this.touchCount,
      startedAt: this.deps.now(),
      hit: null,
      intent: null,
      longPressed: false,
      ended: false,
      asked: null,
      cancelAsk: null,
      generation: this.generation,
    };
    return this.touchCount;
  }

  /** What the screen found under touch `id`. */
  touchResolved(id: number, hit: Hit) {
    const touch = this.touch;
    if (!touch || touch.id !== id || touch.ended) return;
    touch.hit = hit;
    touch.intent = this.intentFor(hit);
    if (!touch.intent || touch.intent.kind === "resume") {
      if (touch.longPressed) this.beginHold(touch);
      return;
    }
    if (touch.longPressed) {
      this.ask(touch);
      this.beginHold(touch);
      return;
    }
    const waitMs = Math.max(0, touch.startedAt + ASK_AFTER_MS - this.deps.now());
    touch.cancelAsk = this.deps.later(() => {
      touch.cancelAsk = null;
      if (this.touch === touch && !touch.ended) this.ask(touch);
    }, waitMs);
  }

  /** The finger moved past the slop before the long press: a pan, not a hold. */
  touchMoved() {
    const touch = this.touch;
    if (!touch || touch.longPressed) return;
    this.dropTouch();
  }

  /** MapLibre's long press. */
  longPressed() {
    const touch = this.touch;
    if (!touch || touch.ended || touch.longPressed) return;
    touch.longPressed = true;
    if (!touch.hit) return; // still resolving: touchResolved starts the hold
    if (!touch.intent) return;
    if (touch.intent.kind !== "resume" && !touch.asked) {
      touch.cancelAsk?.();
      touch.cancelAsk = null;
      this.ask(touch);
    }
    this.beginHold(touch);
  }

  /** The finger lifted, or the touch was cancelled. */
  touchEnded() {
    const touch = this.touch;
    if (!touch) return;
    touch.ended = true;
    if (!touch.longPressed) {
      this.dropTouch();
      return;
    }
    if (this.mode === "holding") this.release();
  }

  // A touch that never became a hold: its request is called off. One that did
  // is left alone: its answer still lands, and what the hold grew is kept.
  private dropTouch() {
    const touch = this.touch;
    if (!touch) return;
    touch.cancelAsk?.();
    touch.cancelAsk = null;
    if (!touch.longPressed) touch.asked?.abort.abort();
    this.touch = null;
  }

  // ---- what a touch means ----

  private intentFor(hit: Hit): Intent | null {
    const selection = this.preview ? null : this.selection;
    if (selection && hit.piece !== null) return { kind: "resume" };
    if (selection && hit.branch) {
      const [lon, lat] = hit.branch.geometry.coordinates[0]!;
      const to = { segmentId: hit.branch.segmentId, direction: hit.branch.direction, lon: lon!, lat: lat!, atM: 0 };
      return { kind: "extend", request: this.extendRequest(selection, to), to, hit };
    }
    if (!hit.line) return null;
    const { segment, drawing } = hit.line;
    const [lon, lat] = hit.lonLat;
    const held: PathPoint = { segmentId: segment.id, direction: drawing.direction, lon: lon!, lat: lat! };
    if (selection) {
      const end = pointOnPath(selection, this.grownM);
      const start = pointOnPath(selection, 0);
      const toEnd = end ? distanceM(hit.lonLat, [end.lon, end.lat]) : Infinity;
      const toStart = start ? distanceM(hit.lonLat, [start.lon, start.lat]) : Infinity;
      if (toEnd <= NEAR_END_M && toEnd <= toStart) {
        const to = { ...held, atM: heldTravelM(segment, drawing, hit.lonLat) };
        return { kind: "extend", request: this.extendRequest(selection, to), to, hit };
      }
      if (toStart <= NEAR_END_M && start) {
        return {
          kind: "prepend",
          request: {
            from: held,
            to: { segmentId: start.segmentId, direction: start.direction, lon: start.lon, lat: start.lat, atM: start.atM },
            grow: false,
          },
          hit,
        };
      }
    }
    return { kind: "new", request: { from: held }, hit };
  }

  // A hold past the end: from the selection's end, through the held line, and
  // on from it, never back into what is selected.
  private extendRequest(selection: Selection, to: PathPoint & { atM: number }): PathRequest {
    const end = pointOnPath(selection, this.grownM)!;
    return {
      from: { segmentId: end.segmentId, direction: end.direction, lon: end.lon, lat: end.lat, atM: end.atM },
      to,
      grow: true,
      avoid: selectionSegmentIds(cutAt(selection, this.grownM)),
    };
  }

  private ask(touch: Touch) {
    const intent = touch.intent;
    if (!intent || intent.kind === "resume" || touch.asked) return;
    const abort = new AbortController();
    const asked: NonNullable<Touch["asked"]> = { abort, answer: null, failed: null };
    touch.asked = asked;
    this.deps.fetchPath(intent.request, abort.signal).then(
      (answer) => {
        asked.answer = answer;
        if (touch.longPressed) this.answered(touch);
      },
      (err) => {
        if (err instanceof RequestCancelled || abort.signal.aborted) return;
        asked.failed = err;
        if (touch.longPressed) this.answered(touch);
      },
    );
  }

  // ---- holding ----

  private beginHold(touch: Touch) {
    const intent = touch.intent;
    const hit = touch.hit;
    if (!intent || !hit) return;
    this.trimFrom = null;
    if (intent.kind === "resume") {
      if (!this.canGrow()) return;
      this.startGrowing(hit);
      return;
    }
    this.error = null;
    if (intent.kind === "new") {
      this.generation += 1;
      this.pendingAbort?.abort();
      this.pendingAbort = null;
      const { segment, drawing } = hit.line!;
      this.setSelection(previewSelection(segment, drawing, hit.lonLat), true);
      this.grownM = 0;
      this.busy = "path";
      touch.generation = this.generation;
      this.startGrowing(hit);
    } else {
      touch.generation = this.generation;
      this.mode = "holding";
      this.busy = "connect";
      this.emit();
    }
    if (touch.asked?.answer || touch.asked?.failed) this.answered(touch);
  }

  private startGrowing(hit: Hit) {
    this.mode = "holding";
    this.holdStartedAt = this.deps.now();
    this.lastFrameAt = this.holdStartedAt;
    this.pausedUntil = 0;
    this.pausedAt.clear();
    this.metresPerPt = metresPerPoint(hit.zoom, hit.lonLat[1]!);
    if (!this.firstHoldDone) {
      this.firstHoldDone = true;
      this.deps.onFirstHold?.();
    }
    this.emit();
    this.scheduleFrame();
  }

  private scheduleFrame() {
    if (this.cancelFrame) return;
    this.cancelFrame = this.deps.frame((now) => {
      this.cancelFrame = null;
      this.step(now);
    });
  }

  // One frame of growth: on at the hold's speed, paused briefly at each
  // junction the fork rule decided, and stopped at the end of what is fetched,
  // where a `limit` or `joined` end asks for more from the tip.
  private step(now: number) {
    if (this.mode !== "holding" || !this.selection || this.busy === "connect") return;
    const dtMs = Math.min(100, Math.max(0, now - this.lastFrameAt));
    this.lastFrameAt = now;
    if (now < this.pausedUntil) {
      this.scheduleFrame();
      return;
    }
    const speedMPerS = growthSpeedPtPerS((now - this.holdStartedAt) / 1000) * this.metresPerPt;
    let next = this.grownM + (speedMPerS * dtMs) / 1000;
    if (!this.preview) {
      const fork = this.selection.pieces.find(
        (p) => p.atM > this.grownM + 0.01 && p.atM <= next && p.rule !== null && FORK_RULES.has(p.rule) && !this.pausedAt.has(p.atM),
      );
      if (fork) {
        next = fork.atM;
        this.pausedAt.add(fork.atM);
        this.pausedUntil = now + FORK_PAUSE_MS;
      }
    }
    const endM = this.selection.lengthM;
    const atEnd = next >= endM;
    if (atEnd) {
      next = endM;
      if (!this.preview && !this.busy && GROWABLE_STOPS.has(this.selection.stop.reason)) this.askMore();
    }
    if (next !== this.grownM) {
      this.grownM = next;
      this.emit();
    }
    // At the end of what is fetched there is nothing to draw until the answer,
    // more path or a connection lands, and each of those starts the frames
    // again.
    if (!atEnd) this.scheduleFrame();
  }

  private release() {
    this.cancelFrame?.();
    this.cancelFrame = null;
    this.mode = this.selection ? "shown" : "idle";
    this.emit();
    if (!this.preview) this.fitSelection();
  }

  private fitSelection() {
    if (!this.selection || this.preview) return;
    const bounds = selectionBounds(this.selection, this.grownM);
    if (bounds) this.deps.fit(bounds);
  }

  // ---- answers ----

  private answered(touch: Touch) {
    const intent = touch.intent;
    const asked = touch.asked;
    if (!intent || intent.kind === "resume" || !asked) return;
    // The rider has since replaced, cleared, trimmed or flipped the selection.
    if (touch.generation !== this.generation) return;
    if (asked.failed) {
      this.cancelFrame?.();
      this.cancelFrame = null;
      this.busy = null;
      this.error = `Couldn't load the path: ${describeError(asked.failed)}`;
      if (intent.kind === "new") this.setSelection(null);
      this.mode = this.selection ? "shown" : "idle";
      this.emit();
      return;
    }
    const answer = asked.answer!;
    const stillHolding = this.mode === "holding" && this.touch === touch && !touch.ended;

    if (intent.kind === "new") {
      this.busy = null;
      if (answer.pieces.length === 0) {
        this.setSelection(null);
        this.mode = "idle";
        this.error = "Nothing to measure from here";
        this.emit();
        return;
      }
      this.setSelection(fromResponse(answer));
      this.grownM = Math.min(this.grownM, answer.lengthM);
      if (!stillHolding) {
        this.mode = "shown";
        this.fitSelection();
      }
      this.emit();
      if (stillHolding) this.scheduleFrame();
      return;
    }

    if (answer.stop.reason === "unreachable") {
      // No way from the selection to the held line: the hold starts a new
      // selection there instead, as the design asks.
      this.restartAsNew(touch, intent.hit, stillHolding);
      return;
    }
    const base = cutAt(this.selection!, this.grownM);
    this.busy = null;
    if (intent.kind === "extend") {
      const joinedM = base.lengthM + connectionEndM(answer, intent.to);
      this.setSelection(appendPath(base, answer));
      this.grownM = joinedM;
      if (stillHolding) {
        this.startGrowing(intent.hit);
      } else {
        this.mode = "shown";
        this.emit();
        this.fitSelection();
      }
      return;
    }
    // prepend: nothing grows from the start, so the hold is done.
    this.setSelection(prependPath(base, answer));
    this.grownM = base.lengthM + answer.lengthM;
    this.mode = "shown";
    this.cancelFrame?.();
    this.cancelFrame = null;
    this.emit();
    this.fitSelection();
  }

  private restartAsNew(touch: Touch, hit: Hit, stillHolding: boolean) {
    if (!hit.line) {
      this.busy = null;
      this.error = "No way from the selection to that line";
      this.emit();
      return;
    }
    const [lon, lat] = hit.lonLat;
    touch.intent = {
      kind: "new",
      request: { from: { segmentId: hit.line.segment.id, direction: hit.line.drawing.direction, lon: lon!, lat: lat! } },
      hit,
    };
    touch.asked = null;
    this.ask(touch);
    this.beginHold(touch);
    if (!stillHolding) this.release();
  }

  // More path from the tip, asked while the finger is down and growth has
  // reached the end of what was fetched: the 5km limit, the edge of the area
  // the server loaded, or the end of a flipped or connected selection.
  private askMore() {
    const selection = this.selection;
    if (!selection) return;
    const tip = pointOnPath(selection, selection.lengthM);
    if (!tip) return;
    const generation = this.generation;
    const abort = new AbortController();
    this.pendingAbort = abort;
    this.busy = "more";
    this.emit();
    this.deps
      .fetchPath(
        { from: { segmentId: tip.segmentId, direction: tip.direction, lon: tip.lon, lat: tip.lat, atM: tip.atM }, avoid: selectionSegmentIds(selection) },
        abort.signal,
      )
      .then(
        (answer) => {
          if (generation !== this.generation || this.selection !== selection) return;
          this.busy = null;
          this.setSelection(appendPath(selection, answer));
          this.emit();
          if (this.mode === "holding") this.scheduleFrame();
        },
        (err) => {
          if (err instanceof RequestCancelled || abort.signal.aborted || generation !== this.generation) return;
          this.busy = null;
          this.error = `Couldn't load more: ${describeError(err)}`;
          this.emit();
        },
      );
  }

  // ---- the card's buttons, and taps ----

  /** A tap on the selection: preview trimming from that piece to the end. */
  tapSelection(piece: number) {
    if (!this.selection || this.preview || this.mode === "holding") return;
    if (piece < 0 || piece >= this.selection.pieces.length || this.selection.pieces[piece]!.atM >= this.grownM) return;
    this.trimFrom = piece;
    this.emit();
  }

  /** A tap anywhere else on the map. */
  tapMap() {
    if (this.trimFrom === null) return;
    this.trimFrom = null;
    this.emit();
  }

  cancelTrim() {
    this.tapMap();
  }

  // Trimming keeps everything before the tapped piece. It cannot grow again
  // by itself, since the fork rule would only pick the trimmed branch again:
  // the rider holds the line they want instead.
  confirmTrim() {
    if (!this.selection || this.trimFrom === null) return;
    const atM = this.selection.pieces[this.trimFrom]!.atM;
    this.trimFrom = null;
    if (atM <= 0.5) {
      this.clear();
      return;
    }
    this.generation += 1;
    this.setSelection(cutAt(this.selection, atM));
    this.grownM = atM;
    this.emit();
    this.fitSelection();
  }

  async flip() {
    if (!this.selection || this.preview || this.busy || this.mode === "holding") return;
    const base = cutAt(this.selection, this.grownM);
    this.generation += 1;
    const generation = this.generation;
    this.trimFrom = null;
    this.error = null;
    this.busy = "flip";
    this.emit();
    try {
      const { selection } = await flipSelection(base, (request) => this.deps.fetchPath(request));
      if (generation !== this.generation) return;
      this.setSelection(selection);
      this.grownM = selection.lengthM;
      this.busy = null;
      this.emit();
      this.fitSelection();
    } catch (err) {
      if (generation !== this.generation) return;
      this.busy = null;
      this.error = err instanceof FlipFailed ? `Can't flip this: ${err.message}` : `Couldn't flip: ${describeError(err)}`;
      this.emit();
    }
  }

  /** The close button, or Android back. */
  clear() {
    this.generation += 1;
    this.pendingAbort?.abort();
    this.pendingAbort = null;
    this.cancelFrame?.();
    this.cancelFrame = null;
    if (this.touch?.longPressed) this.touch.asked?.abort.abort();
    this.setSelection(null);
    this.mode = "idle";
    this.grownM = 0;
    this.busy = null;
    this.trimFrom = null;
    this.error = null;
    this.emit();
  }

  /** Android back: closes the trim question first, then the selection. Returns whether it used the press. */
  back(): boolean {
    if (this.trimFrom !== null) {
      this.cancelTrim();
      return true;
    }
    if (this.selection || this.error) {
      this.clear();
      return true;
    }
    return false;
  }
}

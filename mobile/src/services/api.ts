import { API_BASE_URL } from "../config";
import type { SegmentWithGradients, TrackedSample } from "../types";

// fetch has no default timeout, so a request that stalls -- which on a bike,
// on mobile data, handing between towers, is routine -- hangs forever. A ride
// once sat on "Saving ride…" for 22 minutes because of this, with nothing to
// abort it and no error to report.
const DEFAULT_TIMEOUT_MS = 20000;
// Matching runs the whole map-match and DEM anchoring pass, so it is allowed
// much longer than a plain upload before being given up on.
const END_SESSION_TIMEOUT_MS = 120000;

async function request<T>(path: string, init?: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // `...init` goes first so a caller can never overwrite `signal` and switch
    // the timeout off by accident, and so headers merge rather than replace.
    const res = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
    if (res.status === 204) return undefined as T;
    return res.json();
  } catch (err) {
    // Ask the controller, not the error. Expo SDK 57 installs its own native
    // fetch whose rejection is a plain Error -- `name` stays "Error", so the
    // usual `name === "AbortError"` test never fired and every timeout reached
    // the user as the raw "fetch failed: Fetch request has been canceled".
    // `signal.aborted` is ours and is guaranteed by the spec once abort() runs.
    if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
      throw new Error(`${path} timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// `startedAt` travels with the request because the session is now created when
// a ride is saved, not when it starts -- so the server can no longer infer the
// start time from the clock.
export function startSession(startedAt?: string): Promise<{ id: number; started_at: string }> {
  return request("/sessions", {
    method: "POST",
    body: JSON.stringify(startedAt ? { startedAt } : {}),
  });
}

export function deleteSession(sessionId: number): Promise<{ deleted: number }> {
  return request(`/sessions/${sessionId}`, { method: "DELETE" });
}

export function uploadSamples(sessionId: number, samples: TrackedSample[]): Promise<void> {
  return request(`/sessions/${sessionId}/samples`, {
    method: "POST",
    body: JSON.stringify({ samples }),
  });
}

// Uploaded in chunks so a stalled connection costs one chunk rather than the
// whole ride, and so `onChunkUploaded` can drop what has landed from the
// phone's buffer -- a retry then resumes instead of starting over. The server
// ignores samples it already holds, so a chunk whose response was lost is safe
// to send again.
//
// 125 rather than 250. At 250 a chunk is ~51KB of JSON, and for that to miss
// the 20s budget the uplink has to be under ~20kbit/s -- an ordinary bad
// cellular link at a trailhead, which is where rides end. Halving it halves the
// throughput each chunk needs, and halves how much progress a failure costs.
// Measured against the live API, a 250-sample chunk answers in 0.8-1.2s of
// which roughly a third is fixed overhead, so a 790-fix ride goes from about
// 3.6s over 4 chunks to about 4.9s over 7. A second on a good link buys a much
// better chance of finishing on a bad one.
//
// A longer timeout was the obvious alternative and is the wrong one: it does
// not make the upload more likely to finish, only the wait before finding out
// longer.
//
// **Not yet confirmed against a real failure.** The backend now logs
// method, path, status, duration and content-length, so the next timeout will
// say which of two things is happening: `ABORTED-BY-CLIENT ~20000ms ~52000B`
// means the upload stalled in flight and this is the right fix, while a clean
// `204` logged at the moment the phone reported failure means the server
// finished and the reply was lost -- which this does not address, and which
// would want idempotent retry instead.
const UPLOAD_CHUNK = 125;

export async function uploadSamplesInChunks(
  sessionId: number,
  samples: TrackedSample[],
  onChunkUploaded?: (uploaded: number) => Promise<void> | void,
): Promise<void> {
  for (let start = 0; start < samples.length; start += UPLOAD_CHUNK) {
    const chunk = samples.slice(start, start + UPLOAD_CHUNK);
    await uploadSamples(sessionId, chunk);
    await onChunkUploaded?.(start + chunk.length);
  }
}

export function endSession(sessionId: number): Promise<{ matchedRuns: number }> {
  return request(`/sessions/${sessionId}/end`, { method: "POST" }, END_SESSION_TIMEOUT_MS);
}

export interface Bbox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export function fetchSegments(bbox: Bbox): Promise<{ segments: SegmentWithGradients[] }> {
  const params = new URLSearchParams({
    minLon: String(bbox.minLon),
    minLat: String(bbox.minLat),
    maxLon: String(bbox.maxLon),
    maxLat: String(bbox.maxLat),
  });
  return request(`/segments?${params}`);
}

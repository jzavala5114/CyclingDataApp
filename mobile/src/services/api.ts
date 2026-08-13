import { API_BASE_URL } from "../config";
import type { SegmentWithGradients, TrackedSample } from "../types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
  if (res.status === 204) return undefined as T;
  return res.json();
}

export function startSession(): Promise<{ id: number; started_at: string }> {
  return request("/sessions", { method: "POST" });
}

export function uploadSamples(sessionId: number, samples: TrackedSample[]): Promise<void> {
  return request(`/sessions/${sessionId}/samples`, {
    method: "POST",
    body: JSON.stringify({ samples }),
  });
}

export function endSession(sessionId: number): Promise<{ matchedRuns: number }> {
  return request(`/sessions/${sessionId}/end`, { method: "POST" });
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

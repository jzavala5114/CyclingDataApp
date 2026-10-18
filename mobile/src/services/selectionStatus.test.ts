import { strict as assert } from "node:assert";
import { test } from "node:test";
import { fromResponse } from "./pathSelection.js";
import { statusFor } from "./selectionStatus.js";
import { makePath } from "./testPaths.js";
import type { PathEnd } from "../types";

// What the card tells the rider to do next. Every reason growth can stop for
// gets its own words, because "hold the next line" and "hold the selection"
// are different gestures, and the wrong one does nothing.

const base = { mode: "shown" as const, busy: null, preview: false, error: null };
const at = (reason: PathEnd, aheadM = 0) => {
  const selection = fromResponse(makePath([{ segmentId: 1, lengthM: 300, slopes: [2] }], { reason, aheadM }));
  return statusFor({ ...base, selection, grownM: 300 })!.text;
};

test("each way growth stops says how to carry on", () => {
  assert.equal(at("fork"), "Fork: hold the way you want");
  assert.equal(at("fork", 40), "Fork 130 ft ahead: hold the way you want");
  assert.equal(at("end"), "The way ends here");
  assert.equal(at("end", 40), "The way ends 130 ft on");
  assert.equal(at("gap"), "No data ahead: hold the next line to bridge the gap");
  assert.equal(at("loop"), "It runs back into the selection here");
  assert.equal(at("limit"), "Hold the selection to keep going");
  assert.equal(at("joined"), "Hold the selection to keep going");
});

test("let go short of the end, holding the selection carries on; after a trim, the next line does", () => {
  const selection = fromResponse(makePath([{ segmentId: 1, lengthM: 300, slopes: [2] }], { reason: "fork" }));
  assert.equal(statusFor({ ...base, selection, grownM: 120 })!.text, "Hold the selection to keep going");
  const trimmed = { ...selection, lengthM: 120, stop: { reason: "cut" as const, atM: 120, aheadM: 0, branches: [] } };
  assert.equal(statusFor({ ...base, selection: trimmed, grownM: 120 })!.text, "Hold the next line to go on");
});

test("waiting shows a spinner; an error wins over everything; a stand-in says nothing", () => {
  const selection = fromResponse(makePath([{ segmentId: 1, lengthM: 300, slopes: [2] }]));
  assert.deepEqual(statusFor({ ...base, selection, grownM: 10, busy: "path", preview: true }), {
    text: "Finding the way…",
    tone: "info",
    waiting: true,
  });
  assert.equal(statusFor({ ...base, selection, grownM: 10, mode: "holding" })!.text, "Lift your finger to stop");
  assert.equal(statusFor({ ...base, selection, grownM: 10, busy: "more", error: "Couldn't load more: x" })!.tone, "error");
  assert.equal(statusFor({ ...base, selection, grownM: 10, preview: true }), null);
  assert.equal(statusFor({ ...base, selection: null, grownM: 0 }), null);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  qualifiesAt,
  MIN_COVERAGE,
  MIN_SPAN_M,
  SHIPPED_GATE,
} from "./elevationAggregator.js";

// The traversal gate had no test of its own until it became one function that
// production and the sweep both call (eval:gate). These pin the shipped rule.

test("the shipped gate is 25m of ground or 70% of the segment", () => {
  assert.equal(MIN_SPAN_M, 25);
  assert.equal(MIN_COVERAGE, 0.7);
  assert.deepEqual(SHIPPED_GATE, { minSpanM: 25, minCoverage: 0.7 });
});

test("BOUNDARY: either door is inclusive, and each opens on its own", () => {
  assert.equal(qualifiesAt(25, 0), true, "span alone, exactly");
  assert.equal(qualifiesAt(24.99, 0.69), false);
  assert.equal(qualifiesAt(0, 0.7), true, "coverage alone, exactly");
  assert.equal(qualifiesAt(10, 0.71), true, "a short segment ridden end to end");
  assert.equal(qualifiesAt(200, 0.1), true, "a long run on a long segment");
});

test("other thresholds move only the door they name", () => {
  const loose = { minSpanM: 18, minCoverage: 0.7 };
  assert.equal(qualifiesAt(20, 0.1, loose), true);
  assert.equal(qualifiesAt(20, 0.1), false, "the default is still the shipped gate");
  assert.equal(qualifiesAt(17, 0.69, loose), false);
  assert.equal(qualifiesAt(17, 0.5, { minSpanM: 25, minCoverage: 0.5 }), true);
});

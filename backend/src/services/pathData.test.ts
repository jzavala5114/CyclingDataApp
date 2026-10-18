import { test } from "node:test";
import assert from "node:assert/strict";
import { boxAround, insideBox } from "./pathData.js";

// The box GET /segments/path loads its network for, and the margin inside it
// where growth stops rather than decide a junction whose branches may be
// missing. Metres north are the same everywhere; metres east shrink with the
// latitude, by cos(38.83 degrees) = 0.779 here.

test("boxAround pads by metres, east-west as well as north-south", () => {
  const box = boxAround([[-104.82, 38.83]], 1000);
  assert.ok(Math.abs((box.maxLat - 38.83) * 111_320 - 1000) < 1e-6);
  const eastM = (box.maxLon + 104.82) * 111_320 * Math.cos((38.83 * Math.PI) / 180);
  assert.ok(Math.abs(eastM - 1000) < 1e-6, `east ${eastM}`);
  assert.ok(Math.abs(box.minLon + 104.82 + (box.maxLon + 104.82)) < 1e-12, "symmetric");
});

test("insideBox keeps a margin: the centre is in, 50 m from the edge is out at a 100 m margin", () => {
  const box = boxAround([[-104.82, 38.83]], 1000);
  const inside = insideBox(box, 100);
  assert.equal(inside([-104.82, 38.83]), true);
  assert.equal(inside([-104.82, 38.83 + 850 / 111_320]), true);
  assert.equal(inside([-104.82, 38.83 + 950 / 111_320]), false);
  const eastDeg = 950 / (111_320 * Math.cos((38.83 * Math.PI) / 180));
  assert.equal(inside([-104.82 + eastDeg, 38.83]), false);
});

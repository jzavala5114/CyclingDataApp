import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SELECTION_HIT_LAYERS, SELECTION_LAYER } from "../services/holdGesture.js";

// SelectionLayers.tsx loads react-native, which node cannot, so this reads its
// source. What it pins: a tap on any of the selection asks to trim there, the
// run still growing included, so every source that draws the selection's own
// line takes taps; and every layer the hit test names is drawn. An opening
// tag with an arrow function in it would cut the tag short here and fail the
// test: give the handler a name, as the file does.

const source = readFileSync(join(__dirname, "SelectionLayers.tsx"), "utf8");
const sources = source
  .split("<GeoJSONSource")
  .slice(1)
  .map((chunk) => chunk.slice(0, chunk.indexOf("</GeoJSONSource>")));
const keyOf = (id: string) => Object.entries(SELECTION_LAYER).find(([, value]) => value === id)![0];
const drawing = (id: string) => sources.filter((s) => s.includes(`id={SELECTION_LAYER.${keyOf(id)}}`));

test("every source that draws the selection's own line takes taps, the run still growing included", () => {
  for (const id of [SELECTION_LAYER.line, SELECTION_LAYER.gap, SELECTION_LAYER.growingLine, SELECTION_LAYER.growingGap]) {
    const owners = drawing(id);
    assert.equal(owners.length, 1, `${id} is drawn by one source`);
    const openingTag = owners[0]!.slice(0, owners[0]!.indexOf(">"));
    assert.match(openingTag, /onPress=\{onPress\}/, `the source drawing ${id} takes taps`);
  }
});

test("every layer the hit test names is a layer the map draws", () => {
  for (const id of SELECTION_HIT_LAYERS) assert.equal(drawing(id).length, 1, `${id} is drawn`);
});

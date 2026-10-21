import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SELECTION_HIT_LAYERS } from "../services/holdGesture.js";

// The card, the map's dot and the screen load react-native, which node cannot,
// so this reads their source. What it pins is the profile scrub's wiring
// (services/profileScrub.ts has the arithmetic): the profile takes the touch
// itself and keeps it, letting go or losing it hides the point, a move redraws
// only what reads the point, the card keeps its height, and the map's dot is
// drawn above everything and takes no taps. Handlers are named, not inline:
// an arrow function's ">" would cut an opening tag short here.

const card = readFileSync(join(__dirname, "SelectionCard.tsx"), "utf8");
const layers = readFileSync(join(__dirname, "SelectionLayers.tsx"), "utf8");
const screen = readFileSync(join(__dirname, "..", "screens", "MapScreen.tsx"), "utf8");

const openingTag = (source: string, marker: string) => {
  const at = source.indexOf(marker);
  assert.ok(at >= 0, `${marker} is in the source`);
  const start = source.lastIndexOf("<", at);
  return source.slice(start, source.indexOf(">", at));
};
const body = (source: string, name: string) => {
  const at = source.indexOf(name);
  assert.ok(at >= 0, `${name} is in the source`);
  return source.slice(at, source.indexOf("\n}", at));
};

test("the profile takes the touch itself and keeps it; letting go, or losing it, hides the point", () => {
  const tag = openingTag(card, "onResponderGrant=");
  assert.match(tag, /style=\{styles\.profile\}/, "on the profile");
  assert.match(tag, /pointerEvents="box-only"/, "the bars never take the touch, so locationX is from the profile's edge");
  for (const [prop, handler] of [
    ["onStartShouldSetResponder", "canScrub"],
    ["onMoveShouldSetResponder", "never"],
    ["onResponderTerminationRequest", "keepScrub"],
    ["onResponderGrant", "startScrub"],
    ["onResponderMove", "moveScrub"],
    ["onResponderRelease", "endScrub"],
    ["onResponderTerminate", "endScrub"],
  ]) {
    assert.match(tag, new RegExp(`${prop}=\\{${handler}\\}`), `${prop} is ${handler}`);
  }
  // The gesture's rules are createScrubGesture's (profileScrub.test.ts tests
  // them); the card only hands it the responder's events.
  assert.match(card, /const never = \(\) => false;/, "a move never starts a scrub: its locationX is not the profile's");
  assert.match(card, /const keepScrub = \(\) => false;/, "a scrub is not given up to another view mid-drag");
  assert.match(card, /const canScrub = \(\) => gesture\.canStart\(\);/);
  assert.match(card, /const startScrub = \(e: GestureResponderEvent\) => gesture\.grant\(e\.nativeEvent\);/);
  assert.match(card, /const moveScrub = \(e: GestureResponderEvent\) => gesture\.move\(e\.nativeEvent\);/);
  assert.match(card, /const endScrub = \(\) => gesture\.end\(\);/);
  assert.match(card, /createScrubGesture\(scrub, \(\) => \(\{ profile: latest\.current\.profile, scrubbable: latest\.current\.scrubbable, width: widthRef\.current \}\)\)/);
  assert.match(card, /const scrubbable = [^;]*mode !== "holding"/, "no scrub while a hold is growing the selection");
  assert.match(card, /const profile = useMemo\(\(\) => scrubProfile\(selection, grownM, preview\), \[selection, preview, grownM\]\);/);
});

test("a new answer, a flip, a trim or a close ends the scrub, so a profile gone mid-scrub cannot leave it running", () => {
  assert.match(card, /useEffect\(\(\) => \(\) => gesture\.end\(\), \[gesture, profile\]\);/);
});

test("the readout and the cursor draw what profileScrub.ts works out, never their own arithmetic", () => {
  assert.match(body(card, "function ScrubReadout"), /const readout = scrubReadout\(point\);/);
  assert.match(body(card, "function ScrubCursor"), /cursorLeft\(point, lengthM, width, CURSOR_WIDTH\)/);
  assert.match(card, /<ScrubCursor scrub=\{scrub\} lengthM=\{profile\?\.lengthM \?\? 0\} width=\{profileWidth\} \/>/);
  assert.match(body(card, "function ScrubReadout"), /numberOfLines=\{1\} adjustsFontSizeToFit/, "one line, shrunk to fit at a large font size");
});

test("a move redraws only what reads the point: the readout and the cursor, never the bars", () => {
  for (const reader of ["function ScrubCursor", "function ScrubReadout"]) {
    assert.match(body(card, reader), /useSyncExternalStore\(scrub\.subscribe, scrub\.get\)/, `${reader} reads the store`);
  }
  const bars = body(card, "const ProfileBars = memo(");
  assert.ok(!/scrub/.test(bars), "the bars know nothing of the scrub");
  assert.match(card, /<ProfileBars columns=\{columns\} low=\{low\} range=\{range\} \/>/);
});

test("the readout is drawn over the totals, so the card keeps its height while a finger is down", () => {
  const readout = card.slice(card.indexOf("readout: {"), card.indexOf("},", card.indexOf("readout: {")));
  for (const edge of ["position: \"absolute\"", "top: 0", "left: 0", "right: 0", "bottom: 0", "backgroundColor: \"white\""]) {
    assert.ok(readout.includes(edge), `the readout style has ${edge}`);
  }
  assert.match(body(card, "function ScrubReadout"), /pointerEvents="none"/);
});

test("the map's dot takes no taps and is drawn above every other layer", () => {
  const dot = body(layers, "export function ScrubDot");
  assert.ok(!/onPress/.test(dot), "its source takes no taps");
  assert.ok(!SELECTION_HIT_LAYERS.includes("selection-scrub-dot"), "the hold's hit test does not name it");
  const map = screen.slice(screen.indexOf("<MapView"), screen.indexOf("</MapView>"));
  const last = map.trimEnd().split("\n").filter((line) => line.trim().startsWith("<")).at(-1)!;
  assert.match(last, /<ScrubDot scrub=\{scrub\} \/>/, "the last thing the map draws");
  assert.match(openingTag(screen, "<SelectionCard"), /scrub=\{scrub\}/, "the card sets the point the dot reads");
});

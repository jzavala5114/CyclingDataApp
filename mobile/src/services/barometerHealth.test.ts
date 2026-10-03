import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  HEALTHY_HZ,
  HEALTHY_USED_SHARE,
  HEALTH_WINDOW_FIXES,
  MIN_FIXES_TO_JUDGE,
  NATIVE_PROVE_ITSELF_MS,
  describeBarometer,
  recentBarometerShare,
  shouldAbandonNative,
  verdictFor,
  type BarometerHealth,
} from "./barometerHealth.js";

// The line on the map is the only instrument the rider has mid-ride, so these
// pin the one distinction that matters: a sensor delivering nothing must not
// read the same as a sensor delivering. Everything else here is there so the
// first case cannot be broken by a later edit without a test noticing.
//
// The tests marked REGRESSION are for defects a cold review found and proved by
// running the real code. Each names what the broken version reported.

function health(over: Partial<BarometerHealth> = {}): BarometerHealth {
  return {
    path: "native",
    registered: true,
    hz: 5,
    readings: 1000,
    repaired: 0,
    wakeUp: false,
    usedShare: 1,
    ...over,
  };
}

const gps = (n: number) => Array.from({ length: n }, () => "gps" as const);
const baro = (n: number) => Array.from({ length: n }, () => "barometer" as const);

test("SILENT is its own verdict: a listener that registered and got nothing", () => {
  // The failure this whole change could have. Everything reports success, the
  // ride records GPS altitude the whole way, and nothing says so until upload.
  const verdict = verdictFor(health({ usedShare: 0, hz: 0, readings: 0 }));
  assert.equal(verdict, "silent");
  assert.match(describeBarometer(health({ usedShare: 0, hz: 0 })), /SILENT/);
});

test("REGRESSION: 5 Hz with no fix using it reads SILENT, not good", () => {
  // A cold review's reproduction. A sensor whose clock disagrees with the
  // phone's delivers at a perfect rate into no fix's window: the old line said
  // "Barometer 5.0 Hz, 12000 readings" while every stored height was GPS,
  // because it counted readings that ARRIVED rather than readings that were
  // USED.
  const lying = health({ hz: 5, readings: 12_000, usedShare: 0 });
  assert.equal(verdictFor(lying), "silent");
  assert.doesNotMatch(describeBarometer(lying), /5\.0 Hz/);
  assert.match(describeBarometer(lying), /SILENT/);
});

test("REGRESSION: an unregistered sensor is OFFLINE, not 'starting' forever", () => {
  // `OnDestroy` stops the module on a registry teardown, which a development
  // reload does mid-ride. The old health had no field for it, so the screen
  // kept whatever the start had set and read "Barometer starting" for the rest
  // of the ride.
  const stopped = health({ registered: false });
  assert.equal(verdictFor(stopped), "offline");
  assert.match(describeBarometer(stopped), /STOPPED/);
  assert.notEqual(describeBarometer(stopped), "Barometer starting");
});

test("THE USED SHARE outranks the rate, because the rate can look perfect while nothing lands", () => {
  assert.equal(verdictFor(health({ hz: 5, usedShare: 0 })), "silent");
  assert.equal(verdictFor(health({ hz: 5, usedShare: 0.5 })), "patchy");
  assert.equal(verdictFor(health({ hz: 5, usedShare: 1 })), "good");
});

test("BOUNDARY: the healthy share is exclusive below, so exactly 80% is not patchy", () => {
  assert.equal(verdictFor(health({ usedShare: HEALTHY_USED_SHARE })), "good");
  assert.equal(verdictFor(health({ usedShare: HEALTHY_USED_SHARE - 0.01 })), "patchy");
  // Pinned against literals as well as against the constant. Asserting only
  // through the constant means the test moves WITH the number it is meant to
  // pin: mutation testing caught exactly that on HEALTHY_HZ below.
  assert.equal(verdictFor(health({ usedShare: 0.8 })), "good");
  assert.equal(verdictFor(health({ usedShare: 0.5 })), "patchy");
});

test("BOUNDARY: the healthy rate is exclusive below, so exactly 2.5 Hz is not slow", () => {
  assert.equal(verdictFor(health({ hz: HEALTHY_HZ })), "good");
  assert.equal(verdictFor(health({ hz: HEALTHY_HZ - 0.01 })), "slow");
  // Literals too. Reading the threshold back out of the constant made this
  // test pass with HEALTHY_HZ mutated from 2.5 to 1.0 -- it moved with the
  // number instead of pinning it, which a surviving mutant is how we found out.
  assert.equal(verdictFor(health({ hz: 2.5 })), "good");
  assert.equal(verdictFor(health({ hz: 2 })), "slow");
  assert.equal(verdictFor(health({ hz: 1 })), "slow");
});

test("no fixes yet reads as good, not as silence, so a fresh ride is not alarming", () => {
  // The counters are polled every 5s and the first read lands before any fix
  // has been buffered. Treating a missing share as zero would put "SILENT" on
  // screen at the start of every ride.
  assert.equal(verdictFor(health({ usedShare: null })), "good");
  assert.equal(describeBarometer(health({ usedShare: null })), "Barometer starting");
});

test("but no fixes AND a zero rate is silence, because the sensor itself said so", () => {
  assert.equal(verdictFor(health({ usedShare: null, hz: 0 })), "silent");
});

test("the expo-sensors fallback SAYS it stops at a screen lock, rather than looking healthy", () => {
  // On this path the ride is not the experiment the rider thinks it is, and
  // the line has to say so or a failed test ride gets blamed on the module.
  const verdict = verdictFor(health({ path: "sensors", hz: null, readings: null }));
  assert.equal(verdict, "fallback");
  assert.match(describeBarometer(health({ path: "sensors" })), /screen locks/);
});

test("no sensor at all is absent, and so is a null health", () => {
  assert.equal(verdictFor(null), "absent");
  assert.equal(verdictFor(health({ path: "none" })), "absent");
  assert.match(describeBarometer(null), /No barometer/);
});

test("repaired timestamps degrade the verdict even at a healthy rate and share", () => {
  // A device whose sensor clock does not agree with its boot clock gets
  // readings stamped "now", which silently turns the per-fix window back into
  // "the newest readings". Rate and share can both look fine while it happens.
  const degraded = health({ hz: 5, usedShare: 1, repaired: 42 });
  assert.equal(verdictFor(degraded), "degraded");
  assert.match(describeBarometer(degraded), /42 bad timestamps/);
});

test("a healthy native path names the share first, because that is the measure", () => {
  assert.equal(describeBarometer(health()), "Barometer 100% of fixes, 5.0 Hz");
});

test("the wake-up sensor is named when it was obtained, because it is rare", () => {
  assert.match(describeBarometer(health({ wakeUp: true })), /wake-up/);
  assert.doesNotMatch(describeBarometer(health({ wakeUp: false })), /wake-up/);
});

test("CONTROL: every verdict produces a non-empty line and none of them throws", () => {
  const cases: (BarometerHealth | null)[] = [
    null,
    health(),
    health({ path: "none" }),
    health({ path: "sensors" }),
    health({ registered: false }),
    health({ usedShare: 0 }),
    health({ usedShare: null }),
    health({ usedShare: null, hz: null }),
    health({ usedShare: 0.3 }),
    health({ hz: 1 }),
    health({ hz: null }),
    health({ repaired: 1 }),
    health({ readings: null }),
    health({ hz: 0.0001, readings: 1, usedShare: 0.9 }),
  ];
  for (const input of cases) {
    const line = describeBarometer(input);
    assert.ok(line.length > 0, `empty line for ${JSON.stringify(input)}`);
    assert.doesNotMatch(line, /undefined|null|NaN/, `leaked a placeholder: ${line}`);
  }
});

// --- the watchdog ----------------------------------------------------------

test("REGRESSION: a native path producing only gps fixes is abandoned, so the old path comes back", () => {
  // THE SEVERE ONE. `startAsync` returning true means Android accepted the
  // registration, not that a reading arrived. The hook treated it as success
  // and never subscribed `expo-sensors`, so a sensor that registered and went
  // quiet cost the ride its barometer entirely -- including the screen-on part
  // that worked before this change existed. A cold review reproduced it against
  // the real background task: the same three fixes gave "barometer, barometer,
  // barometer" without the native module and "gps, gps, gps" with it.
  assert.equal(shouldAbandonNative(NATIVE_PROVE_ITSELF_MS, gps(10)), true);
});

test("ONE barometric fix is enough to keep the native path, because partial silence is not silence", () => {
  const mostlyGps = [...gps(9), "barometer" as const];
  assert.equal(shouldAbandonNative(60_000, mostlyGps), false);
  assert.equal(shouldAbandonNative(60_000, baro(10)), false);
});

test("the grace period is real: an all-gps opening is not convicted early", () => {
  assert.equal(shouldAbandonNative(NATIVE_PROVE_ITSELF_MS - 1, gps(10)), false);
  assert.equal(shouldAbandonNative(NATIVE_PROVE_ITSELF_MS, gps(10)), true);
  // Literals as well as the constant. Reading the threshold back out of the
  // constant makes the test move WITH it: at NATIVE_PROVE_ITSELF_MS mutated to
  // zero, `0 - 1` is still below zero and the assertions above still passed.
  // Five seconds into a ride is one or two fixes, far too early to convict.
  assert.equal(shouldAbandonNative(5_000, gps(10)), false);
  assert.equal(shouldAbandonNative(19_000, gps(10)), false);
  assert.equal(shouldAbandonNative(25_000, gps(10)), true);
});

test("too few fixes is not evidence, however long the ride has run", () => {
  // A ride producing three fixes in a minute has a GPS problem, and swapping
  // the elevation source would not help it.
  assert.equal(shouldAbandonNative(600_000, gps(MIN_FIXES_TO_JUDGE - 1)), false);
  assert.equal(shouldAbandonNative(600_000, gps(MIN_FIXES_TO_JUDGE)), true);
  assert.equal(shouldAbandonNative(600_000, []), false);
});

test("a NaN elapsed time does not abandon the better sensor", () => {
  // `startedAtMs` can come back null from the native counters, and
  // `Date.now() - null` is not what anyone wants deciding this.
  assert.equal(shouldAbandonNative(NaN, gps(10)), false);
  assert.equal(shouldAbandonNative(-1, gps(10)), false);
});

test("the share is null with nothing to judge, and zero with all-gps fixes", () => {
  assert.equal(recentBarometerShare([]), null);
  assert.equal(recentBarometerShare(gps(10)), 0);
  assert.equal(recentBarometerShare(baro(10)), 1);
  assert.equal(recentBarometerShare([...gps(5), ...baro(5)]), 0.5);
});

test("THE WINDOW is the recent fixes, so a sensor that dies an hour in is still caught", () => {
  // The caller takes the last HEALTH_WINDOW_FIXES. A whole-ride share would be
  // dominated by the healthy hour and would never convict.
  const wholeRide = [...baro(500), ...gps(10)];
  const recent = wholeRide.slice(-HEALTH_WINDOW_FIXES);
  assert.equal(recentBarometerShare(wholeRide)! > 0.9, true, "the whole ride looks fine");
  assert.equal(shouldAbandonNative(3_600_000, wholeRide), false, "and would never convict");
  assert.equal(shouldAbandonNative(3_600_000, recent), true, "the recent window does");
});

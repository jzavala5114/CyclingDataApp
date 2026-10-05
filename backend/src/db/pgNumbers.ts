// Numbers that node-postgres hands back as text, converted at the boundary.
//
// pg returns `bigint` (int8) and `numeric` columns as STRINGS, deliberately:
// a JS number cannot hold every int8 exactly, and numeric is arbitrary
// precision, so the driver refuses to guess. Every id in schema.sql is a
// `bigserial` or `bigint`, so every id this backend reads arrives as "84", not
// 84, whatever the TypeScript interface on the query says. `int` and `double
// precision` come back as real numbers; these two types do not.
//
// **It has failed silently twice on record, and neither failure threw.** A
// `Set<number>` never matched a session id, so a counter stayed at 0 and a
// headline metric printed a harmless-looking "n/a" instead of a rate
// (evalLinkerFold, 2026-09-28). A `Number()` on one side of a segment-id
// comparison turned the whole street graph into "nothing is connected to
// anything" and reported "Viterbi recovers nothing" (a measurement script,
// 2026-10-03). A third hazard was latent rather than live: a share of
// "0.00000000000000000000" is a TRUTHY string, so any `if (share)` would read a
// perfect ride as a bad one. Removing that property is the point: a value that
// is not what the type says becomes an error with the field name attached,
// never a quiet wrong answer.
//
// Strict on purpose. Each string pattern accepts the text Postgres emits for
// that type and refuses what `Number` would quietly coerce: "" (which `Number`
// reads as 0), " 84", "1e3", "0x54", "NaN", "Infinity". The patterns are a
// little looser than Postgres's own output -- they accept "0084" and "-0",
// which Postgres never emits -- and that is harmless, because both still
// convert to the number they name.

const INT8_TEXT = /^-?\d+$/;
const NUMERIC_TEXT = /^-?\d+(\.\d+)?$/;

/** The bad value, for an error message. Never throws while building one. */
const show = (value: unknown): string => {
  if (typeof value === "bigint") return `${value}n`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // An object holding a bigint, or a cycle. Formatting the error must not
    // replace it with a different, less useful one.
    return Object.prototype.toString.call(value);
  }
};

/**
 * A `bigint` / `bigserial` column as a JS number, exactly.
 *
 * Accepts what pg returns by default (a string), what it returns if the query
 * casts to `int` (a number), and a native `bigint` in case the driver is ever
 * configured to produce one. Throws on anything else, on a null (ids here are
 * primary or foreign keys, never null), and on `undefined`, which is what a
 * renamed or misspelled column alias produces.
 *
 * Throws past `Number.MAX_SAFE_INTEGER` rather than rounding: two distinct ids
 * that round to the same double would silently become one row's worth of
 * Map key. Current ids are in the hundreds of thousands and OSM node ids around
 * 1.3e10, against a limit of 9.007e15, so this is a tripwire, not a constraint.
 */
export function bigintId(value: unknown, field: string): number {
  let n: number;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "bigint") {
    // No range check needed here: Number() of a bigint too large to represent
    // exactly is either a rounded double past MAX_SAFE_INTEGER or Infinity, and
    // the isSafeInteger check below refuses both with the field name attached.
    n = Number(value);
  } else if (typeof value === "string" && INT8_TEXT.test(value)) {
    n = Number(value);
  } else {
    throw new Error(`${field}: expected an integer id from the database, got ${show(value)}`);
  }
  if (!Number.isSafeInteger(n)) {
    throw new Error(`${field}: ${show(value)} is not an integer a JS number can hold exactly`);
  }
  return n;
}

/**
 * A `numeric` column as a JS number, with SQL NULL kept as `null`.
 *
 * NULL is a real answer here, not an error: an aggregate over no rows is NULL,
 * and the caller has to decide what that means. Everything else must be the
 * decimal text Postgres emits, or an already-finite number. `NaN` and
 * `Infinity` are legal values of the numeric type and are rejected anyway,
 * because no quantity this backend stores in one is allowed to be either.
 *
 * Numeric is arbitrary precision and a JS number is not, so the conversion is
 * lossy by nature -- "0.1" is not exact either. Two consequences, handled
 * differently on purpose. A value too LARGE for a double ("1" followed by 400
 * zeros) would become Infinity, which is refused: it is no longer the quantity
 * it names. A value too SMALL ("0." then 400 zeros then "1") rounds to 0, which
 * is accepted: it is the nearest double, and no measurement here can tell
 * 1e-401 from zero.
 */
export function numericOrNull(value: unknown, field: string): number | null {
  if (value === null) return null;
  let n: number;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string" && NUMERIC_TEXT.test(value)) {
    n = Number(value);
  } else {
    throw new Error(`${field}: expected a decimal number or NULL from the database, got ${show(value)}`);
  }
  // Checked for BOTH branches. The first version checked only the number
  // branch, so a numeric too large for a double passed the text pattern and
  // came out as Infinity -- the exact value the doc above says is refused.
  if (!Number.isFinite(n)) throw new Error(`${field}: ${show(value)} is not a finite number`);
  return n;
}

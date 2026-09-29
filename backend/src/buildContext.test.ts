import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Railway builds this service from `backend/` alone. The rest of the repo is
// not in the build context, so a source file that imports across into a sibling
// directory compiles here and fails there.
//
// That happened, on 2026-09-28. `src/scripts/evalLinkerFold.ts` imports the
// linker's decision logic from `../../../osm-pipeline/`, which is correct -- it
// scores a pipeline decision against this service's behaviour, so it needs
// both halves, and duplicating one of them to keep the directories tidy would
// mean scoring a copy of the thing instead of the thing. But it was left in the
// production build, `tsc` could not resolve the path in the container, and the
// deploy failed with TS2307.
//
// `npm run build` passed locally every time, because a developer checkout has
// the sibling directory the deploy does not. A local build is not a rehearsal
// of the deploy unless something makes it one. This is that something.
//
// The rule: anything the PRODUCTION build compiles must resolve inside
// `backend/`. A file that needs to reach outside is a local tool, belongs in
// tsconfig.json's `exclude`, and is still typechecked by tsconfig.check.json.

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(here, "..");
const srcRoot = path.join(backendRoot, "src");

/** Files tsconfig.json leaves out of the production build. */
function excludedFromBuild(): string[] {
  const raw = fs.readFileSync(path.join(backendRoot, "tsconfig.json"), "utf8");
  // Strip comments; tsconfig allows them and JSON.parse does not.
  const json = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));
  return (json.exclude ?? []).map((p: string) => path.resolve(backendRoot, p));
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".d.ts") ? [full] : [];
  });
}

const RELATIVE_IMPORT = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+["'](\.[^"']*)["']/g;

test("no source file in the production build imports outside the deploy context", () => {
  const excluded = new Set(excludedFromBuild());
  const offenders: string[] = [];

  for (const file of sourceFiles(srcRoot)) {
    if (excluded.has(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const [, spec] of text.matchAll(RELATIVE_IMPORT)) {
      const resolved = path.resolve(path.dirname(file), spec);
      if (!resolved.startsWith(srcRoot + path.sep)) {
        offenders.push(
          `${path.relative(backendRoot, file)} imports "${spec}", which resolves to ` +
            `${path.relative(backendRoot, resolved)} -- outside backend/src`,
        );
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "Railway builds from backend/ alone, so these will fail there and pass here:\n  " +
      offenders.join("\n  "),
  );
});

test("CONTROL: the check can actually see an escaping import", () => {
  // Without this, a regex that matches nothing would pass the test above
  // forever and the whole file would be decoration.
  //
  // The two lines are assembled rather than written out, because the scan above
  // reads every .ts file under src/ INCLUDING this one -- test files are
  // compiled by the production build too, so a test that imports across the
  // boundary breaks the deploy just as surely as a source file does, and
  // skipping them would be a hole. A sample written as one literal would be
  // found by the scan and reported as a real offender.
  const FROM = "from";
  const sample = [
    `import { pool } ${FROM} "../db/pool.js";`,
    `import { buildLinkPlan } ${FROM} "../../../osm-pipeline/scripts/lib/linkPlan.mjs";`,
  ].join("\n");
  const from = path.join(srcRoot, "scripts", "sample.ts");
  const escaping = [...sample.matchAll(RELATIVE_IMPORT)]
    .map(([, spec]) => path.resolve(path.dirname(from), spec))
    .filter((r) => !r.startsWith(srcRoot + path.sep));
  assert.equal(escaping.length, 1, "the cross-boundary import must be detected");
  assert.ok(escaping[0].includes("osm-pipeline"));
});

test("the file that caused this is excluded from the production build", () => {
  // Named explicitly. If it is ever brought back into tsconfig.json's include
  // without its import changing, the deploy breaks again and this says why.
  const excluded = excludedFromBuild();
  assert.ok(
    excluded.some((p) => p.endsWith(path.join("src", "scripts", "evalLinkerFold.ts"))),
    "evalLinkerFold.ts imports across into osm-pipeline/ and cannot be in the deploy build",
  );
});

test("everything excluded from the build still exists and is typechecked elsewhere", () => {
  // An exclude entry pointing at a deleted file is dead config that quietly
  // stops protecting anything.
  for (const p of excludedFromBuild()) {
    assert.ok(fs.existsSync(p), `tsconfig.json excludes ${p}, which does not exist`);
  }
  const check = JSON.parse(
    fs.readFileSync(path.join(backendRoot, "tsconfig.check.json"), "utf8").replace(/^\s*\/\/.*$/gm, ""),
  );
  assert.deepEqual(check.exclude, [], "tsconfig.check.json must check what the build skips");
  assert.equal(check.extends, "./tsconfig.json");
});

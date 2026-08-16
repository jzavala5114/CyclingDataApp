import fs from "node:fs";
import path from "node:path";

// Default bbox covers central Colorado Springs -- downtown plus the
// surrounding neighborhoods, which is wide enough that a normal ride stays
// inside the mapped network. Pass minLat minLon maxLat maxLon to fetch a
// different area.
const DEFAULT_BBOX = [38.78, -104.88, 38.88, -104.77];

const args = process.argv.slice(2).map(Number);
const [minLat, minLon, maxLat, maxLon] = args.length === 4 ? args : DEFAULT_BBOX;

// Overpass needs a server-side timeout generous enough for a city-scale box;
// the default 25s is only enough for a few blocks.
const query = `[out:json][timeout:600];
(
  way["highway"](${minLat},${minLon},${maxLat},${maxLon});
);
out body;
>;
out skel qt;`;

console.log(`fetching ways in ${minLat},${minLon} .. ${maxLat},${maxLon}`);

// Overpass expects the query form-encoded as `data=`; posting it as a raw
// text body gets rejected with 406.
const res = await fetch("https://overpass-api.de/api/interpreter", {
  method: "POST",
  headers: { "User-Agent": "CyclingDataApp/0.1 (hobby project)" },
  body: new URLSearchParams({ data: query }),
});

if (!res.ok) {
  throw new Error(`Overpass request failed: ${res.status} ${(await res.text()).slice(0, 500)}`);
}

const body = await res.text();
const outPath = path.resolve("data/extract.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, body);
console.log(`wrote ${outPath} (${(body.length / 1e6).toFixed(1)} MB)`);

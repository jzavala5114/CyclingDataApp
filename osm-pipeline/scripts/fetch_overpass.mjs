import fs from "node:fs";
import path from "node:path";

// Default bbox covers the Cimarron/Cascade/Wahsatch/Vermijo/Rio Grande
// blocks around 311 E Cimarron St, Colorado Springs -- the neighborhood in
// the reference photo. Pass minLat minLon maxLat maxLon to fetch elsewhere.
const DEFAULT_BBOX = [38.8206852, -104.8269104, 38.8326852, -104.8129104];

const [minLat, minLon, maxLat, maxLon] = process.argv.slice(2).map(Number).length === 4
  ? process.argv.slice(2).map(Number)
  : DEFAULT_BBOX;

const query = `[out:json][timeout:25];
(
  way["highway"](${minLat},${minLon},${maxLat},${maxLon});
);
out body;
>;
out skel qt;`;

const res = await fetch("https://overpass-api.de/api/interpreter", {
  method: "POST",
  body: query,
});

if (!res.ok) {
  throw new Error(`Overpass request failed: ${res.status} ${await res.text()}`);
}

const outPath = path.resolve("data/extract.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, await res.text());
console.log(`wrote ${outPath}`);

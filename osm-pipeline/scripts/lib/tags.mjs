// What an OSM way's tags mean for us: whether a rider can be logged on it, and
// whether the sky is blocked over it.
//
// Pure functions over a tag object, no I/O, so both questions are testable
// without an extract. `split_ways.mjs` is the only caller.

// Only ways a rider can actually be logged on are kept. Everything else is
// dropped outright, which does two jobs at once:
//
//  1. Data quality -- a detour up an alley or through a parking lot matches
//     nothing, so it's discarded instead of polluting a street's gradient.
//  2. De-fragmentation -- driveways and parking aisles used to share nodes
//     with the sidewalks they cross, and every shared node became a segment
//     boundary. Dropping them cut this neighborhood from 2795 segments to
//     ~950 without losing a single real intersection.
export const ROAD_HIGHWAYS = new Set([
  "residential",
  "tertiary",
  "tertiary_link",
  "secondary",
  "secondary_link",
  "primary",
  "primary_link",
  "trunk",
  "trunk_link",
  "unclassified",
  "living_street",
  "road",
]);

export const EXCLUDED_HIGHWAYS = new Set([
  "motorway",
  "motorway_link",
  "construction",
  "proposed",
  "abandoned",
  "steps",
  "service", // alleys, driveways, parking aisles
  "bus_guideway",
  "raceway",
  "escape",
  "corridor",
  "elevator",
]);

// OSM access is layered: a mode-specific tag overrides the general one, so
// `access=no` + `bicycle=yes` means "closed in general, open to bikes". Only
// these values grant access; `dismount`, `destination` and the rest do not.
export const BICYCLE_ALLOWED = new Set(["yes", "designated", "permissive"]);

export const bikesAllowed = (tags) => BICYCLE_ALLOWED.has(tags.bicycle);

export function classify(tags = {}) {
  const highway = tags.highway;
  if (!highway) return null;

  // `highway=track` covers two unrelated things. Of the 234 in this extract,
  // 203 are farm roads and driveways -- Cedar Heights Drive, Amber Valley
  // Drive, unpaved and access=private -- and 31 are real trails, among them
  // Ridgeway Trail, Rim Trail and Red Rock Rim Trail. Excluding the tag
  // wholesale took the trails with the driveways: Ridgeway Trail is mapped as
  // two ways, and only the `path` half was reaching the database, so half of
  // it could never draw a gradient however often it was ridden.
  //
  // Admit only what OSM explicitly opens to bikes. Never infer it from the
  // name or the surface. The kind matters downstream: link_canonical.mjs
  // folds footway/cycleway into parent roads but treats `road` as a *parent*,
  // so calling a track a road would let it absorb the trails beside it.
  if (highway === "track") {
    if (!bikesAllowed(tags)) return null;
    return tags.bicycle === "designated" ? "cycleway" : "footway";
  }

  if (EXCLUDED_HIGHWAYS.has(highway)) return null;
  // A blanket access test discarded 42 ways that OSM marks bike-legal,
  // including three pieces of the New Santa Fe Regional Trail and a whole
  // named singletrack network (Thriller, Shreadzilla, Rattlerocks, Pinball) --
  // all `bicycle=designated`, which is to say *designated bike routes*.
  if ((tags.access === "private" || tags.access === "no") && !bikesAllowed(tags)) return null;
  // Crossings are short, run perpendicular to travel, and would only add
  // chop; they carry no useful gradient of their own.
  if (highway === "footway" && tags.footway === "crossing") return null;
  if (ROAD_HIGHWAYS.has(highway)) return "road";
  if (highway === "cycleway" || (highway === "path" && tags.bicycle === "designated")) return "cycleway";
  if (highway === "footway" || highway === "pedestrian" || highway === "path") return "footway";
  return null;
}

// `tunnel=no` and `tunnel=false` are the only values that mean "not a tunnel".
// Everything else OSM puts in that key -- `yes`, `building_passage`, `culvert`,
// `passage`, `flooded`, `avalanche_protector` -- describes a structure
// overhead. Listing the negatives rather than the positives means a value this
// extract does not yet contain still reads as blocked, which is the safe
// direction: the flag's job is to keep a physically unrecordable stretch from
// being counted as a defect, and over-flagging a handful of ways costs a
// slightly smaller defect list while under-flagging sends someone hunting a
// bug in a place where GPS cannot work.
const NOT_A_TUNNEL = new Set(["no", "false"]);

// `covered=yes` is a roof without a tunnel: a drive-through, an arcade, a
// parking structure's internal aisles. The sky is just as blocked. OSM also
// allows `covered=building_passage`, which this extract has three of.
const COVERED_BLOCKING = new Set(["yes", "building_passage"]);

// Is the sky blocked over this way, so a GPS fix cannot be expected?
//
// This is the question the map needs answered, not "is this a tunnel" in the
// civil-engineering sense. A hole in a drawn line has two possible causes and
// they call for opposite responses: a stretch nobody could record is physics
// and should be left alone, a stretch that was ridden and lost is a defect
// worth chasing. Without this flag the two are indistinguishable, and any
// count of the second is inflated by the first.
//
// Deliberately NOT included:
//
//  - `layer=-1` on its own. 283 ways in this extract carry it and almost all
//    are the lower road at a grade separation -- dipping under an overpass for
//    twenty metres, open sky either side. GPS is unaffected. Treating a layer
//    as a tunnel would flag most of the city's junctions.
//  - `bridge=yes`. A bridge deck has the clearest view of the sky on the
//    route. It belongs to the opposite category and is not read at all.
//  - Name matching. "Union Boulevard Underpass" happens to be tagged
//    `tunnel=yes` already; inferring from the name would also catch the
//    surface street named after the tunnel beside it.
export function isTunnel(tags = {}) {
  const tunnel = tags.tunnel;
  if (typeof tunnel === "string" && tunnel !== "" && !NOT_A_TUNNEL.has(tunnel)) return true;
  return COVERED_BLOCKING.has(tags.covered);
}

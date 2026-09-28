// Real geometry, copied verbatim out of the live `segments` table on
// 2026-09-27, shared by both test files.
//
// #23278 is the unnamed 146m footway beside Hancock Expressway that this whole
// rewrite exists for: it turns a corner, so its chord averages two legs
// belonging to different streets, misses Hancock by 20.6 degrees, stays
// canonical, competes with Hancock for GPS fixes, and leaves Hancock #17973
// with 0m of its 91m drawn on the map.
//
// Each carries its segment id so it can be re-fetched and checked:
//   select id, ST_AsGeoJSON(geom) from segments where id in (23278, 22505, ...)

export const SEG_23278 = [
  [-104.805165938, 38.819286524],
  [-104.8048203, 38.8192725],
  [-104.8047636, 38.8192418],
  [-104.804697, 38.81919],
  [-104.804739365, 38.818274477],
];

export const SEG_22505 = [
  [-104.8053831, 38.8194473],
  [-104.8049213, 38.8194306],
  [-104.804754, 38.8194531],
  [-104.804667, 38.8195132],
  [-104.804650968, 38.819867451],
];

export const HANCOCK_17972 = {
  id: 17972,
  coords: [
    [-104.804477012, 38.820223366],
    [-104.8045064, 38.8197015],
    [-104.8045213, 38.819324],
  ],
};

export const HANCOCK_17973 = {
  id: 17973,
  coords: [
    [-104.8045213, 38.819324],
    [-104.804565353, 38.818504044],
  ],
};

export const HANCOCK_17974 = {
  id: 17974,
  coords: [
    [-104.804565353, 38.818504044],
    [-104.8045877, 38.8180881],
    [-104.8046065, 38.817684],
  ],
};

/** The cross street #23278 runs along before it turns onto Hancock. */
export const TRANSIT_4847 = {
  id: 4847,
  coords: [
    [-104.8045213, 38.819324],
    [-104.8047595, 38.8193317],
    [-104.8053064, 38.8193494],
    [-104.8053837, 38.8193454],
    [-104.8054489, 38.8193421],
    [-104.8055841, 38.8193164],
    [-104.8057086, 38.8192689],
    [-104.8058124, 38.8192059],
    [-104.8058969, 38.81913],
    [-104.8059268, 38.8190904],
    [-104.8059563, 38.8190513],
    [-104.805956428, 38.819050981],
  ],
};

/** A 143m cycleway that merely clips Dublin Boulevard near one end. */
export const SEG_52602 = [
  [-104.7489689, 38.9294584],
  [-104.750385816, 38.930115115],
];

export const DUBLIN_47223 = {
  id: 47223,
  coords: [
    [-104.748407353, 38.929845794],
    [-104.748538, 38.9297187],
    [-104.7486577, 38.9296081],
    [-104.7488512, 38.9294074],
    [-104.74946571, 38.928803514],
  ],
};

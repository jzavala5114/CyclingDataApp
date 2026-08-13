// Deployed backend (see ../../backend), hosted on Railway -- reachable from
// anywhere, no dependency on this PC being on or on the same network.
export const API_BASE_URL = "https://cyclingdataapp-backend-production.up.railway.app";

// Any free raster tile source works for a prototype. Swap for a vector
// style (e.g. self-hosted via MapLibre + OpenMapTiles) later for nicer
// rendering and to avoid third-party rate limits in production.
export const MAP_STYLE_URL =
  "https://tiles.openfreemap.org/styles/liberty";

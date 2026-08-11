// Superseded: this approach required booting a local Strapi instance, which
// only ever sees whatever DB is configured in .env (locally: an empty
// sqlite dev database, unrelated to the real content on
// https://api.routezoeker.com).
//
// The POI import now lives entirely in scripts/import-legacy-pois.js, which
// talks to the real Strapi instance over its REST API instead (no local
// Strapi bootstrap, no DB connection of any kind). This file is intentionally
// left empty; the sandbox this was written in can't delete files on the
// mounted project folder, only overwrite them.
export {};

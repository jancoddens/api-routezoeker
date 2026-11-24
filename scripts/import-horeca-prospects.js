#!/usr/bin/env node

'use strict';

/**
 * Horeca langs onze routes als prospect in Strapi zetten (segment "horeca").
 *
 * 1. Alle gepubliceerde routes met hun routelijn uit Strapi halen.
 * 2. Cafés, restaurants, bars, frituren, ijssalons, tearooms... ophalen uit
 *    OpenStreetMap (Overpass API, licentie ODbL: "© OpenStreetMap-bijdragers").
 * 3. Per zaak tellen hoeveel routes er binnen 250 m langskomen (routes_250m)
 *    en hoeveel wandel-/fietsroutes binnen 15 km starten (zelfde velden als
 *    bij logies, voor de mailtekst).
 * 4. Enkel zaken met minstens 1 route binnen 250 m komen in de lijst.
 *    Ketens (OSM-tag brand) laten we weg.
 * 5. Upsert op source_id ("osm:n123"): bestaande prospects krijgen enkel hun
 *    gegevens bijgewerkt; fase, notities, mails en uitschrijfcode blijven.
 *
 * Prioriteit: A = 5 of meer routes langs de zaak, B = 2-4, C = 1.
 *
 * Gebruik (op de server, in de map van de API):
 *   node scripts/import-horeca-prospects.js --dry-run           enkel tellen, niets wegschrijven
 *   node scripts/import-horeca-prospects.js                     Vlaanderen
 *   node scripts/import-horeca-prospects.js --area NL-LI        Nederlands Limburg (of BE-WAL, BE-BRU, ...)
 *   node scripts/import-horeca-prospects.js --with-email-only   enkel zaken met een e-mailadres in OSM
 *
 * "database is locked"? Gewoon nog eens draaien, of tijdens de import
 * `pm2 stop strapi` en daarna `pm2 start strapi`.
 */

const { domainToASCII } = require('node:url');
const crypto = require('node:crypto');
const { compileStrapi, createStrapi } = require('@strapi/strapi');
const { overpass } = require('./lib/overpass');

const UID = 'api::prospect.prospect';
const ROUTE_UID = 'api::route.route';
const MAX_DISTANCE_M = 250;
const START_RADIUS_KM = 15;
const KINDS = ['cafe', 'pub', 'bar', 'biergarten', 'restaurant', 'fast_food', 'ice_cream'];
const AREA_NAMES = { 'BE-VLG': 'Vlaanderen', 'BE-WAL': 'Wallonië', 'BE-BRU': 'Brussel' };

const log = (...parts) => console.log(`[horeca-prospects] ${parts.join(' ')}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parseArgs = () => {
  const args = process.argv.slice(2);
  const options = { dryRun: false, area: 'BE-VLG', emailOnly: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--with-email-only') options.emailOnly = true;
    else if (arg === '--area') options.area = String(args[(i += 1)] || '').toUpperCase();
    else if (arg !== '--') throw new Error(`Onbekend argument: ${arg}`);
  }
  if (!/^[A-Z]{2}(-[A-Z]{2,3})?$/.test(options.area)) throw new Error('--area moet een ISO-code zijn, bv. BE-VLG of NL-LI');
  return options;
};

// ---------- geometrie ----------

const toRad = (deg) => (deg * Math.PI) / 180;
const distanceM = (a, b) => {
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
};

// Afstand punt - lijnstuk in meter (lokale projectie, ruim nauwkeurig genoeg).
const pointSegmentM = (p, a, b) => {
  const k = Math.cos(toRad(p[0])) * 111320;
  const ax = (a[1] - p[1]) * k;
  const ay = (a[0] - p[0]) * 110540;
  const bx = (b[1] - p[1]) * k;
  const by = (b[0] - p[0]) * 110540;
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len > 0 ? -(ax * dx + ay * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * dx, ay + t * dy);
};

const toLine = (geometry) => {
  if (!geometry || typeof geometry !== 'object') return [];
  if (geometry.type === 'Feature') return toLine(geometry.geometry);
  if (geometry.type === 'FeatureCollection') return (geometry.features || []).flatMap(toLine);
  const coords =
    geometry.type === 'LineString' ? geometry.coordinates : geometry.type === 'MultiLineString' ? (geometry.coordinates || []).flat() : [];
  return (coords || [])
    .filter((c) => Array.isArray(c) && Number.isFinite(Number(c[0])) && Number.isFinite(Number(c[1])))
    .map((c) => [Number(c[1]), Number(c[0])]);
};

// Lijnen vereenvoudigen: punten dichter dan 25 m bij het vorige punt weglaten.
const thin = (line) => {
  const out = [];
  for (const point of line) {
    if (!out.length || distanceM(out[out.length - 1], point) >= 25) out.push(point);
  }
  if (line.length && out[out.length - 1] !== line[line.length - 1]) out.push(line[line.length - 1]);
  return out;
};

// Rooster met lijnstukken per cel (~550 m), zodat we per zaak enkel de
// lijnstukken in de buurt hoeven te bekijken.
const CELL = 0.005;
const cellKey = (lat, lng) => `${Math.floor(lat / CELL)}:${Math.floor(lng / CELL)}`;

const buildSegmentIndex = (routes) => {
  const index = new Map();
  const pad = (MAX_DISTANCE_M / 111000) * 1.6;
  routes.forEach((route, routeIndex) => {
    for (let i = 1; i < route.line.length; i += 1) {
      const a = route.line[i - 1];
      const b = route.line[i];
      const minLat = Math.min(a[0], b[0]) - pad;
      const maxLat = Math.max(a[0], b[0]) + pad;
      const minLng = Math.min(a[1], b[1]) - pad * 1.6;
      const maxLng = Math.max(a[1], b[1]) + pad * 1.6;
      for (let la = Math.floor(minLat / CELL); la <= Math.floor(maxLat / CELL); la += 1) {
        for (let lo = Math.floor(minLng / CELL); lo <= Math.floor(maxLng / CELL); lo += 1) {
          const key = `${la}:${lo}`;
          if (!index.has(key)) index.set(key, []);
          index.get(key).push([routeIndex, a, b]);
        }
      }
    }
  });
  return index;
};

// ---------- opkuisen ----------

const clip = (value, max = 255) => (value ? String(value).trim().slice(0, max) : null);

const cleanEmail = (raw) => {
  if (!raw) return null;
  let value = String(raw).split(';')[0].trim().replace(/^mailto:/i, '').replace(/^['"<\s]+|['">\s]+$/g, '');
  const at = value.lastIndexOf('@');
  if (at < 1) return null;
  const email = `${value.slice(0, at)}@${domainToASCII(value.slice(at + 1).toLowerCase())}`;
  return /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(email) ? email : null;
};

const cleanWebsite = (raw) => {
  const value = String(raw || '').split(';')[0].trim();
  if (!value) return null;
  return clip(/^https?:\/\//i.test(value) ? value : `https://${value}`, 255);
};

const isClosed = (tags) =>
  tags.access === 'private' ||
  String(tags.opening_hours || '').trim() === 'off' ||
  Object.keys(tags).some((key) => /^(disused|abandoned|was|demolished|removed):/.test(key));

const withRetry = async (fn) => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (!/database is locked|SQLITE_BUSY/i.test(String(error?.message || error)) || attempt >= 8) throw error;
      await sleep(250 * attempt);
    }
  }
};

// ---------- hoofdprogramma ----------

const main = async () => {
  const options = parseArgs();
  const areaName = AREA_NAMES[options.area] || options.area;

  const appContext = await compileStrapi();
  const strapi = createStrapi(appContext);
  await strapi.load();

  let created = 0;
  let updated = 0;
  let failed = 0;

  try {
    // 1. Routes.
    const rows = await strapi.db.query(ROUTE_UID).findMany({
      where: { publishedAt: { $notNull: true } },
      select: ['id', 'title', 'route_geometry'],
      populate: { theme: { select: ['slug'] }, route_start_locations: true },
    });
    const seen = new Set();
    const routes = [];
    for (const row of rows) {
      if (seen.has(row.title)) continue; // één rij per route (locales)
      const startGeometry = Array.isArray(row.route_start_locations)
        ? row.route_start_locations.find((loc) => loc?.route_geometry)?.route_geometry
        : null;
      const line = thin(toLine(row.route_geometry || startGeometry));
      if (line.length < 2) continue;
      const themeSlug = String(row.theme?.slug || '').toLowerCase();
      const kind = /fiets/.test(themeSlug) ? 'fietsen' : 'wandelen';
      seen.add(row.title);
      routes.push({ title: row.title, kind, line, start: line[0] });
    }
    log(`${routes.length} gepubliceerde routes met een routelijn`);
    const segmentIndex = buildSegmentIndex(routes);

    // 2. Horeca uit OpenStreetMap.
    log(`Horeca ophalen uit OpenStreetMap (${areaName})...`);
    const query = `[out:json][timeout:300];area["ISO3166-2"="${options.area}"]->.a;(nwr["amenity"~"^(${KINDS.join('|')})$"]["name"](area.a););out center tags;`;
    const json = await overpass(query, log);
    const elements = json.elements || [];
    log(`${elements.length} horecazaken in OpenStreetMap`);

    // 3. Koppelen aan routes.
    const prospects = [];
    const stats = { brand: 0, closed: 0, noRoute: 0, noEmail: 0 };
    for (const element of elements) {
      const tags = element.tags || {};
      const lat = element.lat ?? element.center?.lat;
      const lng = element.lon ?? element.center?.lon;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      if (tags.brand || tags['brand:wikidata']) {
        stats.brand += 1;
        continue;
      }
      if (isClosed(tags)) {
        stats.closed += 1;
        continue;
      }

      const point = [lat, lng];
      const nearest = new Map(); // routeIndex -> afstand
      for (const [routeIndex, a, b] of segmentIndex.get(cellKey(lat, lng)) || []) {
        const d = pointSegmentM(point, a, b);
        if (d <= MAX_DISTANCE_M && d < (nearest.get(routeIndex) ?? Infinity)) nearest.set(routeIndex, d);
      }
      if (nearest.size === 0) {
        stats.noRoute += 1;
        continue;
      }

      const email = cleanEmail(tags.email || tags['contact:email']);
      if (!email) stats.noEmail += 1;
      if (options.emailOnly && !email) continue;

      let walks = 0;
      let bikes = 0;
      for (const route of routes) {
        if (Math.abs(route.start[0] - lat) > 0.15 || Math.abs(route.start[1] - lng) > 0.25) continue;
        if (distanceM(route.start, point) <= START_RADIUS_KM * 1000) {
          if (route.kind === 'fietsen') bikes += 1;
          else walks += 1;
        }
      }

      const along = [...nearest.entries()]
        .sort((x, y) => x[1] - y[1])
        .map(([routeIndex, d]) => ({ route: routes[routeIndex], d }));
      const count = along.length;

      prospects.push({
        name: clip(tags.name, 255),
        priority: count >= 5 ? 'A' : count >= 2 ? 'B' : 'C',
        city: clip(tags['addr:city'] || tags['addr:place']),
        province: null,
        type: clip(tags.amenity),
        segment: 'horeca',
        email,
        phone: clip(String(tags.phone || tags['contact:phone'] || '').split(';')[0]) || null,
        website: cleanWebsite(tags.website || tags['contact:website']),
        street: clip([tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ')) || null,
        postcode: clip(tags['addr:postcode']),
        walk_routes_15km: walks,
        bike_routes_15km: bikes,
        routes_250m: count,
        nearest_routes:
          along
            .slice(0, 5)
            .map(({ route, d }) => `${route.title} (${route.kind}, ${Math.round(d / 10) * 10} m)`)
            .join('\n') || null,
        score: count * 10 + walks * 0.2 + bikes * 0.2 + (email ? 5 : 0) + (tags.website ? 2 : 0),
        latitude: lat,
        longitude: lng,
        source: 'OpenStreetMap',
        source_id: `osm:${element.type[0]}${element.id}`,
      });
    }

    prospects.sort((a, b) => b.score - a.score);
    prospects.forEach((p, i) => {
      p.score = Math.round(p.score * 10) / 10;
      p.rank = i + 1;
    });

    log(
      `${prospects.length} zaken met minstens 1 route binnen ${MAX_DISTANCE_M} m ` +
        `(A ${prospects.filter((p) => p.priority === 'A').length}, B ${prospects.filter((p) => p.priority === 'B').length}, C ${prospects.filter((p) => p.priority === 'C').length}); ` +
        `${prospects.filter((p) => p.email).length} met e-mailadres. ` +
        `Weggelaten: ${stats.brand} ketens, ${stats.closed} gesloten, ${stats.noRoute} zonder route in de buurt.`
    );

    // 4. Wegschrijven.
    const existing = await strapi.db.query(UID).findMany({ select: ['documentId', 'source_id'] });
    const bySource = new Map(existing.map((row) => [row.source_id, row.documentId]));

    for (const p of prospects) {
      const documentId = bySource.get(p.source_id);
      if (options.dryRun) {
        documentId ? (updated += 1) : (created += 1);
        continue;
      }
      try {
        if (documentId) {
          // Rank/score/routes bijwerken, maar een e-mailadres dat je zelf invulde niet wissen.
          const data = { ...p };
          if (!data.email) delete data.email;
          await withRetry(() => strapi.documents(UID).update({ documentId, data }));
          updated += 1;
        } else {
          await withRetry(() =>
            strapi.documents(UID).create({
              data: { ...p, stage: 'nieuw', unsubscribe_token: crypto.randomBytes(18).toString('base64url') },
            })
          );
          created += 1;
        }
      } catch (error) {
        failed += 1;
        log(`  mislukt: ${p.name}: ${String(error?.message || error).split('\n')[0].slice(0, 200)}`);
      }
    }

    log(`${options.dryRun ? 'DROGE TEST – ' : ''}${created} nieuw, ${updated} bijgewerkt, ${failed} mislukt`);
  } finally {
    await strapi.destroy().catch(() => {});
  }

  process.exit(failed ? 1 : 0);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

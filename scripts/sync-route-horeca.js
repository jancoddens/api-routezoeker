#!/usr/bin/env node

'use strict';

/**
 * Eet- en drinkgelegenheden per route vooraf berekenen en bewaren in Strapi
 * (content type "Route horeca"). De routepagina toont ze dan meteen, zonder
 * te wachten op OpenStreetMap. Routes zonder (actuele) berekening vallen op de
 * site terug op de live berekening (/api/route-horeca in de front).
 *
 * Werkwijze (zelfde regels als src/lib/route-horeca.ts in de front):
 * 1. Alle gepubliceerde routes met hun lijn (route_geometry of het GPX-bestand).
 * 2. Alle horeca in België en Nederland in één keer uit OpenStreetMap
 *    (Overpass API, licentie ODbL: "© OpenStreetMap-bijdragers").
 * 3. Per route: zaken binnen 250 m van de lijn ("onderweg") en binnen 500 m
 *    van start of einde, met afstand en kilometerpunt.
 * 4. Upsert per route (route_document_id).
 *
 * Gebruik (op de server, in de map van de API):
 *   node scripts/sync-route-horeca.js --dry-run      enkel tellen
 *   node scripts/sync-route-horeca.js                berekenen en bewaren
 *   node scripts/sync-route-horeca.js --areas BE     enkel België (standaard: BE,NL)
 *
 * Aanrader: maandelijks laten lopen (geplande taak in Plesk), zodat nieuwe of
 * gesloten zaken mee zijn.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { compileStrapi, createStrapi } = require('@strapi/strapi');
const { overpass } = require('./lib/overpass');

const UID = 'api::route-horeca.route-horeca';
const ROUTE_UID = 'api::route.route';

const MAX_ROUTE_DISTANCE_M = 250;
const START_END_RADIUS_M = 500;
const LOOP_THRESHOLD_M = 300;
const MAX_ROUTE_ITEMS = 40;
const MAX_START_END_ITEMS = 8;
const DEDUPE_METERS = 40;
const KINDS = ['cafe', 'pub', 'bar', 'biergarten', 'restaurant', 'fast_food', 'ice_cream'];

const log = (...parts) => console.log(`[route-horeca] ${parts.join(' ')}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parseArgs = () => {
  const args = process.argv.slice(2);
  const options = { dryRun: false, areas: ['BE', 'NL'] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--areas') options.areas = String(args[(i += 1)] || '').toUpperCase().split(',').filter(Boolean);
    else if (arg !== '--') throw new Error(`Onbekend argument: ${arg}`);
  }
  if (!options.areas.length || options.areas.some((a) => !/^[A-Z]{2}$/.test(a))) throw new Error('--areas bv. BE,NL');
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

const toXY = (p, refLatRad) => [toRad(p[1]) * 6371000 * Math.cos(refLatRad), toRad(p[0]) * 6371000];

const projectOnSegment = (p, a, b) => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  let t = lengthSq > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq : 0;
  t = Math.max(0, Math.min(1, t));
  return { distance: Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]), t };
};

// Kortste afstand tot de lijn + afstand vanaf de start (eerste passage).
const locateOnLine = (point, line) => {
  const refLat = toRad(point[0]);
  const p = toXY(point, refLat);
  let best = Infinity;
  let bestAlong = 0;
  let cumulative = 0;
  let a = toXY(line[0], refLat);
  for (let i = 1; i < line.length; i += 1) {
    const b = toXY(line[i], refLat);
    const segLength = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const { distance, t } = projectOnSegment(p, a, b);
    if (distance < best - 5) {
      best = distance;
      bestAlong = cumulative + t * segLength;
    }
    cumulative += segLength;
    a = b;
  }
  return { distanceM: best, alongM: bestAlong };
};

const lineLength = (line) => {
  let total = 0;
  for (let i = 1; i < line.length; i += 1) total += distanceM(line[i - 1], line[i]);
  return total;
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

const readGpxLine = async (url) => {
  if (!url || !String(url).startsWith('/uploads/')) return [];
  try {
    const text = await fs.readFile(path.join(process.cwd(), 'public', url), 'utf8');
    const points = [];
    const tagRegex = /<(?:[\w-]+:)?(?:trkpt|rtept)\b([^>]*)>/g;
    let match;
    while ((match = tagRegex.exec(text))) {
      const lat = Number(/\blat\s*=\s*["']([^"']+)["']/.exec(match[1])?.[1]);
      const lng = Number(/\blon\s*=\s*["']([^"']+)["']/.exec(match[1])?.[1]);
      if (Number.isFinite(lat) && Number.isFinite(lng)) points.push([lat, lng]);
    }
    return points;
  } catch {
    return [];
  }
};

// Punten dichter dan 10 m bij het vorige weglaten (rekenwerk beperken).
const thin = (line) => {
  const out = [];
  for (const point of line) if (!out.length || distanceM(out[out.length - 1], point) >= 10) out.push(point);
  if (line.length > 1 && out[out.length - 1] !== line[line.length - 1]) out.push(line[line.length - 1]);
  return out;
};

// ---------- horeca ----------

const DAY_NAMES = { Mo: 'ma', Tu: 'di', We: 'wo', Th: 'do', Fr: 'vr', Sa: 'za', Su: 'zo', PH: 'feestdagen' };

const dutchOpeningHours = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return undefined;
  if (raw === '24/7') return 'Dag en nacht open';
  return raw
    .replace(/\b(Mo|Tu|We|Th|Fr|Sa|Su|PH)\b/g, (day) => DAY_NAMES[day] || day)
    .replace(/\boff\b|\bclosed\b/gi, 'gesloten')
    .replace(/\s*;\s*/g, ' · ')
    .replace(/,(?=\S)/g, ', ')
    .slice(0, 160);
};

const kindLabel = (kind, tags) =>
  ({
    pub: 'Café',
    bar: 'Bar',
    cafe: 'Koffiebar / tearoom',
    biergarten: 'Biertuin',
    restaurant: 'Restaurant',
    ice_cream: 'IJssalon',
    fast_food: /friture|chips|fries|frit/i.test(tags.cuisine || '') ? 'Frituur' : 'Snackbar',
  })[kind];

const kindCategory = (kind) =>
  kind === 'restaurant' || kind === 'fast_food' ? 'eten' : kind === 'ice_cream' ? 'ijs' : 'drinken';

const normalizeWebsite = (value) => {
  const raw = String(value || '').split(';')[0].trim();
  if (!raw) return undefined;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
};

const isClosed = (tags) =>
  tags.access === 'private' ||
  String(tags.opening_hours || '').trim() === 'off' ||
  Object.keys(tags).some((key) => /^(disused|abandoned|was|demolished|removed):/.test(key));

const toPlace = (element) => {
  const tags = element.tags || {};
  const kind = tags.amenity;
  const name = String(tags.name || '').trim();
  const lat = element.lat ?? element.center?.lat;
  const lng = element.lon ?? element.center?.lon;
  if (!KINDS.includes(kind) || !name || isClosed(tags)) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const street = [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ');
  const city = tags['addr:city'] || tags['addr:place'];
  return {
    id: `${element.type[0]}${element.id}`,
    name: name.slice(0, 120),
    kind,
    kindLabel: kindLabel(kind, tags),
    category: kindCategory(kind),
    lat: Math.round(lat * 1e6) / 1e6,
    lng: Math.round(lng * 1e6) / 1e6,
    openingHours: dutchOpeningHours(tags.opening_hours),
    website: normalizeWebsite(tags.website || tags['contact:website']),
    phone: String(tags.phone || tags['contact:phone'] || '').split(';')[0].trim() || undefined,
    address: [street, city].filter(Boolean).join(', ') || undefined,
    outdoorSeating: tags.outdoor_seating === 'yes' || undefined,
    dogs: tags.dog === 'yes' || tags.dog === 'leashed' || undefined,
    wheelchair: tags.wheelchair === 'yes' || undefined,
  };
};

// Rooster met zaken per cel (~350-550 m).
const CELL = 0.005;
const buildPlaceIndex = (places) => {
  const index = new Map();
  for (const place of places) {
    const key = `${Math.floor(place.lat / CELL)}:${Math.floor(place.lng / CELL)}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(place);
  }
  return index;
};

const candidatesAround = (index, point, cells) => {
  const la = Math.floor(point[0] / CELL);
  const lo = Math.floor(point[1] / CELL);
  const out = [];
  for (let dLa = -cells; dLa <= cells; dLa += 1) {
    for (let dLo = -cells * 2; dLo <= cells * 2; dLo += 1) {
      const bucket = index.get(`${la + dLa}:${lo + dLo}`);
      if (bucket) out.push(...bucket);
    }
  }
  return out;
};

// Zelfde indeling als classifyHoreca() in de front.
const classify = (candidates, line, loop) => {
  const start = line[0];
  const end = line[line.length - 1];
  const items = [];
  for (const place of candidates) {
    const point = [place.lat, place.lng];
    const onLine = locateOnLine(point, line);
    const toStart = distanceM(point, start);
    const toEnd = distanceM(point, end);
    let zone;
    let dist;
    if (toStart <= START_END_RADIUS_M && onLine.alongM <= 1000) {
      zone = 'start';
      dist = toStart;
    } else if (!loop && toEnd <= START_END_RADIUS_M && onLine.distanceM > MAX_ROUTE_DISTANCE_M / 2) {
      zone = 'end';
      dist = toEnd;
    } else if (onLine.distanceM <= MAX_ROUTE_DISTANCE_M) {
      zone = 'route';
      dist = onLine.distanceM;
    } else if (toStart <= START_END_RADIUS_M) {
      zone = 'start';
      dist = toStart;
    } else if (!loop && toEnd <= START_END_RADIUS_M) {
      zone = 'end';
      dist = toEnd;
    } else {
      continue;
    }
    items.push({ ...place, zone, distanceM: Math.round(dist / 10) * 10, km: Math.round(onLine.alongM / 100) / 10 });
  }

  items.sort((a, b) => a.distanceM - b.distanceM);
  const unique = [];
  const keyOf = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const item of items) {
    const duplicate = unique.some(
      (other) => keyOf(other.name) === keyOf(item.name) && distanceM([other.lat, other.lng], [item.lat, item.lng]) < DEDUPE_METERS,
    );
    if (!duplicate) unique.push(item);
  }
  const pick = (zone, max) => unique.filter((item) => item.zone === zone).slice(0, max);
  return [
    ...pick('start', MAX_START_END_ITEMS),
    ...pick('route', MAX_ROUTE_ITEMS).sort((a, b) => a.km - b.km),
    ...pick('end', MAX_START_END_ITEMS),
  ];
};

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

  // 1. Horeca uit OpenStreetMap (eerst, zodat Strapi niet lang openstaat).
  const places = [];
  const seenIds = new Set();
  for (const area of options.areas) {
    log(`Horeca ophalen uit OpenStreetMap (${area})...`);
    const query = `[out:json][timeout:600];area["ISO3166-1"="${area}"][admin_level=2]->.a;(nwr["amenity"~"^(${KINDS.join('|')})$"]["name"](area.a););out center tags;`;
    const json = await overpass(query, log);
    let count = 0;
    for (const element of json.elements || []) {
      const place = toPlace(element);
      if (place && !seenIds.has(place.id)) {
        seenIds.add(place.id);
        places.push(place);
        count += 1;
      }
    }
    log(`  ${count} zaken`);
  }
  const placeIndex = buildPlaceIndex(places);

  const appContext = await compileStrapi();
  const strapi = createStrapi(appContext);
  await strapi.load();

  let created = 0;
  let updated = 0;
  let failed = 0;

  try {
    // 2. Routes.
    const rows = await strapi.db.query(ROUTE_UID).findMany({
      where: { publishedAt: { $notNull: true } },
      select: ['id', 'documentId', 'title', 'route_geometry'],
      populate: { route_start_locations: { populate: { gpx_file: true } } },
    });
    const existing = await strapi.db.query(UID).findMany({ select: ['id', 'route_document_id'] });
    const byRoute = new Map(existing.map((row) => [row.route_document_id, row.id]));

    const seen = new Set();
    let noLine = 0;
    let withItems = 0;
    let totalItems = 0;

    for (const row of rows) {
      if (!row.documentId || seen.has(row.documentId)) continue;
      seen.add(row.documentId);

      const startLocation = Array.isArray(row.route_start_locations)
        ? row.route_start_locations.find((loc) => loc?.gpx_file || loc?.route_geometry)
        : null;
      const gpxUrl = startLocation?.gpx_file?.url || null;
      // De site rekent op de GPX; de lijn uit de GPX heeft dus voorrang.
      let raw = await readGpxLine(gpxUrl);
      if (raw.length < 2) raw = toLine(row.route_geometry || startLocation?.route_geometry);
      if (raw.length < 2) {
        noLine += 1;
        continue;
      }
      const line = thin(raw);
      const loop = distanceM(line[0], line[line.length - 1]) <= LOOP_THRESHOLD_M;

      // Kandidaten: zaken in de cellen rond elk punt van de lijn, plus rond start en einde.
      const candidates = new Map();
      const step = Math.max(1, Math.floor(line.length / 2000));
      for (let i = 0; i < line.length; i += step) {
        for (const place of candidatesAround(placeIndex, line[i], 1)) candidates.set(place.id, place);
      }
      for (const point of [line[0], line[line.length - 1]]) {
        for (const place of candidatesAround(placeIndex, point, 2)) candidates.set(place.id, place);
      }

      const items = classify([...candidates.values()], line, loop);
      if (items.length) withItems += 1;
      totalItems += items.length;

      const data = {
        route_document_id: row.documentId,
        route_title: String(row.title || '').slice(0, 255),
        gpx_url: gpxUrl,
        item_count: items.length,
        data: { loop, distanceKm: Math.round(lineLength(raw) / 100) / 10, items },
        computed_at: new Date().toISOString(),
      };

      if (options.dryRun) {
        byRoute.has(row.documentId) ? (updated += 1) : (created += 1);
        continue;
      }
      try {
        const id = byRoute.get(row.documentId);
        if (id) {
          await withRetry(() => strapi.db.query(UID).update({ where: { id }, data }));
          updated += 1;
        } else {
          await withRetry(() => strapi.documents(UID).create({ data }));
          created += 1;
        }
      } catch (error) {
        failed += 1;
        log(`  mislukt: ${row.title}: ${String(error?.message || error).split('\n')[0].slice(0, 200)}`);
      }
    }

    log(
      `${seen.size} routes: ${withItems} met horeca (gemiddeld ${withItems ? Math.round(totalItems / withItems) : 0} zaken), ` +
        `${seen.size - noLine - withItems} zonder horeca in de buurt, ${noLine} zonder lijn of GPX.`,
    );
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

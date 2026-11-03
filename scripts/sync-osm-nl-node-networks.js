#!/usr/bin/env node

/**
 * Synchroniseert de Nederlandse wandel- en fietsknooppunten uit OpenStreetMap
 * (Overpass API, licentie ODbL: "© OpenStreetMap-bijdragers").
 *
 * OSM-model:
 *   knooppunt  = node met rwn_ref (wandelen) of rcn_ref (fietsen)
 *   verbinding = relation type=route + network=rwn|rcn + network:type=node_network
 *                (één relatie per traject tussen twee knooppunten)
 *
 * Koppeling met Strapi:
 *   node.external_id            = "osm:n<osm-id>"
 *   node-connection.external_id = "osm:r<osm-id>"
 *
 * OSM-knooppunten die op minder dan 30 m van een bestaand (niet-OSM) knooppunt
 * liggen, bv. Nederlandse grensknooppunten uit de Vlaamse dataset, worden niet
 * opnieuw aangemaakt: hun verbindingen hangen aan het bestaande knooppunt. Een
 * verbinding tussen twee zulke bestaande knooppunten slaan we over (zit al in
 * de Vlaamse data).
 *
 * Gebruik:
 *   npm run sync:knooppunten-nl                       droge test (niets wordt gewijzigd)
 *   npm run sync:knooppunten-nl -- --apply            wegschrijven
 *   npm run sync:knooppunten-nl -- --apply --prune    ook OSM-records verwijderen die niet meer in OSM staan
 *   --province NL-GE                                   enkel één provincie (test); --prune werkt dan niet
 *   --mode wandelen|fietsen                            enkel één netwerk
 */

'use strict';

const { compileStrapi, createStrapi } = require('@strapi/strapi');

// Bij een volle server schakelen we door naar de volgende.
const OVERPASS_URLS = process.env.OVERPASS_URL
  ? [process.env.OVERPASS_URL]
  : [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.private.coffee/api/interpreter',
      'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    ];
const USER_AGENT = 'Routezoeker-knooppuntensync/1.0 (+https://www.routezoeker.com)';
const PROVINCES = [
  'NL-DR', 'NL-FL', 'NL-FR', 'NL-GE', 'NL-GR', 'NL-LI',
  'NL-NB', 'NL-NH', 'NL-OV', 'NL-UT', 'NL-ZE', 'NL-ZH',
];
const NETWORKS = {
  wandelen: { network: 'rwn', refTag: 'rwn_ref' },
  fietsen: { network: 'rcn', refTag: 'rcn_ref' },
};
const NODE_PREFIX = 'osm:n';
const CONNECTION_PREFIX = 'osm:r';
const DEDUPE_RADIUS_KM = 0.03;
const ENDPOINT_RADIUS_KM = 0.05;
const STITCH_TOLERANCE_KM = 0.002;
const WRITE_CONCURRENCY = 4;
const DB_BATCH = 2000;
const PAUSE_BETWEEN_QUERIES_MS = 5000;
const MIN_SOURCE_CONNECTIONS_FOR_PRUNE = 5000;

const NODE_UID = 'api::node.node';
const CONNECTION_UID = 'api::node-connection.node-connection';

// ---------------------------------------------------------------------------

const log = (...parts) => console.log(`[sync-osm-nl] ${parts.join(' ')}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round6 = (value) => Math.round(Number(value) * 1e6) / 1e6;

const parseArgs = () => {
  const args = process.argv.slice(2);
  const options = { apply: false, prune: false, provinces: PROVINCES, modes: ['wandelen', 'fietsen'] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--prune') options.prune = true;
    else if (arg === '--province') {
      const value = String(args[i + 1] || '').toUpperCase();
      i += 1;
      if (!PROVINCES.includes(value)) throw new Error(`--province moet één van ${PROVINCES.join(', ')} zijn`);
      options.provinces = [value];
    } else if (arg === '--mode') {
      const value = args[i + 1];
      i += 1;
      if (!NETWORKS[value]) throw new Error('--mode moet "wandelen" of "fietsen" zijn');
      options.modes = [value];
    } else if (arg !== '--') {
      throw new Error(`Onbekende optie: ${arg}`);
    }
  }
  return options;
};

const haversineKm = (lat1, lng1, lat2, lng2) => {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const lineKm = (points) => {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += haversineKm(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
  }
  return total;
};

/** Eenvoudige ruimtelijke index op [lat, lng]-punten. */
class PointIndex {
  constructor(cellDeg = 0.005) {
    this.cellDeg = cellDeg;
    this.cells = new Map();
  }
  key(x, y) {
    return `${x}:${y}`;
  }
  add(item) {
    const k = this.key(Math.floor(item.lng / this.cellDeg), Math.floor(item.lat / this.cellDeg));
    const list = this.cells.get(k);
    if (list) list.push(item);
    else this.cells.set(k, [item]);
  }
  nearest(lat, lng, maxKm, filter) {
    const cx = Math.floor(lng / this.cellDeg);
    const cy = Math.floor(lat / this.cellDeg);
    let best = null;
    let bestKm = Infinity;
    for (let x = cx - 1; x <= cx + 1; x += 1) {
      for (let y = cy - 1; y <= cy + 1; y += 1) {
        for (const item of this.cells.get(this.key(x, y)) || []) {
          if (filter && !filter(item)) continue;
          const km = haversineKm(lat, lng, item.lat, item.lng);
          if (km <= maxKm && km < bestKm) {
            best = item;
            bestKm = km;
          }
        }
      }
    }
    return best;
  }
}

const overpass = async (query, attempt = 1) => {
  const url = OVERPASS_URLS[(attempt - 1) % OVERPASS_URLS.length];
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
      body: `data=${encodeURIComponent(query)}`,
    });
    if ([429, 502, 503, 504].includes(response.status)) throw new Error(`Overpass bezet (HTTP ${response.status})`);
    if (!response.ok) {
      const text = (await response.text()).replace(/\s+/g, ' ').slice(0, 200);
      throw new Error(`HTTP ${response.status}: ${text}`);
    }
    const json = await response.json();
    if (json.remark && /error|timed out|runtime/i.test(json.remark)) throw new Error(`Overpass: ${json.remark}`);
    return json;
  } catch (error) {
    if (attempt >= 8) throw error;
    // Eerst meteen de andere servers proberen, daarna steeds langer wachten.
    const wait = attempt < OVERPASS_URLS.length ? 3000 : 20000 * Math.ceil(attempt / OVERPASS_URLS.length);
    log(`  ${new URL(url).host}: ${String(error.message).split('\n')[0]}; opnieuw over ${wait / 1000} s (poging ${attempt + 1})...`);
    await sleep(wait);
    return overpass(query, attempt + 1);
  }
};

/** Lijnstukken (ways) van één routerelatie tot één lijn aan elkaar rijgen. */
const stitchWays = (ways) => {
  const pieces = ways.filter((way) => way.length >= 2).map((way) => way.slice());
  if (!pieces.length) return { line: null, complete: false };

  const near = (a, b) => haversineKm(a[0], a[1], b[0], b[1]) <= STITCH_TOLERANCE_KM;
  const chains = [];

  while (pieces.length) {
    chains.push(growChain(pieces, near));
  }

  // Onderbroken relatie: het langste aaneengesloten stuk gebruiken.
  chains.sort((left, right) => lineKm(right) - lineKm(left));
  return { line: chains[0], complete: chains.length === 1 };
};

const growChain = (pieces, near) => {
  let chain = pieces.shift();
  let progress = true;

  while (pieces.length && progress) {
    progress = false;
    for (let i = 0; i < pieces.length; i += 1) {
      const piece = pieces[i];
      const start = chain[0];
      const end = chain[chain.length - 1];
      const pStart = piece[0];
      const pEnd = piece[piece.length - 1];
      if (near(end, pStart)) chain = chain.concat(piece.slice(1));
      else if (near(end, pEnd)) chain = chain.concat(piece.slice().reverse().slice(1));
      else if (near(start, pEnd)) chain = piece.slice(0, -1).concat(chain);
      else if (near(start, pStart)) chain = piece.slice().reverse().slice(0, -1).concat(chain);
      else continue;
      pieces.splice(i, 1);
      progress = true;
      break;
    }
  }

  return chain;
};

// ---------------------------------------------------------------------------

const fetchProvince = async (province, mode) => {
  const { network, refTag } = NETWORKS[mode];
  const query = `[out:json][timeout:600];
area["ISO3166-2"="${province}"]->.a;
(
  node(area.a)["${refTag}"];
)->.nodes;
.nodes out body;
relation(area.a)["type"="route"]["network"="${network}"]["network:type"="node_network"];
out geom;`;
  const json = await overpass(query);
  const elements = Array.isArray(json.elements) ? json.elements : [];
  return {
    refNodes: elements.filter((element) => element.type === 'node'),
    routes: elements.filter((element) => element.type === 'relation'),
  };
};

const run = async () => {
  const options = parseArgs();
  const fullRun = options.provinces.length === PROVINCES.length && options.modes.length === 2;
  log(
    options.apply ? 'MODUS: wegschrijven' : 'MODUS: droge test (niets wordt gewijzigd, gebruik --apply)',
    options.prune ? '+ verwijderen' : ''
  );

  // 1. OSM ophalen, per provincie en netwerk.
  const sourceNodes = new Map(); // externalId -> node
  const routeElements = new Map(); // externalId -> { element, mode }
  const perProvince = [];

  for (const province of options.provinces) {
    for (const mode of options.modes) {
      const { refNodes, routes } = await fetchProvince(province, mode);
      for (const element of refNodes) {
        const externalId = `${NODE_PREFIX}${element.id}`;
        const ref = element.tags && element.tags[NETWORKS[mode].refTag];
        if (!sourceNodes.has(externalId)) {
          sourceNodes.set(externalId, {
            externalId,
            osmId: element.id,
            number: ref ? String(ref).trim() : '',
            name: (element.tags && (element.tags[`${NETWORKS[mode].network}:name`] || element.tags.name)) || '',
            lat: round6(element.lat),
            lng: round6(element.lon),
            modes: new Set([mode]),
          });
        } else {
          sourceNodes.get(externalId).modes.add(mode);
        }
      }
      for (const element of routes) {
        routeElements.set(`${CONNECTION_PREFIX}${element.id}`, { element, mode });
      }
      perProvince.push(`${province} ${mode}: ${refNodes.length} knooppunten, ${routes.length} trajecten`);
      log(`  ${perProvince[perProvince.length - 1]}`);
      await sleep(PAUSE_BETWEEN_QUERIES_MS);
    }
  }

  // 2. Trajecten opbouwen: lijn + begin- en eindknooppunt.
  const refIndex = new PointIndex();
  for (const node of sourceNodes.values()) refIndex.add(node);

  const sourceConnections = [];
  const stats = {
    routes: routeElements.size,
    connectionsBuilt: 0,
    noGeometry: 0,
    incomplete: 0,
    noEndpoints: 0,
  };

  for (const [externalId, { element, mode }] of routeElements) {
    const ways = (element.members || [])
      .filter((member) => member.type === 'way' && Array.isArray(member.geometry))
      .map((member) => member.geometry.map((point) => [round6(point.lat), round6(point.lon)]));
    const { line, complete } = stitchWays(ways);
    if (!line) {
      stats.noGeometry += 1;
      continue;
    }
    if (!complete) stats.incomplete += 1;

    const filter = (node) => node.modes.has(mode);
    const start = refIndex.nearest(line[0][0], line[0][1], ENDPOINT_RADIUS_KM, filter);
    const end = refIndex.nearest(line[line.length - 1][0], line[line.length - 1][1], ENDPOINT_RADIUS_KM, filter);
    if (!start || !end || start.externalId === end.externalId) {
      stats.noEndpoints += 1;
      continue;
    }

    sourceConnections.push({
      externalId,
      fromRef: start.externalId,
      toRef: end.externalId,
      distanceKm: Math.round(lineKm(line) * 1000) / 1000,
      geometry: { type: 'LineString', coordinates: line.map(([lat, lng]) => [lng, lat]) },
      mode,
    });
    stats.connectionsBuilt += 1;
  }

  log(`OSM: ${sourceNodes.size} knooppunten, ${stats.routes} trajecten`);
  log(
    `Trajecten: ${stats.connectionsBuilt} bruikbaar, ${stats.incomplete} met onderbroken lijn (langste stuk gebruikt), ${stats.noEndpoints} zonder herkenbaar begin/einde, ${stats.noGeometry} zonder lijn`
  );

  // 3. Strapi.
  const appContext = await compileStrapi();
  const strapi = createStrapi(appContext);
  await strapi.load();

  try {
    const findAll = async (uid, params) => {
      const rows = [];
      for (let offset = 0; ; offset += DB_BATCH) {
        const batch = await strapi.db.query(uid).findMany({ ...params, orderBy: { id: 'asc' }, offset, limit: DB_BATCH });
        rows.push(...batch);
        if (batch.length < DB_BATCH) break;
      }
      return rows;
    };
    const relationId = (value) => {
      const item = Array.isArray(value) ? value[0] : value;
      return item && typeof item.id === 'number' ? item.id : null;
    };
    const runPool = async (items, worker) => {
      let index = 0;
      let done = 0;
      await Promise.all(
        Array.from({ length: Math.min(WRITE_CONCURRENCY, items.length) }, async () => {
          while (index < items.length) {
            const item = items[index];
            index += 1;
            try {
              await worker(item);
            } catch (error) {
              stats.writeErrors = (stats.writeErrors || 0) + 1;
              if (stats.writeErrors <= 10) log(`  fout: ${error && error.message}`);
            }
            done += 1;
            if (done % 1000 === 0) log(`    ${done}/${items.length}`);
          }
        })
      );
    };

    const existingNodes = await findAll(NODE_UID, {
      select: ['id', 'external_id', 'number', 'name', 'latitude', 'longitude'],
    });
    const osmNodeRows = new Map();
    const otherNodeIndex = new PointIndex();
    for (const row of existingNodes) {
      const key = String(row.external_id || '');
      if (key.startsWith(NODE_PREFIX)) {
        if (!osmNodeRows.has(key)) osmNodeRows.set(key, row);
      } else if (Number.isFinite(Number(row.latitude)) && Number.isFinite(Number(row.longitude))) {
        otherNodeIndex.add({ id: row.id, lat: Number(row.latitude), lng: Number(row.longitude) });
      }
    }

    // Knooppunten: bestaand niet-OSM knooppunt in de buurt -> dat gebruiken.
    const strapiIdByRef = new Map();
    const mappedToExisting = new Set();
    const nodeCreates = [];
    const nodeUpdates = [];
    let nodesUnchanged = 0;

    for (const node of sourceNodes.values()) {
      const existing = otherNodeIndex.nearest(node.lat, node.lng, DEDUPE_RADIUS_KM);
      if (existing) {
        strapiIdByRef.set(node.externalId, existing.id);
        mappedToExisting.add(node.externalId);
        continue;
      }
      const row = osmNodeRows.get(node.externalId);
      if (!row) {
        nodeCreates.push(node);
        continue;
      }
      strapiIdByRef.set(node.externalId, row.id);
      const changed =
        String(row.number ?? '') !== node.number ||
        String(row.name ?? '') !== node.name ||
        Math.abs(Number(row.latitude) - node.lat) > 1e-6 ||
        Math.abs(Number(row.longitude) - node.lng) > 1e-6;
      if (changed) nodeUpdates.push({ id: row.id, node });
      else nodesUnchanged += 1;
    }

    log(
      `Knooppunten: ${nodeCreates.length} nieuw, ${nodeUpdates.length} gewijzigd, ${nodesUnchanged} ongewijzigd, ${mappedToExisting.size} gekoppeld aan een bestaand (Vlaams) knooppunt`
    );

    const nodeData = (node) => ({
      external_id: node.externalId,
      number: node.number,
      name: node.name,
      latitude: node.lat,
      longitude: node.lng,
      is_virtual: false,
    });

    if (options.apply) {
      await runPool(nodeCreates, async (node) => {
        const created = await strapi.entityService.create(NODE_UID, { data: nodeData(node) });
        strapiIdByRef.set(node.externalId, created.id);
      });
      await runPool(nodeUpdates, async ({ id, node }) => {
        await strapi.entityService.update(NODE_UID, id, { data: nodeData(node) });
      });
    }

    // Verbindingen.
    const existingConnections = await findAll(CONNECTION_UID, {
      select: ['id', 'external_id', 'distance_km', 'mode'],
      populate: { from_node: { select: ['id'] }, to_node: { select: ['id'] } },
    });
    const osmConnectionRows = new Map();
    for (const row of existingConnections) {
      const key = String(row.external_id || '');
      if (key.startsWith(CONNECTION_PREFIX) && !osmConnectionRows.has(key)) osmConnectionRows.set(key, row);
    }

    const connectionCreates = [];
    const connectionUpdates = [];
    let connectionsUnchanged = 0;
    let connectionsAlreadyInFlanders = 0;

    for (const connection of sourceConnections) {
      if (mappedToExisting.has(connection.fromRef) && mappedToExisting.has(connection.toRef)) {
        connectionsAlreadyInFlanders += 1;
        continue;
      }
      const placeholder = (ref) => (!options.apply && sourceNodes.has(ref) ? -1 : null);
      const fromId = strapiIdByRef.get(connection.fromRef) ?? placeholder(connection.fromRef);
      const toId = strapiIdByRef.get(connection.toRef) ?? placeholder(connection.toRef);
      if (fromId === null || toId === null) continue;

      const target = { ...connection, fromId, toId };
      const row = osmConnectionRows.get(connection.externalId);
      if (!row) {
        connectionCreates.push(target);
        continue;
      }
      // Geometrie vergelijken we niet (te zwaar om in te laden): afstand dekt een gewijzigde lijn.
      const changed =
        relationId(row.from_node) !== fromId ||
        relationId(row.to_node) !== toId ||
        row.mode !== connection.mode ||
        Math.abs(Number(row.distance_km || 0) - connection.distanceKm) > 0.005;
      if (changed) connectionUpdates.push({ id: row.id, target });
      else connectionsUnchanged += 1;
    }

    log(
      `Verbindingen: ${connectionCreates.length} nieuw, ${connectionUpdates.length} gewijzigd, ${connectionsUnchanged} ongewijzigd, ${connectionsAlreadyInFlanders} overgeslagen (zit al in de Vlaamse data)`
    );

    const connectionData = (target) => ({
      external_id: target.externalId,
      from_node: { set: [target.fromId] },
      to_node: { set: [target.toId] },
      node_network: null,
      distance_km: target.distanceKm,
      geometry: target.geometry,
      mode: target.mode,
      is_virtual: false,
    });

    if (options.apply) {
      await runPool(connectionCreates, async (target) => {
        await strapi.entityService.create(CONNECTION_UID, { data: connectionData(target) });
      });
      await runPool(connectionUpdates, async ({ id, target }) => {
        await strapi.entityService.update(CONNECTION_UID, id, { data: connectionData(target) });
      });
    }

    // Verwijderen: enkel OSM-records, enkel bij een volledige run.
    const sourceConnectionIds = new Set(sourceConnections.map((connection) => connection.externalId));
    const staleConnections = [...osmConnectionRows.entries()]
      .filter(([key]) => !sourceConnectionIds.has(key))
      .map(([, row]) => row);
    const staleNodes = [...osmNodeRows.entries()]
      .filter(([key]) => !sourceNodes.has(key) || mappedToExisting.has(key))
      .map(([, row]) => row);
    log(`Niet (meer) in OSM: ${staleConnections.length} verbindingen, ${staleNodes.length} knooppunten`);

    if (options.prune) {
      if (!fullRun) log('Verwijderen overgeslagen: enkel bij een volledige run (alle provincies, beide netwerken).');
      else if (sourceConnections.length < MIN_SOURCE_CONNECTIONS_FOR_PRUNE)
        log('Verwijderen overgeslagen: OSM-resultaat verdacht klein.');
      else if (options.apply) {
        await runPool(staleConnections, (row) => strapi.entityService.delete(CONNECTION_UID, row.id));
        await runPool(staleNodes, (row) => strapi.entityService.delete(NODE_UID, row.id));
      }
    }

    log('Klaar:', JSON.stringify({ ...stats, writeErrors: stats.writeErrors || 0 }));
    if (!options.apply) log('Dit was een droge test. Voer opnieuw uit met --apply om weg te schrijven.');
  } finally {
    await strapi.destroy();
  }
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

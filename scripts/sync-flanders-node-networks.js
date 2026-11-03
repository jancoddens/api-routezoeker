#!/usr/bin/env node

/**
 * Synchroniseert de wandel- en fietsknooppunten van Vlaanderen met de open data
 * van Toerisme Vlaanderen (WFS, wekelijks bijgewerkt, Modellicentie Gratis
 * Hergebruik).
 *
 *   Knooppunten:  routes:knoop_wandel   / routes:knoop_fiets    (geoid, knoopnr, naam)
 *   Verbindingen: routes:traject_wandel / routes:traject_fiets  (pid, begin_geoid, end_geoid)
 *
 * Koppeling met Strapi:
 *   node.external_id            = geoid
 *   node-connection.external_id = pid (bij dubbele pid: pid_1, pid_2, ...)
 *
 * Gebruik:
 *   npm run sync:knooppunten-vlaanderen                 droge test: toont enkel wat er zou veranderen
 *   npm run sync:knooppunten-vlaanderen -- --apply      wijzigingen echt wegschrijven
 *   npm run sync:knooppunten-vlaanderen -- --apply --prune
 *                                                       ook knooppunten/verbindingen verwijderen die
 *                                                       niet meer in de bron staan
 *   --mode wandelen|fietsen                             enkel één netwerk (standaard: beide)
 *
 * De knooppuntenplanner in de draaiende Strapi laadt zijn netwerk opnieuw na
 * maximaal 6 uur (of meteen na `pm2 restart strapi`).
 */

'use strict';

const { compileStrapi, createStrapi } = require('@strapi/strapi');

const WFS_URL = 'https://geodata.toerismevlaanderen.be/geoserver/wfs';
const PAGE_SIZE = 5000;
const WRITE_CONCURRENCY = 4;
const DB_BATCH = 2000;
// Verwijderen enkel als de bron groot genoeg is (beschermt tegen een half
// gelukte download die anders half Vlaanderen zou wissen).
const PRUNE_SAFETY_RATIO = 0.8;
const MIN_SOURCE_NODES = 10000;
const MIN_SOURCE_CONNECTIONS = 15000;

const LAYERS = {
  wandelen: { nodes: 'routes:knoop_wandel', connections: 'routes:traject_wandel' },
  fietsen: { nodes: 'routes:knoop_fiets', connections: 'routes:traject_fiets' },
};

const NODE_UID = 'api::node.node';
const CONNECTION_UID = 'api::node-connection.node-connection';
const NETWORK_UID = 'api::node-network.node-network';

// ---------------------------------------------------------------------------
// Argumenten

const parseArgs = () => {
  const args = process.argv.slice(2);
  const options = { apply: false, prune: false, modes: ['wandelen', 'fietsen'] };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--prune') options.prune = true;
    else if (arg === '--mode') {
      const value = args[i + 1];
      i += 1;
      if (value !== 'wandelen' && value !== 'fietsen') {
        throw new Error('--mode moet "wandelen" of "fietsen" zijn');
      }
      options.modes = [value];
    } else if (arg !== '--') {
      throw new Error(`Onbekende optie: ${arg}`);
    }
  }

  return options;
};

// ---------------------------------------------------------------------------
// Hulpfuncties

const log = (...parts) => console.log(`[sync-knooppunten] ${parts.join(' ')}`);

const round6 = (value) => Math.round(Number(value) * 1e6) / 1e6;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchJson = async (url, attempt = 1) => {
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (text.trimStart().startsWith('<')) {
      throw new Error(`WFS gaf XML terug in plaats van JSON: ${text.slice(0, 300)}`);
    }
    return JSON.parse(text);
  } catch (error) {
    if (attempt >= 4) throw error;
    log(`  fout bij ophalen (poging ${attempt}): ${error.message}, opnieuw proberen...`);
    await sleep(2000 * attempt);
    return fetchJson(url, attempt + 1);
  }
};

const fetchLayer = async (typeName) => {
  const features = [];

  for (let startIndex = 0; ; startIndex += PAGE_SIZE) {
    const params = new URLSearchParams({
      service: 'WFS',
      version: '2.0.0',
      request: 'GetFeature',
      typeNames: typeName,
      outputFormat: 'application/json',
      srsName: 'EPSG:4326',
      sortBy: 'objectid',
      count: String(PAGE_SIZE),
      startIndex: String(startIndex),
    });
    const page = await fetchJson(`${WFS_URL}?${params.toString()}`);
    const pageFeatures = Array.isArray(page.features) ? page.features : [];
    features.push(...pageFeatures);
    if (pageFeatures.length < PAGE_SIZE) break;
  }

  log(`  ${typeName}: ${features.length} records opgehaald`);
  return features;
};

const roundCoordinates = (coordinates) => {
  if (!Array.isArray(coordinates)) return coordinates;
  if (typeof coordinates[0] === 'number') return coordinates.slice(0, 2).map(round6);
  return coordinates.map(roundCoordinates);
};

const normalizeText = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

/** "Wandelnetwerk Bulskampveld", "WNW Bronbossen", "FNW Waasland" -> "bulskampveld", ... */
const networkKey = (value) =>
  normalizeText(value)
    .replace(/\([^)]*\)/g, ' ')
    .replace(/^(uitbreiding\s+)?(wandelnetwerk|fietsnetwerk|fietsroutenetwerk|wnw|fnw)\b[\s:-]*/, '')
    .replace(/^(de|het|t)\s+/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const runPool = async (items, worker) => {
  let index = 0;
  let done = 0;
  const total = items.length;
  const runners = Array.from({ length: Math.min(WRITE_CONCURRENCY, total) }, async () => {
    while (index < total) {
      const item = items[index];
      index += 1;
      await worker(item);
      done += 1;
      if (done % 1000 === 0) log(`    ${done}/${total}`);
    }
  });
  await Promise.all(runners);
};

const findAll = async (strapi, uid, params) => {
  const rows = [];
  for (let offset = 0; ; offset += DB_BATCH) {
    const batch = await strapi.db.query(uid).findMany({
      ...params,
      orderBy: { id: 'asc' },
      offset,
      limit: DB_BATCH,
    });
    rows.push(...batch);
    if (batch.length < DB_BATCH) break;
  }
  return rows;
};

/** "virtual network" = virtueel netwerk zonder bordjes; "signposted network" = bewegwijzerd. */
const isVirtualValue = (value) => /virtual/i.test(String(value || '')) && !/signposted/i.test(String(value || ''));

const relationId = (value) => {
  const item = Array.isArray(value) ? value[0] : value;
  return item && typeof item.id === 'number' ? item.id : null;
};

// ---------------------------------------------------------------------------
// Bron normaliseren

const normalizeSourceNodes = (features, mode) => {
  const nodes = new Map();
  for (const feature of features) {
    const p = feature.properties || {};
    const coords = feature.geometry && feature.geometry.coordinates;
    if (p.geoid === null || p.geoid === undefined || !Array.isArray(coords)) continue;
    const externalId = String(p.geoid);
    nodes.set(externalId, {
      externalId,
      number: p.knoopnr === null || p.knoopnr === undefined ? '' : String(p.knoopnr),
      name: p.naam ? String(p.naam) : '',
      latitude: round6(coords[1]),
      longitude: round6(coords[0]),
      isVirtual: isVirtualValue(p.virtual),
      mode,
    });
  }
  return nodes;
};

const normalizeSourceConnections = (features, mode) => {
  const byPid = new Map();
  for (const feature of features) {
    const p = feature.properties || {};
    if (!p.pid || p.begin_geoid === null || p.end_geoid === null || !feature.geometry) continue;
    const list = byPid.get(p.pid) || [];
    list.push(feature);
    byPid.set(p.pid, list);
  }

  const connections = [];
  for (const [pid, list] of byPid) {
    list.sort((a, b) => (a.properties.objectid || 0) - (b.properties.objectid || 0));
    list.forEach((feature, index) => {
      const p = feature.properties;
      connections.push({
        externalId: list.length > 1 ? `${pid}_${index + 1}` : String(pid),
        fromRef: String(p.begin_geoid),
        toRef: String(p.end_geoid),
        distanceKm:
          typeof p.shape_length === 'number' ? Math.round(p.shape_length) / 1000 : null,
        geometry: {
          type: feature.geometry.type,
          coordinates: roundCoordinates(feature.geometry.coordinates),
        },
        networkName: p.naam ? String(p.naam) : '',
        isVirtual: isVirtualValue(p.virtual),
        mode,
      });
    });
  }
  return connections;
};

// ---------------------------------------------------------------------------
// Hoofdprogramma

const run = async () => {
  const options = parseArgs();
  log(
    options.apply ? 'MODUS: wegschrijven' : 'MODUS: droge test (niets wordt gewijzigd, gebruik --apply)',
    options.prune ? '+ verwijderen' : ''
  );

  // 1. Bron ophalen (vóór Strapi start, zodat een netwerkfout snel faalt).
  const sourceNodes = new Map();
  const sourceConnections = [];
  for (const mode of options.modes) {
    log(`Ophalen ${mode}...`);
    const nodeFeatures = await fetchLayer(LAYERS[mode].nodes);
    const connectionFeatures = await fetchLayer(LAYERS[mode].connections);
    for (const [key, node] of normalizeSourceNodes(nodeFeatures, mode)) {
      if (!sourceNodes.has(key)) sourceNodes.set(key, node);
    }
    sourceConnections.push(...normalizeSourceConnections(connectionFeatures, mode));
  }
  log(`Bron: ${sourceNodes.size} knooppunten, ${sourceConnections.length} verbindingen`);

  const appContext = await compileStrapi();
  const strapi = createStrapi(appContext);
  await strapi.load();

  try {
    const stats = {
      nodesCreated: 0,
      nodesUpdated: 0,
      nodesUnchanged: 0,
      nodesDeleted: 0,
      connectionsCreated: 0,
      connectionsUpdated: 0,
      connectionsUnchanged: 0,
      connectionsDeleted: 0,
      connectionsMissingNode: 0,
      connectionsWithNetwork: 0,
      unmatchedNetworkNames: new Map(),
    };

    // 2. Netwerken in Strapi op naam/slug indexeren.
    const networks = await strapi.db.query(NETWORK_UID).findMany({
      select: ['id', 'name', 'slug', 'publishedAt'],
    });
    const networkIdByKey = new Map();
    // Gepubliceerde rij eerst, zodat die voorrang krijgt.
    networks
      .sort((a, b) => Number(Boolean(b.publishedAt)) - Number(Boolean(a.publishedAt)))
      .forEach((network) => {
        for (const key of [networkKey(network.name), networkKey(network.slug)]) {
          if (key && !networkIdByKey.has(key)) networkIdByKey.set(key, network.id);
        }
      });

    const matchNetwork = (names) => {
      for (const raw of names) {
        for (const part of String(raw || '').split('|')) {
          const key = networkKey(part);
          if (key && networkIdByKey.has(key)) return networkIdByKey.get(key);
        }
      }
      return null;
    };

    // 3. Knooppunten.
    const existingNodes = await findAll(strapi, NODE_UID, {
      select: ['id', 'external_id', 'number', 'name', 'latitude', 'longitude', 'is_virtual'],
    });
    // Bij dubbels (zelfde external_id) houden we de oudste rij (laagste id).
    const nodeByExternalId = new Map();
    const duplicateNodes = [];
    for (const row of existingNodes) {
      if (!row.external_id) continue;
      const key = String(row.external_id);
      if (nodeByExternalId.has(key)) duplicateNodes.push(row);
      else nodeByExternalId.set(key, row);
    }
    log(`Strapi: ${existingNodes.length} knooppunten, waarvan ${duplicateNodes.length} dubbel`);

    const nodeCreates = [];
    const nodeUpdates = [];
    for (const node of sourceNodes.values()) {
      const row = nodeByExternalId.get(node.externalId);
      if (!row) {
        nodeCreates.push(node);
        continue;
      }
      const changed =
        String(row.number ?? '') !== node.number ||
        String(row.name ?? '') !== node.name ||
        Boolean(row.is_virtual) !== node.isVirtual ||
        Math.abs(Number(row.latitude) - node.latitude) > 1e-6 ||
        Math.abs(Number(row.longitude) - node.longitude) > 1e-6;
      if (changed) nodeUpdates.push({ id: row.id, node });
      else stats.nodesUnchanged += 1;
    }

    const nodeData = (node) => ({
      external_id: node.externalId,
      number: node.number,
      name: node.name,
      latitude: node.latitude,
      longitude: node.longitude,
      is_virtual: node.isVirtual,
    });

    log(`Knooppunten: ${nodeCreates.length} nieuw, ${nodeUpdates.length} gewijzigd, ${stats.nodesUnchanged} ongewijzigd`);

    if (options.apply) {
      await runPool(nodeCreates, async (node) => {
        try {
          const created = await strapi.entityService.create(NODE_UID, { data: nodeData(node) });
          nodeByExternalId.set(node.externalId, { id: created.id, external_id: node.externalId });
          stats.nodesCreated += 1;
        } catch (error) {
          stats.nodesFailed = (stats.nodesFailed || 0) + 1;
          if (stats.nodesFailed <= 10) log(`  knooppunt ${node.externalId} overgeslagen: ${error && error.message}`);
        }
      });
      await runPool(nodeUpdates, async ({ id, node }) => {
        try {
          await strapi.entityService.update(NODE_UID, id, { data: nodeData(node) });
          stats.nodesUpdated += 1;
        } catch (error) {
          stats.nodesFailed = (stats.nodesFailed || 0) + 1;
          if (stats.nodesFailed <= 10) log(`  knooppunt ${node.externalId} overgeslagen: ${error && error.message}`);
        }
      });
    }

    // 4. Verbindingen.
    const existingConnections = await findAll(strapi, CONNECTION_UID, {
      select: ['id', 'external_id', 'distance_km', 'geometry', 'mode', 'is_virtual'],
      populate: {
        from_node: { select: ['id'] },
        to_node: { select: ['id'] },
        node_network: { select: ['id'] },
      },
    });
    const connectionByExternalId = new Map();
    const duplicateConnections = [];
    for (const row of existingConnections) {
      if (!row.external_id) continue;
      const key = String(row.external_id);
      if (connectionByExternalId.has(key)) duplicateConnections.push(row);
      else connectionByExternalId.set(key, row);
    }
    log(`Strapi: ${existingConnections.length} verbindingen, waarvan ${duplicateConnections.length} dubbel`);

    const sourceNodeNames = new Map(Array.from(sourceNodes.values(), (node) => [node.externalId, node.name]));
    const connectionCreates = [];
    const connectionUpdates = [];

    for (const connection of sourceConnections) {
      const fromRow = nodeByExternalId.get(connection.fromRef);
      const toRow = nodeByExternalId.get(connection.toRef);
      // In een droge test bestaan nieuwe knooppunten nog niet: dan tellen ze als "zou aangemaakt".
      const placeholder = (ref) => (!options.apply && sourceNodes.has(ref) ? -1 : null);
      const fromId = fromRow ? fromRow.id : placeholder(connection.fromRef);
      const toId = toRow ? toRow.id : placeholder(connection.toRef);
      if (fromId === null || toId === null) {
        stats.connectionsMissingNode += 1;
        continue;
      }

      const networkId = matchNetwork([
        connection.networkName,
        sourceNodeNames.get(connection.fromRef),
        sourceNodeNames.get(connection.toRef),
      ]);
      if (networkId) stats.connectionsWithNetwork += 1;
      else {
        const name = connection.networkName || sourceNodeNames.get(connection.fromRef) || '(leeg)';
        stats.unmatchedNetworkNames.set(name, (stats.unmatchedNetworkNames.get(name) || 0) + 1);
      }

      const target = { ...connection, fromId, toId, networkId };
      const row = connectionByExternalId.get(connection.externalId);

      if (!row) {
        connectionCreates.push(target);
        continue;
      }

      const changed =
        relationId(row.from_node) !== fromId ||
        relationId(row.to_node) !== toId ||
        relationId(row.node_network) !== networkId ||
        row.mode !== connection.mode ||
        Boolean(row.is_virtual) !== connection.isVirtual ||
        Math.abs(Number(row.distance_km || 0) - Number(connection.distanceKm || 0)) > 0.001 ||
        JSON.stringify(roundCoordinates(row.geometry && row.geometry.coordinates)) !==
          JSON.stringify(connection.geometry.coordinates);

      if (changed) connectionUpdates.push({ id: row.id, target });
      else stats.connectionsUnchanged += 1;
    }

    const connectionData = (target) => ({
      external_id: target.externalId,
      from_node: { set: [target.fromId] },
      to_node: { set: [target.toId] },
      node_network: target.networkId,
      distance_km: target.distanceKm,
      geometry: target.geometry,
      mode: target.mode,
      is_virtual: target.isVirtual,
    });

    log(
      `Verbindingen: ${connectionCreates.length} nieuw, ${connectionUpdates.length} gewijzigd, ${stats.connectionsUnchanged} ongewijzigd, ${stats.connectionsMissingNode} overgeslagen (knooppunt ontbreekt)`
    );
    log(
      `Netwerkkoppeling: ${stats.connectionsWithNetwork} verbindingen gekoppeld aan een netwerk in Strapi, ${
        sourceConnections.length - stats.connectionsMissingNode - stats.connectionsWithNetwork
      } zonder overeenkomend netwerk`
    );
    const topUnmatched = Array.from(stats.unmatchedNetworkNames.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25);
    if (topUnmatched.length) {
      log('Netwerknamen uit de bron zonder netwerk in Strapi (top 25):');
      topUnmatched.forEach(([name, count]) => log(`    ${count}x  ${name}`));
    }

    // Eén fout record mag de sync niet stilleggen: eerst opnieuw zonder
    // netwerkkoppeling, anders overslaan en de reden loggen.
    const failures = [];
    const describeError = (error) => {
      const details = error && error.details && error.details.errors;
      return `${error && error.message}${details ? ` ${JSON.stringify(details).slice(0, 400)}` : ''}`;
    };
    const writeConnection = async (target, write) => {
      try {
        await write(connectionData(target));
        return true;
      } catch (error) {
        if (target.networkId) {
          try {
            await write(connectionData({ ...target, networkId: null }));
            stats.connectionsNetworkDropped = (stats.connectionsNetworkDropped || 0) + 1;
            if (stats.connectionsNetworkDropped <= 5) {
              log(`  ${target.externalId}: netwerk ${target.networkId} geweigerd (${describeError(error)}), opgeslagen zonder netwerk`);
            }
            return true;
          } catch (retryError) {
            error = retryError;
          }
        }
        failures.push(target.externalId);
        if (failures.length <= 10) log(`  ${target.externalId} overgeslagen: ${describeError(error)}`);
        return false;
      }
    };

    if (options.apply) {
      await runPool(connectionCreates, async (target) => {
        const ok = await writeConnection(target, (data) => strapi.entityService.create(CONNECTION_UID, { data }));
        if (ok) stats.connectionsCreated += 1;
      });
      await runPool(connectionUpdates, async ({ id, target }) => {
        const ok = await writeConnection(target, (data) => strapi.entityService.update(CONNECTION_UID, id, { data }));
        if (ok) stats.connectionsUpdated += 1;
      });
      stats.connectionsFailed = failures.length;
    }

    // 5. Verwijderen wat niet meer in de bron staat.
    const sourceConnectionIds = new Set(sourceConnections.map((connection) => connection.externalId));
    // Records uit andere bronnen (bv. OpenStreetMap, "osm:...") blijven onaangeroerd.
    const isOtherSource = (row) => /^osm:/.test(String(row.external_id || ''));
    const staleConnections = existingConnections.filter(
      (row) => !isOtherSource(row) && (!row.external_id || !sourceConnectionIds.has(String(row.external_id)))
    );
    const staleNodes = existingNodes.filter(
      (row) => !isOtherSource(row) && (!row.external_id || !sourceNodes.has(String(row.external_id)))
    );
    log(
      `Niet (meer) in de bron: ${staleConnections.length} verbindingen, ${staleNodes.length} knooppunten${
        options.prune ? '' : ' (blijven staan; gebruik --prune om te verwijderen)'
      }`
    );
    // Dubbels die zelf nog in de bron staan (de oudste rij blijft bestaan).
    const staleIds = new Set([...staleConnections, ...staleNodes].map((row) => row.id));
    const extraConnections = duplicateConnections.filter((row) => !staleIds.has(row.id));
    const extraNodes = duplicateNodes.filter((row) => !staleIds.has(row.id));
    log(
      `Dubbels om op te ruimen: ${extraConnections.length} verbindingen, ${extraNodes.length} knooppunten${
        options.prune ? '' : ' (gebruik --prune)'
      }`
    );

    if (options.prune) {
      const safeConnections =
        sourceConnections.length >= MIN_SOURCE_CONNECTIONS &&
        sourceConnections.length >= (existingConnections.length - staleConnections.length) * PRUNE_SAFETY_RATIO;
      const safeNodes = sourceNodes.size >= MIN_SOURCE_NODES;
      if (options.modes.length < 2) {
        log('Verwijderen overgeslagen: enkel mogelijk als wandelen én fietsen samen gesynchroniseerd worden.');
      } else if (!safeConnections || !safeNodes) {
        log('Verwijderen overgeslagen: de bron is verdacht klein tegenover Strapi (half gelukte download?).');
      } else if (options.apply) {
        await runPool([...staleConnections, ...extraConnections], async (row) => {
          await strapi.entityService.delete(CONNECTION_UID, row.id);
          stats.connectionsDeleted += 1;
        });
        // Verbindingen wijzen nu naar de bewaarde rij, dus dubbele knooppunten
        // worden niet meer gebruikt.
        await runPool([...staleNodes, ...extraNodes], async (row) => {
          await strapi.entityService.delete(NODE_UID, row.id);
          stats.nodesDeleted += 1;
        });
      }
    }

    const summary = { ...stats, unmatchedNetworkNames: stats.unmatchedNetworkNames.size };
    log('Klaar:', JSON.stringify(summary));
    if (!options.apply) log('Dit was een droge test. Voer opnieuw uit met --apply om weg te schrijven.');
  } finally {
    await strapi.destroy();
  }
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

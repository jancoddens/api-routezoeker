/**
 * node-planner service
 *
 * Laadt alle knooppunten en verbindingen van gepubliceerde knooppuntennetwerken
 * één keer in het geheugen (vereenvoudigde lijnen) en bewaart dat een tijdje.
 * Na een netwerkimport wordt de cache leeggemaakt (zie node-network service).
 */

import type { Core } from '@strapi/strapi';

import {
  buildNodeIndex,
  buildPlannerGraph,
  modeFromThemeSlug,
  nearestNode,
  type PlannerGraph,
  type PlannerMode,
  type RawPlannerConnection,
  type RawPlannerNode,
} from '../../../utils/node-planner-graph';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const NODE_BATCH = 5000;
const CONNECTION_BATCH = 1000;
const DEFAULT_MODE: PlannerMode = 'wandelen';

let cachedGraph: PlannerGraph | null = null;
let loadingGraph: Promise<PlannerGraph> | null = null;

export type PlannerRoute = {
  id: number;
  title: string;
  /** pad op de website, bv. /wandelroutes/<slug> */
  href: string;
  mode: PlannerMode;
  km: number | null;
  lat: number;
  lng: number;
  /** knooppuntnummers in volgorde, zoals op de routepagina */
  numbers: string[];
  /** knooppunt-ids in de planner, of null als de route niet te koppelen is */
  waypoints: number[] | null;
};

let cachedRoutes: { builtAt: number; graphBuiltAt: number; routes: PlannerRoute[] } | null = null;
let loadingRoutes: Promise<PlannerRoute[]> | null = null;

type RouteRow = {
  id: number;
  title?: string | null;
  slug?: string | null;
  theme?: { slug?: string | null } | null;
  route_nodes?: Array<{
    node_number?: string | null;
    order?: number | null;
    cumulative_distance_km?: number | string | null;
    latitude?: number | string | null;
    longitude?: number | string | null;
  }> | null;
  route_start_locations?: Array<{ distance_km?: number | string | null }> | null;
};

const ROUTE_BATCH = 200;

const loadRoutes = async (strapi: Core.Strapi, graph: PlannerGraph): Promise<PlannerRoute[]> => {
  const started = Date.now();
  const index = buildNodeIndex(graph);
  const routes: PlannerRoute[] = [];

  for (let offset = 0; ; offset += ROUTE_BATCH) {
    const batch = (await strapi.db.query('api::route.route').findMany({
      where: { publishedAt: { $notNull: true } },
      select: ['id', 'title', 'slug'],
      populate: {
        theme: { select: ['slug'] },
        route_nodes: true,
        route_start_locations: { select: ['distance_km'] },
      },
      orderBy: { id: 'asc' },
      offset,
      limit: ROUTE_BATCH,
    })) as RouteRow[];

    for (const row of batch) {
      const points = (row.route_nodes ?? [])
        .map((node) => ({
          number: node.node_number ? String(node.node_number).trim() : '',
          order: Number(node.order ?? 0),
          cumulative: Number(node.cumulative_distance_km),
          lat: Number(node.latitude),
          lng: Number(node.longitude),
        }))
        .filter((node) => Number.isFinite(node.lat) && Number.isFinite(node.lng) && (node.lat !== 0 || node.lng !== 0))
        .sort((a, b) => a.order - b.order);

      if (!row.slug || points.length < 2) continue;

      const themeSlug = row.theme?.slug || 'wandelroutes';
      const mode = modeFromThemeSlug(themeSlug);

      // Routepunten aan netwerkknooppunten koppelen; dubbels na elkaar weg.
      const waypoints: number[] = [];
      let matched = 0;
      for (const point of points) {
        const node = nearestNode(index, point.lat, point.lng, mode, point.number);
        if (!node) continue;
        matched++;
        if (waypoints[waypoints.length - 1] !== node.id) waypoints.push(node.id);
      }

      const startKm = Number(row.route_start_locations?.[0]?.distance_km);
      const lastCumulative = points[points.length - 1].cumulative;

      routes.push({
        id: row.id,
        title: row.title || 'Zonder titel',
        href: `/${themeSlug}/${row.slug}`,
        mode,
        km: Number.isFinite(startKm) && startKm > 0 ? startKm : Number.isFinite(lastCumulative) && lastCumulative > 0 ? lastCumulative : null,
        lat: points[0].lat,
        lng: points[0].lng,
        numbers: points.map((point) => point.number).filter(Boolean),
        waypoints: matched >= points.length * 0.8 && waypoints.length >= 2 ? waypoints : null,
      });
    }

    if (batch.length < ROUTE_BATCH) break;
  }

  strapi.log.info(
    `[node-planner] routes geladen: ${routes.length} routes met knooppunten, ${
      routes.filter((route) => route.waypoints).length
    } bruikbaar in de planner, in ${Date.now() - started} ms`
  );

  return routes;
};

type NetworkRow = {
  id: number;
  documentId?: string | null;
  publishedAt?: string | null;
  theme?: { slug?: string | null } | null;
};

type RelationValue = { id: number } | Array<{ id: number }> | null | undefined;

type ConnectionRow = {
  id: number;
  distance_km?: number | string | null;
  geometry?: unknown;
  mode?: string | null;
  is_virtual?: boolean | null;
  // from_node / to_node zijn manyToMany in het schema: Strapi geeft een lijst terug.
  from_node?: RelationValue;
  to_node?: RelationValue;
  node_network?: RelationValue;
};

const relationId = (value: RelationValue): number | null => {
  const item = Array.isArray(value) ? value[0] : value;
  return item && typeof item.id === 'number' ? item.id : null;
};

const loadGraph = async (strapi: Core.Strapi): Promise<PlannerGraph> => {
  const started = Date.now();

  // Netwerken: draft- en gepubliceerde rij delen een documentId. Enkel
  // netwerken met een gepubliceerde versie tellen mee.
  const networks = (await strapi.db.query('api::node-network.node-network').findMany({
    select: ['id', 'documentId', 'publishedAt'],
    populate: { theme: { select: ['slug'] } },
  })) as NetworkRow[];

  const publishedDocuments = new Set(
    networks.filter((network) => network.publishedAt).map((network) => network.documentId)
  );
  const modeByNetworkId = new Map<number, PlannerMode>();
  const modeByDocument = new Map<string, PlannerMode>();

  for (const network of networks) {
    if (network.documentId && network.theme?.slug) {
      modeByDocument.set(network.documentId, modeFromThemeSlug(network.theme.slug));
    }
  }

  for (const network of networks) {
    if (!network.documentId || !publishedDocuments.has(network.documentId)) continue;
    modeByNetworkId.set(network.id, modeByDocument.get(network.documentId) ?? 'wandelen');
  }

  const nodes: RawPlannerNode[] = [];
  for (let offset = 0; ; offset += NODE_BATCH) {
    const batch = (await strapi.db.query('api::node.node').findMany({
      select: ['id', 'number', 'latitude', 'longitude', 'is_virtual'],
      orderBy: { id: 'asc' },
      offset,
      limit: NODE_BATCH,
    })) as RawPlannerNode[];
    nodes.push(
      ...batch.map((row) => ({ ...row, isVirtual: (row as { is_virtual?: boolean }).is_virtual ?? false }))
    );
    if (batch.length < NODE_BATCH) break;
  }

  const connections: RawPlannerConnection[] = [];
  let rawConnectionCount = 0;
  let skippedUnpublished = 0;
  let missingEndpoints = 0;
  for (let offset = 0; ; offset += CONNECTION_BATCH) {
    const batch = (await strapi.db.query('api::node-connection.node-connection').findMany({
      select: ['id', 'distance_km', 'geometry', 'mode', 'is_virtual'],
      populate: {
        from_node: { select: ['id'] },
        to_node: { select: ['id'] },
        node_network: { select: ['id'] },
      },
      orderBy: { id: 'asc' },
      offset,
      limit: CONNECTION_BATCH,
    })) as ConnectionRow[];
    rawConnectionCount += batch.length;

    for (const row of batch) {
      // Verbindingen uit de officiële dataset hangen vaak niet aan een netwerk:
      // die tellen als wandelen. Hangt een verbinding wel aan een netwerk, dan
      // moet dat netwerk gepubliceerd zijn.
      // Modus: expliciet veld (sync Toerisme Vlaanderen), anders het thema van
      // het netwerk, anders wandelen.
      const networkId = relationId(row.node_network);
      if (networkId !== null && !modeByNetworkId.has(networkId)) {
        skippedUnpublished++;
        continue;
      }
      const mode: PlannerMode | undefined =
        row.mode === 'wandelen' || row.mode === 'fietsen'
          ? row.mode
          : networkId !== null
            ? modeByNetworkId.get(networkId)
            : DEFAULT_MODE;
      if (!mode) {
        skippedUnpublished++;
        continue;
      }

      const from = relationId(row.from_node);
      const to = relationId(row.to_node);
      if (from === null || to === null) {
        missingEndpoints++;
        continue;
      }

      connections.push({
        id: row.id,
        from,
        to,
        distanceKm: row.distance_km ?? null,
        geometry: row.geometry,
        mode,
        isVirtual: row.is_virtual ?? false,
      });
    }

    if (batch.length < CONNECTION_BATCH) break;
  }

  const graph = buildPlannerGraph(nodes, connections);
  const nodesWithCoordinates = nodes.filter(
    (node) => Number(node.latitude) !== 0 && Number.isFinite(Number(node.latitude)) && node.latitude !== null
  ).length;

  strapi.log.info(
    `[node-planner] graaf geladen: ${graph.nodes.size} knooppunten, ${graph.edges.length} verbindingen in ${
      Date.now() - started
    } ms (bron: ${nodes.length} knooppunten, ${rawConnectionCount} verbindingen, ${nodesWithCoordinates} knooppunten met coördinaten, ${skippedUnpublished} verbindingen overgeslagen want netwerk niet gepubliceerd, ${missingEndpoints} zonder begin- of eindknooppunt)`
  );

  return graph;
};

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async getGraph(): Promise<PlannerGraph> {
    if (cachedGraph && Date.now() - cachedGraph.builtAt < CACHE_TTL_MS) {
      return cachedGraph;
    }

    if (!loadingGraph) {
      loadingGraph = loadGraph(strapi)
        .then((graph) => {
          cachedGraph = graph;
          return graph;
        })
        .finally(() => {
          loadingGraph = null;
        });
    }

    // Is er nog een (verlopen) graaf, geef die meteen terug terwijl de nieuwe laadt.
    return cachedGraph ?? loadingGraph;
  },

  async getRoutes(): Promise<PlannerRoute[]> {
    const graph = await this.getGraph();

    if (
      cachedRoutes &&
      cachedRoutes.graphBuiltAt === graph.builtAt &&
      Date.now() - cachedRoutes.builtAt < CACHE_TTL_MS
    ) {
      return cachedRoutes.routes;
    }

    if (!loadingRoutes) {
      loadingRoutes = loadRoutes(strapi, graph)
        .then((routes) => {
          cachedRoutes = { builtAt: Date.now(), graphBuiltAt: graph.builtAt, routes };
          return routes;
        })
        .finally(() => {
          loadingRoutes = null;
        });
    }

    return cachedRoutes?.routes ?? loadingRoutes;
  },

  invalidate() {
    cachedGraph = null;
    cachedRoutes = null;
  },
});

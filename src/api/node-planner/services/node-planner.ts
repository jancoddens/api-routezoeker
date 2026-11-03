/**
 * node-planner service
 *
 * Laadt alle knooppunten en verbindingen van gepubliceerde knooppuntennetwerken
 * één keer in het geheugen (vereenvoudigde lijnen) en bewaart dat een tijdje.
 * Na een netwerkimport wordt de cache leeggemaakt (zie node-network service).
 */

import type { Core } from '@strapi/strapi';

import {
  buildPlannerGraph,
  modeFromThemeSlug,
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

type NetworkRow = {
  id: number;
  documentId?: string | null;
  publishedAt?: string | null;
  theme?: { slug?: string | null } | null;
};

type ConnectionRow = {
  id: number;
  distance_km?: number | string | null;
  geometry?: unknown;
  from_node?: { id: number } | null;
  to_node?: { id: number } | null;
  node_network?: { id: number } | null;
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
      select: ['id', 'number', 'latitude', 'longitude'],
      orderBy: { id: 'asc' },
      offset,
      limit: NODE_BATCH,
    })) as RawPlannerNode[];
    nodes.push(...batch);
    if (batch.length < NODE_BATCH) break;
  }

  const connections: RawPlannerConnection[] = [];
  let rawConnectionCount = 0;
  let skippedUnpublished = 0;
  for (let offset = 0; ; offset += CONNECTION_BATCH) {
    const batch = (await strapi.db.query('api::node-connection.node-connection').findMany({
      select: ['id', 'distance_km', 'geometry'],
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
      const mode = row.node_network
        ? modeByNetworkId.get(row.node_network.id)
        : DEFAULT_MODE;
      if (!mode) {
        skippedUnpublished++;
        continue;
      }

      connections.push({
        id: row.id,
        from: row.from_node?.id ?? null,
        to: row.to_node?.id ?? null,
        distanceKm: row.distance_km ?? null,
        geometry: row.geometry,
        mode,
      });
    }

    if (batch.length < CONNECTION_BATCH) break;
  }

  const graph = buildPlannerGraph(nodes, connections);

  strapi.log.info(
    `[node-planner] graaf geladen: ${graph.nodes.size} knooppunten, ${graph.edges.length} verbindingen in ${
      Date.now() - started
    } ms (bron: ${nodes.length} knooppunten, ${rawConnectionCount} verbindingen, ${skippedUnpublished} overgeslagen want netwerk niet gepubliceerd)`
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

  invalidate() {
    cachedGraph = null;
  },
});

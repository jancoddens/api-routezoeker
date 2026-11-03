/**
 * node-planner controller
 *
 * GET /api/node-planner/graph?bbox=west,south,east,north&mode=wandelen|fietsen
 *   -> knooppunten en verbindingen in de kaartuitsnede
 * GET /api/node-planner/route?from=<nodeId>&to=<nodeId>&mode=wandelen|fietsen
 *   -> kortste pad over het knooppuntennetwerk
 *
 * Compacte antwoorden:
 *   node = [id, nummer, lat, lng, virtueel (0/1)]
 *   edge = [id, vanId, naarId, km, [lat, lng, lat, lng, ...], virtueel (0/1)]
 */

import type { Core } from '@strapi/strapi';

import {
  edgesInBbox,
  parsePlannerMode,
  shortestPath,
  stepCoords,
  type PlannerGraph,
  type PlannerNode,
} from '../../../utils/node-planner-graph';

// Grootste uitsnede die we teruggeven (ongeveer zoomniveau 11 op een groot scherm).
const MAX_BBOX_LNG_SPAN = 0.6;
const MAX_BBOX_LAT_SPAN = 0.4;

const nodeTuple = (node: PlannerNode) => [node.id, node.n, node.lat, node.lng, node.v ? 1 : 0];

const getGraph = (strapi: Core.Strapi): Promise<PlannerGraph> =>
  strapi.service('api::node-planner.node-planner').getGraph();

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async graph(ctx) {
    const parts = String(ctx.query.bbox || '')
      .split(',')
      .map((value) => Number(value));

    if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
      return ctx.badRequest('bbox=west,south,east,north is verplicht');
    }

    const [west, south, east, north] = parts;

    if (west >= east || south >= north) {
      return ctx.badRequest('Ongeldige bbox');
    }

    const mode = parsePlannerMode(ctx.query.mode);

    if (east - west > MAX_BBOX_LNG_SPAN || north - south > MAX_BBOX_LAT_SPAN) {
      ctx.body = { mode, tooLarge: true, nodes: [], edges: [] };
      return;
    }

    const graph = await getGraph(strapi);
    const result = edgesInBbox(graph, { west, south, east, north }, mode);

    ctx.set('Cache-Control', 'public, max-age=600');
    ctx.body = {
      mode,
      truncated: result.truncated,
      nodes: result.nodes.map(nodeTuple),
      edges: result.edges.map((edge) => [edge.id, edge.a, edge.b, edge.km, edge.coords, edge.v ? 1 : 0]),
    };
  },

  async route(ctx) {
    const from = Number(ctx.query.from);
    const to = Number(ctx.query.to);

    if (!Number.isInteger(from) || !Number.isInteger(to) || from <= 0 || to <= 0) {
      return ctx.badRequest('from en to (knooppunt-ids) zijn verplicht');
    }

    const mode = parsePlannerMode(ctx.query.mode);
    const graph = await getGraph(strapi);
    const path = shortestPath(graph, from, to, mode);

    if (!path) {
      return ctx.notFound('Geen verbinding gevonden tussen deze knooppunten');
    }

    ctx.set('Cache-Control', 'public, max-age=600');
    ctx.body = {
      mode,
      km: path.km,
      nodes: path.nodeIds.map((id) => nodeTuple(graph.nodes.get(id)!)),
      edges: path.steps.map((step, index) => [
        step.edge.id,
        path.nodeIds[index],
        path.nodeIds[index + 1],
        step.edge.km,
        stepCoords(step),
        step.edge.v ? 1 : 0,
      ]),
    };
  },
});

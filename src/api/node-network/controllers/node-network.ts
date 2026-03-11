/**
 * node-network controller
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreController('api::node-network.node-network', ({ strapi }) => ({
  async sync(ctx) {
    const authHeader = ctx.request.header.authorization;
    const adminToken = process.env.NODE_NETWORK_SYNC_TOKEN;

    if (!adminToken || authHeader !== `Bearer ${adminToken}`) {
      return ctx.unauthorized('Missing or invalid NODE_NETWORK_SYNC_TOKEN');
    }

    const nodeNetworkId = Number(ctx.params.id);

    if (!Number.isInteger(nodeNetworkId) || nodeNetworkId <= 0) {
      return ctx.badRequest('Invalid node-network id');
    }

    const result = await strapi.service('api::node-network.node-network').syncOfficialDataset(nodeNetworkId);

    ctx.body = {
      ok: true,
      nodeNetworkId,
      result,
    };
  },
}));

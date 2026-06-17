/**
 * favorite-route controller
 */

import { factories } from '@strapi/strapi';

const UID = 'api::favorite-route.favorite-route';

const getAuthenticatedUser = (ctx) => {
  const user = ctx.state.user;

  if (!user) {
    return ctx.unauthorized('You must be logged in.');
  }

  return user;
};

export default factories.createCoreController(UID, ({ strapi }) => ({
  async me(ctx) {
    const user = getAuthenticatedUser(ctx);
    if (!user) return;

    return strapi.documents(UID).findMany({
      filters: {
        user: {
          id: user.id,
        },
      },
      populate: ['route'],
      sort: { createdAt: 'desc' },
    });
  },

  async addMe(ctx) {
    const user = getAuthenticatedUser(ctx);
    if (!user) return;

    const routeId = Number(ctx.params.routeId);
    if (!routeId) {
      return ctx.badRequest('Route id is required.');
    }

    const existing = await strapi.documents(UID).findMany({
      filters: {
        user: {
          id: user.id,
        },
        route: {
          id: routeId,
        },
      },
      limit: 1,
    });

    if (existing[0]) {
      return existing[0];
    }

    return strapi.documents(UID).create({
      data: {
        user: user.id,
        route: routeId,
      },
      populate: ['route'],
    });
  },

  async removeMe(ctx) {
    const user = getAuthenticatedUser(ctx);
    if (!user) return;

    const routeId = Number(ctx.params.routeId);
    if (!routeId) {
      return ctx.badRequest('Route id is required.');
    }

    const existing = await strapi.documents(UID).findMany({
      filters: {
        user: {
          id: user.id,
        },
        route: {
          id: routeId,
        },
      },
      limit: 1,
    });

    if (!existing[0]) {
      return null;
    }

    return strapi.documents(UID).delete({
      documentId: existing[0].documentId,
    });
  },
}));

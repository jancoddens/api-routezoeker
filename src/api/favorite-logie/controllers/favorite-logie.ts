/**
 * favorite-logie controller
 */

import { factories } from '@strapi/strapi';

const UID = 'api::favorite-logie.favorite-logie';

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
      populate: ['partner'],
      sort: { createdAt: 'desc' },
    });
  },

  async addMe(ctx) {
    const user = getAuthenticatedUser(ctx);
    if (!user) return;

    const partnerId = Number(ctx.params.partnerId);
    if (!partnerId) {
      return ctx.badRequest('Partner id is required.');
    }

    const existing = await strapi.documents(UID).findMany({
      filters: {
        user: {
          id: user.id,
        },
        partner: {
          id: partnerId,
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
        partner: partnerId,
      },
      populate: ['partner'],
    });
  },

  async removeMe(ctx) {
    const user = getAuthenticatedUser(ctx);
    if (!user) return;

    const partnerId = Number(ctx.params.partnerId);
    if (!partnerId) {
      return ctx.badRequest('Partner id is required.');
    }

    const existing = await strapi.documents(UID).findMany({
      filters: {
        user: {
          id: user.id,
        },
        partner: {
          id: partnerId,
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

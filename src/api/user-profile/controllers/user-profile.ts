/**
 * user-profile controller
 */

import { factories } from '@strapi/strapi';

const UID = 'api::user-profile.user-profile';

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

    const profiles = await strapi.documents(UID).findMany({
      filters: {
        user: {
          id: user.id,
        },
      },
      populate: ['user'],
      limit: 1,
    });

    return profiles[0] ?? null;
  },

  async upsertMe(ctx) {
    const user = getAuthenticatedUser(ctx);
    if (!user) return;

    const { first_name, last_name, locale } = ctx.request.body?.data ?? ctx.request.body ?? {};
    const profiles = await strapi.documents(UID).findMany({
      filters: {
        user: {
          id: user.id,
        },
      },
      limit: 1,
    });

    const data = {
      first_name,
      last_name,
      locale,
      user: user.id,
    };

    if (profiles[0]) {
      return strapi.documents(UID).update({
        documentId: profiles[0].documentId,
        data,
      });
    }

    return strapi.documents(UID).create({ data });
  },
}));

import type { Core } from '@strapi/strapi';

import { buildRouteAutofill } from './utils/gpx-autofill';

export default {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   *
   * This gives you an opportunity to extend code.
   */
  register(/* { strapi }: { strapi: Core.Strapi } */) {},

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   *
   * This gives you an opportunity to set up your data model,
   * run jobs, or perform some special logic.
   */
  bootstrap({ strapi }: { strapi: Core.Strapi }) {
    const autofillUpdatesInFlight = new Set<number>();

    strapi.db.lifecycles.subscribe({
      models: ['api::route.route'],
      async afterCreate(event) {
        await syncRouteFromGpx(event.result?.id, strapi, autofillUpdatesInFlight);
      },
      async afterUpdate(event) {
        await syncRouteFromGpx(event.result?.id, strapi, autofillUpdatesInFlight);
      },
    });
  },
};

const syncRouteFromGpx = async (
  routeId: number | undefined,
  strapi: Core.Strapi,
  autofillUpdatesInFlight: Set<number>
) => {
  if (!routeId || autofillUpdatesInFlight.has(routeId)) {
    return;
  }

  const route = await strapi.entityService.findOne('api::route.route', routeId, {
    populate: {
      route_start_locations: {
        populate: {
          gpx_file: true,
          address: {
            populate: {
              city: true,
              province: true,
              country: true,
              region: true,
            },
          },
        },
      },
      route_end_location: {
        populate: {
          address: {
            populate: {
              city: true,
              province: true,
              country: true,
              region: true,
            },
          },
        },
      },
      route_waypoints: true,
    },
  });

  const autofillData = await buildRouteAutofill(route as never, strapi);

  if (!autofillData) {
    return;
  }

  autofillUpdatesInFlight.add(routeId);

  try {
    await strapi.entityService.update('api::route.route', routeId, {
      data: autofillData as never,
    });
  } catch (error) {
    strapi.log.error(`GPX autofill failed for route ${routeId}`, error);
  } finally {
    autofillUpdatesInFlight.delete(routeId);
  }
};

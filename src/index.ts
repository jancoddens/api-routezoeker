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
  async bootstrap({ strapi }: { strapi: Core.Strapi }) {
    await configurePasswordResetEmail(strapi);

    const autofillUpdatesInFlight = new Set<number>();

    strapi.db.lifecycles.subscribe({
      models: ['api::route.route'],
      async afterCreate(event) {
        await syncRouteFromGpx(event.result?.id, strapi, autofillUpdatesInFlight);
      },
      async afterUpdate(event) {
        const updateData = event.params?.data;

        if (!shouldRunGpxAutofill(updateData)) {
          return;
        }

        await syncRouteFromGpx(event.result?.id, strapi, autofillUpdatesInFlight);
      },
    });
  },
};

const configurePasswordResetEmail = async (strapi: Core.Strapi) => {
  const frontendUrl = (process.env.FRONTEND_URL || 'https://www.routezoeker.com').replace(/\/+$/, '');
  const fromEmail = process.env.SMTP_FROM || process.env.SMTP_USER || 'info@routezoeker.com';
  const replyTo = process.env.SMTP_REPLY_TO || 'info@routezoeker.com';
  const pluginStore = strapi.store({ type: 'plugin', name: 'users-permissions' });
  const advanced = ((await pluginStore.get({ key: 'advanced' })) || {}) as Record<string, unknown>;
  const email = ((await pluginStore.get({ key: 'email' })) || {}) as Record<string, any>;
  const resetPassword = email.reset_password || {};

  await pluginStore.set({
    key: 'advanced',
    value: {
      ...advanced,
      email_reset_password: `${frontendUrl}/wachtwoord-herstellen`,
    },
  });

  await pluginStore.set({
    key: 'email',
    value: {
      ...email,
      reset_password: {
        ...resetPassword,
        options: {
          ...(resetPassword.options || {}),
          from: {
            name: 'Routezoeker',
            email: fromEmail,
          },
          response_email: replyTo,
          object: 'Stel je Routezoeker-wachtwoord opnieuw in',
          message: `<p>Je vroeg een nieuw wachtwoord aan voor je Routezoeker-account.</p>

<p><a href="<%= URL %>?code=<%= TOKEN %>">Stel een nieuw wachtwoord in</a></p>

<p>Heb je dit niet aangevraagd? Dan mag je deze e-mail negeren.</p>`,
        },
      },
    },
  });
};

const shouldRunGpxAutofill = (updateData: unknown) => {
  if (!updateData || typeof updateData !== 'object') {
    return false;
  }

  const keys = Object.keys(updateData as Record<string, unknown>);

  return keys.includes('route_start_locations');
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
      route_end_locations: {
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
      route_nodes: true,
    },
  });

  const autofillData = await buildRouteAutofill(route as never, strapi);

  if (!autofillData) {
    return;
  }

  if (!hasAutofillChanges(route as Record<string, unknown>, autofillData as Record<string, unknown>)) {
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

const normalizeForComparison = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForComparison(item));
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !['id', '__component'].includes(key))
      .map(([key, nestedValue]) => [key, normalizeForComparison(nestedValue)] as const)
      .sort(([left], [right]) => left.localeCompare(right));

    return Object.fromEntries(entries);
  }

  return value;
};

const hasAutofillChanges = (
  route: Record<string, unknown>,
  autofillData: Record<string, unknown>
) => {
  const currentSubset = {
    title: route.title,
    excerpt: route.excerpt,
    route_geometry: route.route_geometry,
    route_start_locations: route.route_start_locations,
    route_end_locations: route.route_end_locations,
    route_nodes: route.route_nodes,
  };

  return (
    JSON.stringify(normalizeForComparison(currentSubset)) !==
    JSON.stringify(normalizeForComparison(autofillData))
  );
};

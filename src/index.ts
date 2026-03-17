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
    const featuredCitySyncsInFlight = new Set<number>();

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

    strapi.db.lifecycles.subscribe({
      models: ['api::city.city'],
      async afterCreate(event) {
        await syncFeaturedCityLocationThemePage(
          event.result?.id,
          strapi,
          featuredCitySyncsInFlight
        );
      },
      async afterUpdate(event) {
        await syncFeaturedCityLocationThemePage(
          event.result?.id,
          strapi,
          featuredCitySyncsInFlight
        );
      },
    });

    void backfillFeaturedCityLocationThemePages(strapi, featuredCitySyncsInFlight);
  },
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
    route_end_location: route.route_end_location,
    route_nodes: route.route_nodes,
  };

  return (
    JSON.stringify(normalizeForComparison(currentSubset)) !==
    JSON.stringify(normalizeForComparison(autofillData))
  );
};

const backfillFeaturedCityLocationThemePages = async (
  strapi: Core.Strapi,
  featuredCitySyncsInFlight: Set<number>
) => {
  try {
    const featuredCities = await strapi.entityService.findMany('api::city.city', {
      filters: {
        featured: true,
      },
      fields: ['id'],
      locale: 'all',
    });

    for (const city of featuredCities as Array<{ id?: number }>) {
      await syncFeaturedCityLocationThemePage(city.id, strapi, featuredCitySyncsInFlight);
    }
  } catch (error) {
    strapi.log.error('Featured city location-theme-page backfill failed', error);
  }
};

const syncFeaturedCityLocationThemePage = async (
  cityId: number | undefined,
  strapi: Core.Strapi,
  featuredCitySyncsInFlight: Set<number>
) => {
  if (!cityId || featuredCitySyncsInFlight.has(cityId)) {
    return;
  }

  featuredCitySyncsInFlight.add(cityId);

  try {
    const city = await strapi.entityService.findOne('api::city.city', cityId, {
      fields: ['id', 'name', 'slug', 'featured', 'locale'],
      populate: {
        country: {
          fields: ['id'],
        },
        province: {
          fields: ['id'],
        },
        region: {
          fields: ['id'],
        },
      },
    });

    if (!city || !(city as { featured?: boolean }).featured) {
      return;
    }

    const typedCity = city as {
      id: number;
      name?: string;
      slug?: string;
      locale?: string;
      country?: { id: number } | null;
      province?: { id: number } | null;
      region?: { id: number } | null;
    };

    if (!typedCity.name || !typedCity.slug) {
      return;
    }

    const defaultThemeId = await ensureDefaultLocationTheme(strapi, typedCity.locale);

    const existingPages = await strapi.entityService.findMany(
      'api::location-theme-page.location-theme-page',
      {
        filters: {
          city: {
            id: typedCity.id,
          },
        },
        fields: ['id'],
        populate: {
          theme: {
            fields: ['id'],
          },
          country: {
            fields: ['id'],
          },
          province: {
            fields: ['id'],
          },
          region: {
            fields: ['id'],
          },
          city: {
            fields: ['id'],
          },
        },
        locale: typedCity.locale,
        limit: 1,
      }
    );

    const desiredData = {
      title: typedCity.name,
      slug: typedCity.slug,
      city: typedCity.id,
      country: typedCity.country?.id,
      province: typedCity.province?.id,
      region: typedCity.region?.id,
      ...(defaultThemeId ? { theme: defaultThemeId } : {}),
    };

    if (Array.isArray(existingPages) && existingPages.length > 0) {
      const existingPage = existingPages[0] as {
        id: number;
        theme?: { id: number } | null;
        country?: { id: number } | null;
        province?: { id: number } | null;
        region?: { id: number } | null;
        city?: { id: number } | null;
      };

      const updateData: Record<string, unknown> = {};

      updateData.title = typedCity.name;
      updateData.slug = typedCity.slug;

      if (existingPage.city?.id !== typedCity.id) {
        updateData.city = typedCity.id;
      }
      if ((existingPage.country?.id ?? null) !== (typedCity.country?.id ?? null)) {
        updateData.country = typedCity.country?.id ?? null;
      }
      if ((existingPage.province?.id ?? null) !== (typedCity.province?.id ?? null)) {
        updateData.province = typedCity.province?.id ?? null;
      }
      if ((existingPage.region?.id ?? null) !== (typedCity.region?.id ?? null)) {
        updateData.region = typedCity.region?.id ?? null;
      }
      if (defaultThemeId && !existingPage.theme?.id) {
        updateData.theme = defaultThemeId;
      }

      if (Object.keys(updateData).length > 0) {
        await strapi.entityService.update('api::location-theme-page.location-theme-page', existingPage.id, {
          data: updateData as never,
          locale: typedCity.locale,
        });
      }

      return;
    }

    await strapi.entityService.create('api::location-theme-page.location-theme-page', {
      data: desiredData as never,
      locale: typedCity.locale,
    });
  } catch (error) {
    strapi.log.error(`Featured city sync failed for city ${cityId}`, error);
  } finally {
    featuredCitySyncsInFlight.delete(cityId);
  }
};

const ensureDefaultLocationTheme = async (strapi: Core.Strapi, locale?: string) => {
  const existingThemes = await strapi.entityService.findMany('api::theme.theme', {
    filters: {
      $or: [{ slug: { $eq: 'wandelen' } }, { title: { $eq: 'Wandelen' } }],
    },
    fields: ['id'],
    locale,
    limit: 1,
  });

  const existingTheme = Array.isArray(existingThemes)
    ? (existingThemes[0] as { id?: number } | undefined)
    : undefined;

  if (existingTheme?.id) {
    return existingTheme.id;
  }

  const createdTheme = (await strapi.entityService.create('api::theme.theme', {
    data: {
      title: 'Wandelen',
      slug: 'wandelen',
      publishedAt: new Date().toISOString(),
    } as never,
    locale,
  })) as { id?: number };

  return createdTheme.id;
};

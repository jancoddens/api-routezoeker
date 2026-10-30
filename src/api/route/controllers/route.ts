/**
 * route controller
 */

import { factories } from '@strapi/strapi';

type StartLocation = {
  id: number;
  surface_percentage_hard?: number | null;
  gpx_file?: { url?: string } | null;
};

export default factories.createCoreController('api::route.route', ({ strapi }) => ({
  // POST /api/routes/:documentId/surface-percentage
  // body: { percentage: number (1-100), gpxUrl: string }
  //
  // Zet surface_percentage_hard van de eerste startlocatie (draft én
  // gepubliceerde versie), maar enkel als:
  //  - de meegegeven GPX echt bij die startlocatie hoort, en
  //  - het veld nog leeg is (null of 0 = "niet gemeten").
  // Er wordt rechtstreeks op de component-rij geschreven, zodat de rest van de
  // route (GPX, geometrie, andere startlocaties, ...) onaangeroerd blijft.
  async setSurfacePercentage(ctx) {
    const documentId = String(ctx.params.documentId || '').trim();
    const body = (ctx.request.body || {}) as { percentage?: unknown; gpxUrl?: unknown };
    const percentage = Math.round(Number(body.percentage));
    const gpxUrl = typeof body.gpxUrl === 'string' ? body.gpxUrl.trim() : '';

    if (!documentId || !gpxUrl || !Number.isFinite(percentage) || percentage < 1 || percentage > 100) {
      return ctx.badRequest('documentId, gpxUrl en percentage (1-100) zijn verplicht');
    }

    const versions = (await strapi.db.query('api::route.route').findMany({
      where: { documentId },
      populate: { route_start_locations: { populate: { gpx_file: true } } },
    })) as Array<{ id: number; locale?: string; route_start_locations?: StartLocation[] }>;

    if (!versions.length) {
      return ctx.notFound('Route niet gevonden');
    }

    let matched = false;
    let updated = 0;

    for (const version of versions) {
      const first = version.route_start_locations?.[0];
      const fileUrl = first?.gpx_file?.url;

      if (!first || !fileUrl || !gpxUrl.endsWith(fileUrl)) {
        continue;
      }

      matched = true;

      if (typeof first.surface_percentage_hard === 'number' && first.surface_percentage_hard > 0) {
        continue;
      }

      await strapi.db.query('route.route-start-location').update({
        where: { id: first.id },
        data: { surface_percentage_hard: percentage },
      });
      updated += 1;
    }

    if (!matched) {
      return ctx.badRequest('Deze GPX hoort niet bij de eerste startlocatie van de route');
    }

    ctx.body = { ok: true, updated };
  },
}));

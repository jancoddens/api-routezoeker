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
  // POST /api/routes/:documentId/view
  //
  // Telt 1 weergave bij (draft- en gepubliceerde versie, alle talen) en
  // herberekent popularity_score met dezelfde formule als lifecycles.ts.
  // Schrijft rechtstreeks via knex: geen lifecycles en geen webhooks. Een
  // weergave is geen inhoudelijke wijziging, dus de cache van de site mag
  // daarvoor niet vervallen. De ophoging zelf is atomair (view_count + 1 in
  // SQL), zodat gelijktijdige bezoeken elkaar niet meer overschrijven.
  async registerView(ctx) {
    const documentId = String(ctx.params.documentId || '').trim();
    if (!documentId) {
      return ctx.badRequest('documentId is verplicht');
    }

    const knex = strapi.db.connection;
    const updated = await knex('routes')
      .where({ document_id: documentId })
      .increment('view_count', 1);

    if (!updated) {
      return ctx.notFound('Route niet gevonden');
    }

    // NULL-tellers (nooit bekeken) worden door increment niet opgehoogd.
    await knex('routes')
      .where({ document_id: documentId })
      .whereNull('view_count')
      .update({ view_count: 1 });

    const rows = (await knex('routes')
      .where({ document_id: documentId })
      .select('id', 'view_count', 'gpx_downloads', 'favorite_count', 'published_at')) as Array<{
      id: number;
      view_count: number | null;
      gpx_downloads: number | null;
      favorite_count: number | null;
      published_at: string | Date | null;
    }>;

    for (const row of rows) {
      const base =
        Number(row.view_count || 0) +
        Number(row.gpx_downloads || 0) * 3 +
        Number(row.favorite_count || 0) * 5 +
        1;
      const published = row.published_at ? new Date(row.published_at) : new Date();
      const ageHours = (Date.now() - published.getTime()) / 3600000;
      await knex('routes')
        .where({ id: row.id })
        .update({ popularity_score: Math.log10(base) + ageHours / 48 });
    }

    const views = Math.max(0, ...rows.map((row) => Number(row.view_count || 0)));
    ctx.body = { ok: true, views };
  },

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

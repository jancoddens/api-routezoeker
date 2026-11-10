import type { Core } from '@strapi/strapi';

import { buildRouteAutofill } from './utils/gpx-autofill';
import { ensurePartnerInviteCodes } from './utils/partner-invite';
import { createInvoice, ensureInvoiceSetup, getOverview, renderPdf, sendInvoiceMail, setSubscriptionOnline, updateStatus } from './utils/partner-invoicing';
import { ensureProspectSetup, MAX_PER_BATCH, queueMails, sendTestMail, type MailKind } from './utils/prospect-mailer';

export default {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   *
   * This gives you an opportunity to extend code.
   */
  register({ strapi }: { strapi: Core.Strapi }) {
    // Admin-routes voor de knoppen "Verstuur eerste mail" / "Verstuur opvolgmail"
    // / "Testmail naar mij" in de lijst Prospects (zie src/admin/app.tsx).
    // Enkel bereikbaar voor ingelogde admin-gebruikers.
    const readKind = (value: unknown): MailKind => (value === 'followup' ? 'followup' : 'first');
    strapi.server.routes({
      type: 'admin',
      prefix: '/prospect-mailer',
      routes: [
        {
          method: 'POST',
          path: '/send',
          handler: async (ctx: any) => {
            const { documentIds, kind } = ctx.request.body || {};
            if (!Array.isArray(documentIds) || !documentIds.length) return ctx.badRequest('Selecteer minstens één prospect');
            if (documentIds.length > MAX_PER_BATCH) return ctx.badRequest(`Maximaal ${MAX_PER_BATCH} prospects per keer`);
            ctx.body = await queueMails(strapi, documentIds.map(String), readKind(kind));
          },
          config: { policies: ['admin::isAuthenticatedAdmin'] },
        },
        {
          method: 'POST',
          path: '/test',
          handler: async (ctx: any) => {
            const { documentId, kind } = ctx.request.body || {};
            const to = ctx.state?.user?.email;
            if (!documentId || !to) return ctx.badRequest('Geen prospect of geen e-mailadres voor jouw account');
            ctx.body = await sendTestMail(strapi, String(documentId), readKind(kind), to);
          },
          config: { policies: ['admin::isAuthenticatedAdmin'] },
        },
      ],
    } as any);

    // Facturatie partnerabonnementen (menu "Facturen", zie src/admin/pages/Invoices.tsx).
    const adminOnly = { policies: ['admin::isAuthenticatedAdmin'] };
    const guard = (fn: (ctx: any) => Promise<any>) => async (ctx: any) => {
      try {
        ctx.body = await fn(ctx);
      } catch (error: any) {
        strapi.log.error(`Facturatie: ${error?.message}`);
        ctx.badRequest(error?.message || 'Er ging iets mis');
      }
    };
    strapi.server.routes({
      type: 'admin',
      prefix: '/partner-invoicing',
      routes: [
        { method: 'GET', path: '/overview', handler: guard(() => getOverview(strapi)), config: adminOnly },
        {
          method: 'POST',
          path: '/invoices',
          handler: guard((ctx) => {
            const b = ctx.request.body || {};
            if (!b.subscriptionDocumentId) throw new Error('Geen abonnement gekozen');
            return createInvoice(strapi, {
              subscriptionDocumentId: String(b.subscriptionDocumentId),
              price: b.price != null && b.price !== '' ? Number(b.price) : undefined,
              discount: b.discount != null && b.discount !== '' ? Number(b.discount) : undefined,
              description: b.description ? String(b.description) : undefined,
              periodStart: /^\d{4}-\d{2}-\d{2}$/.test(String(b.periodStart || '')) ? String(b.periodStart) : undefined,
            });
          }),
          config: adminOnly,
        },
        {
          method: 'GET',
          path: '/invoices/:id/pdf',
          handler: guard(async (ctx) => {
            const { buffer, filename } = await renderPdf(strapi, Number(ctx.params.id));
            return { filename, base64: buffer.toString('base64') };
          }),
          config: adminOnly,
        },
        {
          method: 'POST',
          path: '/invoices/:id/send',
          handler: guard((ctx) => {
            const b = ctx.request.body || {};
            const kind = b.kind === 'reminder' ? 'reminder' : 'invoice';
            if (b.test) {
              const me = ctx.state?.user?.email;
              if (!me) throw new Error('Geen e-mailadres voor jouw account');
              return sendInvoiceMail(strapi, Number(ctx.params.id), { kind, testTo: me });
            }
            return sendInvoiceMail(strapi, Number(ctx.params.id), { kind, to: b.to ? String(b.to).trim() : undefined });
          }),
          config: adminOnly,
        },
        {
          method: 'POST',
          path: '/invoices/:id/status',
          handler: guard((ctx) => updateStatus(strapi, Number(ctx.params.id), ctx.request.body || {})),
          config: adminOnly,
        },
        {
          method: 'POST',
          path: '/subscriptions/:documentId/online',
          handler: guard((ctx) => setSubscriptionOnline(strapi, String(ctx.params.documentId), ctx.request.body?.online === true)),
          config: adminOnly,
        },
      ],
    } as any);
  },

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   *
   * This gives you an opportunity to set up your data model,
   * run jobs, or perform some special logic.
   */
  async bootstrap({ strapi }: { strapi: Core.Strapi }) {
    await configurePasswordResetEmail(strapi);
    await ensurePartnerDashboardPermissions(strapi);
    await ensureReviewPermissions(strapi);
    await ensurePartnerInviteCodes(strapi);
    await ensureProspectSetup(strapi);
    await ensureInvoiceSetup(strapi);

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

// Het logie-dashboard (/api/me/partners/...) moet bruikbaar zijn voor elke
// aangemelde gebruiker; de controller controleert zelf of de gebruiker
// manager is van de logie. Zo hoeft niemand dit manueel aan te vinken onder
// Users & Permissions > Roles > Authenticated.
const PARTNER_DASHBOARD_ACTIONS = [
  'api::partner.partner.myPartners',
  'api::partner.partner.myPartner',
  'api::partner.partner.updateMyPartner',
  'api::partner.partner.uploadMyPartnerMedia',
  'api::partner.partner.claimPartnerInvite',
];

// Reviews: aangemelde gebruikers mogen een review indienen, iedereen mag de
// goedgekeurde reviews van een route lezen.
const ROLE_ACTIONS: Record<string, string[]> = {
  authenticated: ['api::review.review.submitMe', 'api::review.review.listFor'],
  public: ['api::review.review.listFor'],
};

const ensureReviewPermissions = async (strapi: Core.Strapi) => {
  try {
    for (const [type, actions] of Object.entries(ROLE_ACTIONS)) {
      const role = await strapi.db
        .query('plugin::users-permissions.role')
        .findOne({ where: { type }, select: ['id'] });
      if (!role) continue;

      const existing = await strapi.db.query('plugin::users-permissions.permission').findMany({
        where: { role: { id: role.id }, action: { $in: actions } },
        select: ['action'],
      });
      const existingActions = new Set(existing.map((permission: { action: string }) => permission.action));

      for (const action of actions) {
        if (!existingActions.has(action)) {
          await strapi.db.query('plugin::users-permissions.permission').create({
            data: { action, role: role.id },
          });
        }
      }
    }
  } catch (error) {
    strapi.log.error('[review] rechten konden niet gezet worden', error);
  }
};

const ensurePartnerDashboardPermissions = async (strapi: Core.Strapi) => {
  try {
    const role = await strapi.db
      .query('plugin::users-permissions.role')
      .findOne({ where: { type: 'authenticated' }, select: ['id'] });

    if (!role) return;

    const existing = await strapi.db.query('plugin::users-permissions.permission').findMany({
      where: { role: { id: role.id }, action: { $in: PARTNER_DASHBOARD_ACTIONS } },
      select: ['action'],
    });
    const existingActions = new Set(existing.map((permission: { action: string }) => permission.action));

    for (const action of PARTNER_DASHBOARD_ACTIONS) {
      if (!existingActions.has(action)) {
        await strapi.db.query('plugin::users-permissions.permission').create({
          data: { action, role: role.id },
        });
      }
    }
  } catch (error) {
    strapi.log.error('[partner-dashboard] rechten voor Authenticated konden niet gezet worden', error);
  }
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

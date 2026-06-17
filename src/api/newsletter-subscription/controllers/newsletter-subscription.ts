/**
 * newsletter-subscription controller
 */

import { createHash } from 'crypto';
import { factories } from '@strapi/strapi';

const UID = 'api::newsletter-subscription.newsletter-subscription';

const getRequestIpHash = (ctx) => {
  const ip = ctx.request.ip;

  if (!ip) {
    return undefined;
  }

  return createHash('sha256').update(ip).digest('hex');
};

export default factories.createCoreController(UID, ({ strapi }) => ({
  async subscribe(ctx) {
    const body = ctx.request.body?.data ?? ctx.request.body ?? {};
    const user = ctx.state.user;
    const email = String(body.email ?? user?.email ?? '').trim().toLowerCase();

    if (!email) {
      return ctx.badRequest('Email is required.');
    }

    const source = ['website', 'import', 'admin'].includes(body.source) ? body.source : 'website';
    const existing = await strapi.documents(UID).findMany({
      filters: { email },
      limit: 1,
    });

    const data = {
      email,
      user: user?.id,
      status: 'subscribed' as const,
      source: source as 'website' | 'import' | 'admin',
      consent_at: new Date().toISOString(),
      consent_ip_hash: getRequestIpHash(ctx),
      consent_user_agent: ctx.request.header['user-agent'],
      unsubscribed_at: null,
    };

    if (existing[0]) {
      return strapi.documents(UID).update({
        documentId: existing[0].documentId,
        data,
      });
    }

    return strapi.documents(UID).create({ data });
  },

  async unsubscribe(ctx) {
    const body = ctx.request.body?.data ?? ctx.request.body ?? {};
    const user = ctx.state.user;
    const email = String(body.email ?? user?.email ?? '').trim().toLowerCase();

    if (!email) {
      return ctx.badRequest('Email is required.');
    }

    const existing = await strapi.documents(UID).findMany({
      filters: { email },
      limit: 1,
    });

    if (!existing[0]) {
      return null;
    }

    return strapi.documents(UID).update({
      documentId: existing[0].documentId,
      data: {
        status: 'unsubscribed',
        unsubscribed_at: new Date().toISOString(),
      },
    });
  },
}));

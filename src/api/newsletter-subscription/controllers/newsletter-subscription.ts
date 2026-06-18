/**
 * newsletter-subscription controller
 */

import { createHash, randomBytes } from 'crypto';
import { factories } from '@strapi/strapi';

const UID = 'api::newsletter-subscription.newsletter-subscription';
const CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;

type NewsletterSubscriptionDocument = {
  documentId: string;
  status?: 'pending' | 'subscribed' | 'unsubscribed';
  confirmation_expires_at?: string | Date | null;
};

const getRequestIpHash = (ctx) => {
  const ip = ctx.request.ip;

  if (!ip) {
    return undefined;
  }

  return createHash('sha256').update(ip).digest('hex');
};

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

const getConfirmationUrl = (token: string) => {
  const frontendUrl = (process.env.FRONTEND_URL || 'https://www.routezoeker.com').replace(/\/+$/, '');

  return `${frontendUrl}/nieuwsbrief-bevestigen?token=${encodeURIComponent(token)}`;
};

const sendConfirmationEmail = async (strapi, email: string, token: string) => {
  const confirmationUrl = getConfirmationUrl(token);

  await strapi.plugin('email').service('email').send({
    to: email,
    from: process.env.SMTP_FROM || process.env.SMTP_USER || 'info@routezoeker.com',
    replyTo: process.env.SMTP_REPLY_TO || 'info@routezoeker.com',
    subject: 'Bevestig je inschrijving voor de Routezoeker-nieuwsbrief',
    text: `Bevestig je inschrijving via deze link: ${confirmationUrl}`,
    html: `<p>Bedankt voor je interesse in de Routezoeker-nieuwsbrief.</p>

<p><a href="${confirmationUrl}">Bevestig je inschrijving</a></p>

<p>Deze link is 24 uur geldig. Heb je dit niet aangevraagd? Dan mag je deze e-mail negeren.</p>`,
  });
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
    const current = existing[0];

    if (current?.status === 'subscribed') {
      return {
        ok: true,
        status: 'subscribed',
        message: 'Dit e-mailadres is al ingeschreven.',
      };
    }

    const token = randomBytes(32).toString('hex');
    const now = new Date();
    const data = {
      email,
      user: user?.id,
      status: 'pending' as const,
      source: source as 'website' | 'import' | 'admin',
      consent_at: now.toISOString(),
      consent_ip_hash: getRequestIpHash(ctx),
      consent_user_agent: ctx.request.header['user-agent'],
      confirmation_token_hash: hashToken(token),
      confirmation_expires_at: new Date(now.getTime() + CONFIRMATION_TTL_MS).toISOString(),
      confirmation_sent_at: now.toISOString(),
      confirmed_at: null,
      unsubscribed_at: null,
    };

    if (current) {
      await strapi.documents(UID).update({
        documentId: current.documentId,
        data,
      });
    } else {
      await strapi.documents(UID).create({ data });
    }

    await sendConfirmationEmail(strapi, email, token);

    return {
      ok: true,
      status: 'pending',
      message: 'Controleer je e-mail om je inschrijving te bevestigen.',
    };
  },

  async confirm(ctx) {
    const body = ctx.request.body?.data ?? ctx.request.body ?? {};
    const token = String(body.token ?? '').trim();

    if (!token) {
      return ctx.badRequest('Confirmation token is required.');
    }

    const subscriptions = (await strapi.documents(UID).findMany({
      filters: {
        confirmation_token_hash: hashToken(token),
      } as never,
      limit: 1,
    })) as NewsletterSubscriptionDocument[];
    const subscription = subscriptions[0];

    if (!subscription) {
      return ctx.badRequest('Confirmation token is invalid.');
    }

    const expiresAt = subscription.confirmation_expires_at
      ? new Date(subscription.confirmation_expires_at).getTime()
      : 0;

    if (!expiresAt || expiresAt < Date.now()) {
      return ctx.badRequest('Confirmation token has expired.');
    }

    await strapi.documents(UID).update({
      documentId: subscription.documentId,
      data: {
        status: 'subscribed',
        confirmed_at: new Date().toISOString(),
        confirmation_token_hash: null,
        confirmation_expires_at: null,
      },
    });

    return {
      ok: true,
      status: 'subscribed',
      message: 'Je inschrijving is bevestigd.',
    };
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
        confirmation_token_hash: null,
        confirmation_expires_at: null,
      },
    });
  },
}));

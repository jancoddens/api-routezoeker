import { createHash, randomBytes } from 'crypto';
import { factories } from '@strapi/strapi';

const UID = 'api::account-deletion-request.account-deletion-request';
const CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;

type AccountDeletionRequestDocument = {
  documentId: string;
  email: string;
  confirmation_expires_at?: string | Date | null;
  user?: {
    id?: number;
  } | null;
};

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

const getConfirmationUrl = (token: string) => {
  const frontendUrl = (process.env.FRONTEND_URL || 'https://www.routezoeker.com').replace(/\/+$/, '');

  return `${frontendUrl}/account-verwijderen-bevestigen?token=${encodeURIComponent(token)}`;
};

const sendConfirmationEmail = async (strapi, email: string, token: string) => {
  const confirmationUrl = getConfirmationUrl(token);

  await strapi.plugin('email').service('email').send({
    to: email,
    from: process.env.SMTP_FROM || process.env.SMTP_USER || 'info@routezoeker.com',
    replyTo: process.env.SMTP_REPLY_TO || 'info@routezoeker.com',
    subject: 'Bevestig de verwijdering van je Routezoeker-account',
    text: `Je vroeg om je Routezoeker-account definitief te verwijderen. Bevestig dit via deze link: ${confirmationUrl}\n\nDeze link is 24 uur geldig. Heb je dit niet aangevraagd? Dan mag je deze e-mail negeren.`,
    html: `<p>Je vroeg om je Routezoeker-account definitief te verwijderen.</p>

<p>Wanneer je dit bevestigt, verwijderen we al je accountgegevens, waaronder je profiel, statistieken, wandelgeschiedenis en opgeslagen wandelingen. Dit kan niet ongedaan worden gemaakt.</p>

<p><a href="${confirmationUrl}">Mijn account definitief verwijderen</a></p>

<p>Deze link is 24 uur geldig. Heb je dit niet aangevraagd? Dan mag je deze e-mail negeren en blijft je account behouden.</p>`,
  });
};

const deleteDocumentsForUser = async (strapi, uid: string, userId: number) => {
  const documents = await strapi.documents(uid).findMany({
    filters: {
      user: {
        id: userId,
      },
    },
    limit: 1000,
  });

  for (const document of documents) {
    await strapi.documents(uid).delete({
      documentId: document.documentId,
    });
  }
};

export default factories.createCoreController(UID, ({ strapi }) => ({
  async requestDeletion(ctx) {
    const user = ctx.state.user;

    if (!user) {
      return ctx.unauthorized('You must be logged in.');
    }

    const email = String(user.email ?? '').trim().toLowerCase();

    if (!email) {
      return ctx.badRequest('No email address is linked to this account.');
    }

    const existing = await strapi.documents(UID).findMany({
      filters: {
        user: {
          id: user.id,
        },
      },
      limit: 1,
    });
    const token = randomBytes(32).toString('hex');
    const now = new Date();
    const data = {
      user: user.id,
      email,
      confirmation_token_hash: hashToken(token),
      confirmation_expires_at: new Date(now.getTime() + CONFIRMATION_TTL_MS).toISOString(),
      confirmation_sent_at: now.toISOString(),
    };

    if (existing[0]) {
      await strapi.documents(UID).update({
        documentId: existing[0].documentId,
        data,
      });
    } else {
      await strapi.documents(UID).create({ data });
    }

    await sendConfirmationEmail(strapi, email, token);

    return {
      ok: true,
      message: 'Controleer je e-mail en bevestig daar dat je je account wilt verwijderen.',
    };
  },

  async confirmDeletion(ctx) {
    const body = ctx.request.body?.data ?? ctx.request.body ?? {};
    const token = String(body.token ?? '').trim();

    if (!token) {
      return ctx.badRequest('Confirmation token is required.');
    }

    const requests = (await strapi.documents(UID).findMany({
      filters: {
        confirmation_token_hash: hashToken(token),
      } as never,
      populate: ['user'],
      limit: 1,
    })) as AccountDeletionRequestDocument[];
    const deletionRequest = requests[0];

    if (!deletionRequest) {
      return ctx.badRequest('Confirmation token is invalid.');
    }

    const expiresAt = deletionRequest.confirmation_expires_at
      ? new Date(deletionRequest.confirmation_expires_at).getTime()
      : 0;

    if (!expiresAt || expiresAt < Date.now()) {
      await strapi.documents(UID).delete({
        documentId: deletionRequest.documentId,
      });
      return ctx.badRequest('Confirmation token has expired.');
    }

    const userId = Number(deletionRequest.user?.id);

    if (!Number.isInteger(userId) || userId <= 0) {
      await strapi.documents(UID).delete({
        documentId: deletionRequest.documentId,
      });
      return ctx.badRequest('The account no longer exists.');
    }

    await deleteDocumentsForUser(strapi, 'api::favorite-route.favorite-route', userId);
    await deleteDocumentsForUser(strapi, 'api::favorite-logie.favorite-logie', userId);
    await deleteDocumentsForUser(strapi, 'api::user-profile.user-profile', userId);

    const newsletterSubscriptions = await strapi.documents('api::newsletter-subscription.newsletter-subscription').findMany({
      filters: {
        $or: [
          {
            user: {
              id: userId,
            },
          },
          {
            email: deletionRequest.email,
          },
        ],
      } as never,
      limit: 1000,
    });

    for (const subscription of newsletterSubscriptions) {
      await strapi.documents('api::newsletter-subscription.newsletter-subscription').delete({
        documentId: subscription.documentId,
      });
    }

    await strapi.documents(UID).delete({
      documentId: deletionRequest.documentId,
    });
    await strapi.db.query('plugin::users-permissions.user').delete({
      where: {
        id: userId,
      },
    });

    return {
      ok: true,
      message: 'Je account en accountgegevens zijn definitief verwijderd.',
    };
  },
}));

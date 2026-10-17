import crypto from 'node:crypto';
import type { Core } from '@strapi/strapi';

/**
 * Uitnodigingslinks voor logie-uitbaters.
 *
 * Elke partner heeft een geheime `invite_code` en een kant-en-klare
 * `invite_url` (beide private: niet zichtbaar via de publieke API, wel in de
 * admin). Wie de link opent kan een account aanmaken of inloggen en wordt dan
 * meteen als manager aan de partner gekoppeld. Na gebruik krijgt de partner
 * automatisch een nieuwe code, zodat een link maar één keer werkt.
 *
 * Basis-URL: PARTNER_INVITE_BASE_URL, anders FRONTEND_URL.
 */

const PARTNER_UID = 'api::partner.partner';

export const generateInviteCode = () => crypto.randomBytes(18).toString('base64url');

export const getInviteBaseUrl = () =>
  (process.env.PARTNER_INVITE_BASE_URL || process.env.FRONTEND_URL || 'https://www.routezoeker.com').replace(
    /\/+$/,
    '',
  );

export const buildInviteUrl = (code: string) => `${getInviteBaseUrl()}/logie-koppelen?code=${code}`;

/** Zet voor één partner (alle locales, draft + published) een nieuwe code. */
export const rotateInviteCode = async (strapi: Core.Strapi, documentId: string) => {
  const code = generateInviteCode();
  await strapi.db.query(PARTNER_UID).updateMany({
    where: { documentId },
    data: { invite_code: code, invite_url: buildInviteUrl(code) },
  });
  return code;
};

/**
 * Bij het opstarten: elke partner een code geven en de invite_url gelijk
 * trekken met de huidige basis-URL (handig na de domeinwissel).
 */
export const ensurePartnerInviteCodes = async (strapi: Core.Strapi) => {
  try {
    const rows = await strapi.db.query(PARTNER_UID).findMany({
      select: ['documentId', 'invite_code', 'invite_url'],
    });

    const byDocument = new Map<string, { codes: Set<string>; urls: Set<string> }>();
    rows.forEach((row: any) => {
      const entry = byDocument.get(row.documentId) ?? { codes: new Set(), urls: new Set() };
      entry.codes.add(row.invite_code || '');
      entry.urls.add(row.invite_url || '');
      byDocument.set(row.documentId, entry);
    });

    for (const [documentId, { codes, urls }] of byDocument) {
      const [code] = [...codes];
      const consistent = codes.size === 1 && Boolean(code);
      if (!consistent) {
        await rotateInviteCode(strapi, documentId);
      } else if (urls.size !== 1 || !urls.has(buildInviteUrl(code))) {
        await strapi.db.query(PARTNER_UID).updateMany({
          where: { documentId },
          data: { invite_url: buildInviteUrl(code) },
        });
      }
    }
  } catch (error) {
    strapi.log.error('[partner-invite] uitnodigingscodes konden niet aangemaakt worden', error);
  }
};

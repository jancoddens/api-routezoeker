/**
 * Aanmelden als horecapartner (zie routes/horeca-signup.ts).
 *
 * Een aanmelding komt NIET meteen online: de partner en het abonnement worden
 * als concept aangemaakt (abonnement met status "draft"). Jan krijgt een mail,
 * vult coördinaten/foto's aan, stuurt de proforma en publiceert na betaling.
 */

import type { Core } from '@strapi/strapi';
import { getHorecaPackagePrices, HORECA_PACKAGES } from '../../../utils/horeca-packages';

const PARTNER_UID = 'api::partner.partner';
const SUBSCRIPTION_UID = 'api::partner-subscription.partner-subscription';
const CITY_UID = 'api::city.city';
const LOCALE = process.env.STRAPI_LOCALE || 'nl';

const HORECA_TYPES = ['Café', 'Restaurant', 'Brasserie', 'Bar', 'Tearoom', 'Frituur', 'IJssalon', 'Popup bar'];

// Eenvoudige rem tegen spam: max. 10 aanmeldingen per IP per uur.
const recentByIp = new Map<string, number[]>();
const isRateLimited = (ip: string) => {
  const now = Date.now();
  const hits = (recentByIp.get(ip) || []).filter((time) => now - time < 60 * 60 * 1000);
  hits.push(now);
  recentByIp.set(ip, hits);
  return hits.length > 10;
};

const text = (value: unknown, max = 255) =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';

const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);

const slugify = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' en ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'horeca';

const normalizeWebsite = (value: string) => {
  if (!value) return '';
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withProtocol);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : '';
  } catch {
    return '';
  }
};

export default ({ strapi }: { strapi: Core.Strapi }) => {
  const uniqueSlug = async (base: string) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const existing = await strapi.db.query(PARTNER_UID).findOne({ where: { slug: candidate }, select: ['id'] });
      if (!existing) return candidate;
    }
    return `${base}-${Date.now().toString(36)}`;
  };

  const findCityDocumentId = async (name: string, postalCode: string) => {
    if (!name && !postalCode) return null;
    const where: Record<string, unknown> = { locale: LOCALE };
    if (name) where.name = { $eqi: name };
    else where.postal_code = postalCode;
    const city = await strapi.db.query(CITY_UID).findOne({ where, select: ['documentId'] });
    return city?.documentId ?? null;
  };

  const notifyAdmin = async (lines: string[], name: string) => {
    const to = process.env.PARTNER_EDIT_NOTIFY_EMAIL || 'info@routezoeker.com';
    try {
      await strapi.plugin('email').service('email').send({
        to,
        subject: `Nieuwe horeca-aanmelding: ${name}`,
        text: lines.join('\n'),
      });
    } catch (error) {
      strapi.log.warn('[horeca-signup] notificatiemail kon niet verstuurd worden', error);
    }
  };

  return {
    async prices(ctx) {
      const prices = await getHorecaPackagePrices(strapi);
      ctx.set('Cache-Control', 'public, max-age=300');
      ctx.body = { packages: HORECA_PACKAGES.map((name) => ({ name, price: prices[name] })) };
    },

    async create(ctx) {
      const body = (ctx.request.body || {}) as Record<string, unknown>;

      // Honeypot: echte bezoekers zien dit veld niet.
      if (text(body.company_website)) {
        ctx.body = { ok: true };
        return;
      }

      // Achter Cloudflare is ctx.request.ip het IP van Cloudflare, niet van de bezoeker.
      const clientIp = String(ctx.get('cf-connecting-ip') || ctx.request.ip || 'onbekend');
      if (isRateLimited(clientIp)) {
        return ctx.tooManyRequests('Te veel aanmeldingen. Probeer het later opnieuw.');
      }

      const pkg = text(body.package);
      const name = text(body.name, 120);
      const type = text(body.type);
      const contactName = text(body.contact_name, 120);
      const email = text(body.email, 160).toLowerCase();
      const phone = text(body.phone, 40);
      const street = text(body.street, 120);
      const houseNumber = text(body.house_number, 20);
      const postalCode = text(body.postal_code, 12);
      const cityName = text(body.city, 80);
      const website = normalizeWebsite(text(body.website, 300));
      const vat = text(body.vat, 40);
      const message = text(body.message, 2000);

      if (!HORECA_PACKAGES.includes(pkg as (typeof HORECA_PACKAGES)[number])) {
        return ctx.badRequest('Kies een pakket.');
      }
      if (!name || !contactName || !email || !cityName) {
        return ctx.badRequest('Vul alle verplichte velden in.');
      }
      if (!isEmail(email)) {
        return ctx.badRequest('Dit e-mailadres lijkt niet te kloppen.');
      }
      if (body.accept_terms !== true) {
        return ctx.badRequest('Ga akkoord met de voorwaarden.');
      }

      const prices = await getHorecaPackagePrices(strapi);
      const cityDocumentId = await findCityDocumentId(cityName, postalCode);
      const slug = await uniqueSlug(slugify(name));

      const partner = await strapi.documents(PARTNER_UID).create({
        locale: LOCALE,
        data: {
          name,
          slug,
          universe: 'Horeca',
          type: HORECA_TYPES.includes(type) ? type : null,
          website_url: website || null,
          phone: phone || null,
          email,
          address: {
            street: street || null,
            house_number: houseNumber || null,
            postal_code: postalCode || null,
            ...(cityDocumentId ? { city: cityDocumentId } : {}),
          },
        } as any,
      });

      const subscription = await strapi.documents(SUBSCRIPTION_UID).create({
        data: {
          partner: partner.documentId,
          status_subscription: 'draft',
          package: pkg,
          price: prices[pkg as (typeof HORECA_PACKAGES)[number]] ?? null,
          contact_email: email,
          contact_phone: phone || null,
          billing_name: contactName,
          billing_vat: vat || null,
          notes: [
            `Aangemeld via /horeca-aanmelden op ${new Date().toISOString().slice(0, 10)}.`,
            !cityDocumentId ? `Gemeente "${cityName}" niet gevonden: koppel ze zelf.` : '',
            message ? `Bericht: ${message}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        } as any,
      });

      await notifyAdmin(
        [
          `Nieuwe horeca-aanmelding via Routezoeker.com`,
          '',
          `Zaak: ${name}${type ? ` (${type})` : ''}`,
          `Pakket: ${pkg} – € ${prices[pkg as (typeof HORECA_PACKAGES)[number]] ?? '?'} per jaar`,
          `Contact: ${contactName} – ${email}${phone ? ` – ${phone}` : ''}`,
          `Adres: ${[street, houseNumber].filter(Boolean).join(' ')}, ${postalCode} ${cityName}`,
          website ? `Website: ${website}` : '',
          vat ? `Btw: ${vat}` : '',
          message ? `\nBericht:\n${message}` : '',
          '',
          'Partner en abonnement staan als concept in Strapi. Nog te doen:',
          '- coördinaten (latitude/longitude) invullen in het adres, anders verschijnt de zaak niet bij de routes',
          '- foto\'s, tekst, openingsuren en voorzieningen aanvullen (of laten aanvullen via Mijn logies)',
          '- proforma sturen, en na betaling: abonnement op "active" zetten en beide publiceren',
          '',
          `Partner: ${partner.documentId} · Abonnement: ${subscription.documentId}`,
        ].filter((line) => line !== ''),
        name,
      );

      ctx.body = { ok: true };
    },
  };
};

/**
 * Aanmelden als partner via de website (/logie-aanmelden en /horeca-aanmelden).
 * Beide pagina's hebben hun eigen endpoint en pakketten; de logica is gedeeld.
 *
 * Een aanmelding komt NIET meteen online: partner en abonnement worden als
 * concept aangemaakt (abonnement met status "draft"). Jan krijgt een mail,
 * vult coördinaten/foto's aan, stuurt de proforma en publiceert na betaling.
 */

import type { Core } from '@strapi/strapi';
import { getPackagePrices, type PricedPackage } from './horeca-packages';

const PARTNER_UID = 'api::partner.partner';
const SUBSCRIPTION_UID = 'api::partner-subscription.partner-subscription';
const CITY_UID = 'api::city.city';
const LOCALE = process.env.STRAPI_LOCALE || 'nl';

export type SignupConfig = {
  universe: 'Logie' | 'Horeca';
  /** Woord in mails en meldingen, bv. "logie" of "horecazaak". */
  label: string;
  page: string;
  packages: readonly PricedPackage[];
  types: readonly string[];
};

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
    .slice(0, 80) || 'partner';

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

export const createSignupController = (strapi: Core.Strapi, config: SignupConfig) => {
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
        subject: `Nieuwe aanmelding (${config.label}): ${name}`,
        text: lines.join('\n'),
      });
    } catch (error) {
      strapi.log.warn(`[${config.page}] notificatiemail kon niet verstuurd worden`, error);
    }
  };

  return {
    async prices(ctx: any) {
      const prices = await getPackagePrices(strapi);
      ctx.set('Cache-Control', 'public, max-age=300');
      ctx.body = { packages: config.packages.map((name) => ({ name, price: prices[name] })) };
    },

    async create(ctx: any) {
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

      const pkg = text(body.package) as PricedPackage;
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

      if (!config.packages.includes(pkg)) return ctx.badRequest('Kies een pakket.');
      if (!name || !contactName || !email || !cityName) return ctx.badRequest('Vul alle verplichte velden in.');
      if (!isEmail(email)) return ctx.badRequest('Dit e-mailadres lijkt niet te kloppen.');
      if (body.accept_terms !== true) return ctx.badRequest('Ga akkoord met de voorwaarden.');

      const prices = await getPackagePrices(strapi);
      const cityDocumentId = await findCityDocumentId(cityName, postalCode);
      const slug = await uniqueSlug(slugify(name));

      const partner = await strapi.documents(PARTNER_UID).create({
        locale: LOCALE,
        data: {
          name,
          slug,
          universe: config.universe,
          type: config.types.includes(type) ? type : null,
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
          price: prices[pkg] ?? null,
          contact_email: email,
          contact_phone: phone || null,
          billing_name: contactName,
          billing_vat: vat || null,
          notes: [
            `Aangemeld via /${config.page} op ${new Date().toISOString().slice(0, 10)}.`,
            !cityDocumentId ? `Gemeente "${cityName}" niet gevonden: koppel ze zelf.` : '',
            message ? `Bericht: ${message}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        } as any,
      });

      await notifyAdmin(
        [
          `Nieuwe aanmelding via Routezoeker.com/${config.page}`,
          '',
          `${config.label.charAt(0).toUpperCase()}${config.label.slice(1)}: ${name}${type ? ` (${type})` : ''}`,
          `Pakket: ${pkg} – € ${prices[pkg] ?? '?'} per jaar (excl. btw)`,
          `Contact: ${contactName} – ${email}${phone ? ` – ${phone}` : ''}`,
          `Adres: ${[street, houseNumber].filter(Boolean).join(' ')}, ${postalCode} ${cityName}`,
          website ? `Website: ${website}` : '',
          vat ? `Btw: ${vat}` : '',
          message ? `\nBericht:\n${message}` : '',
          '',
          'Partner en abonnement staan als concept in Strapi. Nog te doen:',
          '- coördinaten (latitude/longitude) invullen in het adres, anders verschijnt de partner niet bij de routes',
          "- foto's en tekst aanvullen (of laten aanvullen via Mijn logies)",
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

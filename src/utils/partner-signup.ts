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

  type SignupMail = {
    name: string;
    type: string;
    pkg: string;
    price: number | undefined;
    contactName: string;
    email: string;
    phone: string;
    street: string;
    houseNumber: string;
    postalCode: string;
    cityName: string;
    cityLinked: boolean;
    website: string;
    vat: string;
    message: string;
    partnerId: string;
    subscriptionId: string;
  };

  const escapeHtml = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const adminUrl = (uid: string, documentId: string, localized: boolean) =>
    `${(process.env.API_PUBLIC_URL || 'https://api.routezoeker.com').replace(/\/+$/, '')}/admin/content-manager/collection-types/${uid}/${documentId}${
      localized ? `?plugins[i18n][locale]=${LOCALE}` : ''
    }`;

  const notifyAdmin = async (mail: SignupMail) => {
    const to = process.env.PARTNER_EDIT_NOTIFY_EMAIL || 'info@routezoeker.com';
    const price = mail.price != null ? `€ ${String(mail.price).replace('.', ',')} per jaar (excl. btw)` : '';
    const address = [[mail.street, mail.houseNumber].filter(Boolean).join(' '), [mail.postalCode, mail.cityName].filter(Boolean).join(' ')]
      .filter(Boolean)
      .join(', ');
    const partnerUrl = adminUrl(PARTNER_UID, mail.partnerId, true);
    const subscriptionUrl = adminUrl(SUBSCRIPTION_UID, mail.subscriptionId, false);

    const rows: Array<[string, string, string?]> = [
      [config.label === 'logie' ? 'Logie' : 'Zaak', mail.name],
      ['Soort', mail.type],
      ['Pakket', `${mail.pkg}${price ? ` – ${price}` : ''}`],
      ['Contactpersoon', mail.contactName],
      ['E-mail', mail.email, `mailto:${mail.email}`],
      ['Telefoon', mail.phone, mail.phone ? `tel:${mail.phone.replace(/[^\d+]/g, '')}` : undefined],
      ['Adres', address + (mail.cityLinked ? '' : ' (gemeente niet gevonden in Strapi: zelf koppelen)')],
      ['Website', mail.website, mail.website || undefined],
      ['Btw-nummer', mail.vat],
    ].filter(([, value]) => Boolean(value)) as Array<[string, string, string?]>;

    const todo = [
      'Coördinaten (latitude/longitude) invullen in het adres, anders verschijnt de partner niet bij de routes.',
      "Foto's en tekst aanvullen (of laten aanvullen via Mijn logies).",
      'Proforma sturen. Na betaling: abonnement op "active" zetten en partner én abonnement publiceren.',
    ];

    const text = [
      `Nieuwe aanmelding via Routezoeker.com/${config.page}`,
      '',
      ...rows.map(([label, value]) => `${label}: ${value}`),
      ...(mail.message ? ['', 'Bericht:', mail.message] : []),
      '',
      'Nog te doen:',
      ...todo.map((item, index) => `${index + 1}. ${item}`),
      '',
      `Partner openen: ${partnerUrl}`,
      `Abonnement openen: ${subscriptionUrl}`,
      '',
      `Antwoorden op deze mail gaat rechtstreeks naar ${mail.contactName} (${mail.email}).`,
    ].join('\n');

    const cell = 'padding:8px 12px;border-bottom:1px solid #eeeeee;vertical-align:top;font-size:14px;';
    const button = (href: string, label: string, dark: boolean) =>
      `<a href="${escapeHtml(href)}" style="display:inline-block;margin:0 8px 8px 0;padding:10px 18px;border-radius:999px;font-size:14px;font-weight:600;text-decoration:none;${
        dark ? 'background:#16a34a;color:#ffffff;' : 'background:#ffffff;color:#171717;border:1px solid #d4d4d4;'
      }">${escapeHtml(label)}</a>`;

    const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f5f4;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#171717;">
<div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:16px;padding:28px;">
<p style="margin:0;font-size:12px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#16a34a;">Nieuwe aanmelding · ${escapeHtml(config.page)}</p>
<h1 style="margin:6px 0 20px;font-size:22px;">${escapeHtml(mail.name)}</h1>
<table style="width:100%;border-collapse:collapse;">${rows
      .map(
        ([label, value, href]) =>
          `<tr><td style="${cell}color:#737373;width:140px;">${escapeHtml(label)}</td><td style="${cell}">${
            href ? `<a href="${escapeHtml(href)}" style="color:#171717;">${escapeHtml(value)}</a>` : escapeHtml(value)
          }</td></tr>`,
      )
      .join('')}</table>
${
  mail.message
    ? `<p style="margin:20px 0 6px;font-size:14px;font-weight:600;">Bericht</p><p style="margin:0;padding:12px 14px;background:#f5f5f4;border-radius:12px;font-size:14px;white-space:pre-wrap;">${escapeHtml(mail.message)}</p>`
    : ''
}
<p style="margin:24px 0 8px;font-size:14px;font-weight:600;">Nog te doen</p>
<ol style="margin:0 0 20px;padding-left:20px;font-size:14px;line-height:1.6;">${todo.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ol>
<div>${button(partnerUrl, 'Partner openen in Strapi', true)}${button(subscriptionUrl, 'Abonnement openen', false)}</div>
<p style="margin:16px 0 0;font-size:12px;color:#737373;">Antwoorden op deze mail gaat rechtstreeks naar ${escapeHtml(mail.contactName)} (${escapeHtml(mail.email)}).</p>
</div></body></html>`;

    try {
      await strapi.plugin('email').service('email').send({
        to,
        replyTo: mail.email,
        subject: `Nieuwe aanmelding (${config.label}): ${mail.name} – ${mail.pkg}`,
        text,
        html,
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
      // Bericht: regeleindes behouden, wel overbodige witruimte weg.
      const message =
        typeof body.message === 'string'
          ? body.message.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 2000)
          : '';

      if (!config.packages.includes(pkg)) return ctx.badRequest('Kies een pakket.');
      if (!name || !contactName || !email || !cityName) return ctx.badRequest('Vul alle verplichte velden in.');
      if (!isEmail(email)) return ctx.badRequest('Dit e-mailadres lijkt niet te kloppen.');
      if (body.accept_terms !== true) return ctx.badRequest('Ga akkoord met de voorwaarden.');

      try {
        await saveSignup();
      } catch (error) {
        strapi.log.error(`[${config.page}] aanmelding kon niet opgeslagen worden`, error);
        return ctx.internalServerError(
          'Je aanmelding kon niet opgeslagen worden. Probeer het later opnieuw of mail naar info@routezoeker.com.',
        );
      }

      ctx.body = { ok: true };

      async function saveSignup() {
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
          // "address" is een herhaalbare component in Strapi: altijd een lijst.
          address: [
            {
              street: street || null,
              house_number: houseNumber || null,
              postal_code: postalCode || null,
              ...(cityDocumentId ? { city: cityDocumentId } : {}),
            },
          ],
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

      await notifyAdmin({
        name,
        type,
        pkg,
        price: prices[pkg],
        contactName,
        email,
        phone,
        street,
        houseNumber,
        postalCode,
        cityName,
        cityLinked: Boolean(cityDocumentId),
        website,
        vat,
        message,
        partnerId: partner.documentId,
        subscriptionId: subscription.documentId,
      });
      }
    },
  };
};

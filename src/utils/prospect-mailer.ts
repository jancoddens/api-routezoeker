import crypto from 'node:crypto';
import type { Core } from '@strapi/strapi';

// Prospectmails: één voor één, met een pauze ertussen, als gewone tekstmail
// vanuit het Routezoeker-adres. Elke mail krijgt een persoonlijke
// uitschrijflink en de List-Unsubscribe-headers die Gmail en Outlook verwachten.

const PROSPECT = 'api::prospect.prospect';
const TEMPLATE = 'api::prospect-mail-template.prospect-mail-template';

export type MailKind = 'first' | 'followup';

export const MAX_PER_BATCH = 25;
const PAUSE_BETWEEN_MAILS_MS = 20_000;

const apiUrl = () => (process.env.API_PUBLIC_URL || 'https://api.routezoeker.com').replace(/\/+$/, '');
const siteUrl = () => (process.env.FRONTEND_URL || 'https://www.routezoeker.com').replace(/\/+$/, '');
const replyTo = () => process.env.SMTP_REPLY_TO || 'info@routezoeker.com';
const fromAddress = () => process.env.SMTP_FROM || process.env.SMTP_USER || 'info@routezoeker.com';

export const DEFAULT_TEMPLATE = {
  from_name: 'Jan van Routezoeker',
  max_per_day: 25,
  logies_first_subject: '{Routes} vlak bij {naam}',
  logies_first_body: `Dag,

Ik ben Jan van Routezoeker.com, de site waar elke maand meer dan 55.000 wandelaars en fietsers een route zoeken in Vlaanderen.

Binnen 15 km van {naam} in {gemeente} liggen {routes} uit onze databank{waaronder}. Wie zo'n route plant, zoekt ook een plek om te overnachten. Met een eigen partnerpagina op Routezoeker staat jullie {soort} bij al die routes in de buurt.

- Geen commissie: gasten boeken rechtstreeks via jullie
- Een eigen pagina met 30 tot 50 routes rond jullie {soort}
- Zichtbaar op de routepagina's, de gemeente- en provinciepagina
- Een gratis QR-code met routes voor jullie gasten

Bekijk welke routes er al bij jullie in de buurt liggen: {routes_link}
Pakketten vanaf € 39,99 per jaar: {pakketten_link}

Zal ik een voorbeeldpagina voor {naam} klaarzetten? Een kort antwoord op deze mail volstaat.

Met vriendelijke groeten,
Jan Coddens
Routezoeker.com

Liever geen mails meer van Routezoeker? Schrijf je hier uit: {uitschrijflink}`,
  logies_followup_subject: 'Nog even over {naam} op Routezoeker',
  logies_followup_body: `Dag,

Ik stuurde je vorige week een mailtje over Routezoeker, maar misschien is het tussen de reservaties door ondergesneeuwd.

Kort samengevat: rond {naam} liggen {routes}. Wandelaars en fietsers die die routes bekijken, zoeken vaak ook een overnachting in de buurt. Een partnerpagina zet jullie {soort} precies daar, met een rechtstreekse link naar jullie website en zonder commissie.

Een vermelding kost vanaf € 39,99 per jaar. Als je wil, maak ik eerst een voorbeeld zodat je ziet hoe het eruit ziet.

Groeten,
Jan Coddens
Routezoeker.com

Liever geen mails meer van Routezoeker? Schrijf je hier uit: {uitschrijflink}`,
  horeca_first_subject: 'Wandelaars en fietsers komen langs {naam}',
  horeca_first_body: `Dag,

Ik ben Jan van Routezoeker.com, de site waar elke maand meer dan 55.000 wandelaars en fietsers een route zoeken in Vlaanderen.

Binnen 15 km van {naam} in {gemeente} liggen {routes}{waaronder}. Die mensen zoeken onderweg een plek om te stoppen. Met een eigen pagina op Routezoeker verschijnt jullie {soort} bij die routes, met een link naar jullie website.

- Geen commissie, een vaste prijs vanaf € 39,99 per jaar
- Zichtbaar op de routepagina's, de gemeente- en provinciepagina
- Een gratis QR-code met routes voor je klanten

Bekijk welke routes er al bij jullie in de buurt liggen: {routes_link}

Zal ik een voorbeeldpagina voor {naam} klaarzetten? Een kort antwoord op deze mail volstaat.

Met vriendelijke groeten,
Jan Coddens
Routezoeker.com

Liever geen mails meer van Routezoeker? Schrijf je hier uit: {uitschrijflink}`,
  horeca_followup_subject: 'Nog even over wandelaars en fietsers bij {naam}',
  horeca_followup_body: `Dag,

Vorige week stuurde ik je een mailtje over Routezoeker. Ik begrijp dat het druk is, dus kort: rond {naam} liggen {routes} die wandelaars en fietsers bij ons opzoeken. Wie een route plant, zoekt meteen ook een plek voor een koffie, een pint of een middagmaal.

Met een vermelding op Routezoeker sta je bij die routes, met een link naar je website en zonder commissie. Vanaf € 39,99 per jaar.

Interesse? Een kort antwoord op deze mail volstaat, dan maak ik de pagina voor je klaar.

Groeten,
Jan Coddens
Routezoeker.com

Liever geen mails meer van Routezoeker? Schrijf je hier uit: {uitschrijflink}`,
};

const TYPE_WORD: Record<string, string> = {
  'B&B': 'B&B',
  Hotel: 'hotel',
  Camping: 'camping',
  'Kamergebonden logies': 'gastenkamers',
  'Terreingebonden logies': 'verblijf',
  Vakantiepark: 'vakantiepark',
  Vakantiewoning: 'vakantiewoning',
  restaurant: 'restaurant',
  cafe: 'tearoom',
  pub: 'café',
  bar: 'bar',
  biergarten: 'terras',
};

export const newUnsubscribeToken = () => crypto.randomBytes(18).toString('base64url');
export const unsubscribeUrl = (token: string) => `${apiUrl()}/api/prospects/unsubscribe/${token}`;

const routeSentence = (p: any) => {
  const parts: string[] = [];
  const walks = p.walk_routes_15km || 0;
  const bikes = p.bike_routes_15km || 0;
  if (walks) parts.push(`${walks} wandelroute${walks > 1 ? 's' : ''}`);
  if (bikes) parts.push(`${bikes} fietsroute${bikes > 1 ? 's' : ''}`);
  return parts.join(' en ') || 'heel wat routes';
};

const topRoutes = (p: any) =>
  String(p.nearest_routes || '')
    .split('\n')
    .map((line) => line.replace(/\s*\([^)]*\)\s*$/, '').trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(' en ');

export const renderMail = (template: any, prospect: any, kind: MailKind, token: string) => {
  const segment = prospect.segment === 'horeca' ? 'horeca' : 'logies';
  const key = `${segment}_${kind === 'first' ? 'first' : 'followup'}`;
  const subjectTpl = template?.[`${key}_subject`] || (DEFAULT_TEMPLATE as any)[`${key}_subject`];
  let bodyTpl = template?.[`${key}_body`] || (DEFAULT_TEMPLATE as any)[`${key}_body`];

  const routes = routeSentence(prospect);
  const top = topRoutes(prospect);
  const values: Record<string, string> = {
    naam: prospect.name || '',
    gemeente: prospect.city || '',
    soort: TYPE_WORD[prospect.type] || 'zaak',
    routes,
    Routes: routes.charAt(0).toUpperCase() + routes.slice(1),
    waaronder: top ? `, waaronder ${top}` : '',
    routes_link: `${siteUrl()}/routes-in-de-buurt?q=${encodeURIComponent(prospect.city || '')}`,
    pakketten_link: `${siteUrl()}/logie-aanmelden`,
    uitschrijflink: unsubscribeUrl(token),
  };

  // De uitschrijflink moet er altijd in staan, ook als iemand ze uit de tekst haalt.
  if (!bodyTpl.includes('{uitschrijflink}')) {
    bodyTpl += '\n\nLiever geen mails meer van Routezoeker? Schrijf je hier uit: {uitschrijflink}';
  }

  const fill = (text: string) => text.replace(/\{(\w+)\}/g, (match, name) => (name in values ? values[name] : match));
  return { subject: fill(subjectTpl), text: fill(bodyTpl) };
};

export const getTemplate = async (strapi: Core.Strapi) => {
  const stored = await strapi.documents(TEMPLATE).findFirst({});
  return { ...DEFAULT_TEMPLATE, ...Object.fromEntries(Object.entries(stored || {}).filter(([, v]) => v !== null && v !== '')) };
};

/** Bij het opstarten: standaardteksten aanmaken en prospects zonder fase op "nieuw" zetten. */
export const ensureProspectSetup = async (strapi: Core.Strapi) => {
  const stored = await strapi.documents(TEMPLATE).findFirst({});
  if (!stored) await strapi.documents(TEMPLATE).create({ data: DEFAULT_TEMPLATE as any });
  await strapi.db.query(PROSPECT).updateMany({ where: { stage: { $null: true } }, data: { stage: 'nieuw' } });
};

const startOfToday = () => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.toISOString();
};

/** Waarom een prospect deze mail (nog) niet mag krijgen, of null als het mag. */
export const skipReason = (p: any, kind: MailKind) => {
  if (!p.email) return 'geen e-mailadres';
  if (['niet_contacteren', 'niet_geinteresseerd', 'partner'].includes(p.stage)) return `status ${p.stage}`;
  if (p.unsubscribed_at) return 'uitgeschreven';
  if (kind === 'first' && p.stage !== 'nieuw') return `al gemaild (status ${p.stage})`;
  if (kind === 'followup' && p.stage !== 'gemaild') return `opvolgmail enkel na status gemaild (nu ${p.stage})`;
  return null;
};

const escapeHtml = (value: string) =>
  value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

/** Dezelfde tekst als HTML, zodat regels en links in elk mailprogramma goed staan. */
const textToHtml = (text: string) =>
  `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222">${escapeHtml(text)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
    .replace(/\n/g, '<br>')}</div>`;

const sendOne = async (strapi: Core.Strapi, template: any, prospect: any, kind: MailKind, to: string) => {
  let token = prospect.unsubscribe_token;
  if (!token) {
    token = newUnsubscribeToken();
    await strapi.db.query(PROSPECT).update({ where: { id: prospect.id }, data: { unsubscribe_token: token } });
  }
  const { subject, text } = renderMail(template, prospect, kind, token);
  const link = unsubscribeUrl(token);
  await strapi.plugin('email').service('email').send({
    to,
    from: `${template.from_name} <${fromAddress()}>`,
    replyTo: replyTo(),
    subject,
    text,
    html: textToHtml(text),
    headers: {
      'List-Unsubscribe': `<${link}>, <mailto:${replyTo()}?subject=uitschrijven>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  });
  return { subject, text };
};

/** Testmail: de tekst voor deze prospect, maar naar jezelf. Status blijft gelijk. */
export const sendTestMail = async (strapi: Core.Strapi, documentId: string, kind: MailKind, to: string) => {
  const prospect = await strapi.db.query(PROSPECT).findOne({ where: { documentId } });
  if (!prospect) throw new Error('Prospect niet gevonden');
  const template = await getTemplate(strapi);
  // Eigen nepcode: klik je in de testmail op "uitschrijven", dan raakt dat de prospect niet.
  const { subject } = await sendOne(strapi, template, { ...prospect, email: to, unsubscribe_token: 'testmail-voorbeeld' }, kind, to);
  return { subject, to, name: prospect.name };
};

/**
 * Controleert de selectie, en stuurt daarna op de achtergrond de mails één
 * voor één (met een pauze), zodat de admin niet hoeft te wachten.
 */
export const queueMails = async (strapi: Core.Strapi, documentIds: string[], kind: MailKind) => {
  const template = await getTemplate(strapi);
  const ids = [...new Set(documentIds)].slice(0, MAX_PER_BATCH);
  const prospects = await strapi.db.query(PROSPECT).findMany({ where: { documentId: { $in: ids } } });

  const sentToday = await strapi.db.query(PROSPECT).count({ where: { last_mailed_at: { $gte: startOfToday() } } });
  const room = Math.max(0, (template.max_per_day || DEFAULT_TEMPLATE.max_per_day) - sentToday);

  const toSend: any[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const p of prospects) {
    const reason = skipReason(p, kind);
    if (reason) skipped.push({ name: p.name, reason });
    else if (toSend.length >= room) skipped.push({ name: p.name, reason: 'daglimiet bereikt' });
    else toSend.push(p);
  }

  void (async () => {
    for (const [index, p] of toSend.entries()) {
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, PAUSE_BETWEEN_MAILS_MS));
      const now = new Date().toISOString();
      try {
        // Opnieuw ophalen: misschien is er intussen iets gewijzigd (bv. uitgeschreven).
        const fresh = await strapi.db.query(PROSPECT).findOne({ where: { id: p.id } });
        const reason = fresh ? skipReason(fresh, kind) : 'verwijderd';
        if (reason) continue;
        await sendOne(strapi, template, fresh, kind, fresh.email);
        await strapi.documents(PROSPECT).update({
          documentId: fresh.documentId,
          data: {
            stage: kind === 'first' ? 'gemaild' : 'opgevolgd',
            last_mailed_at: now,
            mail_count: (fresh.mail_count || 0) + 1,
            last_mail_result: `${kind === 'first' ? 'Eerste mail' : 'Opvolgmail'} verstuurd ${now.slice(0, 16).replace('T', ' ')}`,
          } as any,
        });
      } catch (error: any) {
        strapi.log.error(`Prospectmail naar ${p.email} mislukt: ${error?.message}`);
        await strapi.db
          .query(PROSPECT)
          .update({ where: { id: p.id }, data: { last_mail_result: `Mislukt ${now.slice(0, 16)}: ${String(error?.message).slice(0, 180)}` } })
          .catch(() => {});
      }
    }
  })();

  return {
    queued: toSend.map((p) => p.name),
    skipped,
    seconds: Math.max(0, toSend.length - 1) * (PAUSE_BETWEEN_MAILS_MS / 1000),
    remainingToday: room - toSend.length,
  };
};

/** Uitschrijven via de link in de mail. */
export const unsubscribeByToken = async (strapi: Core.Strapi, token: string) => {
  if (!token || token.length < 10) return null;
  const prospect = await strapi.db.query(PROSPECT).findOne({ where: { unsubscribe_token: token } });
  if (!prospect) return null;
  if (prospect.stage !== 'niet_contacteren') {
    const today = new Date().toISOString().slice(0, 10);
    await strapi.documents(PROSPECT).update({
      documentId: prospect.documentId,
      data: {
        stage: 'niet_contacteren',
        unsubscribed_at: new Date().toISOString(),
        last_mail_result: `Uitgeschreven via link in mail op ${today}`,
      } as any,
    });
  }
  return prospect;
};

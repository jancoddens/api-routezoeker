#!/usr/bin/env node

'use strict';

// Zet de prospectlijst (logies en horeca die we als partner willen werven) in
// Strapi, in het content type "Prospect". Daarna beheer je alles in de admin
// (api.routezoeker.com/admin > Content Manager > Prospect).
//
// - Leest een JSON-bestand (standaard data/prospects.json, staat NIET in git:
//   upload het via Plesk Bestandsbeheer naar de map data/ van de API).
// - Koppelt op source_id. Nieuwe prospects worden aangemaakt; bestaande krijgen
//   enkel hun gegevens (adres, routes, score, mailteksten) bijgewerkt.
//   Status, notities, mailed_at, follow_up_at en history blijven ongemoeid,
//   dus het script mag je gerust opnieuw draaien met een nieuwere lijst.
//
// Gebruik:
//   node scripts/import-prospects.js --dry-run
//   node scripts/import-prospects.js
//   node scripts/import-prospects.js --file data/prospects.json --limit 3000

const fs = require('node:fs/promises');
const path = require('node:path');
const { compileStrapi, createStrapi } = require('@strapi/strapi');

const UID = 'api::prospect.prospect';

const parseArgs = () => {
  const args = process.argv.slice(2);
  const options = { file: path.join(__dirname, '..', 'data', 'prospects.json'), dryRun: false, limit: Infinity };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--file') options.file = path.resolve(args[(i += 1)]);
    else if (arg === '--limit') options.limit = Number(args[(i += 1)]);
    else throw new Error(`Onbekend argument: ${arg}`);
  }
  return options;
};

// ---------- mailteksten ----------
const TYPE_WORD = {
  'B&B': 'B&B', Hotel: 'hotel', Camping: 'camping', 'Kamergebonden logies': 'gastenkamers',
  'Terreingebonden logies': 'verblijf', Vakantiepark: 'vakantiepark', Vakantiewoning: 'vakantiewoning',
  restaurant: 'restaurant', cafe: 'tearoom', pub: 'café', bar: 'bar', biergarten: 'terras',
};

const routeLine = (p) => {
  const parts = [];
  if (p.w5) parts.push(`${p.w5} wandelroute${p.w5 > 1 ? 's' : ''}`);
  if (p.f5) parts.push(`${p.f5} fietsroute${p.f5 > 1 ? 's' : ''}`);
  return parts.join(' en ');
};
const topRoutes = (p) => (p.top || []).slice(0, 2).map((r) => r[0]).join(' en ');
const cityLink = (p) => `https://www.routezoeker.com/routes-in-de-buurt?q=${encodeURIComponent(p.c || '')}`;
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const firstMail = (p) => {
  const w = TYPE_WORD[p.t] || 'zaak';
  const rl = routeLine(p);
  const tr = topRoutes(p);
  if (p.seg === 'horeca') {
    return {
      subject: `Wandelaars en fietsers komen langs ${p.n}`,
      body: `Dag,

Ik ben Jan van Routezoeker.com, de site waar elke maand meer dan 55.000 wandelaars en fietsers een route zoeken in Vlaanderen.

Binnen 5 km van ${p.n} in ${p.c} liggen ${rl}${tr ? `, waaronder ${tr}` : ''}. Die mensen zoeken onderweg een plek om te stoppen. Met een eigen pagina op Routezoeker verschijnt jullie ${w} bij die routes, met een link naar jullie website.

- Geen commissie, een vaste prijs vanaf € 39,99 per jaar
- Zichtbaar op de routepagina's, de gemeente- en provinciepagina
- Een gratis QR-code met routes voor je klanten

Bekijk welke routes er al bij jullie in de buurt liggen: ${cityLink(p)}

Zal ik een voorbeeldpagina voor ${p.n} klaarzetten? Een kort antwoord op deze mail volstaat.

Met vriendelijke groeten,
Jan Coddens
Routezoeker.com

Liever geen mails meer van Routezoeker? Laat het me weten, dan haal ik je uit de lijst.`,
    };
  }
  return {
    subject: `${capital(rl)} vlak bij ${p.n}`,
    body: `Dag,

Ik ben Jan van Routezoeker.com, de site waar elke maand meer dan 55.000 wandelaars en fietsers een route zoeken in Vlaanderen.

Binnen 5 km van ${p.n} in ${p.c} liggen ${rl} uit onze databank${tr ? `, waaronder ${tr}` : ''}. Wie zo'n route plant, zoekt ook een plek om te overnachten. Met een eigen partnerpagina op Routezoeker staat jullie ${w} bij al die routes in de buurt.

- Geen commissie: gasten boeken rechtstreeks via jullie
- Een eigen pagina met 30 tot 50 routes rond jullie ${w}
- Zichtbaar op de routepagina's, de gemeente- en provinciepagina
- Een gratis QR-code met routes voor jullie gasten

Bekijk welke routes er al bij jullie in de buurt liggen: ${cityLink(p)}
Pakketten vanaf € 39,99 per jaar: https://www.routezoeker.com/logie-aanmelden

Zal ik een voorbeeldpagina voor ${p.n} klaarzetten? Een kort antwoord op deze mail volstaat.

Met vriendelijke groeten,
Jan Coddens
Routezoeker.com

Liever geen mails meer van Routezoeker? Laat het me weten, dan haal ik je uit de lijst.`,
  };
};

const followupMail = (p) => {
  const w = TYPE_WORD[p.t] || 'zaak';
  const rl = routeLine(p);
  if (p.seg === 'horeca') {
    return {
      subject: `Nog even over wandelaars en fietsers bij ${p.n}`,
      body: `Dag,

Vorige week stuurde ik je een mailtje over Routezoeker. Ik begrijp dat het druk is, dus kort: rond ${p.n} liggen ${rl} die wandelaars en fietsers bij ons opzoeken. Wie een route plant, zoekt meteen ook een plek voor een koffie, een pint of een middagmaal.

Met een vermelding op Routezoeker sta je bij die routes, met een link naar je website en zonder commissie. Vanaf € 39,99 per jaar.

Interesse? Een kort antwoord op deze mail volstaat, dan maak ik de pagina voor je klaar.

Groeten,
Jan Coddens
Routezoeker.com`,
    };
  }
  return {
    subject: `Nog even over ${p.n} op Routezoeker`,
    body: `Dag,

Ik stuurde je vorige week een mailtje over Routezoeker, maar misschien is het tussen de reservaties door ondergesneeuwd.

Kort samengevat: rond ${p.n} liggen ${rl}. Wandelaars en fietsers die die routes bekijken, zoeken vaak ook een overnachting in de buurt. Een partnerpagina zet jullie ${w} precies daar, met een rechtstreekse link naar jullie website en zonder commissie.

Een vermelding kost vanaf € 39,99 per jaar. Als je wil, maak ik eerst een voorbeeld zodat je ziet hoe het eruit ziet.

Groeten,
Jan Coddens
Routezoeker.com`,
  };
};

// ---------- omzetten naar Strapi-velden ----------
const clip = (s, n = 255) => (s ? String(s).slice(0, n) : null);

const toData = (p) => {
  const first = firstMail(p);
  const follow = followupMail(p);
  return {
    name: clip(p.n),
    priority: p.pr || null,
    city: clip(p.c),
    province: clip(p.p),
    type: clip(p.t),
    segment: p.seg === 'horeca' ? 'horeca' : 'logies',
    email: p.e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.e) ? p.e : null,
    phone: clip(p.ph ? p.ph.replace(/^tel:/, '') : null),
    website: clip(p.w),
    street: clip(p.s),
    postcode: clip(p.pc),
    walk_routes_5km: p.w5 ?? 0,
    bike_routes_5km: p.f5 ?? 0,
    nearest_routes: (p.top || []).map((r) => `${r[0]} (${r[1]}, ${String(r[2]).replace('.', ',')} km)`).join('\n') || null,
    score: p.sc ?? null,
    rank: p.rank ?? null,
    vlaanderen_vakantieland_url: p.vv ? `https://www.vlaanderenvakantieland.be${p.vv}` : null,
    beds: p.b ?? null,
    other_properties: p.o && p.o.length ? p.o.join(', ') : null,
    mail_subject: clip(first.subject),
    mail_body: first.body,
    followup_subject: clip(follow.subject),
    followup_body: follow.body,
    latitude: p.la ?? null,
    longitude: p.lo ?? null,
    source: p.seg === 'horeca' ? 'OpenStreetMap' : 'Toerisme Vlaanderen',
    source_id: p.i,
  };
};

const main = async () => {
  const options = parseArgs();
  const raw = JSON.parse(await fs.readFile(options.file, 'utf8'));
  const prospects = raw.slice(0, options.limit);
  console.log(`${prospects.length} prospects in ${options.file}`);

  const appContext = await compileStrapi();
  const strapi = createStrapi(appContext);
  await strapi.load();

  let created = 0;
  let updated = 0;
  let failed = 0;

  try {
    const existing = await strapi.db.query(UID).findMany({ select: ['documentId', 'source_id'] });
    const bySource = new Map(existing.map((row) => [row.source_id, row.documentId]));
    console.log(`${bySource.size} prospects staan al in Strapi`);

    for (const [index, p] of prospects.entries()) {
      const data = toData(p);
      const documentId = bySource.get(data.source_id);
      try {
        if (options.dryRun) {
          documentId ? (updated += 1) : (created += 1);
        } else if (documentId) {
          await strapi.documents(UID).update({ documentId, data });
          updated += 1;
        } else {
          await strapi.documents(UID).create({ data: { ...data, status: 'nieuw' } });
          created += 1;
        }
      } catch (error) {
        failed += 1;
        console.warn(`Mislukt: ${data.name} (${data.source_id}): ${error.message}`);
      }
      if ((index + 1) % 500 === 0) console.log(`${index + 1}/${prospects.length}...`);
    }
  } finally {
    await strapi.destroy().catch(() => {});
  }

  console.log(`${options.dryRun ? '[dry-run] ' : ''}Nieuw: ${created}, bijgewerkt: ${updated}, mislukt: ${failed}`);
  process.exit(failed ? 1 : 0);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

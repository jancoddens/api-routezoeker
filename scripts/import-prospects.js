#!/usr/bin/env node

'use strict';

// Zet de prospectlijst (logies en horeca die we als partner willen werven) in
// Strapi, in het content type "Prospect". Daarna beheer je alles in de admin
// (api.routezoeker.com/admin > Content Manager > Prospect).
//
// - Leest een JSON-bestand (standaard data/prospects.json, staat NIET in git:
//   upload het via Plesk Bestandsbeheer naar de map data/ van de API).
// - Koppelt op source_id. Nieuwe prospects worden aangemaakt; bestaande krijgen
//   enkel hun gegevens (adres, routes, score) bijgewerkt.
//   Fase (stage), notities, mailed_at, follow_up_at, history en de
//   uitschrijfcode blijven ongemoeid. De mailteksten staan centraal in
//   Content Manager > Prospect mailteksten. Het script mag je dus gerust
//   opnieuw draaien met een nieuwere lijst.
//
// Gebruik:
//   node scripts/import-prospects.js --dry-run
//   node scripts/import-prospects.js
//   node scripts/import-prospects.js --file data/prospects.json --limit 3000
//
// Mislukken er rijen met "database is locked"? Draai het script gewoon nog eens:
// wat al bestaat wordt overgeslagen/bijgewerkt, enkel de ontbrekende komen erbij.

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

// ---------- omzetten naar Strapi-velden ----------
const clip = (s, n = 255) => (s ? String(s).slice(0, n) : null);

const toData = (p) => {
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
    latitude: p.la ?? null,
    longitude: p.lo ?? null,
    source: p.seg === 'horeca' ? 'OpenStreetMap' : 'Toerisme Vlaanderen',
    source_id: p.i,
  };
};

// Strapi draait op SQLite: terwijl de live server schrijft, kan een insert
// "database is locked" geven. Dan even wachten en opnieuw proberen.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isLocked = (error) => /database is locked|SQLITE_BUSY/i.test(String(error?.message || error));
const withRetry = async (fn) => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (!isLocked(error) || attempt >= 8) throw error;
      await sleep(250 * attempt);
    }
  }
};
const shortError = (error) => {
  const message = String(error?.message || error);
  return isLocked(error) ? 'database is locked' : message.split('\n')[0].slice(0, 200);
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
          await withRetry(() => strapi.documents(UID).update({ documentId, data }));
          updated += 1;
        } else {
          await withRetry(() => strapi.documents(UID).create({ data: { ...data, stage: 'nieuw' } }));
          created += 1;
        }
      } catch (error) {
        failed += 1;
        console.warn(`Mislukt: ${data.name} (${data.source_id}): ${shortError(error)}`);
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

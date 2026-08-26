#!/usr/bin/env node

'use strict';

// Herstelt ontbrekende draft-rijen voor Blog Post-documenten.
//
// ROOT CAUSE (26 augustus 2026): de fix in legacy-blog-import.ts voor het
// duplicate-document-probleem zette publishedAt NA het aanmaken/updaten
// rechtstreeks via db.query() op de bestaande (draft-)rij, in plaats van via
// Strapi's documents().publish() -- die normaal een APARTE published-rij
// aanmaakt en de draft-rij laat staan. Door rechtstreeks op de rij te
// schrijven werd de enige rij van elk document in-place omgezet naar
// "published", waardoor er nooit meer een draft-rij overbleef. Resultaat:
// alle 46 Blog Post-documenten hadden enkel nog een published-rij en 0
// draft-rijen (bevestigd via SQL: COUNT(*)=46, draft_rijen=0). Dat is een
// abnormale staat -- Strapi's eigen documentatie stelt dat een gepubliceerd
// document altijd ook een draft-tegenhanger heeft. Gevolg in de admin-UI: de
// Content Manager-lijst staat standaard op de "Draft"-weergave, en omdat er
// geen enkele draft-rij meer bestond, toonde dat altijd "0 entries found"
// zodra je zonder expliciete ?status=published-parameter navigeerde.
//
// FIX: voor elk document zonder draft-rij wordt strapi.documents(uid)
// .discardDraft({ documentId, locale }) aangeroepen. Dat is Strapi's eigen,
// voor dit scenario bedoelde methode: ze kloont de volledige gepubliceerde
// rij (incl. relaties, componenten, dynamic-zone-content, cover image) naar
// een nieuwe draft-rij. Geen ruwe SQL-clone nodig, dus geen risico dat we
// component-/relatietabellen verkeerd dupliceren.
//
// legacy-blog-import.ts is AL gefixt (eerder vandaag) om voortaan .publish()
// te gebruiken i.p.v. rechtstreeks db.query op publishedAt te schrijven, dus
// dit script is eenmalig nodig om de bestaande 46 documenten te herstellen.
//
// Gebruik:
//   node scripts/restore-missing-drafts.js              # dry-run
//   node scripts/restore-missing-drafts.js --execute     # herstelt echt
//
// Maak eerst een backup van data/data.db voor je --execute draait.

const { compileStrapi, createStrapi } = require('@strapi/strapi');

const isShutdownAbortError = (error) => error?.message === 'aborted';

process.on('unhandledRejection', (error) => {
  if (isShutdownAbortError(error)) {
    return;
  }

  throw error;
});

const execute = process.argv.includes('--execute');
const UID = 'api::blog-post.blog-post';

const run = async () => {
  const appContext = await compileStrapi();
  const strapi = createStrapi(appContext);
  let runError;
  let restored = 0;
  let failed = 0;

  try {
    await strapi.load();

    const all = await strapi.db.query(UID).findMany({
      select: ['id', 'documentId', 'locale', 'slug', 'title', 'publishedAt'],
    });

    const byDocLocale = new Map();

    for (const row of all) {
      const key = `${row.documentId}::${row.locale}`;

      if (!byDocLocale.has(key)) {
        byDocLocale.set(key, []);
      }

      byDocLocale.get(key).push(row);
    }

    const missingDraft = [...byDocLocale.entries()]
      .map(([key, rows]) => {
        const hasDraft = rows.some((row) => row.publishedAt === null);
        const published = rows.find((row) => row.publishedAt !== null);

        return { key, rows, hasDraft, published };
      })
      .filter((group) => !group.hasDraft && group.published);

    console.log(
      `Totaal ${byDocLocale.size} document/locale-combinaties, ${missingDraft.length} zonder draft-rij.\n`
    );

    for (const group of missingDraft) {
      const { published } = group;

      console.log(
        `  [${execute ? 'HERSTELLEN' : 'ZOU HERSTELLEN'}] documentId=${published.documentId} ` +
          `locale=${published.locale} slug=${published.slug} title="${published.title}"`
      );

      if (execute) {
        try {
          await strapi.documents(UID).discardDraft({
            documentId: published.documentId,
            locale: published.locale,
          });
          restored += 1;
        } catch (error) {
          failed += 1;
          console.error(`    -> MISLUKT voor documentId=${published.documentId}: ${error.message}`);
        }
      }
    }

    console.log('');
    console.log(
      execute
        ? `Klaar. ${restored} draft-rijen hersteld, ${failed} mislukt.`
        : `Dry-run. Zou ${missingDraft.length} draft-rijen herstellen. Herdraai met --execute om het echt te doen.`
    );
  } catch (error) {
    runError = error;
  } finally {
    try {
      await strapi.destroy();
    } catch (error) {
      if (!runError && !isShutdownAbortError(error)) {
        throw error;
      }
    }
  }

  if (runError) {
    throw runError;
  }
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

#!/usr/bin/env node

'use strict';

// Rapporteert (en, met --execute, ruimt op) dubbele Blog Post-documenten die
// ontstonden tijdens de batch-import van 26 augustus 2026: door een quirk in
// Strapi's (deprecated) entityService-compatlaag op v5 werd voor 42 van de 43
// posts een TWEEDE, los document aangemaakt i.p.v. het bestaande te updaten
// -- terwijl de scriptoutput zelf "updated" bleef rapporteren. De losse
// --only 7-herrun (walking-museum-damme) had dit probleem niet.
//
// Groepeert alle rijen op slug (status-onafhankelijk, dus draft + published
// samen), en toont per duplicaat-groep: id, documentId, aantal contentblokken,
// updatedAt, publishedAt. De rij met de meeste contentblokken wint (bij
// gelijkstand: meest recente updatedAt); de rest wordt als "VERWIJDEREN"
// gemarkeerd. Zonder --execute wordt er NIETS verwijderd (dry-run).
//
// Gebruik:
//   node scripts/dedupe-legacy-blogs.js              # dry-run, toont alle groepen
//   node scripts/dedupe-legacy-blogs.js --execute     # verwijdert de "verliezer"-rijen
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

const countBlocks = (content) => {
  if (!Array.isArray(content)) {
    return 0;
  }

  let total = 0;

  for (const zone of content) {
    if (Array.isArray(zone?.content)) {
      total += zone.content.length;
    }
  }

  return total;
};

const run = async () => {
  const appContext = await compileStrapi();
  const strapi = createStrapi(appContext);
  let runError;
  let deleted = 0;

  try {
    await strapi.load();

    const all = await strapi.db.query('api::blog-post.blog-post').findMany({
      select: ['id', 'documentId', 'slug', 'title', 'updatedAt', 'createdAt', 'publishedAt'],
      populate: { content: true },
      orderBy: { slug: 'asc' },
    });

    const bySlug = new Map();

    for (const row of all) {
      if (!row.slug) {
        continue;
      }

      if (!bySlug.has(row.slug)) {
        bySlug.set(row.slug, []);
      }

      bySlug.get(row.slug).push(row);
    }

    const duplicateGroups = [...bySlug.entries()].filter(([, rows]) => rows.length > 1);

    console.log(
      `Totaal ${all.length} rijen, ${bySlug.size} unieke slugs, ${duplicateGroups.length} slugs met duplicaten.\n`
    );

    for (const [slug, rows] of duplicateGroups) {
      const enriched = rows.map((row) => ({
        ...row,
        blocks: countBlocks(row.content),
      }));

      // Winnaar: een GEPUBLICEERDE rij (publishedAt niet null) wint altijd van een
      // pure draft, ongeacht blokken-aantal -- een draft-only rij is nooit live op
      // de site, dus die mag nooit voorrang krijgen op een gepubliceerde rij met
      // minder blokken (zou de post laten verdwijnen van de front-end). Binnen
      // dezelfde publicatiestatus: meeste contentblokken wint; bij gelijkstand de
      // recentst geüpdatete rij.
      const winner = [...enriched].sort((a, b) => {
        const aPublished = a.publishedAt != null ? 1 : 0;
        const bPublished = b.publishedAt != null ? 1 : 0;

        if (bPublished !== aPublished) {
          return bPublished - aPublished;
        }

        if (b.blocks !== a.blocks) {
          return b.blocks - a.blocks;
        }

        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      })[0];

      const maxLoserBlocks = Math.max(0, ...enriched.filter((row) => row.id !== winner.id).map((row) => row.blocks));
      const reviewFlag = maxLoserBlocks > winner.blocks ? '  [LET OP: verwijderde rij had meer blokken -- manueel nakijken]' : '';

      console.log(`--- ${slug} (${enriched.length} rijen)${reviewFlag} ---`);

      for (const row of enriched) {
        const mark = row.id === winner.id ? 'BEHOUDEN  ' : 'VERWIJDEREN';
        console.log(
          `  [${mark}] id=${row.id} documentId=${row.documentId} blokken=${row.blocks} ` +
            `updatedAt=${row.updatedAt} publishedAt=${row.publishedAt}`
        );
      }

      if (execute) {
        const losers = enriched.filter((row) => row.id !== winner.id);

        for (const loser of losers) {
          await strapi.db.query('api::blog-post.blog-post').delete({ where: { id: loser.id } });
          deleted += 1;
          console.log(`    -> id=${loser.id} verwijderd.`);
        }
      }

      console.log('');
    }

    const wouldDelete = duplicateGroups.reduce((sum, [, rows]) => sum + rows.length - 1, 0);

    console.log(
      execute
        ? `Klaar. ${deleted} rijen verwijderd.`
        : `Dry-run. Zou ${wouldDelete} rijen verwijderen. Herdraai met --execute om echt te verwijderen.`
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

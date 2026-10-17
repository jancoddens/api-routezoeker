#!/usr/bin/env node

'use strict';

// Importeert de accounts + nieuwsbriefvoorkeuren van de oude site naar Strapi.
// Zie de uitgebreide toelichting bovenaan src/utils/legacy-user-import.ts
// (wachtwoordafhandeling, veiligheidsvoorwaarden) voor je dit draait.
//
// Gebruik:
//   node scripts/import-legacy-users.js \
//     --profiel-sql /pad/naar/Profiel.sql \
//     --newsletter-sql /pad/naar/Nieuwsbrief_voorkeuren.sql
//     [--limit 20]            (test eerst op een klein deel)
//     [--no-dry-run --confirm-production]   (pas dan wordt er echt geschreven)
//
// Standaard (zonder --no-dry-run) wordt ENKEL een rapport getoond, er wordt
// niets weggeschreven.

const path = require('node:path');
const { compileStrapi, createStrapi } = require('@strapi/strapi');

const parseArgs = () => {
  const rawArgs = process.argv.slice(2);
  const options = {
    profielSqlPath: undefined,
    newsletterSqlPath: undefined,
    limit: undefined,
    offset: undefined,
    dryRun: true,
    confirmProduction: false,
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];

    if (arg === '--profiel-sql') {
      options.profielSqlPath = rawArgs[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--newsletter-sql') {
      options.newsletterSqlPath = rawArgs[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--limit') {
      options.limit = Number(rawArgs[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--offset') {
      options.offset = Number(rawArgs[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--no-dry-run') {
      options.dryRun = false;
      continue;
    }
    if (arg === '--confirm-production') {
      options.confirmProduction = true;
      continue;
    }

    throw new Error(`Onbekend argument: ${arg}`);
  }

  if (!options.profielSqlPath || !options.newsletterSqlPath) {
    throw new Error('--profiel-sql en --newsletter-sql zijn verplicht.');
  }

  if (!options.dryRun && !options.confirmProduction) {
    throw new Error(
      'Voeg --confirm-production toe wanneer je --no-dry-run gebruikt -- dit is een extra veiligheidsvangnet ' +
        'zodat dit script nooit per ongeluk écht schrijft naar een database.',
    );
  }

  options.profielSqlPath = path.resolve(options.profielSqlPath);
  options.newsletterSqlPath = path.resolve(options.newsletterSqlPath);

  return options;
};

const run = async () => {
  const options = parseArgs();
  const appContext = await compileStrapi();
  const strapi = createStrapi(appContext);
  let runError;
  let report;

  try {
    await strapi.load();

    const { importLegacyUsers } = await import('../dist/src/utils/legacy-user-import.js');
    report = await importLegacyUsers(strapi, {
      profielSqlPath: options.profielSqlPath,
      newsletterSqlPath: options.newsletterSqlPath,
      dryRun: options.dryRun,
      limit: options.limit,
      offset: options.offset,
    });
  } catch (error) {
    runError = error;
  } finally {
    try {
      await strapi.destroy();
    } catch (error) {
      if (!runError && error?.message !== 'aborted') {
        throw error;
      }
    }
  }

  if (runError) {
    throw runError;
  }

  console.log(JSON.stringify({ ok: true, dryRun: options.dryRun, report }, null, 2));
};

run().catch((error) => {
  const validationErrors = error?.details?.errors;

  if (Array.isArray(validationErrors) && validationErrors.length > 0) {
    console.error('Validation details:', JSON.stringify(validationErrors, null, 2));
  }

  console.error(error);
  process.exit(1);
});

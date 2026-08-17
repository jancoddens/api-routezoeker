#!/usr/bin/env node

'use strict';

// Importeert de oude blogposts (routezoeker.com, PHP/'Blog'-tabel) naar de
// nieuwe Strapi content-types blog-post / blog-category / author.
//
// Leest rechtstreeks uit de legacy MySQL-database (credentials via config.php,
// zelfde manier als scripts/inspect-legacy-blog-tables.js) en haalt
// afbeeldingen op via HTTP van de live legacy site (routezoeker.com).
//
// Gebruik:
//   node scripts/import-legacy-blogs.js --dry-run
//   node scripts/import-legacy-blogs.js --dry-run --limit 3
//   node scripts/import-legacy-blogs.js --only 1,2,3
//   node scripts/import-legacy-blogs.js
//   node scripts/import-legacy-blogs.js --config /pad/naar/config.php --host localhost --user routezoeker --password *** --database front_routezoeker

const path = require('node:path');
const { compileStrapi, createStrapi } = require('@strapi/strapi');

const DEFAULT_LEGACY_ROOT = '/Users/jancoddens/Documents/Websites/Routezoeker.com/V4';

const parseArgs = () => {
  const rawArgs = process.argv.slice(2);
  const options = {
    configPath: path.join(DEFAULT_LEGACY_ROOT, 'config.php'),
    imageBaseUrl: undefined,
    profileImagePath: undefined,
    locale: undefined,
    limit: undefined,
    offset: undefined,
    onlyIds: undefined,
    dryRun: false,
    skipImages: false,
    skipCategory: undefined,
    hostOverride: undefined,
    portOverride: undefined,
    userOverride: undefined,
    passwordOverride: undefined,
    databaseOverride: undefined,
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];

    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (arg === '--skip-images') {
      options.skipImages = true;
      continue;
    }

    if (arg === '--locale') {
      options.locale = rawArgs[index + 1];
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

    if (arg === '--only') {
      options.onlyIds = rawArgs[index + 1]
        .split(',')
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value));
      index += 1;
      continue;
    }

    if (arg === '--config') {
      options.configPath = rawArgs[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--image-base-url') {
      options.imageBaseUrl = rawArgs[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--profile-image-path') {
      options.profileImagePath = rawArgs[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--skip-category') {
      options.skipCategory = rawArgs[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--host') {
      options.hostOverride = rawArgs[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--port') {
      options.portOverride = Number(rawArgs[index + 1]);
      index += 1;
      continue;
    }

    if (arg === '--user') {
      options.userOverride = rawArgs[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--password') {
      options.passwordOverride = rawArgs[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--database') {
      options.databaseOverride = rawArgs[index + 1];
      index += 1;
      continue;
    }

    throw new Error(`Unexpected argument: ${arg}`);
  }

  return options;
};

const run = async () => {
  const options = parseArgs();
  const appContext = await compileStrapi();
  const strapi = createStrapi(appContext);
  let importError;
  let result;

  try {
    await strapi.load();

    const { importLegacyBlogs } = await import('../dist/src/utils/legacy-blog-import.js');
    result = await importLegacyBlogs(strapi, options);

    console.log(JSON.stringify({ ok: true, dryRun: options.dryRun, ...result }, null, 2));
  } catch (error) {
    importError = error;
  } finally {
    try {
      await strapi.destroy();
    } catch (error) {
      if (!importError && error?.message !== 'aborted') {
        throw error;
      }
    }
  }

  if (importError) {
    throw importError;
  }
};

run().catch((error) => {
  const validationErrors = error?.details?.errors;

  if (Array.isArray(validationErrors) && validationErrors.length > 0) {
    console.error('Validation details:', JSON.stringify(validationErrors, null, 2));
  }

  console.error(error);
  process.exit(1);
});

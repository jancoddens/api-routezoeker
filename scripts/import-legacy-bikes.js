#!/usr/bin/env node

'use strict';

// --descriptions-path <map> (default: <legacy-root>/descriptions_bike): vult
// route.long_description aan vanuit descriptions_bike/<slug>.php wanneer een
// bestand matcht op de route-slug (dit veld werd voorheen nooit gezet).
// Kopieer descriptions_bike (met haar eigen images/ submap) eerst naar de VPS,
// als submap van --legacy-root.

const path = require('node:path');
const { compileStrapi, createStrapi } = require('@strapi/strapi');

const DEFAULT_LEGACY_ROOT = '/Users/jancoddens/Documents/Websites/Routezoeker.com/V4';
const legacyRoot = process.env.LEGACY_ROOT || DEFAULT_LEGACY_ROOT;
const configPath = process.env.LEGACY_CONFIG || path.join(legacyRoot, 'config.php');
const bikeTable = process.env.LEGACY_BIKE_TABLE;

const isShutdownAbortError = (error) => error?.message === 'aborted';

process.on('unhandledRejection', (error) => {
  if (isShutdownAbortError(error)) {
    return;
  }

  throw error;
});

const parseArgs = () => {
  const rawArgs = process.argv.slice(2);
  const options = {
    configPath,
    legacyRoot,
    locale: undefined,
    limit: undefined,
    offset: undefined,
    dryRun: false,
    descriptionsPath: undefined,
    hostOverride: undefined,
    portOverride: undefined,
    userOverride: undefined,
    passwordOverride: undefined,
    databaseOverride: undefined,
    bikeTable,
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];

    if (arg === '--dry-run') {
      options.dryRun = true;
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

    if (arg === '--config') {
      options.configPath = rawArgs[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--legacy-root') {
      options.legacyRoot = rawArgs[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--descriptions-path') {
      options.descriptionsPath = rawArgs[index + 1];
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

    if (arg === '--table' || arg === '--bike-table') {
      options.bikeTable = rawArgs[index + 1];
      index += 1;
      continue;
    }

    throw new Error(`Unexpected argument: ${arg}`);
  }

  // Standaard: descriptions_bike als submap van --legacy-root, zodat je enkel
  // die map naar de VPS moet kopiëren (naast config.php e.d.) zonder een
  // extra flag te moeten meegeven. Override met --descriptions-path als de
  // map ergens anders staat.
  if (options.descriptionsPath === undefined) {
    options.descriptionsPath = path.join(options.legacyRoot, 'descriptions_bike');
  }

  return options;
};

const run = async () => {
  const options = parseArgs();
  const appContext = await compileStrapi();
  const strapi = createStrapi(appContext);
  let importError;

  try {
    await strapi.load();

    const { importLegacyBikes } = await import('../dist/src/utils/legacy-bike-import.js');
    const result = await importLegacyBikes(strapi, options);

    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } catch (error) {
    importError = error;
  } finally {
    try {
      await strapi.destroy();
    } catch (error) {
      if (!importError && !isShutdownAbortError(error)) {
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

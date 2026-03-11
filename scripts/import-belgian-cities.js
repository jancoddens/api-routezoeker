#!/usr/bin/env node

'use strict';

const { compileStrapi, createStrapi } = require('@strapi/strapi');

const parseArgs = () => {
  const rawArgs = process.argv.slice(2);
  const options = {
    source: null,
    dryRun: false,
    locale: undefined,
    limit: undefined,
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
      const limit = Number(rawArgs[index + 1]);

      if (!Number.isInteger(limit) || limit <= 0) {
        throw new Error('Usage: npm run import:belgian-cities -- <source> [--dry-run] [--locale <code>] [--limit <n>]');
      }

      options.limit = limit;
      index += 1;
      continue;
    }

    if (!options.source) {
      options.source = arg;
      continue;
    }

    throw new Error(`Unexpected argument: ${arg}`);
  }

  if (!options.source) {
    throw new Error('Usage: npm run import:belgian-cities -- <source> [--dry-run] [--locale <code>] [--limit <n>]');
  }

  return options;
};

const run = async () => {
  const options = parseArgs();
  const appContext = await compileStrapi();
  const strapi = createStrapi(appContext);

  try {
    await strapi.load();

    const { importBelgianCities } = await import('../dist/src/utils/belgian-city-import.js');
    const result = await importBelgianCities(strapi, options.source, {
      dryRun: options.dryRun,
      locale: options.locale,
      limit: options.limit,
    });

    console.log(JSON.stringify({ ok: true, source: options.source, ...result }, null, 2));
  } finally {
    await strapi.destroy();
  }
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

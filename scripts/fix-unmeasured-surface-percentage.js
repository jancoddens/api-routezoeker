#!/usr/bin/env node

'use strict';

/**
 * Achtergrond
 * -----------
 * Op de route-detailpagina tonen we een "Verhard"-percentage
 * (route_start_locations[].surface_percentage_hard). In de praktijk is dat
 * veld voor elke route al ingevuld met een cijfer — nooit leeg — waardoor
 * "0%" niet meer te onderscheiden is van "nooit gemeten, per ongeluk op 0
 * gezet". Dit script zoekt alle routes met minstens één start_location op
 * exact 0% en zet die terug op leeg (null), zodat de site voortaan "Onbekend"
 * toont in plaats van een onbetrouwbare "0%".
 *
 * BELANGRIJK: dit overschrijft content. Als een route écht 0% verhard is
 * (bv. een volledig onverhard bospad), gaat die informatie na dit script
 * verloren en moet ze opnieuw manueel ingevuld worden. Bekijk daarom eerst
 * altijd het dry-run rapport voor je --apply gebruikt.
 *
 * Gebruik
 * -------
 *   node scripts/fix-unmeasured-surface-percentage.js
 *     -> dry run (standaard): toont enkel welke routes geraakt worden,
 *        wijzigt niets.
 *
 *   node scripts/fix-unmeasured-surface-percentage.js --apply
 *     -> voert de wijziging echt door.
 *
 *   node scripts/fix-unmeasured-surface-percentage.js --apply --locale nl
 *     -> beperk tot één locale (standaard: alle locales).
 *
 * Dit script moet draaien in een omgeving die verbonden is met de
 * PRODUCTIE-database van Strapi (dus met de juiste env-variabelen voor
 * DATABASE_*, niet de lokale sqlite dev-db).
 */

const { compileStrapi, createStrapi } = require('@strapi/strapi');

const isShutdownAbortError = (error) => error?.message === 'aborted';

process.on('unhandledRejection', (error) => {
  if (isShutdownAbortError(error)) return;
  console.error(error);
  process.exit(1);
});

const parseArgs = () => {
  const rawArgs = process.argv.slice(2);
  const options = {
    apply: false,
    locale: 'all',
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];

    if (arg === '--apply') {
      options.apply = true;
      continue;
    }

    if (arg === '--locale') {
      options.locale = rawArgs[index + 1];
      index += 1;
      continue;
    }

    throw new Error(`Onbekend argument: ${arg}`);
  }

  return options;
};

const PAGE_SIZE = 50;

const findAllRoutes = async (strapi, locale) => {
  const routes = [];
  let start = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const page = await strapi.entityService.findMany('api::route.route', {
      fields: ['title', 'slug', 'locale', 'publishedAt'],
      populate: {
        route_start_locations: true,
      },
      locale,
      start,
      limit: PAGE_SIZE,
    });

    if (!Array.isArray(page) || page.length === 0) break;

    routes.push(...page);
    start += PAGE_SIZE;

    if (page.length < PAGE_SIZE) break;
  }

  return routes;
};

const run = async () => {
  const options = parseArgs();
  const appContext = await compileStrapi();
  const strapi = createStrapi(appContext);
  let scriptError;

  try {
    await strapi.load();

    const routes = await findAllRoutes(strapi, options.locale);

    const affected = routes
      .map((route) => {
        const locations = Array.isArray(route.route_start_locations)
          ? route.route_start_locations
          : [];
        const zeroLocations = locations.filter(
          (location) => location.surface_percentage_hard === 0,
        );

        return { route, locations, zeroLocations };
      })
      .filter((entry) => entry.zeroLocations.length > 0);

    console.log(
      `Gevonden: ${affected.length} van ${routes.length} route-rijen (draft + published apart geteld) ` +
        'met minstens één start_location op exact 0% verhard.',
    );

    for (const { route, zeroLocations, locations } of affected) {
      const status = route.publishedAt ? 'published' : 'draft';
      console.log(
        `  [${route.id}] ${route.title ?? '(geen titel)'} (${route.slug ?? '-'}) ` +
          `locale=${route.locale ?? '-'} status=${status} ` +
          `${zeroLocations.length}/${locations.length} start_location(s) op 0%`,
      );
    }

    if (!options.apply) {
      console.log(
        '\nDry run — er is niets gewijzigd. Voeg --apply toe om deze routes echt bij te werken.',
      );
      return;
    }

    let updatedCount = 0;

    for (const { route, locations } of affected) {
      const updatedLocations = locations.map((location) =>
        location.surface_percentage_hard === 0
          ? { ...location, surface_percentage_hard: null }
          : location,
      );

      // eslint-disable-next-line no-await-in-loop
      await strapi.entityService.update('api::route.route', route.id, {
        data: {
          route_start_locations: updatedLocations,
        },
      });

      updatedCount += 1;
      console.log(`Bijgewerkt: [${route.id}] ${route.title ?? '(geen titel)'}`);
    }

    console.log(`\nKlaar. ${updatedCount} route-rijen bijgewerkt.`);
  } catch (error) {
    scriptError = error;
  } finally {
    try {
      await strapi.destroy();
    } catch (error) {
      if (!scriptError && !isShutdownAbortError(error)) {
        throw error;
      }
    }
  }

  if (scriptError) {
    throw scriptError;
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

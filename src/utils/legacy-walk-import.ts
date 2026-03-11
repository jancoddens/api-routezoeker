import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import mime from 'mime-types';
import type { Core } from '@strapi/strapi';

const execFileAsync = promisify(execFile);

type LegacyDbConfig = {
  host: string;
  user: string;
  password: string;
  database: string;
  port?: number;
};

type ImportOptions = {
  configPath: string;
  legacyRoot: string;
  locale?: string;
  limit?: number;
  dryRun?: boolean;
  hostOverride?: string;
  portOverride?: number;
  userOverride?: string;
  passwordOverride?: string;
  databaseOverride?: string;
};

type LegacyWalkRow = {
  ID: number;
  Titel: string | null;
  URL: string | null;
  Korte_omschrijving: string | null;
  Type: string | null;
  Aantal_km: string | number | null;
  Aantal_tijd: string | number | null;
  Moeilijkheid: string | number | null;
  Rolstoel: string | number | null;
  Hond: string | number | null;
  Buggy: string | number | null;
  Land: string | null;
  Provincie: string | null;
  Gemeente: string | null;
  Regio: string | null;
  Start_gemeente: string | null;
  Start_plaats: string | null;
  Eind_plaats: string | null;
  Cor1: string | number | null;
  Cor2: string | number | null;
  GPX: string | null;
  PDF: string | null;
  Knooppunten: string | null;
  Knooppunten_afstand: string | null;
  Afbeelding_large: string | null;
  Meta_title: string | null;
  Meta_description: string | null;
  Bordje: string | null;
  Sign: string | null;
  Color: string | null;
  Aangeboden: string | null;
  Virtueel: string | number | null;
  Aantal_verhard: string | number | null;
  Status: string | number | null;
};

type LegacyGpxRow = {
  Wid: number;
  Titel: string | null;
  Start_gemeente: string | null;
  Start_plaats: string | null;
  Cor1: string | number | null;
  Cor2: string | number | null;
  GPX: string | null;
};

type EntityReference = {
  id: number;
  name: string;
  slug: string;
  country?: { id: number } | null;
  province?: { id: number } | null;
  region?: { id: number } | null;
};

type UploadFileEntity = {
  id: number;
  name: string;
  url: string;
};

type ImportSummary = {
  total: number;
  created: number;
  updated: number;
  skipped: number;
};

const WALK_QUERY_COLUMNS = [
  'ID',
  'Titel',
  'URL',
  'Korte_omschrijving',
  'Type',
  'Aantal_km',
  'Aantal_tijd',
  'Moeilijkheid',
  'Rolstoel',
  'Hond',
  'Buggy',
  'Land',
  'Provincie',
  'Gemeente',
  'Regio',
  'Start_gemeente',
  'Start_plaats',
  'Eind_plaats',
  'Cor1',
  'Cor2',
  'GPX',
  'PDF',
  'Knooppunten',
  'Knooppunten_afstand',
  'Afbeelding_large',
  'Meta_title',
  'Meta_description',
  'Bordje',
  'Sign',
  'Color',
  'Aangeboden',
  'Virtueel',
  'Aantal_verhard',
  'Status',
];

const GPX_QUERY_COLUMNS = ['Wid', 'Titel', 'Start_gemeente', 'Start_plaats', 'Cor1', 'Cor2', 'GPX'];

const slugify = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const normalizeWhitespace = (value: string) => value.trim().replace(/\s+/g, ' ');

const toStringValue = (value: unknown) => {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = normalizeWhitespace(String(value));
  return normalized.length > 0 ? normalized : null;
};

const toNumberValue = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const normalized = Number(value.replace(',', '.').trim());
  return Number.isFinite(normalized) ? normalized : null;
};

const toBooleanValue = (value: unknown) => {
  if (typeof value === 'boolean') {
    return value;
  }

  const normalized = toStringValue(value)?.toLowerCase();

  if (!normalized) {
    return false;
  }

  return ['1', 'true', 'yes', 'ja', 'y'].includes(normalized);
};

const toBlocks = (text: string) =>
  text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => ({
      type: 'paragraph',
      children: [
        {
          type: 'text',
          text: paragraph,
        },
      ],
    }));

const mapDifficulty = (value: unknown) => {
  const numeric = toNumberValue(value);

  if (numeric === null) {
    return undefined;
  }

  if (numeric <= 2) {
    return 'easy';
  }

  if (numeric <= 4) {
    return 'moderate';
  }

  return 'hard';
};

const parseDurationMinutes = (value: unknown) => {
  const raw = toStringValue(value);

  if (!raw) {
    return null;
  }

  const colonMatch = raw.match(/^(\d{1,2}):(\d{1,2})$/);

  if (colonMatch) {
    return Number(colonMatch[1]) * 60 + Number(colonMatch[2]);
  }

  const hoursMatch = raw.match(/(\d+(?:[.,]\d+)?)\s*(u|uur|uren|h)\b/i);
  const minutesMatch = raw.match(/(\d+)\s*(min|mins|minuten|minute|m)\b/i);

  if (hoursMatch || minutesMatch) {
    const hours = hoursMatch ? Number(hoursMatch[1].replace(',', '.')) : 0;
    const minutes = minutesMatch ? Number(minutesMatch[1]) : 0;
    return Math.round(hours * 60 + minutes);
  }

  const compactHoursMinutes = raw.match(/^(\d{1,2})u(\d{1,2})$/i);

  if (compactHoursMinutes) {
    return Number(compactHoursMinutes[1]) * 60 + Number(compactHoursMinutes[2]);
  }

  const numeric = toNumberValue(raw);

  if (numeric === null) {
    return null;
  }

  if (numeric <= 12) {
    return Math.round(numeric * 60);
  }

  return Math.round(numeric);
};

const parsePhpConfig = async (configPath: string): Promise<LegacyDbConfig> => {
  const raw = await fs.readFile(configPath, 'utf8');
  const extract = (variable: string) =>
    raw.match(new RegExp(`\\$${variable}\\s*=\\s*'([^']*)'`, 'i'))?.[1] ?? null;

  const host = extract('dbhost');
  const user = extract('dbuser');
  const password = extract('dbpass');
  const database = extract('dbname');

  if (!host || !user || password === null || !database) {
    throw new Error(`Could not parse database credentials from ${configPath}`);
  }

  return {
    host,
    user,
    password,
    database,
  };
};

const escapeSqlString = (value: string) => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

const buildJsonSelect = (table: string, columns: string[], whereClause: string, limit?: number) => {
  const jsonPairs = columns
    .map((column) => `'${column}', ${column}`)
    .join(', ');

  return [
    `SELECT JSON_OBJECT(${jsonPairs})`,
    `FROM ${table}`,
    whereClause ? `WHERE ${whereClause}` : '',
    limit && limit > 0 ? `LIMIT ${limit}` : '',
  ]
    .filter(Boolean)
    .join(' ');
};

const runMysqlQuery = async (config: LegacyDbConfig, sql: string) => {
  const args = [
    '--batch',
    '--raw',
    '--skip-column-names',
    '-h',
    config.host,
    '-u',
    config.user,
    '-D',
    config.database,
    '-e',
    sql,
  ];

  if (config.port) {
    args.splice(6, 0, '-P', String(config.port));
  }

  const { stdout } = await execFileAsync('mysql', args, {
    env: {
      ...process.env,
      MYSQL_PWD: config.password,
    },
    maxBuffer: 1024 * 1024 * 50,
  });

  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
};

const findOneBySlugOrName = async (
  strapi: Core.Strapi,
  uid:
    | 'api::country.country'
    | 'api::province.province'
    | 'api::region.region'
    | 'api::city.city'
    | 'api::route-type.route-type'
    | 'api::route.route',
  slug: string,
  name: string,
  locale?: string
) => {
  const entries = await strapi.entityService.findMany(uid, {
    filters: {
      $or: [{ slug: { $eq: slug } }, { name: { $eq: name } }],
    },
    locale,
    limit: 1,
  });

  return Array.isArray(entries) ? ((entries[0] as unknown) as EntityReference | undefined) : undefined;
};

const ensureNamedEntity = async (
  strapi: Core.Strapi,
  uid:
    | 'api::country.country'
    | 'api::province.province'
    | 'api::region.region'
    | 'api::city.city'
    | 'api::route-type.route-type',
  name: string,
  extraData: Record<string, unknown>,
  locale?: string,
  dryRun?: boolean
) => {
  const slug = slugify(name);
  const existing = await findOneBySlugOrName(strapi, uid, slug, name, locale);

  if (existing || dryRun) {
    return existing ?? { id: 0, name, slug };
  }

  return (await strapi.entityService.create(uid, {
    data: {
      name,
      slug,
      publishedAt: new Date().toISOString(),
      ...extraData,
    } as never,
    locale,
  })) as EntityReference;
};

const uploadLocalFile = async (
  strapi: Core.Strapi,
  absolutePath: string,
  mediaName: string,
  dryRun?: boolean
) => {
  if (dryRun) {
    return null;
  }

  const stats = await fs.stat(absolutePath);
  const existing = await strapi.db.query('plugin::upload.file').findOne({
    where: {
      name: mediaName,
      size: Math.round((stats.size / 1024) * 1000) / 1000,
    },
  });

  if (existing) {
    return existing as UploadFileEntity;
  }

  const uploaded = await strapi.plugin('upload').service('upload').upload({
    data: {},
    files: {
      filepath: absolutePath,
      originalFilename: path.basename(absolutePath),
      mimetype: mime.lookup(absolutePath) || 'application/octet-stream',
      size: stats.size,
    },
  });

  return Array.isArray(uploaded) ? (uploaded[0] as UploadFileEntity | undefined) ?? null : null;
};

const findExistingRoute = async (strapi: Core.Strapi, slug: string, title: string, locale?: string) => {
  const entries = await strapi.entityService.findMany('api::route.route', {
    filters: {
      $or: [{ slug: { $eq: slug } }, { title: { $eq: title } }],
    },
    populate: {
      cover_image: true,
      pdf: true,
      route_start_locations: {
        populate: {
          gpx_file: true,
        },
      },
    },
    locale,
    limit: 1,
  });

  return Array.isArray(entries) ? (entries[0] as Record<string, unknown> | undefined) : undefined;
};

const resolveLegacyFile = async (root: string, folder: string, fileName: string | null) => {
  const normalized = toStringValue(fileName);

  if (!normalized) {
    return null;
  }

  const fullPath = path.join(root, folder, normalized);

  try {
    await fs.access(fullPath);
    return fullPath;
  } catch {
    return null;
  }
};

const dedupeStartLocations = (locations: Array<Record<string, unknown>>) => {
  const seen = new Set<string>();

  return locations.filter((location) => {
    const key = JSON.stringify([
      location.name ?? '',
      location.gpx_file ?? '',
      location.address ?? {},
    ]);

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
};

export const importLegacyWalks = async (
  strapi: Core.Strapi,
  options: ImportOptions
): Promise<ImportSummary> => {
  const dbConfig = await parsePhpConfig(options.configPath);
  const config: LegacyDbConfig = {
    host: options.hostOverride ?? dbConfig.host,
    user: options.userOverride ?? dbConfig.user,
    password: options.passwordOverride ?? dbConfig.password,
    database: options.databaseOverride ?? dbConfig.database,
    port: options.portOverride ?? dbConfig.port,
  };

  const walks = (await runMysqlQuery(
    config,
    buildJsonSelect(
      'Wandelingen',
      WALK_QUERY_COLUMNS,
      "Status = 1 AND URL != ''",
      options.limit
    )
  )) as LegacyWalkRow[];
  const gpxRows = (await runMysqlQuery(
    config,
    buildJsonSelect('GPX', GPX_QUERY_COLUMNS, 'Wid IS NOT NULL')
  )) as LegacyGpxRow[];
  const gpxByWalkId = new Map<number, LegacyGpxRow[]>();

  for (const row of gpxRows) {
    const walkId = Number(row.Wid);

    if (!Number.isFinite(walkId)) {
      continue;
    }

    const existing = gpxByWalkId.get(walkId) ?? [];
    existing.push(row);
    gpxByWalkId.set(walkId, existing);
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const walk of walks) {
    const title = toStringValue(walk.Titel);
    const slug = toStringValue(walk.URL);

    if (!title || !slug) {
      skipped += 1;
      continue;
    }

    const countryName = toStringValue(walk.Land);
    const provinceName = toStringValue(walk.Provincie);
    const cityName = toStringValue(walk.Gemeente);
    const regionName = toStringValue(walk.Regio);
    const startCityName = toStringValue(walk.Start_gemeente) ?? cityName;
    const routeTypeName = toStringValue(walk.Type);

    const country = countryName
      ? await ensureNamedEntity(strapi, 'api::country.country', countryName, {}, options.locale, options.dryRun)
      : null;
    const province = provinceName
      ? await ensureNamedEntity(
          strapi,
          'api::province.province',
          provinceName,
          {
            country: country?.id ?? null,
          },
          options.locale,
          options.dryRun
        )
      : null;
    const region = regionName
      ? await ensureNamedEntity(
          strapi,
          'api::region.region',
          regionName,
          {
            country: country?.id ?? null,
          },
          options.locale,
          options.dryRun
        )
      : null;
    const city = cityName
      ? await ensureNamedEntity(
          strapi,
          'api::city.city',
          cityName,
          {
            country: country?.id ?? null,
            province: province?.id ?? null,
            region: region?.id ?? null,
          },
          options.locale,
          options.dryRun
        )
      : null;
    const startCity =
      startCityName && startCityName !== cityName
        ? await ensureNamedEntity(
            strapi,
            'api::city.city',
            startCityName,
            {
              country: country?.id ?? null,
              province: province?.id ?? null,
              region: region?.id ?? null,
            },
            options.locale,
            options.dryRun
          )
        : city;
    const routeType = routeTypeName
      ? await ensureNamedEntity(
          strapi,
          'api::route-type.route-type',
          routeTypeName,
          {},
          options.locale,
          options.dryRun
        )
      : null;

    const imagePath = await resolveLegacyFile(options.legacyRoot, 'images/wandelingen', walk.Afbeelding_large);
    const pdfPath = await resolveLegacyFile(options.legacyRoot, 'pdf', walk.PDF);
    const primaryGpxPath = await resolveLegacyFile(options.legacyRoot, 'gpx', walk.GPX);
    const coverImage = imagePath
      ? await uploadLocalFile(strapi, imagePath, path.basename(imagePath), options.dryRun)
      : null;
    const pdfFile = pdfPath
      ? await uploadLocalFile(strapi, pdfPath, path.basename(pdfPath), options.dryRun)
      : null;

    const startLocations = [];
    const primaryStartLocationGpx = primaryGpxPath
      ? await uploadLocalFile(strapi, primaryGpxPath, path.basename(primaryGpxPath), options.dryRun)
      : null;

    startLocations.push({
      name: toStringValue(walk.Start_plaats) ?? undefined,
      address: {
        latitude: toNumberValue(walk.Cor1),
        longitude: toNumberValue(walk.Cor2),
        city: startCity?.id ?? null,
        province: province?.id ?? null,
        country: country?.id ?? null,
        region: region?.id ?? null,
      },
      gpx_file: primaryStartLocationGpx?.id ?? null,
      distance_km: toNumberValue(walk.Aantal_km),
      duration_minutes: parseDurationMinutes(walk.Aantal_tijd),
      surface_percentage_hard: toNumberValue(walk.Aantal_verhard),
      read_out_gpx: false,
    });

    for (const gpxRow of gpxByWalkId.get(Number(walk.ID)) ?? []) {
      const gpxPath = await resolveLegacyFile(options.legacyRoot, 'gpx', gpxRow.GPX);
      const gpxFile = gpxPath
        ? await uploadLocalFile(strapi, gpxPath, path.basename(gpxPath), options.dryRun)
        : null;

      startLocations.push({
        name: toStringValue(gpxRow.Start_plaats) ?? toStringValue(gpxRow.Titel) ?? undefined,
        address: {
          latitude: toNumberValue(gpxRow.Cor1),
          longitude: toNumberValue(gpxRow.Cor2),
          city: startCity?.id ?? null,
          province: province?.id ?? null,
          country: country?.id ?? null,
          region: region?.id ?? null,
        },
        gpx_file: gpxFile?.id ?? null,
        distance_km: toNumberValue(walk.Aantal_km),
        duration_minutes: parseDurationMinutes(walk.Aantal_tijd),
        surface_percentage_hard: toNumberValue(walk.Aantal_verhard),
        read_out_gpx: false,
      });
    }

    const markingImagePath = await resolveLegacyFile(options.legacyRoot, 'images/wandelingen', walk.Bordje);
    const markingImage = markingImagePath
      ? await uploadLocalFile(strapi, markingImagePath, path.basename(markingImagePath), options.dryRun)
      : null;
    const routeMarkings: Array<Record<string, unknown>> = [];

    if (markingImage || toStringValue(walk.Sign) || toStringValue(walk.Color)) {
      routeMarkings.push({
        name: toStringValue(walk.Sign) ?? 'Bewegwijzering',
        marking_type: 'symbol',
        color: toStringValue(walk.Color) ?? undefined,
        image: markingImage?.id ?? null,
      });
    }

    if (toBooleanValue(walk.Virtueel)) {
      routeMarkings.push({
        name: 'Virtuele knooppunten',
        marking_type: 'knooppunten',
        color: toStringValue(walk.Color) ?? undefined,
      });
    }

    const description = toStringValue(walk.Korte_omschrijving);
    const routeData = {
      title,
      slug,
      description: description ? toBlocks(description) : undefined,
      difficulty: mapDifficulty(walk.Moeilijkheid),
      wheelchair_accessible: toBooleanValue(walk.Rolstoel),
      dog_friendly: toBooleanValue(walk.Hond),
      stroller_friendly: toBooleanValue(walk.Buggy),
      waymarked: routeMarkings.length > 0 || toStringValue(walk.Knooppunten) !== null,
      countries: country?.id ? { connect: [country.id] } : undefined,
      provinces: province?.id ? { connect: [province.id] } : undefined,
      cities: city?.id ? { connect: [city.id] } : undefined,
      region: region?.id ?? null,
      route_type: routeType?.id ? { connect: [routeType.id] } : undefined,
      route_start_locations: dedupeStartLocations(startLocations),
      route_end_location: toStringValue(walk.Eind_plaats)
        ? [
            {
              name: toStringValue(walk.Eind_plaats) ?? undefined,
            },
          ]
        : [],
      route_markings: routeMarkings,
      cover_image: coverImage?.id ?? null,
      pdf: pdfFile?.id ?? null,
      route_by: toStringValue(walk.Aangeboden) ?? undefined,
      seo:
        toStringValue(walk.Meta_title) || toStringValue(walk.Meta_description)
          ? {
              meta_title: toStringValue(walk.Meta_title) ?? undefined,
              meta_description: toStringValue(walk.Meta_description) ?? undefined,
            }
          : undefined,
      publishedAt: new Date().toISOString(),
    };

    const existingRoute = await findExistingRoute(strapi, slug, title, options.locale);

    if (options.dryRun) {
      if (existingRoute) {
        updated += 1;
      } else {
        created += 1;
      }
      continue;
    }

    if (existingRoute?.id) {
      await strapi.entityService.update('api::route.route', Number(existingRoute.id), {
        data: routeData as never,
        locale: options.locale,
      });
      updated += 1;
    } else {
      await strapi.entityService.create('api::route.route', {
        data: routeData as never,
        locale: options.locale,
      });
      created += 1;
    }
  }

  return {
    total: walks.length,
    created,
    updated,
    skipped,
  };
};

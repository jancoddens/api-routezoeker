import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import mime from 'mime-types';
import type { Core } from '@strapi/strapi';

const execFileAsync = promisify(execFile);

const formatCopyrightCaption = (copyright?: string | null) => {
  const normalized = copyright?.trim();

  if (!normalized) {
    return undefined;
  }

  return normalized.startsWith('©') ? normalized : `© ${normalized}`;
};

const sanitizeUploadFilename = (value: string) => {
  const normalized = path.basename(value).normalize('NFC');
  const originalExtension = path.extname(normalized);
  const sanitizedExtension = originalExtension.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '');
  const baseName = path.basename(normalized, originalExtension);
  const sanitizedBaseName = baseName
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const reservedWindowsName = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
  const safeBaseName =
    sanitizedBaseName && sanitizedBaseName !== '.' && sanitizedBaseName !== '..'
      ? reservedWindowsName.test(sanitizedBaseName)
        ? `${sanitizedBaseName}-file`
        : sanitizedBaseName
      : 'file';
  const maxBaseLength = Math.max(1, 255 - sanitizedExtension.length);

  return `${safeBaseName.slice(0, maxBaseLength)}${sanitizedExtension}` || 'file';
};

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
  offset?: number;
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
  Copywright: string | null;
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
  name?: string;
  slug: string;
  country?: { id: number } | null;
  province?: { id: number } | null;
  region?: { id: number } | null;
};

type UploadFileEntity = {
  id: number;
  name: string;
  url: string;
  size?: number | string | null;
  alternativeText?: string | null;
  caption?: string | null;
  copyright?: string | null;
  folder?: { id?: number | null } | number | null;
};

type UploadFolderEntity = {
  id: number;
  name: string;
};

type Coordinate = {
  latitude: number;
  longitude: number;
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
  'Copywright',
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

const decodeHtmlEntities = (value: string) =>
  value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');

const stripHtmlTags = (value: string) => normalizeWhitespace(decodeHtmlEntities(value.replace(/<[^>]+>/g, ' ')));

const normalizeHref = (href: string) => decodeHtmlEntities(href.trim());

const getLinkTarget = (href: string) => (/^https?:\/\//i.test(href) ? '_blank' : '_self');

const getLinkRel = (href: string) => (/^https?:\/\//i.test(href) ? 'noopener noreferrer' : '');

const htmlInlineToChildren = (value: string) => {
  const children: Array<Record<string, unknown>> = [];
  const linkPattern = /<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let lastIndex = 0;

  for (const match of value.matchAll(linkPattern)) {
    const index = match.index ?? 0;
    const before = stripHtmlTags(value.slice(lastIndex, index));

    if (before) {
      children.push({
        type: 'text',
        text: before,
      });
    }

    const href = normalizeHref(match[2] ?? '');
    const linkText = stripHtmlTags(match[3] ?? '');

    if (href && linkText) {
      children.push({
        type: 'link',
        url: href,
        target: getLinkTarget(href),
        rel: getLinkRel(href),
        children: [
          {
            type: 'text',
            text: linkText,
          },
        ],
      });
    } else if (linkText) {
      children.push({
        type: 'text',
        text: linkText,
      });
    }

    lastIndex = index + match[0].length;
  }

  const after = stripHtmlTags(value.slice(lastIndex));

  if (after) {
    children.push({
      type: 'text',
      text: after,
    });
  }

  return children.length > 0
    ? children
    : [
        {
          type: 'text',
          text: '',
        },
      ];
};

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

const htmlToBlocks = (value: string) =>
  value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<p[^>]*>/gi, '')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => ({
      type: 'paragraph',
      children: htmlInlineToChildren(paragraph),
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

const mapLegacyTypeTags = (value: string | null) => {
  const normalized = value?.trim().toLowerCase();

  if (!normalized) {
    return [];
  }

  const tags: string[] = [];

  if (normalized === 'city walk') {
    tags.push('Stadswandeling');
  }

  if (normalized === 'forrest walk' || normalized === 'forest walk') {
    tags.push('Boswandeling');
  }

  return tags;
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

const parseRouteNodes = (
  nodesValue: string | null,
  distancesValue: string | null,
  coordinatesByNodeNumber: Map<string, { latitude: number; longitude: number }>
) => {
  if (!nodesValue) {
    return [];
  }

  const nodeNumbers = Array.from(nodesValue.matchAll(/\d+[A-Za-z]?/g), (match) => match[0].trim()).filter(Boolean);

  if (nodeNumbers.length === 0) {
    return [];
  }

  const rawDistances = Array.from(
    (distancesValue ?? '').matchAll(/\d+(?:[.,]\d+)?/g),
    (match) => Number.parseFloat(match[0].replace(',', '.'))
  ).filter((value) => Number.isFinite(value));

  const cumulativeDistances =
    rawDistances.length === nodeNumbers.length
      ? rawDistances
      : rawDistances.length === nodeNumbers.length - 1
        ? rawDistances.reduce<number[]>((accumulator, distance, index) => {
            const previous = index === 0 ? 0 : accumulator[index];
            accumulator.push(previous + distance);
            return accumulator;
          }, [0])
        : rawDistances.length === 1 && nodeNumbers.length > 1
          ? Array.from({ length: nodeNumbers.length }, (_, index) =>
              index === 0 ? 0 : (rawDistances[0] / (nodeNumbers.length - 1)) * index
            )
          : Array.from({ length: nodeNumbers.length }, () => 0);

  return nodeNumbers.map((nodeNumber, index) => {
    const cumulativeDistanceKm = cumulativeDistances[index] ?? 0;
    const previousCumulativeDistanceKm = index === 0 ? 0 : cumulativeDistances[index - 1] ?? 0;
    const segmentDistanceKm = index === 0 ? 0 : cumulativeDistanceKm - previousCumulativeDistanceKm;
    const coordinates = coordinatesByNodeNumber.get(nodeNumber) ?? null;

    return {
      node_number: nodeNumber,
      label: nodeNumber,
      order: index + 1,
      segment_distance_km: Math.round(segmentDistanceKm * 100) / 100,
      cumulative_distance_km: Math.round(cumulativeDistanceKm * 100) / 100,
      latitude: coordinates?.latitude ?? null,
      longitude: coordinates?.longitude ?? null,
    };
  });
};

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

const distanceBetweenCoordinatesKm = (
  a: Coordinate,
  b: Coordinate
) => {
  const earthRadiusKm = 6371;
  const deltaLat = toRadians(b.latitude - a.latitude);
  const deltaLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);

  const haversine =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;

  return 2 * earthRadiusKm * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
};

const distanceBetweenCoordinatesMeters = (a: Coordinate, b: Coordinate) =>
  distanceBetweenCoordinatesKm(a, b) * 1000;

const buildCoordinateBounds = (coordinates: Coordinate[]) => {
  let minLatitude = Number.POSITIVE_INFINITY;
  let maxLatitude = Number.NEGATIVE_INFINITY;
  let minLongitude = Number.POSITIVE_INFINITY;
  let maxLongitude = Number.NEGATIVE_INFINITY;

  for (const coordinate of coordinates) {
    minLatitude = Math.min(minLatitude, coordinate.latitude);
    maxLatitude = Math.max(maxLatitude, coordinate.latitude);
    minLongitude = Math.min(minLongitude, coordinate.longitude);
    maxLongitude = Math.max(maxLongitude, coordinate.longitude);
  }

  if (!Number.isFinite(minLatitude) || !Number.isFinite(minLongitude)) {
    return null;
  }

  return {
    minLatitude,
    maxLatitude,
    minLongitude,
    maxLongitude,
  };
};

const distanceToRouteMeters = (candidate: Coordinate, routeCoordinates: Coordinate[]) => {
  if (routeCoordinates.length === 0) {
    return Number.POSITIVE_INFINITY;
  }

  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const routeCoordinate of routeCoordinates) {
    const distance = distanceBetweenCoordinatesMeters(candidate, routeCoordinate);

    if (distance < nearestDistance) {
      nearestDistance = distance;
    }
  }

  return nearestDistance;
};

const findNodeCoordinatesByNumber = async (
  strapi: Core.Strapi,
  nodeNumbers: string[],
  startCoordinate?: Coordinate | null,
  provinceId?: number | null,
  countryId?: number | null,
  routeCoordinates: Coordinate[] = []
) => {
  if (nodeNumbers.length === 0) {
    return new Map<string, Coordinate>();
  }

  const uniqueNodeNumbers = Array.from(new Set(nodeNumbers));
  const routeBounds = buildCoordinateBounds(routeCoordinates);
  const boundsPadding = 0.02;

  const findCandidates = async (filters: Record<string, unknown>) =>
    (await strapi.entityService.findMany('api::node.node', {
      filters,
      fields: ['number', 'latitude', 'longitude'],
      publicationState: 'preview',
      limit: uniqueNodeNumbers.length * 10,
    })) as Array<{ number?: string | null; latitude?: number | string | null; longitude?: number | string | null }>;

  let candidates = await findCandidates({
    number: {
      $in: uniqueNodeNumbers,
    },
    ...(routeBounds
      ? {
          latitude: {
            $gte: routeBounds.minLatitude - boundsPadding,
            $lte: routeBounds.maxLatitude + boundsPadding,
          },
          longitude: {
            $gte: routeBounds.minLongitude - boundsPadding,
            $lte: routeBounds.maxLongitude + boundsPadding,
          },
        }
      : {}),
    ...(provinceId
      ? {
          province: {
            id: provinceId,
          },
        }
      : {}),
    ...(countryId
      ? {
          country: {
            id: countryId,
          },
        }
      : {}),
  });

  if (candidates.length === 0) {
    candidates = await findCandidates({
      number: {
        $in: uniqueNodeNumbers,
      },
      ...(routeBounds
        ? {
            latitude: {
              $gte: routeBounds.minLatitude - boundsPadding,
              $lte: routeBounds.maxLatitude + boundsPadding,
            },
            longitude: {
              $gte: routeBounds.minLongitude - boundsPadding,
              $lte: routeBounds.maxLongitude + boundsPadding,
            },
          }
        : {}),
    });
  }

  if (candidates.length === 0) {
    candidates = await findCandidates({
      number: {
        $in: uniqueNodeNumbers,
      },
    });
  }

  const candidatesByNodeNumber = new Map<string, Coordinate[]>();

  for (const candidate of candidates) {
    const nodeNumber = toStringValue(candidate.number);
    const latitude =
      typeof candidate.latitude === 'number' ? candidate.latitude : toNumberValue(candidate.latitude);
    const longitude =
      typeof candidate.longitude === 'number' ? candidate.longitude : toNumberValue(candidate.longitude);

    if (!nodeNumber || latitude === null || longitude === null) {
      continue;
    }

    const existing = candidatesByNodeNumber.get(nodeNumber) ?? [];

    existing.push({
      latitude: Math.round(latitude * 1_000_000) / 1_000_000,
      longitude: Math.round(longitude * 1_000_000) / 1_000_000,
    });
    candidatesByNodeNumber.set(nodeNumber, existing);
  }

  const coordinatesByNodeNumber = new Map<string, { latitude: number; longitude: number }>();

  for (const [nodeNumber, nodeCandidates] of candidatesByNodeNumber) {
    if (nodeCandidates.length === 1 || !startCoordinate) {
      coordinatesByNodeNumber.set(nodeNumber, nodeCandidates[0]);
      continue;
    }

    let bestCandidate = nodeCandidates[0];
    let bestRouteDistance = Number.POSITIVE_INFINITY;
    let bestStartDistance = Number.POSITIVE_INFINITY;

    for (const candidate of nodeCandidates) {
      const routeDistance = distanceToRouteMeters(candidate, routeCoordinates);
      const startDistance = startCoordinate
        ? distanceBetweenCoordinatesKm(startCoordinate, candidate)
        : Number.POSITIVE_INFINITY;

      if (
        routeDistance < bestRouteDistance ||
        (routeDistance === bestRouteDistance && startDistance < bestStartDistance)
      ) {
        bestRouteDistance = routeDistance;
        bestStartDistance = startDistance;
        bestCandidate = candidate;
      }
    }

    coordinatesByNodeNumber.set(nodeNumber, bestCandidate);
  }

  return coordinatesByNodeNumber;
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

const buildJsonSelect = (
  table: string,
  columns: string[],
  whereClause: string,
  limit?: number,
  offset?: number,
  orderBy?: string
) => {
  const jsonPairs = columns
    .map((column) => `'${column}', ${column}`)
    .join(', ');

  return [
    `SELECT JSON_OBJECT(${jsonPairs})`,
    `FROM ${table}`,
    whereClause ? `WHERE ${whereClause}` : '',
    orderBy ? `ORDER BY ${orderBy}` : '',
    limit && limit > 0 ? `LIMIT ${limit}` : '',
    offset && offset > 0 ? `OFFSET ${offset}` : '',
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

const runMysqlRawRows = async (config: LegacyDbConfig, sql: string) => {
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
    maxBuffer: 1024 * 1024 * 20,
  });

  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split('\t'));
};

const findOneBySlugOrName = async (
  strapi: Core.Strapi,
  uid:
    | 'api::country.country'
    | 'api::province.province'
    | 'api::region.region'
    | 'api::city.city'
    | 'api::tag.tag'
    | 'api::route-type.route-type'
    | 'api::route.route',
  slug: string,
  name: string,
  locale?: string
) => {
  const populateByUid: Partial<
    Record<
      | 'api::country.country'
      | 'api::province.province'
      | 'api::region.region'
      | 'api::city.city'
      | 'api::tag.tag'
      | 'api::route-type.route-type'
      | 'api::route.route',
      string[]
    >
  > = {
    'api::province.province': ['country'],
    'api::region.region': ['country'],
    'api::city.city': ['country', 'province', 'region'],
  };

  const entries = await strapi.entityService.findMany(uid, {
    filters: {
      $or: [{ slug: { $eq: slug } }, { name: { $eq: name } }],
    },
    ...(populateByUid[uid] ? { populate: populateByUid[uid] as never } : {}),
    locale,
    limit: 1,
  });

  return Array.isArray(entries) ? ((entries[0] as unknown) as EntityReference | undefined) : undefined;
};

const ensureThemeEntity = async (
  strapi: Core.Strapi,
  title: string,
  locale?: string,
  dryRun?: boolean
) => {
  const slug = slugify(title);
  const entries = await strapi.entityService.findMany('api::theme.theme', {
    filters: {
      $or: [{ slug: { $eq: slug } }, { title: { $eq: title } }],
    },
    locale,
    limit: 1,
  });
  const existing = Array.isArray(entries) ? ((entries[0] as unknown) as EntityReference | undefined) : undefined;

  if (existing || dryRun) {
    return existing ?? { id: 0, name: title, slug };
  }

  return (await strapi.entityService.create('api::theme.theme', {
    data: {
      title,
      slug,
      publishedAt: new Date().toISOString(),
    } as never,
    locale,
  })) as EntityReference;
};

const ensureNamedEntity = async (
  strapi: Core.Strapi,
  uid:
    | 'api::country.country'
    | 'api::province.province'
    | 'api::region.region'
    | 'api::city.city'
    | 'api::tag.tag'
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

  return ((await strapi.entityService.create(uid, {
    data: {
      name,
      slug,
      publishedAt: new Date().toISOString(),
      ...extraData,
    } as never,
    locale,
  })) as unknown) as EntityReference;
};

const uploadLocalFile = async (
  strapi: Core.Strapi,
  absolutePath: string,
  mediaName: string,
  folderName: string | null,
  alternativeText?: string | null,
  copyright?: string | null,
  dryRun?: boolean
) => {
  if (dryRun) {
    return null;
  }

  const sanitizedMediaName = sanitizeUploadFilename(mediaName);
  const sanitizedOriginalFilename = sanitizeUploadFilename(path.basename(absolutePath));
  const caption = formatCopyrightCaption(copyright);
  const stats = await fs.stat(absolutePath);
  const normalizedSize = Math.round((stats.size / 1024) * 1000) / 1000;
  const folder = folderName
    ? ((await strapi.db.query('plugin::upload.folder').findOne({
        where: {
          name: folderName,
        },
      })) as UploadFolderEntity | null)
    : null;
  const existingCandidates = (await strapi.db.query('plugin::upload.file').findMany({
    where: {
      name: sanitizedMediaName,
    },
    populate: {
      folder: true,
    },
  })) as UploadFileEntity[];
  const existing =
    existingCandidates.find((candidate) => {
      const candidateFolderId =
        typeof candidate.folder === 'object' ? candidate.folder?.id ?? null : candidate.folder ?? null;
      const candidateSize =
        typeof candidate.size === 'number' ? candidate.size : candidate.size ? Number(candidate.size) : null;

      return candidateFolderId === (folder?.id ?? null) && candidateSize === normalizedSize;
    }) ?? null;

  if (existing) {
    if (
      (alternativeText && existing.alternativeText !== alternativeText) ||
      (copyright && existing.copyright !== copyright) ||
      (caption && existing.caption !== caption)
    ) {
      await strapi.plugin('upload').service('upload').updateFileInfo(existing.id, {
        alternativeText,
        caption,
        folder: folder?.id,
      });
      if (copyright) {
        await strapi.db.query('plugin::upload.file').update({
          where: { id: existing.id },
          data: { copyright },
        });
      }
    }
    return existing as UploadFileEntity;
  }

  const uploaded = await strapi.plugin('upload').service('upload').upload({
    data: {
      fileInfo: {
        folder: folder?.id,
        alternativeText: alternativeText ?? undefined,
        caption,
      },
    },
    files: {
      filepath: absolutePath,
      originalFilename: sanitizedOriginalFilename,
      mimetype: mime.lookup(absolutePath) || 'application/octet-stream',
      size: stats.size,
    },
  });

  const uploadedFile = Array.isArray(uploaded) ? ((uploaded[0] as UploadFileEntity | undefined) ?? null) : null;

  if (uploadedFile?.id && copyright) {
    await strapi.db.query('plugin::upload.file').update({
      where: { id: uploadedFile.id },
      data: { copyright },
    });
    uploadedFile.copyright = copyright;
  }

  if (uploadedFile && caption) {
    uploadedFile.caption = caption;
  }

  return uploadedFile;
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

  const candidateNames = Array.from(
    new Set(
      [normalized, path.basename(normalized)]
        .map((value) => value.trim())
        .filter(Boolean)
    )
  );

  for (const candidateName of candidateNames) {
    const fullPath = path.join(root, folder, candidateName);

    try {
      await fs.access(fullPath);
      return fullPath;
    } catch {
      continue;
    }
  }

  try {
    const entries = await fs.readdir(path.join(root, folder));
    const lowerCaseEntries = new Map(entries.map((entry) => [entry.toLowerCase(), entry]));

    for (const candidateName of candidateNames) {
      const matchedEntry = lowerCaseEntries.get(candidateName.toLowerCase());

      if (matchedEntry) {
        return path.join(root, folder, matchedEntry);
      }
    }
  } catch {
    return null;
  }

  return null;
};

const readGpxWaypointCoordinates = async (absolutePath: string | null) => {
  if (!absolutePath) {
    return new Map<string, Coordinate>();
  }

  const xml = await fs.readFile(absolutePath, 'utf8');
  const matches = xml.matchAll(/<wpt\b([^>]*)>([\s\S]*?)<\/wpt>/gi);
  const coordinatesByNodeNumber = new Map<string, Coordinate>();

  for (const [, attrs, inner] of matches) {
    const latitudeMatch = attrs.match(/\blat=["']([^"']+)["']/i);
    const longitudeMatch = attrs.match(/\blon=["']([^"']+)["']/i);
    const nameMatch = inner.match(/<name\b[^>]*>([\s\S]*?)<\/name>/i);
    const nodeNumber = toStringValue(decodeHtmlEntities(nameMatch?.[1] ?? ''));
    const latitude = toNumberValue(latitudeMatch?.[1]);
    const longitude = toNumberValue(longitudeMatch?.[1]);

    if (!nodeNumber || latitude === null || longitude === null || coordinatesByNodeNumber.has(nodeNumber)) {
      continue;
    }

    coordinatesByNodeNumber.set(nodeNumber, {
      latitude: Math.round(latitude * 1_000_000) / 1_000_000,
      longitude: Math.round(longitude * 1_000_000) / 1_000_000,
    });
  }

  return coordinatesByNodeNumber;
};

const readGpxRouteCoordinates = async (absolutePath: string | null) => {
  if (!absolutePath) {
    return [];
  }

  const xml = await fs.readFile(absolutePath, 'utf8');
  const matches = xml.matchAll(/<(trkpt|rtept)\b([^>]*)>/gi);
  const coordinates: Coordinate[] = [];

  for (const [, , attrs] of matches) {
    const latitudeMatch = attrs.match(/\blat=["']([^"']+)["']/i);
    const longitudeMatch = attrs.match(/\blon=["']([^"']+)["']/i);
    const latitude = toNumberValue(latitudeMatch?.[1]);
    const longitude = toNumberValue(longitudeMatch?.[1]);

    if (latitude === null || longitude === null) {
      continue;
    }

    coordinates.push({
      latitude: Math.round(latitude * 1_000_000) / 1_000_000,
      longitude: Math.round(longitude * 1_000_000) / 1_000_000,
    });
  }

  return coordinates;
};

const getExistingTableColumns = async (config: LegacyDbConfig, tableName: string) => {
  try {
    const rows = await runMysqlRawRows(config, `SHOW COLUMNS FROM ${tableName}`);
    return rows.map((row) => row[0]).filter(Boolean);
  } catch {
    return [];
  }
};

const pickExistingColumn = (columns: string[], candidates: string[]) => {
  const existingColumns = new Map(columns.map((column) => [column.toLowerCase(), column]));

  for (const candidate of candidates) {
    const match = existingColumns.get(candidate.toLowerCase());

    if (match) {
      return match;
    }
  }

  return null;
};

const findLegacyWalkNodeCoordinates = async (config: LegacyDbConfig, walkId: number) => {
  const tableName = 'Wandeling_knooppunten';
  const columns = await getExistingTableColumns(config, tableName);

  if (columns.length === 0) {
    return new Map<string, { latitude: number; longitude: number }>();
  }

  const walkIdColumn = pickExistingColumn(columns, ['Wid', 'wid', 'wandeling_id', 'walk_id', 'route_id']);
  const nodeNumberColumn = pickExistingColumn(columns, ['Knooppunt', 'knooppunt', 'node_number', 'number', 'nr']);
  const latitudeColumn = pickExistingColumn(columns, ['Latitude', 'latitude', 'lat', 'Cor1', 'y']);
  const longitudeColumn = pickExistingColumn(columns, ['Longitude', 'longitude', 'lng', 'lon', 'Cor2', 'x']);
  const orderColumn = pickExistingColumn(columns, ['Volgorde', 'volgorde', 'order', 'position', 'positie']);

  if (!walkIdColumn || !nodeNumberColumn || !latitudeColumn || !longitudeColumn) {
    return new Map<string, { latitude: number; longitude: number }>();
  }

  const selectedColumns = [walkIdColumn, nodeNumberColumn, latitudeColumn, longitudeColumn];

  if (orderColumn) {
    selectedColumns.push(orderColumn);
  }

  try {
    const rows = (await runMysqlQuery(
      config,
      buildJsonSelect(
        tableName,
        selectedColumns,
        `${walkIdColumn} = ${Number(walkId)}`,
        undefined,
        undefined,
        orderColumn ? `${orderColumn} ASC` : undefined
      )
    )) as Array<Record<string, unknown>>;

    const coordinatesByNodeNumber = new Map<string, { latitude: number; longitude: number }>();

    for (const row of rows) {
      const nodeNumber = toStringValue(row[nodeNumberColumn]);
      const latitude = toNumberValue(row[latitudeColumn]);
      const longitude = toNumberValue(row[longitudeColumn]);

      if (!nodeNumber || latitude === null || longitude === null || coordinatesByNodeNumber.has(nodeNumber)) {
        continue;
      }

      coordinatesByNodeNumber.set(nodeNumber, {
        latitude: Math.round(latitude * 1_000_000) / 1_000_000,
        longitude: Math.round(longitude * 1_000_000) / 1_000_000,
      });
    }

    return coordinatesByNodeNumber;
  } catch {
    return new Map<string, { latitude: number; longitude: number }>();
  }
};

const normalizeLocationName = (value: unknown) => slugify(toStringValue(value) ?? '');

const roundCoordinate = (value: unknown) => {
  const numeric = toNumberValue(value);
  return numeric === null ? null : Number(numeric.toFixed(5));
};

const stripUndefinedDeep = <T>(value: T): T => {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is NonNullable<typeof item> => item !== undefined)
      .map((item) => stripUndefinedDeep(item)) as T;
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .map(([key, entryValue]) => [key, stripUndefinedDeep(entryValue)])
    ) as T;
  }

  return value;
};

const dedupeStartLocations = (locations: Array<Record<string, unknown>>) => {
  const merged = new Map<string, Record<string, unknown>>();

  for (const location of locations) {
    const address =
      location.address && typeof location.address === 'object'
        ? (location.address as Record<string, unknown>)
        : {};
    const key = JSON.stringify([
      normalizeLocationName(location.name),
      roundCoordinate(address.latitude),
      roundCoordinate(address.longitude),
      address.city ?? null,
    ]);
    const existing = merged.get(key);

    if (!existing) {
      merged.set(key, location);
      continue;
    }

    const existingAddress =
      existing.address && typeof existing.address === 'object'
        ? (existing.address as Record<string, unknown>)
        : {};

    merged.set(key, {
      ...existing,
      ...location,
      name: toStringValue(existing.name) ?? toStringValue(location.name) ?? undefined,
      gpx_file: existing.gpx_file ?? location.gpx_file ?? null,
      address: {
        ...existingAddress,
        ...address,
        latitude: existingAddress.latitude ?? address.latitude ?? null,
        longitude: existingAddress.longitude ?? address.longitude ?? null,
        city: existingAddress.city ?? address.city ?? null,
        province: existingAddress.province ?? address.province ?? null,
        country: existingAddress.country ?? address.country ?? null,
        region: existingAddress.region ?? address.region ?? null,
      },
    });
  }

  return [...merged.values()];
};

const buildStartAddress = (
  city: EntityReference | null,
  province: EntityReference | null,
  region: EntityReference | null,
  country: EntityReference | null,
  latitude: unknown,
  longitude: unknown
) => {
  const resolvedProvinceId = city?.province?.id ?? province?.id ?? null;
  const resolvedRegionId = city?.region?.id ?? region?.id ?? null;
  const resolvedCountryId =
    city?.country?.id ??
    province?.country?.id ??
    region?.country?.id ??
    country?.id ??
    null;

  return {
    latitude: toNumberValue(latitude),
    longitude: toNumberValue(longitude),
    city: city?.id ?? null,
    province: resolvedProvinceId,
    country: resolvedCountryId,
    region: resolvedRegionId,
  };
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
      options.limit,
      options.offset,
      'ID ASC'
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
    const walkingTheme = await ensureThemeEntity(strapi, 'Wandelen', options.locale, options.dryRun);

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
          {
            theme: walkingTheme?.id ?? null,
          },
          options.locale,
          options.dryRun
        )
      : null;
    const tagNames = mapLegacyTypeTags(routeTypeName);

    if (toStringValue(walk.Knooppunten)) {
      tagNames.push('Knooppunten');
    }

    const uniqueTagNames = Array.from(new Set(tagNames));
    const tags = [];

    for (const tagName of uniqueTagNames) {
      const tag = await ensureNamedEntity(strapi, 'api::tag.tag', tagName, {}, options.locale, options.dryRun);
      if (tag?.id) {
        tags.push(tag.id);
      }
    }

    const imagePath = await resolveLegacyFile(options.legacyRoot, 'images/wandelingen', walk.Afbeelding_large);
    const pdfPath = await resolveLegacyFile(options.legacyRoot, 'pdf', walk.PDF);
    const primaryGpxPath = await resolveLegacyFile(options.legacyRoot, 'gpx', walk.GPX);
    const additionalGpxRows = gpxByWalkId.get(Number(walk.ID)) ?? [];
    const coverImage = imagePath
      ? await uploadLocalFile(
          strapi,
          imagePath,
          path.basename(imagePath),
          'routes',
          title,
          toStringValue(walk.Copywright),
          options.dryRun
        )
      : null;
    const pdfFile = pdfPath
      ? await uploadLocalFile(strapi, pdfPath, path.basename(pdfPath), 'routes', null, null, options.dryRun)
      : null;

    const startLocations = [];
    const primaryStartLocationGpx = primaryGpxPath
      ? await uploadLocalFile(strapi, primaryGpxPath, path.basename(primaryGpxPath), 'gpx', null, null, options.dryRun)
      : null;
    const primaryGpxBaseName = primaryGpxPath ? path.basename(primaryGpxPath).toLowerCase() : null;

    startLocations.push({
      name: toStringValue(walk.Start_plaats) ?? undefined,
      address: buildStartAddress(startCity, province, region, country, walk.Cor1, walk.Cor2),
      gpx_file: primaryStartLocationGpx?.id ?? null,
      distance_km: toNumberValue(walk.Aantal_km),
      duration_minutes: parseDurationMinutes(walk.Aantal_tijd),
      surface_percentage_hard: toNumberValue(walk.Aantal_verhard),
      read_out_gpx: false,
    });

    for (const gpxRow of additionalGpxRows) {
      const gpxRowName = toStringValue(gpxRow.GPX);

      if (primaryGpxBaseName && gpxRowName && path.basename(gpxRowName).toLowerCase() === primaryGpxBaseName) {
        continue;
      }

      const gpxStartCityName = toStringValue(gpxRow.Start_gemeente) ?? startCityName;
      const gpxStartCity =
        gpxStartCityName && gpxStartCityName !== startCityName
          ? await ensureNamedEntity(
              strapi,
              'api::city.city',
              gpxStartCityName,
              {
                country: country?.id ?? null,
                province: province?.id ?? null,
                region: region?.id ?? null,
              },
              options.locale,
              options.dryRun
            )
          : startCity;
      const gpxPath = await resolveLegacyFile(options.legacyRoot, 'gpx', gpxRow.GPX);
      const gpxFile = gpxPath
        ? await uploadLocalFile(strapi, gpxPath, path.basename(gpxPath), 'gpx', null, null, options.dryRun)
        : null;

      startLocations.push({
        name: toStringValue(gpxRow.Start_plaats) ?? toStringValue(gpxRow.Titel) ?? undefined,
        address: buildStartAddress(gpxStartCity, province, region, country, gpxRow.Cor1, gpxRow.Cor2),
        gpx_file: gpxFile?.id ?? null,
        distance_km: toNumberValue(walk.Aantal_km),
        duration_minutes: parseDurationMinutes(walk.Aantal_tijd),
        surface_percentage_hard: toNumberValue(walk.Aantal_verhard),
        read_out_gpx: false,
      });
    }

    const markingImagePath = await resolveLegacyFile(options.legacyRoot, 'images/wandelingen', walk.Bordje);
    const markingImage = markingImagePath
      ? await uploadLocalFile(
          strapi,
          markingImagePath,
          path.basename(markingImagePath),
          'signs',
          `routebord ${title}`,
          null,
          options.dryRun
        )
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
    const blocksDescription = description ? htmlToBlocks(description) : null;
    const rawKnooppunten = toStringValue(walk.Knooppunten);
    const rawKnooppuntenAfstand = toStringValue(walk.Knooppunten_afstand);
    const parsedNodeNumbers = Array.from(
      (rawKnooppunten ?? '').matchAll(/\d+[A-Za-z]?/g),
      (match) => match[0].trim()
    ).filter(Boolean);
    const startCoordinate = {
      latitude: toNumberValue(walk.Cor1),
      longitude: toNumberValue(walk.Cor2),
    };
    const gpxCoordinatesByNodeNumber = new Map<string, { latitude: number; longitude: number }>();
    const gpxRouteCoordinates: Coordinate[] = [];
    const gpxPathsForNodeMatching = [primaryGpxPath];

    for (const gpxRow of additionalGpxRows) {
      const gpxPath = await resolveLegacyFile(options.legacyRoot, 'gpx', gpxRow.GPX);

      if (gpxPath) {
        gpxPathsForNodeMatching.push(gpxPath);
      }
    }

    for (const gpxPath of Array.from(new Set(gpxPathsForNodeMatching.filter(Boolean)))) {
      const gpxCoordinates = await readGpxWaypointCoordinates(gpxPath);
      const gpxRoutePoints = await readGpxRouteCoordinates(gpxPath);

      for (const [nodeNumber, coordinates] of gpxCoordinates) {
        if (!gpxCoordinatesByNodeNumber.has(nodeNumber)) {
          gpxCoordinatesByNodeNumber.set(nodeNumber, coordinates);
        }
      }

      gpxRouteCoordinates.push(...gpxRoutePoints);
    }

    const nodeTableCoordinatesByNodeNumber = await findNodeCoordinatesByNumber(
      strapi,
      parsedNodeNumbers,
      startCoordinate.latitude !== null && startCoordinate.longitude !== null ? startCoordinate : null,
      province?.id ?? null,
      country?.id ?? null,
      gpxRouteCoordinates
    );

    const legacyTableCoordinatesByNodeNumber = await findLegacyWalkNodeCoordinates(config, Number(walk.ID));
    const mergedCoordinatesByNodeNumber = new Map<string, { latitude: number; longitude: number }>();

    for (const nodeNumber of parsedNodeNumbers) {
      const coordinates =
        gpxCoordinatesByNodeNumber.get(nodeNumber) ??
        legacyTableCoordinatesByNodeNumber.get(nodeNumber) ??
        nodeTableCoordinatesByNodeNumber.get(nodeNumber) ??
        null;

      if (coordinates) {
        mergedCoordinatesByNodeNumber.set(nodeNumber, coordinates);
      }
    }

    const routeNodes = parseRouteNodes(rawKnooppunten, rawKnooppuntenAfstand, mergedCoordinatesByNodeNumber);
    const routeData = stripUndefinedDeep({
      title,
      slug,
      description: blocksDescription && blocksDescription.length > 0 ? blocksDescription : undefined,
      difficulty: mapDifficulty(walk.Moeilijkheid),
      wheelchair_accessible: toBooleanValue(walk.Rolstoel),
      dog_friendly: toBooleanValue(walk.Hond),
      stroller_friendly: toBooleanValue(walk.Buggy),
      waymarked: routeMarkings.length > 0 || rawKnooppunten !== null,
      countries: country?.id ? { connect: [country.id] } : undefined,
      provinces: province?.id ? { connect: [province.id] } : undefined,
      cities: city?.id ? { connect: [city.id] } : undefined,
      region: region?.id ?? null,
      theme: walkingTheme?.id ?? null,
      route_type: routeType?.id ? [routeType.id] : undefined,
      tags: tags.length > 0 ? { connect: tags } : undefined,
      route_start_locations: dedupeStartLocations(startLocations),
      route_nodes: routeNodes,
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
      knooppunten: rawKnooppunten ?? undefined,
      knooppunten_afstand: rawKnooppuntenAfstand ?? undefined,
      seo:
        toStringValue(walk.Meta_title) || toStringValue(walk.Meta_description)
          ? {
              meta_title: toStringValue(walk.Meta_title) ?? undefined,
              meta_description: toStringValue(walk.Meta_description) ?? undefined,
            }
          : undefined,
      publishedAt: new Date().toISOString(),
    });

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

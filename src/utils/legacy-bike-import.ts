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
  bikeTable?: string;
};

type LegacyBikeRow = {
  ID: number;
  Titel: string | null;
  URL: string | null;
  Korte_omschrijving: string | null;
  Long_description: string | null;
  Type: string | null;
  Etappes: string | null;
  Aantal_km: string | number | null;
  Aantal_tijd: string | number | null;
  Moeilijkheid: string | number | null;
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
  Aantal_verhard: string | number | null;
  Openbaar_vervoer: string | null;
  T_Bewegwijzerd: string | number | null;
  T_Knooppunten: string | number | null;
  T_Stadsfietstocht: string | number | null;
  Status: string | number | null;
};

type LegacyGpxRow = {
  BikeId: number;
  Titel: string | null;
  Start_gemeente: string | null;
  Start_plaats: string | null;
  Cor1: string | number | null;
  Cor2: string | number | null;
  GPX: string | null;
};

type LegacyBikeNetworkRow = {
  BikeId: number;
  legacyNetworkId: number;
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

const MAX_NODE_DISTANCE_FROM_ROUTE_METERS = 250;

type LegacyBikeNode = Coordinate & {
  id?: number;
  nodeNumber: string;
};

const BIKE_QUERY_COLUMNS = [
  'ID',
  'Titel',
  'URL',
  'Korte_omschrijving',
  'Long_description',
  'Type',
  'Etappes',
  'Aantal_km',
  'Aantal_tijd',
  'Moeilijkheid',
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
  'Aantal_verhard',
  'Openbaar_vervoer',
  'T_Bewegwijzerd',
  'T_Knooppunten',
  'T_Stadsfietstocht',
  'Status',
];

const slugify = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const canonicalCountrySlug = (value: string | null) => {
  const normalized = value ? slugify(value) : null;

  if (!normalized) {
    return null;
  }

  if (['belgie', 'belgie', 'belgium', 'be'].includes(normalized)) {
    return 'belgie';
  }

  if (['nederland', 'netherlands', 'holland', 'nl'].includes(normalized)) {
    return 'nederland';
  }

  return normalized;
};

const normalizeLegacyProvinceName = (provinceName: string | null, countryName: string | null) => {
  if (!provinceName) {
    return null;
  }

  const normalizedProvinceSlug = slugify(provinceName);
  const normalizedCountrySlug = canonicalCountrySlug(countryName);

  if (normalizedProvinceSlug === 'limburg' && normalizedCountrySlug === 'belgie') {
    return 'Limburg Vlaanderen';
  }

  return provinceName;
};

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

  if (normalized === 'city bike' || normalized === 'stadsfietsroute') {
    tags.push('Stadsfietsroute');
  }

  if (normalized === 'forrest bike' || normalized === 'forest bike' || normalized === 'bosfietsroute') {
    tags.push('Bosfietsroute');
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

const buildCumulativeDistancesFromSegments = (distances: number[]) =>
  distances.reduce<number[]>((accumulator, distance, index) => {
    const previous = index === 0 ? 0 : accumulator[index];
    accumulator.push(previous + distance);
    return accumulator;
  }, [0]);

const normalizeNodeDistances = (
  rawDistances: number[],
  nodeCount: number,
  expectedTotalDistanceKm?: number | null
) => {
  if (nodeCount === 0) {
    return [] as number[];
  }

  const candidates: number[][] = [];
  const monotonicRawDistances = rawDistances.every((value, index) => index === 0 || value >= rawDistances[index - 1]);

  if (rawDistances.length === nodeCount) {
    candidates.push(rawDistances);

    if ((rawDistances[0] ?? 0) > 0) {
      candidates.push([0, ...rawDistances.slice(0, -1)]);
    }
  } else if (rawDistances.length === nodeCount - 1) {
    candidates.push(buildCumulativeDistancesFromSegments(rawDistances));

    if (monotonicRawDistances) {
      candidates.push([0, ...rawDistances]);
    }
  } else if (rawDistances.length === 1 && nodeCount > 1) {
    candidates.push(
      Array.from({ length: nodeCount }, (_, index) =>
        index === 0 ? 0 : (rawDistances[0] / (nodeCount - 1)) * index
      )
    );
  } else {
    candidates.push(Array.from({ length: nodeCount }, () => 0));
  }

  const scaleFactors = [1, 0.1, 0.01, 0.001];
  let bestCandidate = candidates[0];
  let bestScore = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    for (const scaleFactor of scaleFactors) {
      const scaledCandidate = candidate.map((value) => value * scaleFactor);
      const firstDistancePenalty = Math.abs(scaledCandidate[0] ?? 0) * 5;
      const finalDistance = scaledCandidate[scaledCandidate.length - 1] ?? 0;
      const totalDistancePenalty =
        typeof expectedTotalDistanceKm === 'number' && Number.isFinite(expectedTotalDistanceKm) && expectedTotalDistanceKm > 0
          ? Math.abs(finalDistance - expectedTotalDistanceKm)
          : finalDistance;
      const score = firstDistancePenalty + totalDistancePenalty;

      if (score < bestScore) {
        bestScore = score;
        bestCandidate = scaledCandidate;
      }
    }
  }

  return bestCandidate;
};

const parseNodeSequence = (
  nodesValue: string | null,
  distancesValue: string | null,
  expectedTotalDistanceKm?: number | null
) => {
  if (!nodesValue) {
    return {
      nodeNumbers: [] as string[],
      cumulativeDistances: [] as number[],
    };
  }

  const nodeNumbers = Array.from(nodesValue.matchAll(/\d+[A-Za-z]?/g), (match) => match[0].trim()).filter(Boolean);

  if (nodeNumbers.length === 0) {
    return {
      nodeNumbers,
      cumulativeDistances: [] as number[],
    };
  }

  const rawDistances = Array.from(
    (distancesValue ?? '').matchAll(/\d+(?:[.,]\d+)?/g),
    (match) => Number.parseFloat(match[0].replace(',', '.'))
  ).filter((value) => Number.isFinite(value));

  const cumulativeDistances = normalizeNodeDistances(
    rawDistances,
    nodeNumbers.length,
    expectedTotalDistanceKm
  );

  return {
    nodeNumbers,
    cumulativeDistances,
  };
};

const parseRouteNodes = (
  nodesValue: string | null,
  distancesValue: string | null,
  coordinatesByNodeIndex: Array<Coordinate | null>,
  expectedTotalDistanceKm?: number | null
) => {
  const { nodeNumbers, cumulativeDistances } = parseNodeSequence(
    nodesValue,
    distancesValue,
    expectedTotalDistanceKm
  );

  if (nodeNumbers.length === 0) {
    return [];
  }

  return nodeNumbers.map((nodeNumber, index) => {
    const cumulativeDistanceKm = cumulativeDistances[index] ?? 0;
    const previousCumulativeDistanceKm = index === 0 ? 0 : cumulativeDistances[index - 1] ?? 0;
    const segmentDistanceKm = index === 0 ? 0 : cumulativeDistanceKm - previousCumulativeDistanceKm;
    const coordinates = coordinatesByNodeIndex[index] ?? null;

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

const getNearestRoutePointMatch = (candidate: Coordinate, routeCoordinates: Coordinate[]) => {
  let nearestDistance = Number.POSITIVE_INFINITY;
  let nearestIndex = -1;

  for (let index = 0; index < routeCoordinates.length; index += 1) {
    const distance = distanceBetweenCoordinatesMeters(candidate, routeCoordinates[index]);

    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  }

  return {
    routeDistanceMeters: nearestDistance,
    routeIndex: nearestIndex,
  };
};

type RouteNodeCandidate = Coordinate & {
  routeDistanceMeters: number;
  routeIndex: number;
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
    return new Map<string, RouteNodeCandidate[]>();
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

  const candidatesByNodeNumber = new Map<string, RouteNodeCandidate[]>();

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

    const routeMatch = getNearestRoutePointMatch(
      {
        latitude: Math.round(latitude * 1_000_000) / 1_000_000,
        longitude: Math.round(longitude * 1_000_000) / 1_000_000,
      },
      routeCoordinates
    );

    existing.push({
      latitude: Math.round(latitude * 1_000_000) / 1_000_000,
      longitude: Math.round(longitude * 1_000_000) / 1_000_000,
      routeDistanceMeters: routeMatch.routeDistanceMeters,
      routeIndex: routeMatch.routeIndex,
    });
    candidatesByNodeNumber.set(nodeNumber, existing);
  }

  return candidatesByNodeNumber;
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

const escapeSqlIdentifier = (value: string) => `\`${value.replace(/`/g, '``')}\``;

const buildJsonSelect = (
  table: string,
  columns: string[],
  whereClause: string,
  limit?: number,
  offset?: number,
  orderBy?: string
) => {
  const jsonPairs = columns
    .map((column) => `'${column}', ${escapeSqlIdentifier(column)}`)
    .join(', ');

  return [
    `SELECT JSON_OBJECT(${jsonPairs})`,
    `FROM ${escapeSqlIdentifier(table)}`,
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

const getExistingTableNames = async (config: LegacyDbConfig) => {
  try {
    const rows = await runMysqlRawRows(config, 'SHOW TABLES');
    return rows.map((row) => row[0]).filter(Boolean);
  } catch {
    return [];
  }
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
  extraData: Record<string, unknown>,
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

  const relationFilters: Record<string, unknown>[] = [];

  for (const relationName of ['country', 'province', 'region'] as const) {
    const relationId = extraData[relationName];

    if (typeof relationId !== 'number') {
      continue;
    }

    relationFilters.push({
      [relationName]: {
        id: {
          $eq: relationId,
        },
      },
    });
  }

  const entries = await strapi.entityService.findMany(uid, {
    filters:
      relationFilters.length > 0
        ? {
            $and: [
              {
                $or: [{ slug: { $eq: slug } }, { name: { $eq: name } }],
              },
              ...relationFilters,
            ],
          }
        : {
            $or: [{ slug: { $eq: slug } }, { name: { $eq: name } }],
          },
    ...(populateByUid[uid] ? { populate: populateByUid[uid] as never } : {}),
    locale,
    limit: 1,
  });

  return Array.isArray(entries) ? ((entries[0] as unknown) as EntityReference | undefined) : undefined;
};

const isUniqueConstraintError = (error: unknown) =>
  Boolean(error && typeof error === 'object' && (error as { name?: string }).name === 'YupValidationError') &&
  Array.isArray((error as { details?: { errors?: Array<{ message?: string }> } }).details?.errors) &&
  ((error as { details?: { errors?: Array<{ message?: string }> } }).details?.errors ?? []).some((entry) =>
    String(entry?.message ?? '').toLowerCase().includes('unique')
  );

const findOneBySlugOrNameRelaxed = async (
  strapi: Core.Strapi,
  uid:
    | 'api::country.country'
    | 'api::province.province'
    | 'api::region.region'
    | 'api::city.city'
    | 'api::tag.tag'
    | 'api::route-type.route-type',
  slug: string,
  name: string,
  locale?: string
) => findOneBySlugOrName(strapi, uid, slug, name, {}, locale);

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
  const existing = await findOneBySlugOrName(strapi, uid, slug, name, extraData, locale);
  const relaxedExisting = existing ?? (await findOneBySlugOrNameRelaxed(strapi, uid, slug, name, locale));

  if (relaxedExisting || dryRun) {
    return relaxedExisting ?? { id: 0, name, slug };
  }

  try {
    return ((await strapi.entityService.create(uid, {
      data: {
        name,
        slug,
        publishedAt: new Date().toISOString(),
        ...extraData,
      } as never,
      locale,
    })) as unknown) as EntityReference;
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const relaxedMatch = await findOneBySlugOrNameRelaxed(strapi, uid, slug, name, locale);

      if (relaxedMatch) {
        strapi.log.warn(
          `[legacy-bike-import] Reused existing ${uid} after unique collision for name="${name}" slug="${slug}"`
        );
        return relaxedMatch;
      }

      strapi.log.error(
        `[legacy-bike-import] Unique collision creating ${uid} name="${name}" slug="${slug}" extra=${JSON.stringify(extraData)}`
      );
    }

    throw error;
  }
};

const findNamedEntity = async (
  strapi: Core.Strapi,
  uid:
    | 'api::country.country'
    | 'api::province.province'
    | 'api::region.region'
    | 'api::city.city',
  name: string,
  extraData: Record<string, unknown>,
  locale?: string
) => {
  const slug = slugify(name);

  return (
    (await findOneBySlugOrName(strapi, uid, slug, name, extraData, locale)) ??
    (await findOneBySlugOrNameRelaxed(strapi, uid, slug, name, locale)) ??
    null
  );
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

const buildRouteDistanceIndex = (routeCoordinates: Coordinate[]) => {
  if (routeCoordinates.length === 0) {
    return [];
  }

  let cumulativeDistanceKm = 0;

  return routeCoordinates.map((coordinate, index) => {
    if (index > 0) {
      cumulativeDistanceKm += distanceBetweenCoordinatesKm(routeCoordinates[index - 1], coordinate);
    }

    return cumulativeDistanceKm;
  });
};

const findExactLegacyNodeSequence = (expectedNodeNumbers: string[], legacyNodes: LegacyBikeNode[]) => {
  if (expectedNodeNumbers.length === 0 || legacyNodes.length < expectedNodeNumbers.length) {
    return null;
  }

  for (let startIndex = 0; startIndex <= legacyNodes.length - expectedNodeNumbers.length; startIndex += 1) {
    let matches = true;

    for (let offset = 0; offset < expectedNodeNumbers.length; offset += 1) {
      if (legacyNodes[startIndex + offset]?.nodeNumber !== expectedNodeNumbers[offset]) {
        matches = false;
        break;
      }
    }

    if (matches) {
      return legacyNodes.slice(startIndex, startIndex + expectedNodeNumbers.length);
    }
  }

  return null;
};

const buildSequentialRouteNodeCoordinates = (
  nodeNumbers: string[],
  cumulativeDistances: number[],
  startCoordinate: Coordinate | null,
  routeCoordinates: Coordinate[],
  gpxCoordinatesByNodeNumber: Map<string, Coordinate>,
  legacyTableCoordinatesByNodeNumber: Map<string, Coordinate>,
  dbCandidatesByNodeNumber: Map<string, RouteNodeCandidate[]>
) => {
  const matchedCoordinates: Array<Coordinate | null> = [];
  let previousCoordinate = startCoordinate;
  let previousRouteIndex = 0;
  const routeIndexTolerance = 5;
  const routeDistanceIndex = buildRouteDistanceIndex(routeCoordinates);

  for (let index = 0; index < nodeNumbers.length; index += 1) {
    const nodeNumber = nodeNumbers[index];
    const expectedDistanceKm = cumulativeDistances[index] ?? null;
    const directCoordinate =
      gpxCoordinatesByNodeNumber.get(nodeNumber) ?? legacyTableCoordinatesByNodeNumber.get(nodeNumber) ?? null;

    if (directCoordinate) {
      matchedCoordinates.push(directCoordinate);

      if (routeCoordinates.length > 0) {
        const directRouteMatch = getNearestRoutePointMatch(directCoordinate, routeCoordinates);

        if (directRouteMatch.routeIndex >= 0) {
          previousRouteIndex = directRouteMatch.routeIndex;
        }
      }

      previousCoordinate = directCoordinate;
      continue;
    }

    const allCandidates = dbCandidatesByNodeNumber.get(nodeNumber) ?? [];
    const candidatesNearRoute = allCandidates.filter(
      (candidate) =>
        routeCoordinates.length === 0 ||
        !Number.isFinite(candidate.routeDistanceMeters) ||
        candidate.routeDistanceMeters <= MAX_NODE_DISTANCE_FROM_ROUTE_METERS
    );
    const candidates = candidatesNearRoute.length > 0 ? candidatesNearRoute : allCandidates;

    if (candidates.length === 0) {
      matchedCoordinates.push(null);
      continue;
    }

    const candidatePool =
      routeCoordinates.length > 0
        ? candidates.filter((candidate) => candidate.routeIndex >= previousRouteIndex - routeIndexTolerance)
        : candidates;
    const scopedCandidates = candidatePool.length > 0 ? candidatePool : candidates;

    const sortedCandidates = [...scopedCandidates].sort((a, b) => {
      const aExpectedDistanceDelta =
        expectedDistanceKm !== null && routeDistanceIndex[a.routeIndex] !== undefined
          ? Math.abs(routeDistanceIndex[a.routeIndex] - expectedDistanceKm)
          : Number.POSITIVE_INFINITY;
      const bExpectedDistanceDelta =
        expectedDistanceKm !== null && routeDistanceIndex[b.routeIndex] !== undefined
          ? Math.abs(routeDistanceIndex[b.routeIndex] - expectedDistanceKm)
          : Number.POSITIVE_INFINITY;

      if (index === 0) {
        const aStartDistance = startCoordinate
          ? distanceBetweenCoordinatesMeters(startCoordinate, a)
          : Number.POSITIVE_INFINITY;
        const bStartDistance = startCoordinate
          ? distanceBetweenCoordinatesMeters(startCoordinate, b)
          : Number.POSITIVE_INFINITY;

        if (aStartDistance !== bStartDistance) {
          return aStartDistance - bStartDistance;
        }

        if (routeCoordinates.length > 0 && a.routeIndex !== b.routeIndex) {
          return a.routeIndex - b.routeIndex;
        }

        if (aExpectedDistanceDelta !== bExpectedDistanceDelta) {
          return aExpectedDistanceDelta - bExpectedDistanceDelta;
        }

        return a.routeDistanceMeters - b.routeDistanceMeters;
      }

      const aPreviousDistance = previousCoordinate
        ? distanceBetweenCoordinatesMeters(previousCoordinate, a)
        : Number.POSITIVE_INFINITY;
      const bPreviousDistance = previousCoordinate
        ? distanceBetweenCoordinatesMeters(previousCoordinate, b)
        : Number.POSITIVE_INFINITY;

      if (aPreviousDistance !== bPreviousDistance) {
        return aPreviousDistance - bPreviousDistance;
      }

      if (aExpectedDistanceDelta !== bExpectedDistanceDelta) {
        return aExpectedDistanceDelta - bExpectedDistanceDelta;
      }

      if (routeCoordinates.length > 0 && a.routeIndex !== b.routeIndex) {
        return a.routeIndex - b.routeIndex;
      }

      return a.routeDistanceMeters - b.routeDistanceMeters;
    });

    const bestCandidate = sortedCandidates[0] ?? null;

    if (!bestCandidate) {
      matchedCoordinates.push(null);
      continue;
    }

    matchedCoordinates.push(bestCandidate);
    previousCoordinate = bestCandidate;

    if (routeCoordinates.length > 0 && bestCandidate.routeIndex >= 0) {
      previousRouteIndex = bestCandidate.routeIndex;
    }
  }

  return matchedCoordinates;
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

const findLegacyBikeNodes = async (config: LegacyDbConfig, bikeId: number) => {
  const tableName = 'Fietsroute_knooppunten';
  const columns = await getExistingTableColumns(config, tableName);

  if (columns.length === 0) {
    return [] as LegacyBikeNode[];
  }

  const bikeIdColumn = pickExistingColumn(columns, [
    'Fid',
    'fid',
    'fietsroute_id',
    'fiets_id',
    'bike_id',
    'route_id',
    'Wid',
    'wid',
  ]);
  const rowIdColumn = pickExistingColumn(columns, ['id', 'ID']);
  const nodeNumberColumn = pickExistingColumn(columns, ['Knooppunt', 'knooppunt', 'node_number', 'number', 'nr']);
  const latitudeColumn = pickExistingColumn(columns, ['Latitude', 'latitude', 'lat', 'Cor1', 'y']);
  const longitudeColumn = pickExistingColumn(columns, ['Longitude', 'longitude', 'lng', 'lon', 'Cor2', 'x']);
  const orderColumn = pickExistingColumn(columns, ['Volgorde', 'volgorde', 'order', 'position', 'positie']);

  if (!bikeIdColumn || !nodeNumberColumn || !latitudeColumn || !longitudeColumn) {
    return [] as LegacyBikeNode[];
  }

  const selectedColumns = [bikeIdColumn, nodeNumberColumn, latitudeColumn, longitudeColumn];

  if (rowIdColumn) {
    selectedColumns.push(rowIdColumn);
  }

  if (orderColumn) {
    selectedColumns.push(orderColumn);
  }

  try {
    const rows = (await runMysqlQuery(
      config,
      buildJsonSelect(
        tableName,
        selectedColumns,
        `${bikeIdColumn} = ${Number(bikeId)}`,
        undefined,
        undefined,
        orderColumn ? `${orderColumn} ASC` : rowIdColumn ? `${rowIdColumn} ASC` : undefined
      )
    )) as Array<Record<string, unknown>>;

    const nodes: LegacyBikeNode[] = [];

    for (const row of rows) {
      const nodeNumber = toStringValue(row[nodeNumberColumn]);
      const latitude = toNumberValue(row[latitudeColumn]);
      const longitude = toNumberValue(row[longitudeColumn]);

      if (!nodeNumber || latitude === null || longitude === null) {
        continue;
      }

      nodes.push({
        id: rowIdColumn ? toNumberValue(row[rowIdColumn]) ?? undefined : undefined,
        nodeNumber,
        latitude: Math.round(latitude * 1_000_000) / 1_000_000,
        longitude: Math.round(longitude * 1_000_000) / 1_000_000,
      });
    }

    return nodes;
  } catch {
    return [] as LegacyBikeNode[];
  }
};

const findLegacyBikeGpxRows = async (config: LegacyDbConfig) => {
  const tableName = 'GPX';
  const columns = await getExistingTableColumns(config, tableName);

  if (columns.length === 0) {
    return [] as LegacyGpxRow[];
  }

  const bikeIdColumn = pickExistingColumn(columns, [
    'Fid',
    'fid',
    'fietsroute_id',
    'fiets_id',
    'bike_id',
    'route_id',
    'Wid',
    'wid',
  ]);

  if (!bikeIdColumn) {
    return [] as LegacyGpxRow[];
  }

  const titleColumn = pickExistingColumn(columns, ['Titel', 'title', 'Name', 'name']);
  const startCityColumn = pickExistingColumn(columns, ['Start_gemeente', 'start_gemeente', 'Gemeente']);
  const startPlaceColumn = pickExistingColumn(columns, ['Start_plaats', 'start_plaats', 'Start']);
  const latitudeColumn = pickExistingColumn(columns, ['Cor1', 'Latitude', 'latitude', 'lat', 'y']);
  const longitudeColumn = pickExistingColumn(columns, ['Cor2', 'Longitude', 'longitude', 'lng', 'lon', 'x']);
  const gpxColumn = pickExistingColumn(columns, ['GPX', 'gpx', 'Name_GPX', 'name_gpx']);
  const selectedColumns = Array.from(
    new Set(
      [
        bikeIdColumn,
        titleColumn,
        startCityColumn,
        startPlaceColumn,
        latitudeColumn,
        longitudeColumn,
        gpxColumn,
      ].filter(Boolean) as string[]
    )
  );

  try {
    const rows = (await runMysqlQuery(
      config,
      buildJsonSelect(tableName, selectedColumns, `${bikeIdColumn} IS NOT NULL`)
    )) as Array<Record<string, unknown>>;

    return rows
      .map((row) => ({
        BikeId: Number(row[bikeIdColumn]),
        Titel: titleColumn ? toStringValue(row[titleColumn]) : null,
        Start_gemeente: startCityColumn ? toStringValue(row[startCityColumn]) : null,
        Start_plaats: startPlaceColumn ? toStringValue(row[startPlaceColumn]) : null,
        Cor1: latitudeColumn ? row[latitudeColumn] : null,
        Cor2: longitudeColumn ? row[longitudeColumn] : null,
        GPX: gpxColumn ? toStringValue(row[gpxColumn]) : null,
      }))
      .filter((row) => Number.isFinite(row.BikeId) && row.GPX) as LegacyGpxRow[];
  } catch {
    return [] as LegacyGpxRow[];
  }
};

const findLegacyBikeNetworkRows = async (config: LegacyDbConfig) => {
  const tableName = 'Fietsnetwerken_route';
  const columns = await getExistingTableColumns(config, tableName);

  if (columns.length === 0) {
    return [] as LegacyBikeNetworkRow[];
  }

  const bikeIdColumn = pickExistingColumn(columns, [
    'Fid',
    'fid',
    'fietsroute_id',
    'fiets_id',
    'bike_id',
    'route_id',
    'Wid',
    'wid',
  ]);
  const networkIdColumn = pickExistingColumn(columns, [
    'FNid',
    'fnid',
    'fietsnetwerk_id',
    'node_network_id',
    'network_id',
    'WNid',
    'wnid',
  ]);

  if (!bikeIdColumn || !networkIdColumn) {
    return [] as LegacyBikeNetworkRow[];
  }

  try {
    const rows = (await runMysqlQuery(
      config,
      buildJsonSelect(
        tableName,
        [bikeIdColumn, networkIdColumn],
        `${bikeIdColumn} IS NOT NULL AND ${networkIdColumn} IS NOT NULL`
      )
    )) as Array<Record<string, unknown>>;

    return rows
      .map((row) => ({
        BikeId: Number(row[bikeIdColumn]),
        legacyNetworkId: Number(row[networkIdColumn]),
      }))
      .filter((row) => Number.isFinite(row.BikeId) && Number.isFinite(row.legacyNetworkId));
  } catch {
    return [] as LegacyBikeNetworkRow[];
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

export const importLegacyBikes = async (
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

  const bikes = (await runMysqlQuery(
    config,
    buildJsonSelect(
      options.bikeTable ?? 'Fietsen',
      BIKE_QUERY_COLUMNS,
      "`Status` = 1 AND `URL` != ''",
      options.limit,
      options.offset,
      '`ID` ASC'
    )
  )) as LegacyBikeRow[];
  const gpxRows = await findLegacyBikeGpxRows(config);
  const bikeNetworkRows = await findLegacyBikeNetworkRows(config);
  const gpxByBikeId = new Map<number, LegacyGpxRow[]>();
  const nodeNetworkIdByLegacyId = new Map<number, number>();
  const bikeNetworkLegacyIdByBikeId = new Map<number, number>();

  const nodeNetworks = (await strapi.entityService.findMany('api::node-network.node-network', {
    fields: ['id', 'source_config'],
    publicationState: 'preview',
    locale: options.locale,
    limit: 500,
  })) as Array<{ id: number; source_config?: { legacyId?: unknown } | null }>;

  for (const nodeNetwork of nodeNetworks) {
    const legacyId =
      nodeNetwork.source_config &&
      typeof nodeNetwork.source_config === 'object' &&
      typeof nodeNetwork.source_config.legacyId === 'number'
        ? nodeNetwork.source_config.legacyId
        : null;

    if (legacyId !== null) {
      nodeNetworkIdByLegacyId.set(legacyId, nodeNetwork.id);
    }
  }

  for (const row of gpxRows) {
    const bikeId = Number(row.BikeId);

    if (!Number.isFinite(bikeId)) {
      continue;
    }

    const existing = gpxByBikeId.get(bikeId) ?? [];
    existing.push(row);
    gpxByBikeId.set(bikeId, existing);
  }

  for (const row of bikeNetworkRows) {
    const bikeId = Number(row.BikeId);
    const legacyNodeNetworkId = Number(row.legacyNetworkId);

    if (!Number.isFinite(bikeId) || !Number.isFinite(legacyNodeNetworkId) || bikeNetworkLegacyIdByBikeId.has(bikeId)) {
      continue;
    }

    bikeNetworkLegacyIdByBikeId.set(bikeId, legacyNodeNetworkId);
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const bike of bikes) {
    const title = toStringValue(bike.Titel);
    const rawSlug = toStringValue(bike.URL);
    const slug = rawSlug ? slugify(rawSlug) : null;

    if (!title || !slug) {
      skipped += 1;
      continue;
    }

    const countryName = toStringValue(bike.Land);
    const provinceName = normalizeLegacyProvinceName(toStringValue(bike.Provincie), countryName);
    const cityName = toStringValue(bike.Gemeente);
    const regionName = toStringValue(bike.Regio);
    const startCityName = toStringValue(bike.Start_gemeente) ?? cityName;
    const routeTypeName = toStringValue(bike.Type);
    const cyclingTheme = await ensureThemeEntity(strapi, 'Fietsen', options.locale, options.dryRun);

    const country = countryName ? await findNamedEntity(strapi, 'api::country.country', countryName, {}, options.locale) : null;
    const province = provinceName
      ? await findNamedEntity(
          strapi,
          'api::province.province',
          provinceName,
          {
            country: country?.id ?? null,
          },
          options.locale
        )
      : null;
    const region = regionName
      ? await findNamedEntity(
          strapi,
          'api::region.region',
          regionName,
          {
            country: country?.id ?? null,
          },
          options.locale
        )
      : null;
    const city = cityName
      ? await findNamedEntity(
          strapi,
          'api::city.city',
          cityName,
          {
            country: country?.id ?? null,
            province: province?.id ?? null,
            region: region?.id ?? null,
          },
          options.locale
        )
      : null;
    const startCity =
      startCityName && startCityName !== cityName
        ? await findNamedEntity(
            strapi,
            'api::city.city',
            startCityName,
            {
              country: country?.id ?? null,
              province: province?.id ?? null,
              region: region?.id ?? null,
            },
            options.locale
          )
        : city;
    const routeType = routeTypeName
      ? await ensureNamedEntity(
          strapi,
          'api::route-type.route-type',
          routeTypeName,
          {
            theme: cyclingTheme?.id ?? null,
          },
          options.locale,
          options.dryRun
        )
      : null;
    const tagNames = mapLegacyTypeTags(routeTypeName);

    if (toStringValue(bike.Knooppunten) || toBooleanValue(bike.T_Knooppunten)) {
      tagNames.push('Knooppunten');
    }

    if (toBooleanValue(bike.T_Stadsfietstocht)) {
      tagNames.push('Stadsfietsroute');
    }

    const uniqueTagNames = Array.from(new Set(tagNames));
    const tags = [];

    for (const tagName of uniqueTagNames) {
      const tag = await ensureNamedEntity(strapi, 'api::tag.tag', tagName, {}, options.locale, options.dryRun);
      if (tag?.id) {
        tags.push(tag.id);
      }
    }

    const imagePath = await resolveLegacyFile(options.legacyRoot, 'images/fietsroutes', bike.Afbeelding_large);
    const pdfPath = await resolveLegacyFile(options.legacyRoot, 'pdf', bike.PDF);
    const primaryGpxPath = await resolveLegacyFile(options.legacyRoot, 'gpx', bike.GPX);
    const additionalGpxRows = gpxByBikeId.get(Number(bike.ID)) ?? [];
    const coverImage = imagePath
      ? await uploadLocalFile(
          strapi,
          imagePath,
          path.basename(imagePath),
          'routes',
          title,
          toStringValue(bike.Copywright),
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
      name: toStringValue(bike.Start_plaats) ?? undefined,
      address: buildStartAddress(startCity, province, region, country, bike.Cor1, bike.Cor2),
      gpx_file: primaryStartLocationGpx?.id ?? null,
      distance_km: toNumberValue(bike.Aantal_km),
      duration_minutes: parseDurationMinutes(bike.Aantal_tijd),
      surface_percentage_hard: toNumberValue(bike.Aantal_verhard),
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
          ? await findNamedEntity(
              strapi,
              'api::city.city',
              gpxStartCityName,
              {
                country: country?.id ?? null,
                province: province?.id ?? null,
                region: region?.id ?? null,
              },
              options.locale
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
        distance_km: toNumberValue(bike.Aantal_km),
        duration_minutes: parseDurationMinutes(bike.Aantal_tijd),
        surface_percentage_hard: toNumberValue(bike.Aantal_verhard),
        read_out_gpx: false,
      });
    }

    const markingImagePath = await resolveLegacyFile(options.legacyRoot, 'images/fietsroutes', bike.Bordje);
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
    const signName = toStringValue(bike.Sign);
    const hasNodeMarking = toBooleanValue(bike.T_Knooppunten);
    const signIsNodeMarking = signName ? slugify(signName) === 'knooppunten' : false;
    const shouldAddSymbolMarking =
      Boolean(markingImage) ||
      (!hasNodeMarking && (Boolean(signName) || Boolean(toStringValue(bike.Color)) || toBooleanValue(bike.T_Bewegwijzerd))) ||
      (hasNodeMarking && Boolean(signName) && !signIsNodeMarking);

    if (shouldAddSymbolMarking) {
      routeMarkings.push({
        name: signName ?? 'Bewegwijzering',
        marking_type: 'symbol',
        color: toStringValue(bike.Color) ?? undefined,
        image: markingImage?.id ?? null,
      });
    }

    if (hasNodeMarking) {
      routeMarkings.push({
        name: 'Knooppunten',
        marking_type: 'knooppunten',
        color: toStringValue(bike.Color) ?? undefined,
      });
    }

    const description = toStringValue(bike.Korte_omschrijving) ?? toStringValue(bike.Long_description);
    const blocksDescription = description ? htmlToBlocks(description) : null;
    const rawKnooppunten = toStringValue(bike.Knooppunten);
    const rawKnooppuntenAfstand = toStringValue(bike.Knooppunten_afstand);
    const expectedRouteDistanceKm = toNumberValue(bike.Aantal_km);
    const parsedTextSequence = parseNodeSequence(rawKnooppunten, rawKnooppuntenAfstand);
    const parsedNodeNumbersFromText = parsedTextSequence.nodeNumbers;
    const startCoordinate = {
      latitude: toNumberValue(bike.Cor1),
      longitude: toNumberValue(bike.Cor2),
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

    const legacyTableNodes = await findLegacyBikeNodes(config, Number(bike.ID));
    const exactLegacyNodeSequence = findExactLegacyNodeSequence(parsedNodeNumbersFromText, legacyTableNodes);
    const parsedNodeNumbers =
      exactLegacyNodeSequence?.map((node) => node.nodeNumber) ??
      (legacyTableNodes.length > 0 ? legacyTableNodes.map((node) => node.nodeNumber) : parsedNodeNumbersFromText);
    const effectiveKnooppunten =
      exactLegacyNodeSequence || legacyTableNodes.length > 0 ? parsedNodeNumbers.join(' ') : rawKnooppunten;
    const { cumulativeDistances } = parseNodeSequence(
      effectiveKnooppunten,
      rawKnooppuntenAfstand,
      expectedRouteDistanceKm
    );
    const nodeTableCoordinatesByNodeNumber = await findNodeCoordinatesByNumber(
      strapi,
      parsedNodeNumbers,
      startCoordinate.latitude !== null && startCoordinate.longitude !== null ? startCoordinate : null,
      province?.id ?? null,
      country?.id ?? null,
      gpxRouteCoordinates
    );
    const legacyTableCoordinatesByNodeNumber = new Map<string, Coordinate>();
    const legacyNodesForCoordinates = exactLegacyNodeSequence ?? legacyTableNodes;

    for (const legacyTableNode of legacyNodesForCoordinates) {
      if (!legacyTableCoordinatesByNodeNumber.has(legacyTableNode.nodeNumber)) {
        legacyTableCoordinatesByNodeNumber.set(legacyTableNode.nodeNumber, {
          latitude: legacyTableNode.latitude,
          longitude: legacyTableNode.longitude,
        });
      }
    }

    const matchedNodeCoordinates =
      exactLegacyNodeSequence?.map((node) => ({
        latitude: node.latitude,
        longitude: node.longitude,
      })) ??
      buildSequentialRouteNodeCoordinates(
        parsedNodeNumbers,
        cumulativeDistances,
        startCoordinate.latitude !== null && startCoordinate.longitude !== null ? startCoordinate : null,
        gpxRouteCoordinates,
        gpxCoordinatesByNodeNumber,
        legacyTableCoordinatesByNodeNumber,
        nodeTableCoordinatesByNodeNumber
      );

    const routeNodes = parseRouteNodes(
      effectiveKnooppunten,
      rawKnooppuntenAfstand,
      matchedNodeCoordinates,
      expectedRouteDistanceKm
    );
    const legacyNodeNetworkId = bikeNetworkLegacyIdByBikeId.get(Number(bike.ID));
    const nodeNetworkId =
      typeof legacyNodeNetworkId === 'number' ? (nodeNetworkIdByLegacyId.get(legacyNodeNetworkId) ?? null) : null;
    const routeData = stripUndefinedDeep({
      title,
      slug,
      description: blocksDescription && blocksDescription.length > 0 ? blocksDescription : undefined,
      difficulty: mapDifficulty(bike.Moeilijkheid),
      waymarked: routeMarkings.length > 0 || effectiveKnooppunten !== null || toBooleanValue(bike.T_Bewegwijzerd),
      public_transport_access: toStringValue(bike.Openbaar_vervoer) ? true : undefined,
      countries: country?.id ? { connect: [country.id] } : undefined,
      provinces: province?.id ? { connect: [province.id] } : undefined,
      cities: city?.id ? { connect: [city.id] } : undefined,
      region: region?.id ?? null,
      theme: cyclingTheme?.id ?? null,
      node_network: nodeNetworkId,
      route_type: routeType?.id ? { connect: [routeType.id] } : undefined,
      tags: tags.length > 0 ? { connect: tags } : undefined,
      route_start_locations: dedupeStartLocations(startLocations),
      route_nodes: routeNodes,
      route_end_locations: toStringValue(bike.Eind_plaats)
        ? [
            {
              name: toStringValue(bike.Eind_plaats) ?? undefined,
            },
          ]
        : [],
      route_markings: routeMarkings,
      cover_image: coverImage?.id ?? null,
      pdf: pdfFile?.id ?? null,
      route_by: toStringValue(bike.Aangeboden) ?? undefined,
      knooppunten: effectiveKnooppunten ?? undefined,
      knooppunten_afstand: rawKnooppuntenAfstand ?? undefined,
      seo:
        toStringValue(bike.Meta_title) || toStringValue(bike.Meta_description)
          ? {
              meta_title: toStringValue(bike.Meta_title) ?? undefined,
              meta_description: toStringValue(bike.Meta_description) ?? undefined,
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
    total: bikes.length,
    created,
    updated,
    skipped,
  };
};

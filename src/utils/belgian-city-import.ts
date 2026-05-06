import type { Core } from '@strapi/strapi';
import * as turf from '@turf/turf';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

type JsonRecord = Record<string, unknown>;

type GeoJsonGeometry = GeoJSON.Geometry;

type GeoJsonFeature = GeoJSON.Feature<GeoJsonGeometry, JsonRecord>;
type GeoJsonFeatureCollection = GeoJSON.FeatureCollection<GeoJsonGeometry, JsonRecord>;

type ImportOptions = {
  locale?: string;
  dryRun?: boolean;
  limit?: number;
  legacyConfigPath?: string;
};

type ImportSourceRecord = {
  name: string;
  slug: string;
  postalCode: string | null;
  latitude: number | null;
  longitude: number | null;
  boundaryGeojson: GeoJsonGeometry | null;
  provinceName: string | null;
  regionName: string | null;
};

type EntityReference = {
  id: number;
  name: string;
  slug: string;
  iso_code?: string | null;
  code?: string | null;
  country?: { id: number } | null;
};

const toEntityReference = (value: unknown): EntityReference | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const entry = value as Record<string, unknown>;
  const id = typeof entry.id === 'number' ? entry.id : null;
  const name = typeof entry.name === 'string' ? entry.name : null;

  if (id === null || !name) {
    return undefined;
  }

  const slug = typeof entry.slug === 'string' && entry.slug.length > 0 ? entry.slug : slugify(name);
  const countryValue = entry.country;
  const country =
    countryValue && typeof countryValue === 'object' && typeof (countryValue as Record<string, unknown>).id === 'number'
      ? { id: (countryValue as Record<string, unknown>).id as number }
      : null;

  return {
    id,
    name,
    slug,
    iso_code: typeof entry.iso_code === 'string' ? entry.iso_code : null,
    code: typeof entry.code === 'string' ? entry.code : null,
    country,
  };
};

type ImportSummary = {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  country: string;
  source: string;
};

const COUNTRY_NAME = 'Belgie';
const COUNTRY_SLUG = 'belgie';
const DEFAULT_SOURCE = 'builtin-belgian-municipalities';
const DEFAULT_DICTIONARY_URL =
  'https://raw.githubusercontent.com/mathiasleroy/belgium-geographic-data/master/dist/metadata/be-dictionary.csv';
const DEFAULT_POSTAL_CODE_POINTS_URL =
  'https://raw.githubusercontent.com/mathiasleroy/belgium-geographic-data/master/dist/points/postal-codes.WGS84.js';
const DEFAULT_LEGACY_CONFIG_CANDIDATES = [
  path.join(process.cwd(), 'legacy-import', 'config.php'),
  path.join(process.cwd(), '..', 'legacy-import', 'config.php'),
];

const BELGIUM_COUNTRY_ALIASES = ['belgie', 'belgium', 'belgique', 'belgien'];

type BuiltinMunicipalityRecord = {
  nis5: string;
  name: string;
  postalCode: string | null;
  provinceName: string | null;
  regionName: string | null;
  latitude: number | null;
  longitude: number | null;
};

type LegacyDbConfig = {
  host: string;
  user: string;
  password: string;
  database: string;
  port?: number;
};

type LegacySubmunicipalityRow = {
  Hoofdgemeente?: string | null;
  Deelgemeente?: string | null;
  Subgemeente?: string | null;
  Provincie?: string | null;
  Land?: string | null;
};

type LegacyCorsRow = {
  Titel?: string | null;
  Latitude?: string | number | null;
  Longitude?: string | number | null;
  Postcode?: string | number | null;
};

const REGION_DEFINITIONS = [
  { name: 'Vlaanderen', slug: 'vlaanderen' },
  { name: 'Wallonië', slug: 'wallonie' },
  { name: 'Brussels Hoofdstedelijk Gewest', slug: 'brussels-hoofdstedelijk-gewest' },
] as const;

const PROVINCE_DEFINITIONS = [
  { name: 'Antwerpen', slug: 'antwerpen', regionSlug: 'vlaanderen' },
  { name: 'Limburg', slug: 'limburg', regionSlug: 'vlaanderen' },
  { name: 'Oost-Vlaanderen', slug: 'oost-vlaanderen', regionSlug: 'vlaanderen' },
  { name: 'Vlaams-Brabant', slug: 'vlaams-brabant', regionSlug: 'vlaanderen' },
  { name: 'West-Vlaanderen', slug: 'west-vlaanderen', regionSlug: 'vlaanderen' },
  { name: 'Brabant wallon', slug: 'brabant-wallon', regionSlug: 'wallonie' },
  { name: 'Hainaut', slug: 'hainaut', regionSlug: 'wallonie' },
  { name: 'Liege', slug: 'liege', regionSlug: 'wallonie' },
  { name: 'Luxembourg', slug: 'luxembourg', regionSlug: 'wallonie' },
  { name: 'Namur', slug: 'namur', regionSlug: 'wallonie' },
] as const;

const REGION_ALIAS_MAP = new Map<string, string>([
  ['vlaanderen', 'vlaanderen'],
  ['vlaams gewest', 'vlaanderen'],
  ['flemish region', 'vlaanderen'],
  ['flanders', 'vlaanderen'],
  ['wallonie', 'wallonie'],
  ['waals gewest', 'wallonie'],
  ['region wallonne', 'wallonie'],
  ['walloon region', 'wallonie'],
  ['brussels hoofdstedelijk gewest', 'brussels-hoofdstedelijk-gewest'],
  ['brussels-capital region', 'brussels-hoofdstedelijk-gewest'],
  ['region de bruxelles-capitale', 'brussels-hoofdstedelijk-gewest'],
  ['bruxelles-capitale', 'brussels-hoofdstedelijk-gewest'],
]);

const PROVINCE_ALIAS_MAP = new Map<string, string>([
  ['antwerpen', 'antwerpen'],
  ['anvers', 'antwerpen'],
  ['province of antwerp', 'antwerpen'],
  ['limburg', 'limburg'],
  ['limbourg', 'limburg'],
  ['oost-vlaanderen', 'oost-vlaanderen'],
  ['east flanders', 'oost-vlaanderen'],
  ['flandre orientale', 'oost-vlaanderen'],
  ['vlaams-brabant', 'vlaams-brabant'],
  ['flemish brabant', 'vlaams-brabant'],
  ['brabant flamand', 'vlaams-brabant'],
  ['west-vlaanderen', 'west-vlaanderen'],
  ['west flanders', 'west-vlaanderen'],
  ['flandre occidentale', 'west-vlaanderen'],
  ['waals-brabant', 'brabant-wallon'],
  ['brabant wallon', 'brabant-wallon'],
  ['walloon brabant', 'brabant-wallon'],
  ['hainaut', 'hainaut'],
  ['henegouwen', 'hainaut'],
  ['liege', 'liege'],
  ['liege province', 'liege'],
  ['luik', 'liege'],
  ['luxembourg', 'luxembourg'],
  ['belgian luxembourg', 'luxembourg'],
  ['luxemburg', 'luxembourg'],
  ['namur', 'namur'],
  ['namen', 'namur'],
  ['brussels hoofdstedelijk gewest', ''],
  ['brussels-capital region', ''],
  ['region de bruxelles-capitale', ''],
]);

const PROVINCE_REGION_MAP = new Map<string, string>(
  PROVINCE_DEFINITIONS.map((province) => [province.slug, province.regionSlug])
);
const REGION_DISPLAY_NAME_BY_SLUG = new Map<string, string>(
  REGION_DEFINITIONS.map((region) => [region.slug, region.name])
);
const PROVINCE_DISPLAY_NAME_BY_SLUG = new Map(
  PROVINCE_DEFINITIONS.map((province) => [province.slug, province.name])
);

const NAME_FIELDS = ['name', 'naam', 'municipality', 'gemeente', 'city', 'stad', 'nom'];
const POSTAL_CODE_FIELDS = ['postal_code', 'postalCode', 'postcode', 'zip', 'zip_code', 'postnr'];
const PROVINCE_FIELDS = ['province', 'provincie', 'province_name'];
const REGION_FIELDS = ['region', 'regio', 'region_name'];
const LATITUDE_FIELDS = ['latitude', 'lat', 'y'];
const LONGITUDE_FIELDS = ['longitude', 'lng', 'lon', 'x'];

const publishedAt = () => new Date().toISOString();

const slugify = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const normalizeWhitespace = (value: string) => value.trim().replace(/\s+/g, ' ');

const TEXT_REPLACEMENTS: Array<[RegExp, string]> = [
  [/^Li�ge$/i, 'Liège'],
  [/^Liége$/i, 'Liège'],
  [/^Bl�gny$/i, 'Blégny'],
];

const repairMojibake = (value: string) => {
  for (const [pattern, replacement] of TEXT_REPLACEMENTS) {
    if (pattern.test(value)) {
      return replacement;
    }
  }

  if (!/[ÃÂÄÅÆÇÈÉÊËÌÍÎÏÑÒÓÔÕÖØÙÚÛÜÝßàáâãäåæçèéêëìíîïñòóôõöøùúûüýÿ�]/.test(value)) {
    return value;
  }

  try {
    const repaired = Buffer.from(value, 'latin1').toString('utf8');

    for (const [pattern, replacement] of TEXT_REPLACEMENTS) {
      if (pattern.test(repaired)) {
        return replacement;
      }
    }

    if (repaired.includes('\uFFFD')) {
      const fallback = value.replace(/�/g, 'é');

      for (const [pattern, replacement] of TEXT_REPLACEMENTS) {
        if (pattern.test(fallback)) {
          return replacement;
        }
      }

      return fallback;
    }

    return repaired;
  } catch {
    const fallback = value.replace(/�/g, 'é');

    for (const [pattern, replacement] of TEXT_REPLACEMENTS) {
      if (pattern.test(fallback)) {
        return replacement;
      }
    }

    return fallback;
  }
};

const toStringValue = (value: unknown) => {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = normalizeWhitespace(repairMojibake(String(value)));
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

const getObjectValue = (record: JsonRecord | null | undefined, fieldNames: string[]) => {
  if (!record) {
    return undefined;
  }

  for (const fieldName of fieldNames) {
    const value = record[fieldName];

    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }

  return undefined;
};

const isFeatureCollection = (value: unknown): value is GeoJsonFeatureCollection =>
  Boolean(
    value &&
      typeof value === 'object' &&
      (value as GeoJsonFeatureCollection).type === 'FeatureCollection' &&
      Array.isArray((value as GeoJsonFeatureCollection).features)
  );

const isFeature = (value: unknown): value is GeoJsonFeature =>
  Boolean(value && typeof value === 'object' && (value as GeoJsonFeature).type === 'Feature');

const isRecordArray = (value: unknown): value is JsonRecord[] =>
  Array.isArray(value) && value.every((item) => item && typeof item === 'object' && !Array.isArray(item));

const parseSourcePayload = (payload: unknown): Array<JsonRecord | GeoJsonFeature> => {
  if (isFeatureCollection(payload)) {
    return payload.features;
  }

  if (Array.isArray(payload)) {
    if (payload.every((item) => isFeature(item))) {
      return payload;
    }

    if (isRecordArray(payload)) {
      return payload;
    }
  }

  if (payload && typeof payload === 'object') {
    const records = (payload as JsonRecord).records;

    if (isRecordArray(records)) {
      return records;
    }
  }

  throw new Error('Unsupported import payload. Expected GeoJSON FeatureCollection or JSON array.');
};

const normalizeProvinceSlug = (value: string | null) => {
  if (!value) {
    return null;
  }

  const alias = PROVINCE_ALIAS_MAP.get(slugify(value));
  return alias === undefined ? slugify(value) : alias || null;
};

const normalizeRegionSlug = (value: string | null) => {
  if (!value) {
    return null;
  }

  return REGION_ALIAS_MAP.get(slugify(value)) ?? slugify(value);
};

const canonicalProvinceKey = (value: string | null) => normalizeProvinceSlug(value);

const canonicalRegionKey = (value: string | null) => normalizeRegionSlug(value);

const canonicalCountryKey = (value: string | null) => {
  if (!value) {
    return null;
  }

  const normalized = slugify(value);

  if (BELGIUM_COUNTRY_ALIASES.includes(normalized) || normalized === 'be') {
    return COUNTRY_SLUG;
  }

  return normalized;
};

const prefersRegion = (entry: EntityReference, regionSlug: string | null) => {
  if (!regionSlug) {
    return 0;
  }

  const haystack = `${entry.name} ${entry.slug} ${entry.code ?? ''}`.toLowerCase();
  const regionName = REGION_DISPLAY_NAME_BY_SLUG.get(regionSlug)?.toLowerCase() ?? '';

  if (haystack.includes(regionSlug)) {
    return 3;
  }

  if (regionName && haystack.includes(regionName.toLowerCase())) {
    return 2;
  }

  if (regionSlug === 'vlaanderen' && haystack.includes('vlaam')) {
    return 2;
  }

  if (regionSlug === 'wallonie' && (haystack.includes('waal') || haystack.includes('wallon'))) {
    return 2;
  }

  return 0;
};

const resolveCentroid = (feature: GeoJsonFeature) => {
  if (!feature.geometry) {
    return { latitude: null, longitude: null };
  }

  if (feature.geometry.type === 'Point') {
    return {
      latitude: feature.geometry.coordinates[1],
      longitude: feature.geometry.coordinates[0],
    };
  }

  try {
    const centroid = turf.centroid(feature);
    return {
      latitude: centroid.geometry.coordinates[1],
      longitude: centroid.geometry.coordinates[0],
    };
  } catch {
    return { latitude: null, longitude: null };
  }
};

const normalizeSourceItem = (item: JsonRecord | GeoJsonFeature): ImportSourceRecord | null => {
  const feature = isFeature(item) ? item : null;
  const properties = (feature?.properties ?? item) as JsonRecord;
  const name = toStringValue(getObjectValue(properties, NAME_FIELDS));

  if (!name) {
    return null;
  }

  const rawProvince = toStringValue(getObjectValue(properties, PROVINCE_FIELDS));
  const provinceSlug = normalizeProvinceSlug(rawProvince);
  const rawRegion = toStringValue(getObjectValue(properties, REGION_FIELDS));
  const derivedRegionSlug = normalizeRegionSlug(rawRegion) ?? (provinceSlug ? PROVINCE_REGION_MAP.get(provinceSlug) ?? null : null);
  const centroid = feature ? resolveCentroid(feature) : { latitude: null, longitude: null };
  const latitude = centroid.latitude ?? toNumberValue(getObjectValue(properties, LATITUDE_FIELDS));
  const longitude = centroid.longitude ?? toNumberValue(getObjectValue(properties, LONGITUDE_FIELDS));

  return {
    name,
    slug: slugify(name),
    postalCode: toStringValue(getObjectValue(properties, POSTAL_CODE_FIELDS)),
    latitude,
    longitude,
    boundaryGeojson: feature?.geometry ?? null,
    provinceName:
      provinceSlug !== null
        ? PROVINCE_DEFINITIONS.find((province) => province.slug === provinceSlug)?.name ?? rawProvince
        : null,
    regionName:
      derivedRegionSlug !== null
        ? REGION_DEFINITIONS.find((region) => region.slug === derivedRegionSlug)?.name ?? rawRegion
        : null,
  };
};

const fetchPayload = async (source: string) => {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source);

    if (!response.ok) {
      throw new Error(`Dataset fetch failed with status ${response.status} for ${source}`);
    }

    return (await response.json()) as unknown;
  }

  const { readFile } = await import('node:fs/promises');
  try {
    const raw = await readFile(source, 'utf8');
    return JSON.parse(raw) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Import source not found: ${source}. Provide an existing file path, a URL, or omit the argument to use the built-in Belgian municipalities source.`
      );
    }

    throw error;
  }
};

const fetchText = async (url: string) => {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Dataset fetch failed with status ${response.status} for ${url}`);
  }

  return response.text();
};

const splitCsvLine = (line: string) => {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (character === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }

      continue;
    }

    if (character === ',' && !inQuotes) {
      result.push(current);
      current = '';
      continue;
    }

    current += character;
  }

  result.push(current);
  return result;
};

const parseCsv = (raw: string) => {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return [];
  }

  const headers = splitCsvLine(lines[0]);

  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line);
    const record: JsonRecord = {};

    headers.forEach((header, index) => {
      record[header] = values[index] ?? '';
    });

    return record;
  });
};

const parsePostalCodePoints = (raw: string) => {
  const pointRegex =
    /"(?<postal>\d{4})"\s*:\s*\{\s*"lat"\s*:\s*(?<lat>-?\d+(?:\.\d+)?)\s*,\s*"lng"\s*:\s*(?<lng>-?\d+(?:\.\d+)?)\s*\}/g;
  const points = new Map<string, { latitude: number; longitude: number }>();

  for (const match of raw.matchAll(pointRegex)) {
    const postal = match.groups?.postal;
    const latitude = toNumberValue(match.groups?.lat);
    const longitude = toNumberValue(match.groups?.lng);

    if (!postal || latitude === null || longitude === null) {
      continue;
    }

    points.set(postal, { latitude, longitude });
  }

  return points;
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

  return { host, user, password, database };
};

const buildMysqlJsonSelect = (table: string, columns: string[], whereClause: string) => {
  const jsonPairs = columns.map((column) => `'${column}', ${column}`).join(', ');

  return [`SELECT JSON_OBJECT(${jsonPairs})`, `FROM ${table}`, whereClause ? `WHERE ${whereClause}` : '']
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
    maxBuffer: 1024 * 1024 * 20,
  });

  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
};

const resolveLegacyConfigPath = async (explicitPath?: string) => {
  if (explicitPath) {
    return explicitPath;
  }

  for (const candidate of DEFAULT_LEGACY_CONFIG_CANDIDATES) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }

  return null;
};

const loadLegacyCorsIndex = async (legacyConfigPath?: string) => {
  const resolvedConfigPath = await resolveLegacyConfigPath(legacyConfigPath);

  if (!resolvedConfigPath) {
    return new Map<
      string,
      {
        postalCode: string | null;
        latitude: number | null;
        longitude: number | null;
      }
    >();
  }

  const config = await parsePhpConfig(resolvedConfigPath);
  const corsRows = (await runMysqlQuery(
    config,
    buildMysqlJsonSelect('Cors', ['Titel', 'Latitude', 'Longitude', 'Postcode'], '')
  )) as LegacyCorsRow[];
  const corsBySlug = new Map<
    string,
    {
      postalCode: string | null;
      latitude: number | null;
      longitude: number | null;
    }
  >();

  for (const row of corsRows) {
    const title = toStringValue(row.Titel);

    if (!title) {
      continue;
    }

    corsBySlug.set(slugify(title), {
      postalCode: toStringValue(row.Postcode),
      latitude: toNumberValue(row.Latitude),
      longitude: toNumberValue(row.Longitude),
    });
  }

  return corsBySlug;
};

const loadFlemishSubmunicipalities = async (legacyConfigPath?: string): Promise<ImportSourceRecord[]> => {
  const resolvedConfigPath = await resolveLegacyConfigPath(legacyConfigPath);

  if (!resolvedConfigPath) {
    return [];
  }

  const config = await parsePhpConfig(resolvedConfigPath);
  const [rows, corsBySlug] = await Promise.all([
    runMysqlQuery(
      config,
      buildMysqlJsonSelect(
        'Deelgemeenten',
        ['Hoofdgemeente', 'Deelgemeente', 'Subgemeente', 'Provincie', 'Land'],
        "Land = 'Vlaanderen'"
      )
    ) as Promise<LegacySubmunicipalityRow[]>,
    loadLegacyCorsIndex(resolvedConfigPath),
  ]);
  const places = new Map<string, ImportSourceRecord>();

  for (const row of rows) {
    const provinceName = toStringValue(row.Provincie);
    const hoofdgemeente = toStringValue(row.Hoofdgemeente);
    const names = [toStringValue(row.Deelgemeente), toStringValue(row.Subgemeente)].filter(
      (value): value is string => Boolean(value)
    );

    for (const name of names) {
      if (name === hoofdgemeente) {
        continue;
      }

      const slug = slugify(name);

      if (places.has(slug)) {
        continue;
      }

      const corsMatch = corsBySlug.get(slug);

      places.set(slug, {
        name,
        slug,
        postalCode: corsMatch?.postalCode ?? null,
        latitude: corsMatch?.latitude ?? null,
        longitude: corsMatch?.longitude ?? null,
        boundaryGeojson: null,
        provinceName,
        regionName: 'Vlaanderen',
      });
    }
  }

  return Array.from(places.values());
};

const loadBuiltinMunicipalities = async (): Promise<ImportSourceRecord[]> => {
  const [dictionaryRaw, postalPointsRaw] = await Promise.all([
    fetchText(DEFAULT_DICTIONARY_URL),
    fetchText(DEFAULT_POSTAL_CODE_POINTS_URL),
  ]);
  const dictionaryRows = parseCsv(dictionaryRaw);
  const postalPoints = parsePostalCodePoints(postalPointsRaw);
  const municipalities = new Map<string, BuiltinMunicipalityRecord>();

  for (const row of dictionaryRows) {
    const nis5 = toStringValue(row.NIS5);
    const name = toStringValue(row.Municipality);

    if (!nis5 || !name) {
      continue;
    }

    const postalCode = toStringValue(row.PostCode);

    if (!municipalities.has(nis5)) {
      const point = postalCode ? postalPoints.get(postalCode) : undefined;

      municipalities.set(nis5, {
        nis5,
        name,
        postalCode,
        provinceName: toStringValue(row.Province),
        regionName: toStringValue(row.Region),
        latitude: point?.latitude ?? null,
        longitude: point?.longitude ?? null,
      });
      continue;
    }

    const existing = municipalities.get(nis5)!;

    if (!existing.postalCode && postalCode) {
      const point = postalPoints.get(postalCode);
      existing.postalCode = postalCode;
      existing.latitude = point?.latitude ?? existing.latitude ?? null;
      existing.longitude = point?.longitude ?? existing.longitude ?? null;
    }
  }

  return Array.from(municipalities.values()).map((municipality) => ({
    name: municipality.name,
    slug: slugify(municipality.name),
    postalCode: municipality.postalCode,
    latitude: municipality.latitude,
    longitude: municipality.longitude,
    boundaryGeojson: null,
    provinceName: municipality.provinceName,
    regionName: municipality.regionName,
  }));
};

const findOneBySlugOrName = async (
  strapi: Core.Strapi,
  uid: 'api::country.country' | 'api::region.region' | 'api::province.province' | 'api::city.city',
  slug: string,
  name: string,
  locale?: string
) => {
  const filters = {
    $or: [{ slug: { $eq: slug } }, { name: { $eq: name } }],
  };

  const entries = await strapi.entityService.findMany(uid, {
    filters,
    locale,
    limit: 1,
  });

  return Array.isArray(entries) ? toEntityReference(entries[0]) : undefined;
};

const listEntities = async (
  strapi: Core.Strapi,
  uid: 'api::country.country' | 'api::region.region' | 'api::province.province',
  locale?: string
) => {
  const entries = await strapi.entityService.findMany(uid, {
    populate: uid === 'api::province.province' ? ({ country: true } as never) : undefined,
    locale,
    limit: 500,
  });

  return Array.isArray(entries) ? entries.map(toEntityReference).filter((entry): entry is EntityReference => !!entry) : [];
};

const findCountryCandidate = (
  countries: EntityReference[],
  countryName: string | null,
  regionSlug: string | null
) => {
  const exactBelgium = countries.find((country) => {
    const keys = [
      canonicalCountryKey(country.name),
      canonicalCountryKey(country.slug),
      canonicalCountryKey(country.iso_code ?? null),
    ];

    return keys.includes(COUNTRY_SLUG);
  });

  if (exactBelgium) {
    return exactBelgium;
  }

  const requestedKey = canonicalCountryKey(countryName);

  if (requestedKey) {
    const directMatch = countries.find((country) => {
      const keys = [
        canonicalCountryKey(country.name),
        canonicalCountryKey(country.slug),
        canonicalCountryKey(country.iso_code ?? null),
      ];

      return keys.includes(requestedKey);
    });

    if (directMatch) {
      return directMatch;
    }
  }

  if (!regionSlug) {
    return undefined;
  }

  return countries.find((country) => {
    const keys = [canonicalCountryKey(country.name), canonicalCountryKey(country.slug)];
    return keys.includes(regionSlug);
  });
};

const findRegionCandidate = (regions: EntityReference[], regionName: string | null) => {
  const regionKey = canonicalRegionKey(regionName);

  if (!regionKey) {
    return undefined;
  }

  return regions.find((region) => {
    const keys = [canonicalRegionKey(region.name), canonicalRegionKey(region.slug)];
    return keys.includes(regionKey);
  });
};

const findProvinceCandidate = (
  provinces: EntityReference[],
  provinceName: string | null,
  regionSlug: string | null
) => {
  const provinceKey = canonicalProvinceKey(provinceName);

  if (!provinceKey) {
    return undefined;
  }

  const candidates = provinces.filter((province) => {
    const keys = [
      canonicalProvinceKey(province.name),
      canonicalProvinceKey(province.slug),
      canonicalProvinceKey(province.code ?? null),
    ];

    return keys.includes(provinceKey);
  });

  if (candidates.length <= 1) {
    return candidates[0];
  }

  return candidates.sort((left, right) => prefersRegion(right, regionSlug) - prefersRegion(left, regionSlug))[0];
};

const ensureCountry = async (
  strapi: Core.Strapi,
  countries: EntityReference[],
  locale?: string,
  dryRun?: boolean
) => {
  const existing = findCountryCandidate(countries, COUNTRY_NAME, null);

  if (existing || dryRun) {
    return existing ?? { id: 0, name: COUNTRY_NAME, slug: COUNTRY_SLUG, iso_code: 'BE' };
  }

  const createdEntry = await strapi.entityService.create('api::country.country', {
    data: {
      name: COUNTRY_NAME,
      slug: COUNTRY_SLUG,
      iso_code: 'BE',
      publishedAt: publishedAt(),
    } as never,
    locale,
  });
  const created = toEntityReference(createdEntry) ?? {
    id: 0,
    name: COUNTRY_NAME,
    slug: COUNTRY_SLUG,
    iso_code: 'BE',
  };

  countries.push(created);

  return created;
};

const ensureRegions = async (
  strapi: Core.Strapi,
  countryId: number,
  existingRegions: EntityReference[],
  locale?: string,
  dryRun?: boolean
) => {
  const regionMap = new Map<string, EntityReference>();

  for (const region of REGION_DEFINITIONS) {
    const existing = findRegionCandidate(existingRegions, region.name);

    if (existing) {
      regionMap.set(region.slug, existing);
      continue;
    }

    if (dryRun) {
      regionMap.set(region.slug, { id: 0, name: region.name, slug: region.slug });
      continue;
    }

    const createdEntry = await strapi.entityService.create('api::region.region', {
      data: {
        name: region.name,
        slug: region.slug,
        country: countryId,
        publishedAt: publishedAt(),
      } as never,
      locale,
    });
    const created = toEntityReference(createdEntry) ?? {
      id: 0,
      name: region.name,
      slug: region.slug,
    };

    existingRegions.push(created);
    regionMap.set(region.slug, created);
  }

  return regionMap;
};

const ensureProvinces = async (
  strapi: Core.Strapi,
  countries: EntityReference[],
  regions: Map<string, EntityReference>,
  existingProvinces: EntityReference[],
  locale?: string,
  dryRun?: boolean
) => {
  const provinceMap = new Map<string, EntityReference>();

  for (const province of PROVINCE_DEFINITIONS) {
    const existing = findProvinceCandidate(existingProvinces, province.name, province.regionSlug);

    if (existing) {
      provinceMap.set(province.slug, existing);
      continue;
    }

    if (dryRun) {
      provinceMap.set(province.slug, { id: 0, name: province.name, slug: province.slug });
      continue;
    }

    const countryId =
      findCountryCandidate(countries, COUNTRY_NAME, province.regionSlug)?.id ??
      findCountryCandidate(countries, null, province.regionSlug)?.id ??
      null;

    const createdEntry = await strapi.entityService.create('api::province.province', {
      data: {
        name: province.name,
        slug: province.slug,
        country: countryId,
        regions: regions.get(province.regionSlug)?.id
          ? { connect: [regions.get(province.regionSlug)!.id] }
          : undefined,
        publishedAt: publishedAt(),
      } as never,
      locale,
    });
    const created = toEntityReference(createdEntry) ?? {
      id: 0,
      name: province.name,
      slug: province.slug,
      country: countryId ? { id: countryId } : null,
    };

    existingProvinces.push(created);
    provinceMap.set(province.slug, created);
  }

  return provinceMap;
};

export const importBelgianCities = async (
  strapi: Core.Strapi,
  source?: string,
  options: ImportOptions = {}
): Promise<ImportSummary> => {
  const resolvedSource = source ?? DEFAULT_SOURCE;
  const normalizedItems =
    resolvedSource === DEFAULT_SOURCE
      ? await loadBuiltinMunicipalities()
      : parseSourcePayload(await fetchPayload(resolvedSource))
          .map((item) => normalizeSourceItem(item))
          .filter((item): item is ImportSourceRecord => item !== null);
  const corsBySlug =
    resolvedSource === DEFAULT_SOURCE
      ? await loadLegacyCorsIndex(options.legacyConfigPath)
      : new Map<string, { postalCode: string | null; latitude: number | null; longitude: number | null }>();
  const submunicipalityItems =
    resolvedSource === DEFAULT_SOURCE
      ? await loadFlemishSubmunicipalities(options.legacyConfigPath)
      : [];
  const enrichedItems = normalizedItems.map((item) => {
    const corsMatch = corsBySlug.get(item.slug);

    if (!corsMatch) {
      return item;
    }

    return {
      ...item,
      postalCode: item.postalCode ?? corsMatch.postalCode,
      latitude: item.latitude ?? corsMatch.latitude,
      longitude: item.longitude ?? corsMatch.longitude,
    };
  });
  const mergedItems = Array.from(
    new Map(
      [...enrichedItems, ...submunicipalityItems].map((item) => [item.slug, item])
    ).values()
  );
  const limitedItems =
    options.limit && options.limit > 0 ? mergedItems.slice(0, options.limit) : mergedItems;

  const [countries, existingRegions, existingProvinces] = await Promise.all([
    listEntities(strapi, 'api::country.country', options.locale),
    listEntities(strapi, 'api::region.region', options.locale),
    listEntities(strapi, 'api::province.province', options.locale),
  ]);
  const country = await ensureCountry(strapi, countries, options.locale, options.dryRun);
  const regions = await ensureRegions(
    strapi,
    country.id,
    existingRegions,
    options.locale,
    options.dryRun
  );
  const provinces = await ensureProvinces(
    strapi,
    countries,
    regions,
    existingProvinces,
    options.locale,
    options.dryRun
  );

  let created = 0;
  let updated = 0;
  let skipped = mergedItems.length - limitedItems.length;

  for (const item of limitedItems) {
    const regionSlug = normalizeRegionSlug(item.regionName);
    const provinceSlug = normalizeProvinceSlug(item.provinceName);
    const region = regionSlug ? regions.get(regionSlug) : undefined;
    const province = provinceSlug ? provinces.get(provinceSlug) : undefined;
    const itemCountry =
      (province?.country?.id
        ? countries.find((candidate) => candidate.id === province.country?.id)
        : undefined) ??
      findCountryCandidate(countries, COUNTRY_NAME, regionSlug) ??
      findCountryCandidate(countries, item.regionName, regionSlug) ??
      country;
    const existing = await findOneBySlugOrName(
      strapi,
      'api::city.city',
      item.slug,
      item.name,
      options.locale
    );

    if (options.dryRun) {
      if (existing) {
        updated += 1;
      } else {
        created += 1;
      }

      continue;
    }

    const data = {
      name: item.name,
      slug: item.slug,
      postal_code: item.postalCode,
      latitude: item.latitude,
      longitude: item.longitude,
      boundary_geojson: item.boundaryGeojson,
      country: itemCountry?.id ?? null,
      region: region?.id ?? null,
      province: province?.id ?? null,
      publishedAt: publishedAt(),
    };

    if (existing) {
      await strapi.entityService.update('api::city.city', existing.id, {
        data: data as never,
        locale: options.locale,
      });
      updated += 1;
    } else {
      await strapi.entityService.create('api::city.city', {
        data: data as never,
        locale: options.locale,
      });
      created += 1;
    }
  }

  return {
    total: limitedItems.length,
    created,
    updated,
    skipped,
    country: country.name,
    source: resolvedSource,
  };
};

import type { Core } from '@strapi/strapi';
import * as turf from '@turf/turf';

type JsonRecord = Record<string, unknown>;

type GeoJsonGeometry = GeoJSON.Geometry;

type GeoJsonFeature = GeoJSON.Feature<GeoJsonGeometry, JsonRecord>;
type GeoJsonFeatureCollection = GeoJSON.FeatureCollection<GeoJsonGeometry, JsonRecord>;

type ImportOptions = {
  locale?: string;
  dryRun?: boolean;
  limit?: number;
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
};

type ImportSummary = {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  country: string;
};

const COUNTRY_NAME = 'Belgie';
const COUNTRY_SLUG = 'belgie';

const REGION_DEFINITIONS = [
  { name: 'Vlaanderen', slug: 'vlaanderen' },
  { name: 'Wallonie', slug: 'wallonie' },
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
  const raw = await readFile(source, 'utf8');
  return JSON.parse(raw) as unknown;
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

  return Array.isArray(entries) ? (entries[0] as EntityReference | undefined) : undefined;
};

const ensureCountry = async (strapi: Core.Strapi, locale?: string, dryRun?: boolean) => {
  const existing = await findOneBySlugOrName(strapi, 'api::country.country', COUNTRY_SLUG, COUNTRY_NAME, locale);

  if (existing || dryRun) {
    return existing ?? { id: 0, name: COUNTRY_NAME, slug: COUNTRY_SLUG };
  }

  const created = (await strapi.entityService.create('api::country.country', {
    data: {
      name: COUNTRY_NAME,
      slug: COUNTRY_SLUG,
      iso_code: 'BE',
      publishedAt: publishedAt(),
    } as never,
    locale,
  })) as EntityReference;

  return created;
};

const ensureRegions = async (
  strapi: Core.Strapi,
  countryId: number,
  locale?: string,
  dryRun?: boolean
) => {
  const regionMap = new Map<string, EntityReference>();

  for (const region of REGION_DEFINITIONS) {
    const existing = await findOneBySlugOrName(
      strapi,
      'api::region.region',
      region.slug,
      region.name,
      locale
    );

    if (existing) {
      regionMap.set(region.slug, existing);
      continue;
    }

    if (dryRun) {
      regionMap.set(region.slug, { id: 0, name: region.name, slug: region.slug });
      continue;
    }

    const created = (await strapi.entityService.create('api::region.region', {
      data: {
        name: region.name,
        slug: region.slug,
        country: countryId,
        publishedAt: publishedAt(),
      } as never,
      locale,
    })) as EntityReference;

    regionMap.set(region.slug, created);
  }

  return regionMap;
};

const ensureProvinces = async (
  strapi: Core.Strapi,
  countryId: number,
  regions: Map<string, EntityReference>,
  locale?: string,
  dryRun?: boolean
) => {
  const provinceMap = new Map<string, EntityReference>();

  for (const province of PROVINCE_DEFINITIONS) {
    const existing = await findOneBySlugOrName(
      strapi,
      'api::province.province',
      province.slug,
      province.name,
      locale
    );

    if (existing) {
      provinceMap.set(province.slug, existing);
      continue;
    }

    if (dryRun) {
      provinceMap.set(province.slug, { id: 0, name: province.name, slug: province.slug });
      continue;
    }

    const created = (await strapi.entityService.create('api::province.province', {
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
    })) as EntityReference;

    provinceMap.set(province.slug, created);
  }

  return provinceMap;
};

export const importBelgianCities = async (
  strapi: Core.Strapi,
  source: string,
  options: ImportOptions = {}
): Promise<ImportSummary> => {
  const payload = await fetchPayload(source);
  const sourceItems = parseSourcePayload(payload);
  const normalizedItems = sourceItems
    .map((item) => normalizeSourceItem(item))
    .filter((item): item is ImportSourceRecord => item !== null);
  const limitedItems =
    options.limit && options.limit > 0 ? normalizedItems.slice(0, options.limit) : normalizedItems;

  const country = await ensureCountry(strapi, options.locale, options.dryRun);
  const regions = await ensureRegions(strapi, country.id, options.locale, options.dryRun);
  const provinces = await ensureProvinces(
    strapi,
    country.id,
    regions,
    options.locale,
    options.dryRun
  );

  let created = 0;
  let updated = 0;
  let skipped = normalizedItems.length - limitedItems.length;

  for (const item of limitedItems) {
    const regionSlug = normalizeRegionSlug(item.regionName);
    const provinceSlug = normalizeProvinceSlug(item.provinceName);
    const region = regionSlug ? regions.get(regionSlug) : undefined;
    const province = provinceSlug ? provinces.get(provinceSlug) : undefined;
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
      country: country.id,
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
  };
};

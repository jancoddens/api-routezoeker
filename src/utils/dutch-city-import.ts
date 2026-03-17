import type { Core } from '@strapi/strapi';
import * as turf from '@turf/turf';

type JsonRecord = Record<string, unknown>;
type GeoJsonGeometry = GeoJSON.Geometry;

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
};

type EntityReference = {
  id: number;
  name: string;
  slug: string;
  iso_code?: string | null;
  code?: string | null;
  country?: { id: number } | null;
};

type ImportSummary = {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  country: string;
  source: string;
};

type GeoRefDutchRecord = {
  geo_point_2d?: { lon?: number; lat?: number } | null;
  geo_shape?: { geometry?: GeoJsonGeometry | null } | null;
  prov_name?: string[] | null;
  gem_name?: string[] | null;
};

type OpendatasoftResponse = {
  total_count?: number;
  results?: JsonRecord[];
};

const COUNTRY_NAME = 'Nederland';
const COUNTRY_SLUG = 'nederland';
const DEFAULT_SOURCE =
  'https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/georef-netherlands-gemeente/records';
const DEFAULT_POSTCODE_SOURCE =
  'https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/georef-netherlands-postcode-pc4/records';
const DEFAULT_PAGE_SIZE = 100;

const DUTCH_COUNTRY_ALIASES = ['nederland', 'netherlands', 'the-netherlands', 'holland', 'nl'];
const DUTCH_PROVINCES = [
  { name: 'Drenthe', slug: 'drenthe' },
  { name: 'Flevoland', slug: 'flevoland' },
  { name: 'Friesland', slug: 'friesland' },
  { name: 'Gelderland', slug: 'gelderland' },
  { name: 'Groningen', slug: 'groningen' },
  { name: 'Limburg', slug: 'limburg' },
  { name: 'Noord-Brabant', slug: 'noord-brabant' },
  { name: 'Noord-Holland', slug: 'noord-holland' },
  { name: 'Overijssel', slug: 'overijssel' },
  { name: 'Utrecht', slug: 'utrecht' },
  { name: 'Zeeland', slug: 'zeeland' },
  { name: 'Zuid-Holland', slug: 'zuid-holland' },
] as const;

const DUTCH_PROVINCE_ALIAS_MAP = new Map<string, string>([
  ['drenthe', 'drenthe'],
  ['flevoland', 'flevoland'],
  ['friesland', 'friesland'],
  ['fryslan', 'friesland'],
  ['gelderland', 'gelderland'],
  ['groningen', 'groningen'],
  ['limburg', 'limburg'],
  ['noord-brabant', 'noord-brabant'],
  ['north-brabant', 'noord-brabant'],
  ['brabant', 'noord-brabant'],
  ['noord-holland', 'noord-holland'],
  ['north-holland', 'noord-holland'],
  ['overijssel', 'overijssel'],
  ['utrecht', 'utrecht'],
  ['zeeland', 'zeeland'],
  ['zuid-holland', 'zuid-holland'],
  ['south-holland', 'zuid-holland'],
]);

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

const resolveCentroid = (geometry: GeoJsonGeometry | null | undefined) => {
  if (!geometry) {
    return { latitude: null, longitude: null };
  }

  if (geometry.type === 'Point') {
    return {
      latitude: geometry.coordinates[1],
      longitude: geometry.coordinates[0],
    };
  }

  try {
    const centroid = turf.centroid({
      type: 'Feature',
      geometry,
      properties: {},
    });
    return {
      latitude: centroid.geometry.coordinates[1],
      longitude: centroid.geometry.coordinates[0],
    };
  } catch {
    return { latitude: null, longitude: null };
  }
};

const normalizeProvinceSlug = (value: string | null) => {
  if (!value) {
    return null;
  }

  const alias = DUTCH_PROVINCE_ALIAS_MAP.get(slugify(value));
  return alias ?? slugify(value);
};

const canonicalCountryKey = (value: string | null) => {
  if (!value) {
    return null;
  }

  const normalized = slugify(value);
  return DUTCH_COUNTRY_ALIASES.includes(normalized) ? COUNTRY_SLUG : normalized;
};

const canonicalProvinceKey = (value: string | null) => normalizeProvinceSlug(value);

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

const fetchJson = async (url: string) => {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Dataset fetch failed with status ${response.status} for ${url}`);
  }

  return (await response.json()) as unknown;
};

const fetchPagedDataset = async (baseUrl: string) => {
  const firstPage = (await fetchJson(
    `${baseUrl}?limit=${DEFAULT_PAGE_SIZE}&offset=0`
  )) as OpendatasoftResponse;
  const total = firstPage.total_count ?? firstPage.results?.length ?? 0;
  const results = [...(firstPage.results ?? [])];

  for (let offset = DEFAULT_PAGE_SIZE; offset < total; offset += DEFAULT_PAGE_SIZE) {
    const page = (await fetchJson(
      `${baseUrl}?limit=${DEFAULT_PAGE_SIZE}&offset=${offset}`
    )) as OpendatasoftResponse;
    results.push(...(page.results ?? []));
  }

  return { total_count: total, results };
};

const fetchDefaultDataset = async () => fetchPagedDataset(DEFAULT_SOURCE);

const fetchDefaultPostcodes = async () => {
  const payload = await fetchPagedDataset(DEFAULT_POSTCODE_SOURCE);
  const postcodeMap = new Map<string, string>();

  for (const row of payload.results ?? []) {
    const record = row as {
      gem_name?: string;
      pc4_code?: string;
    };
    const name = toStringValue(record.gem_name);
    const postcode = toStringValue(record.pc4_code);

    if (!name || !postcode) {
      continue;
    }

    const key = slugify(name);
    const existing = postcodeMap.get(key);

    if (!existing || postcode < existing) {
      postcodeMap.set(key, postcode);
    }
  }

  return postcodeMap;
};

const parseOpendatasoftResults = (payload: unknown) => {
  if (
    payload &&
    typeof payload === 'object' &&
    Array.isArray((payload as { results?: unknown[] }).results)
  ) {
    return (payload as { results: GeoRefDutchRecord[] }).results;
  }

  if (Array.isArray(payload)) {
    return payload as GeoRefDutchRecord[];
  }

  throw new Error('Unsupported Dutch import payload. Expected Opendatasoft results or JSON array.');
};

const normalizeRecord = (
  record: GeoRefDutchRecord,
  postcodeMap?: Map<string, string>
): ImportSourceRecord | null => {
  const name = toStringValue(record.gem_name?.[0]);

  if (!name) {
    return null;
  }

  const geometry = record.geo_shape?.geometry ?? null;
  const centroidFromGeometry = resolveCentroid(geometry);
  const latitude = record.geo_point_2d?.lat ?? centroidFromGeometry.latitude;
  const longitude = record.geo_point_2d?.lon ?? centroidFromGeometry.longitude;
  const provinceName = toStringValue(record.prov_name?.[0]);
  const provinceSlug = normalizeProvinceSlug(provinceName);

  return {
    name,
    slug: slugify(name),
    postalCode: postcodeMap?.get(slugify(name)) ?? null,
    latitude,
    longitude,
    boundaryGeojson: geometry,
    provinceName:
      provinceSlug !== null
        ? DUTCH_PROVINCES.find((province) => province.slug === provinceSlug)?.name ?? provinceName
        : provinceName,
  };
};

const findOneBySlugOrName = async (
  strapi: Core.Strapi,
  uid: 'api::country.country' | 'api::province.province' | 'api::city.city',
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

  return Array.isArray(entries)
    ? ((entries[0] as unknown) as EntityReference | undefined)
    : undefined;
};

const listEntities = async (
  strapi: Core.Strapi,
  uid: 'api::country.country' | 'api::province.province',
  locale?: string
) => {
  const entries = await strapi.entityService.findMany(uid, {
    populate: uid === 'api::province.province' ? ({ country: true } as never) : undefined,
    locale,
    limit: 500,
  });

  return (Array.isArray(entries) ? entries : []) as EntityReference[];
};

const findCountryCandidate = (countries: EntityReference[]) =>
  countries.find((country) =>
    [canonicalCountryKey(country.name), canonicalCountryKey(country.slug), canonicalCountryKey(country.iso_code ?? null)]
      .filter(Boolean)
      .includes(COUNTRY_SLUG)
  );

const ensureCountry = async (
  strapi: Core.Strapi,
  countries: EntityReference[],
  locale?: string,
  dryRun?: boolean
) => {
  const existing = findCountryCandidate(countries);

  if (existing || dryRun) {
    return existing ?? { id: 0, name: COUNTRY_NAME, slug: COUNTRY_SLUG, iso_code: 'NL' };
  }

  const created = (await strapi.entityService.create('api::country.country', {
    data: {
      name: COUNTRY_NAME,
      slug: COUNTRY_SLUG,
      iso_code: 'NL',
      publishedAt: new Date().toISOString(),
    } as never,
    locale,
  })) as EntityReference;

  countries.push(created);
  return created;
};

const findProvinceCandidate = (provinces: EntityReference[], provinceName: string | null) => {
  const provinceKey = canonicalProvinceKey(provinceName);

  if (!provinceKey) {
    return undefined;
  }

  return provinces.find((province) => {
    const keys = [
      canonicalProvinceKey(province.name),
      canonicalProvinceKey(province.slug),
      canonicalProvinceKey(province.code ?? null),
    ];

    return keys.includes(provinceKey);
  });
};

const ensureProvinces = async (
  strapi: Core.Strapi,
  countryId: number,
  existingProvinces: EntityReference[],
  locale?: string,
  dryRun?: boolean
) => {
  const provinceMap = new Map<string, EntityReference>();

  for (const province of DUTCH_PROVINCES) {
    const existing = findProvinceCandidate(existingProvinces, province.name);

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
        publishedAt: new Date().toISOString(),
      } as never,
      locale,
    })) as EntityReference;

    existingProvinces.push(created);
    provinceMap.set(province.slug, created);
  }

  return provinceMap;
};

export const importDutchCities = async (
  strapi: Core.Strapi,
  source?: string,
  options: ImportOptions = {}
): Promise<ImportSummary> => {
  const resolvedSource = source ?? DEFAULT_SOURCE;
  const [payload, postcodeMap] =
    resolvedSource === DEFAULT_SOURCE
      ? await Promise.all([fetchDefaultDataset(), fetchDefaultPostcodes()])
      : [await fetchPayload(resolvedSource), undefined];
  const normalizedItems = parseOpendatasoftResults(payload)
    .map((item) => normalizeRecord(item, postcodeMap))
    .filter((item): item is ImportSourceRecord => item !== null);
  const limitedItems =
    options.limit && options.limit > 0 ? normalizedItems.slice(0, options.limit) : normalizedItems;

  const [countries, provinces] = await Promise.all([
    listEntities(strapi, 'api::country.country', options.locale),
    listEntities(strapi, 'api::province.province', options.locale),
  ]);

  const country = await ensureCountry(strapi, countries, options.locale, options.dryRun);
  const provinceMap = await ensureProvinces(
    strapi,
    country.id,
    provinces,
    options.locale,
    options.dryRun
  );

  let created = 0;
  let updated = 0;
  let skipped = normalizedItems.length - limitedItems.length;

  for (const item of limitedItems) {
    const provinceSlug = normalizeProvinceSlug(item.provinceName);
    const province = provinceSlug ? provinceMap.get(provinceSlug) : undefined;
    const itemCountry =
      (province?.country?.id
        ? countries.find((candidate) => candidate.id === province.country?.id)
        : undefined) ?? country;
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
      province: province?.id ?? null,
      region: null,
      publishedAt: new Date().toISOString(),
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

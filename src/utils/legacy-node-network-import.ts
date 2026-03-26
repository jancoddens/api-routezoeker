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
  table: string;
  imageFolder: string;
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

type LegacyNodeNetworkRow = {
  ID: number;
  Structuur?: string | number | null;
  Titel?: string | null;
  Filter?: string | null;
  Virtueel?: string | number | null;
  Lat?: string | number | null;
  Lon?: string | number | null;
  KM?: string | number | null;
  Provincie?: string | null;
  Image_top?: string | null;
  Intro?: string | null;
};

type EntityReference = {
  id: number;
  name?: string;
  slug?: string;
  country?: { id: number } | null;
  regions?: Array<{ id: number; name?: string; slug?: string }>;
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

type ImportSummary = {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  parentRelationsUpdated: number;
  table: string;
};

const NODE_NETWORK_QUERY_COLUMNS = ['ID', 'Structuur', 'Titel', 'Filter', 'Virtueel', 'Lat', 'Lon', 'KM', 'Provincie', 'Image_top', 'Intro'];

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

const buildJsonSelect = (
  table: string,
  columns: string[],
  whereClause: string,
  limit?: number,
  offset?: number,
  orderBy?: string
) => {
  const jsonPairs = columns.map((column) => `'${column}', ${column}`).join(', ');

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
  const args = ['--batch', '--raw', '--skip-column-names', '-h', config.host, '-u', config.user, '-D', config.database, '-e', sql];

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

const cleanupLegacyHtml = (value: string) =>
  value
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/?(div|section|article|main|header|footer|span|font)[^>]*>/gi, ' ')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/(ul|ol)>/gi, '\n\n')
    .replace(/<(ul|ol)[^>]*>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<h[1-6][^>]*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<p[^>]*>/gi, '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const htmlToBlocks = (value: string) =>
  cleanupLegacyHtml(value)
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => ({
      type: 'paragraph',
      children: htmlInlineToChildren(paragraph),
    }));

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

const normalizeLegacyProvinceName = (provinceName: string | null) => {
  if (!provinceName) {
    return null;
  }

  if (slugify(provinceName) === 'limburg') {
    return 'Limburg Vlaanderen';
  }

  return provinceName;
};

const findOneBySlugOrName = async (
  strapi: Core.Strapi,
  uid: 'api::theme.theme' | 'api::country.country' | 'api::province.province' | 'api::region.region' | 'api::node-network.node-network',
  slug: string,
  name: string,
  locale?: string
) => {
  const populate =
    uid === 'api::province.province'
      ? ({
          country: { fields: ['id'] },
          regions: { fields: ['id', 'name', 'slug'] },
        } as const)
      : undefined;

  const entries = await strapi.entityService.findMany(uid, {
    filters: {
      $or: [{ slug: { $eq: slug } }, { name: { $eq: name } }, { title: { $eq: name } }],
    } as never,
    ...(populate ? { populate: populate as never } : {}),
    locale,
    publicationState: 'preview',
    limit: 1,
  });

  return Array.isArray(entries) ? ((entries[0] as unknown) as EntityReference | undefined) : undefined;
};

const ensureThemeEntity = async (strapi: Core.Strapi, title: string, locale?: string, dryRun?: boolean) => {
  const slug = slugify(title);
  const existing = await findOneBySlugOrName(strapi, 'api::theme.theme', slug, title, locale);

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
  })) as unknown as EntityReference;
};

const ensureCountryEntity = async (strapi: Core.Strapi, name: string, locale?: string, dryRun?: boolean) => {
  const slug = slugify(name);
  const existing = await findOneBySlugOrName(strapi, 'api::country.country', slug, name, locale);

  if (existing || dryRun) {
    return existing ?? { id: 0, name, slug };
  }

  return (await strapi.entityService.create('api::country.country', {
    data: {
      name,
      slug,
      publishedAt: new Date().toISOString(),
    } as never,
    locale,
  })) as unknown as EntityReference;
};

const ensureProvinceEntity = async (
  strapi: Core.Strapi,
  name: string,
  countryId: number | null,
  locale?: string,
  dryRun?: boolean
) => {
  const slug = slugify(name);
  const entries = await strapi.entityService.findMany('api::province.province', {
    filters: {
      $and: [
        {
          $or: [{ slug: { $eq: slug } }, { name: { $eq: name } }],
        },
        ...(countryId
          ? [
              {
                country: {
                  id: {
                    $eq: countryId,
                  },
                },
              },
            ]
          : []),
      ],
    } as never,
    populate: {
      country: { fields: ['id'] },
      regions: { fields: ['id', 'name', 'slug'] },
    } as never,
    locale,
    publicationState: 'preview',
    limit: 1,
  });
  const existing = Array.isArray(entries) ? ((entries[0] as unknown) as EntityReference | undefined) : undefined;

  if (existing || dryRun) {
    return existing ?? { id: 0, name, slug, country: countryId ? { id: countryId } : null, regions: [] };
  }

  return (await strapi.entityService.create('api::province.province', {
    data: {
      name,
      slug,
      country: countryId,
      publishedAt: new Date().toISOString(),
    } as never,
    locale,
  })) as unknown as EntityReference;
};

const resolveLegacyFile = async (root: string, folder: string, fileName: string | null) => {
  const normalized = toStringValue(fileName);

  if (!normalized) {
    return null;
  }

  if (/^https?:\/\//i.test(normalized)) {
    return null;
  }

  const directCandidates = Array.from(
    new Set(
      [
        normalized.startsWith('/') ? normalized.slice(1) : normalized,
        normalized.replace(/^\.\//, ''),
      ].filter(Boolean)
    )
  );

  for (const candidate of directCandidates) {
    const fullPath = path.join(root, candidate);

    try {
      await fs.access(fullPath);
      return fullPath;
    } catch {
      continue;
    }
  }

  const candidateNames = Array.from(new Set([normalized, path.basename(normalized)].map((value) => value.trim()).filter(Boolean)));

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

const sanitizeUploadFilename = (value: string) => {
  const normalized = path.basename(value).normalize('NFC');
  const originalExtension = path.extname(normalized);
  const sanitizedExtension = originalExtension.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '');
  const baseName = path.basename(normalized, originalExtension);
  const sanitizedBaseName = baseName.replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ').replace(/\s+/g, ' ').trim();
  const safeBaseName = sanitizedBaseName && sanitizedBaseName !== '.' && sanitizedBaseName !== '..' ? sanitizedBaseName : 'file';
  const maxBaseLength = Math.max(1, 255 - sanitizedExtension.length);

  return `${safeBaseName.slice(0, maxBaseLength)}${sanitizedExtension}` || 'file';
};

const uploadLocalFile = async (
  strapi: Core.Strapi,
  absolutePath: string,
  mediaName: string,
  folderName: string | null,
  alternativeText?: string | null,
  dryRun?: boolean
) => {
  if (dryRun) {
    return null;
  }

  const sanitizedMediaName = sanitizeUploadFilename(mediaName);
  const sanitizedOriginalFilename = sanitizeUploadFilename(path.basename(absolutePath));
  const stats = await fs.stat(absolutePath);
  const normalizedSize = Math.round((stats.size / 1024) * 1000) / 1000;
  const folder = folderName
    ? ((await strapi.db.query('plugin::upload.folder').findOne({
        where: { name: folderName },
      })) as UploadFolderEntity | null)
    : null;
  const existingCandidates = (await strapi.db.query('plugin::upload.file').findMany({
    where: { name: sanitizedMediaName },
    populate: { folder: true },
  })) as UploadFileEntity[];
  const existing =
    existingCandidates.find((candidate) => {
      const candidateFolderId = typeof candidate.folder === 'object' ? candidate.folder?.id ?? null : candidate.folder ?? null;
      const candidateSize = typeof candidate.size === 'number' ? candidate.size : candidate.size ? Number(candidate.size) : null;

      return candidateFolderId === (folder?.id ?? null) && candidateSize === normalizedSize;
    }) ?? null;

  if (existing) {
    return existing;
  }

  const uploaded = await strapi.plugin('upload').service('upload').upload({
    data: {
      fileInfo: {
        folder: folder?.id,
        alternativeText: alternativeText ?? undefined,
      },
    },
    files: {
      filepath: absolutePath,
      originalFilename: sanitizedOriginalFilename,
      mimetype: mime.lookup(absolutePath) || 'application/octet-stream',
      size: stats.size,
    },
  });

  return Array.isArray(uploaded) ? ((uploaded[0] as UploadFileEntity | undefined) ?? null) : null;
};

const buildIntroContent = (intro: string | null) => {
  if (!intro) {
    return undefined;
  }

  const blocks = htmlToBlocks(intro);

  if (blocks.length === 0) {
    return undefined;
  }

  return [
    {
      __component: 'page-blocks.text-section',
      title: 'Intro',
      max_width: 'default',
      content: blocks,
    },
  ];
};

const resolveParentLegacyId = (row: LegacyNodeNetworkRow, rowsById: Map<number, LegacyNodeNetworkRow>) => {
  const structureId = toNumberValue(row.Structuur);

  if (!structureId || structureId === row.ID || !rowsById.has(structureId)) {
    return null;
  }

  return structureId;
};

export const importLegacyNodeNetworks = async (
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

  const rows = (await runMysqlQuery(
    config,
    buildJsonSelect(options.table, NODE_NETWORK_QUERY_COLUMNS, '', options.limit, options.offset, 'ID ASC')
  )) as LegacyNodeNetworkRow[];

  const rowsById = new Map(rows.map((row) => [Number(row.ID), row]));
  const importedByLegacyId = new Map<number, number>();
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let parentRelationsUpdated = 0;

  const walkingTheme = await ensureThemeEntity(strapi, 'Wandelen', options.locale, options.dryRun);
  const country = await ensureCountryEntity(strapi, 'Belgie', options.locale, options.dryRun);

  for (const row of rows) {
    const legacyId = Number(row.ID);
    const title = toStringValue(row.Titel);

    if (!legacyId || !title) {
      skipped += 1;
      continue;
    }

    const slug = slugify(title);
    const normalizedProvinceName = normalizeLegacyProvinceName(toStringValue(row.Provincie));
    const province = normalizedProvinceName
      ? await ensureProvinceEntity(strapi, normalizedProvinceName, country.id ?? null, options.locale, options.dryRun)
      : null;
    const region = province?.regions?.[0] ? { id: province.regions[0].id } : null;
    const imagePath = await resolveLegacyFile(options.legacyRoot, options.imageFolder, toStringValue(row.Image_top));
    const image = imagePath
      ? await uploadLocalFile(strapi, imagePath, `${slug}${path.extname(imagePath) || '.jpg'}`, 'node-networks', title, options.dryRun)
      : null;
    const content = buildIntroContent(toStringValue(row.Intro));

    const payload = stripUndefinedDeep({
      name: title,
      slug,
      theme: walkingTheme.id ?? null,
      country: country.id ?? null,
      province: province?.id ?? null,
      region: region?.id ?? null,
      image: image?.id ?? null,
      content,
      distance_km: toNumberValue(row.KM) ?? undefined,
      latitude: toNumberValue(row.Lat) ?? undefined,
      longitude: toNumberValue(row.Lon) ?? undefined,
      is_virtual: toBooleanValue(row.Virtueel),
      sync_enabled: false,
      source_config: {
        provider: 'legacy-node-network',
        legacyTable: options.table,
        legacyId,
        legacyFilter: toStringValue(row.Filter),
        legacyStructure: toNumberValue(row.Structuur),
      },
      publishedAt: new Date().toISOString(),
    });

    const existing = await findOneBySlugOrName(strapi, 'api::node-network.node-network', slug, title, options.locale);

    if (options.dryRun) {
      importedByLegacyId.set(legacyId, existing?.id ?? legacyId);
      if (existing) {
        updated += 1;
      } else {
        created += 1;
      }
      continue;
    }

    if (existing?.id) {
      await strapi.entityService.update('api::node-network.node-network', existing.id, {
        data: payload as never,
        locale: options.locale,
      });
      importedByLegacyId.set(legacyId, existing.id);
      updated += 1;
      continue;
    }

    const createdEntry = (await strapi.entityService.create('api::node-network.node-network', {
      data: payload as never,
      locale: options.locale,
    })) as { id: number };
    importedByLegacyId.set(legacyId, createdEntry.id);
    created += 1;
  }

  for (const row of rows) {
    const legacyId = Number(row.ID);
    const parentLegacyId = resolveParentLegacyId(row, rowsById);
    const strapiId = importedByLegacyId.get(legacyId);

    if (!strapiId || !parentLegacyId) {
      continue;
    }

    const parentStrapiId = importedByLegacyId.get(parentLegacyId);

    if (!parentStrapiId || parentStrapiId === strapiId) {
      continue;
    }

    if (!options.dryRun) {
      await strapi.entityService.update('api::node-network.node-network', strapiId, {
        data: {
          node_network: parentStrapiId,
        } as never,
        locale: options.locale,
      });
    }

    parentRelationsUpdated += 1;
  }

  return {
    total: rows.length,
    created,
    updated,
    skipped,
    parentRelationsUpdated,
    table: options.table,
  };
};

#!/usr/bin/env node

'use strict';

// Imports POIs (Gebouwen/Locaties/Wandelnetwerken) from the legacy site and
// links them to the matching partner, via the Strapi REST API.
//
// This does NOT connect to any database directly (local or remote): the
// source data comes from a mysqldump `.sql` export (uploaded by the user,
// parsed directly below), and the destination is whatever Strapi instance
// --base-url points at, reached over HTTPS with an API token. This sidesteps
// the fact that the real partner content lives on a hosted Strapi
// (https://api.routezoeker.com) that isn't reachable as a local database
// from a dev machine.
//
// Usage:
//   node scripts/import-legacy-pois.js \
//     --sql-dump ~/Downloads/front_routezoeker.sql \
//     --token <strapi-full-access-api-token> \
//     --dry-run
//
// Generate the token in the Strapi admin: Settings > API Tokens > Create
// new API Token > Token type: Full access. Without --dry-run it needs write
// access; --dry-run only needs read access.
//
// --legacy-root/--image-folder should point at the folder on your machine
// with the actual point images (e.g. Vlooybergtoren.jpg). If an image can't
// be found, the poi is still created/updated, just without an image.

const fs = require('node:fs/promises');
const path = require('node:path');
const mime = require('mime-types');

const DEFAULT_LEGACY_ROOT = '/Users/jancoddens/Documents/Websites/Routezoeker.com/V4';
const DEFAULT_BASE_URL = 'https://api.routezoeker.com';
const POI_TYPES = ['Gebouwen', 'Locaties', 'Wandelnetwerken'];

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const parseArgs = () => {
  const rawArgs = process.argv.slice(2);
  const options = {
    sqlDumpPath: undefined,
    baseUrl: process.env.STRAPI_BASE_URL || DEFAULT_BASE_URL,
    token: process.env.STRAPI_ADMIN_API_TOKEN,
    legacyRoot: DEFAULT_LEGACY_ROOT,
    imageFolder: 'images/punten',
    limit: undefined,
    dryRun: false,
    fixAltText: false,
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];

    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (arg === '--fix-alt-text') {
      options.fixAltText = true;
      continue;
    }

    if (arg === '--sql-dump') {
      options.sqlDumpPath = rawArgs[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--base-url') {
      options.baseUrl = rawArgs[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--token') {
      options.token = rawArgs[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--legacy-root') {
      options.legacyRoot = rawArgs[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--image-folder') {
      options.imageFolder = rawArgs[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--limit') {
      options.limit = Number(rawArgs[index + 1]);
      index += 1;
      continue;
    }

    throw new Error(`Unexpected argument: ${arg}`);
  }

  if (!options.sqlDumpPath && !options.fixAltText) {
    throw new Error('--sql-dump /pad/naar/front_routezoeker.sql is verplicht.');
  }

  if (!options.token) {
    throw new Error(
      '--token <strapi-api-token> is verplicht (of zet STRAPI_ADMIN_API_TOKEN). Maak een "Full access" token aan via Strapi admin > Settings > API Tokens.'
    );
  }

  options.baseUrl = options.baseUrl.replace(/\/+$/, '');

  return options;
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const slugify = (value) =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const normalizeWhitespace = (value) => value.trim().replace(/\s+/g, ' ');

const toStringValue = (value) => {
  if (value === undefined || value === null) return null;
  const normalized = normalizeWhitespace(String(value));
  return normalized.length > 0 ? normalized : null;
};

const decodeHtmlEntities = (value) =>
  value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');

const stripHtmlTags = (value) => normalizeWhitespace(decodeHtmlEntities(value.replace(/<[^>]+>/g, ' ')));

const normalizeHref = (href) => decodeHtmlEntities(href.trim());

const getLinkTarget = (href, legacyTarget) =>
  legacyTarget === '_blank' || /^https?:\/\//i.test(href) ? '_blanc' : '_self';

const htmlInlineToChildren = (value) => {
  const children = [];
  const linkPattern = /<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let lastIndex = 0;

  for (const match of value.matchAll(linkPattern)) {
    const index = match.index ?? 0;
    const before = stripHtmlTags(value.slice(lastIndex, index));
    if (before) children.push({ type: 'text', text: before });

    const href = normalizeHref(match[2] ?? '');
    const linkText = stripHtmlTags(match[3] ?? '');

    if (href && linkText) {
      children.push({ type: 'link', url: href, children: [{ type: 'text', text: linkText }] });
    } else if (linkText) {
      children.push({ type: 'text', text: linkText });
    }

    lastIndex = index + match[0].length;
  }

  const after = stripHtmlTags(value.slice(lastIndex));
  if (after) children.push({ type: 'text', text: after });

  return children.length > 0 ? children : [{ type: 'text', text: '' }];
};

const cleanupLegacyHtml = (value) =>
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

const htmlToBlocks = (value) =>
  cleanupLegacyHtml(value)
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => ({ type: 'paragraph', children: htmlInlineToChildren(paragraph) }));

const resolveLegacyFile = async (root, folder, fileName) => {
  const normalized = toStringValue(fileName);
  if (!normalized || /^https?:\/\//i.test(normalized)) return null;

  const directCandidates = Array.from(
    new Set([normalized.startsWith('/') ? normalized.slice(1) : normalized, normalized.replace(/^\.\//, '')].filter(Boolean))
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

  const candidateNames = Array.from(new Set([normalized, path.basename(normalized)].map((v) => v.trim()).filter(Boolean)));

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
      if (matchedEntry) return path.join(root, folder, matchedEntry);
    }
  } catch {
    return null;
  }

  return null;
};

// ---------------------------------------------------------------------------
// mysqldump `.sql` parsing (no DB connection needed)
// ---------------------------------------------------------------------------

const unquoteSqlValue = (raw) => {
  const trimmed = raw.trim();
  if (trimmed === 'NULL') return null;

  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    const inner = trimmed.slice(1, -1);
    let out = '';
    for (let i = 0; i < inner.length; i += 1) {
      const ch = inner[i];
      if (ch === '\\' && i + 1 < inner.length) {
        const next = inner[i + 1];
        const mapping = { n: '\n', r: '\r', t: '\t', '0': '\0', '\\': '\\', "'": "'", '"': '"' };
        out += mapping[next] ?? next;
        i += 1;
        continue;
      }
      out += ch;
    }
    return out;
  }

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return trimmed.includes('.') ? Number(trimmed) : parseInt(trimmed, 10);
  }

  return trimmed;
};

const parseSqlTuples = (blob) => {
  const tuples = [];
  let i = 0;
  const n = blob.length;

  while (i < n) {
    if (blob[i] !== '(') {
      i += 1;
      continue;
    }

    let j = i + 1;
    const fields = [];
    let current = '';
    let inString = false;

    while (j < n) {
      const ch = blob[j];

      if (inString) {
        if (ch === '\\') {
          current += ch + (blob[j + 1] ?? '');
          j += 2;
          continue;
        }
        if (ch === "'") {
          inString = false;
          current += ch;
          j += 1;
          continue;
        }
        current += ch;
        j += 1;
        continue;
      }

      if (ch === "'") {
        inString = true;
        current += ch;
        j += 1;
        continue;
      }
      if (ch === ',') {
        fields.push(current);
        current = '';
        j += 1;
        continue;
      }
      if (ch === ')') {
        fields.push(current);
        j += 1;
        break;
      }
      current += ch;
      j += 1;
    }

    tuples.push(fields.map((f) => f.trim()));
    i = j;
  }

  return tuples;
};

const parseSqlDumpTable = (sqlText, table) => {
  const pattern = new RegExp(`INSERT INTO \`${table}\`\\s*\\(([^)]*)\\)\\s*VALUES\\s*([\\s\\S]*?);\\r?\\n`, 'g');
  let columns = null;
  const rows = [];
  let match;

  while ((match = pattern.exec(sqlText)) !== null) {
    const cols = match[1].split(',').map((c) => c.trim().replace(/`/g, ''));
    if (!columns) columns = cols;

    for (const tuple of parseSqlTuples(match[2])) {
      const row = {};
      cols.forEach((col, idx) => {
        row[col] = unquoteSqlValue(tuple[idx] ?? 'NULL');
      });
      rows.push(row);
    }
  }

  if (!columns) {
    throw new Error(`Geen "INSERT INTO \`${table}\`" statements gevonden in de SQL dump.`);
  }

  return rows;
};

// ---------------------------------------------------------------------------
// Strapi REST helpers
// ---------------------------------------------------------------------------

const strapiRequest = async (options, requestPath, init = {}) => {
  const response = await fetch(`${options.baseUrl}${requestPath}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${options.token}`,
      ...(init.headers || {}),
    },
  });

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!response.ok) {
    const message = body?.error?.message || response.statusText;
    throw new Error(`Strapi ${init.method || 'GET'} ${requestPath} -> ${response.status}: ${message}`);
  }

  return body;
};

const findPoiByTitleAndType = async (options, title, type) => {
  const query = new URLSearchParams({
    'filters[title][$eq]': title,
    'filters[type][$eq]': type,
    'pagination[pageSize]': '1',
    status: 'draft',
  });
  const body = await strapiRequest(options, `/api/pois?${query.toString()}`);
  return body?.data?.[0] ?? null;
};

const findPartnerBySlug = async (options, slug) => {
  const query = new URLSearchParams({
    'filters[slug][$eq]': slug,
    'pagination[pageSize]': '1',
    status: 'draft',
  });
  query.append('populate[pois][fields][0]', 'id');
  const body = await strapiRequest(options, `/api/partners?${query.toString()}`);
  return body?.data?.[0] ?? null;
};

const uploadImage = async (options, absolutePath, fileName, alternativeText) => {
  const buffer = await fs.readFile(absolutePath);
  const blob = new Blob([buffer], { type: mime.lookup(absolutePath) || 'application/octet-stream' });
  const formData = new FormData();
  formData.append('files', blob, fileName);

  if (alternativeText) {
    formData.append('fileInfo', JSON.stringify({ alternativeText }));
  }

  const response = await fetch(`${options.baseUrl}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${options.token}` },
    body: formData,
  });

  const body = await response.json();

  if (!response.ok) {
    throw new Error(`Strapi POST /api/upload -> ${response.status}: ${body?.error?.message || response.statusText}`);
  }

  return Array.isArray(body) ? body[0] : null;
};

const updateFileAltText = async (options, fileId, alternativeText) => {
  const formData = new FormData();
  formData.append('fileInfo', JSON.stringify({ alternativeText }));

  const response = await fetch(`${options.baseUrl}/api/upload?id=${fileId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${options.token}` },
    body: formData,
  });

  const body = await response.json();

  if (!response.ok) {
    throw new Error(`Strapi POST /api/upload?id=${fileId} -> ${response.status}: ${body?.error?.message || response.statusText}`);
  }

  return body;
};

// ---------------------------------------------------------------------------
// Main import
// ---------------------------------------------------------------------------

// One-off repair for POIs imported before the uploader started sending
// fileInfo: walks every poi with an image and sets the media's
// alternativeText to the poi's title if it's currently empty.
const fixAltText = async (options) => {
  let page = 1;
  let fixed = 0;
  let alreadyOk = 0;
  let noImage = 0;

  for (;;) {
    const query = new URLSearchParams({
      'pagination[page]': String(page),
      'pagination[pageSize]': '100',
      status: 'draft',
    });
    query.append('populate[image][fields][0]', 'id');
    query.append('populate[image][fields][1]', 'alternativeText');
    query.append('fields[0]', 'title');

    const body = await strapiRequest({ ...options }, `/api/pois?${query.toString()}`);
    const entries = body?.data ?? [];

    if (entries.length === 0) break;

    for (const entry of entries) {
      const image = entry.image;

      if (!image) {
        noImage += 1;
        continue;
      }

      if (image.alternativeText && image.alternativeText.trim().length > 0) {
        alreadyOk += 1;
        continue;
      }

      await updateFileAltText(options, image.id, entry.title);
      fixed += 1;
    }

    const pageCount = body?.meta?.pagination?.pageCount ?? page;
    if (page >= pageCount) break;
    page += 1;
  }

  console.log(JSON.stringify({ ok: true, mode: 'fix-alt-text', fixed, alreadyOk, noImage }, null, 2));
};

const run = async () => {
  const options = parseArgs();

  if (options.fixAltText) {
    await fixAltText(options);
    return;
  }

  const sqlText = await fs.readFile(options.sqlDumpPath, 'utf8');

  const points = parseSqlDumpTable(sqlText, 'Points');
  const pointsRoute = parseSqlDumpTable(sqlText, 'Points_route');
  const logies = parseSqlDumpTable(sqlText, 'Logies');

  const pointsById = new Map(points.map((row) => [Number(row.ID), row]));
  const logieById = new Map(logies.map((row) => [Number(row.ID), row]));

  const links = pointsRoute.filter((row) => Number(row.Lid) !== 0);
  const linkedPidsByLid = new Map();

  for (const link of links) {
    const lid = Number(link.Lid);
    const pid = Number(link.Pid);
    if (!linkedPidsByLid.has(lid)) linkedPidsByLid.set(lid, new Set());
    linkedPidsByLid.get(lid).add(pid);
  }

  const distinctPids = Array.from(new Set(links.map((link) => Number(link.Pid))));
  const pidsToImport = typeof options.limit === 'number' ? distinctPids.slice(0, options.limit) : distinctPids;
  const pidToStrapiId = new Map(); // pid -> { id, documentId }

  let poisCreated = 0;
  let poisUpdated = 0;
  let poisSkipped = 0;
  let skippedUnknownType = 0;

  for (const pid of pidsToImport) {
    const point = pointsById.get(pid);
    if (!point) {
      poisSkipped += 1;
      continue;
    }

    const type = toStringValue(point.Type);
    const title = toStringValue(point.Title);

    if (!POI_TYPES.includes(type) || !title) {
      skippedUnknownType += 1;
      continue;
    }

    const descriptionHtml = toStringValue(point.Description);
    const description = descriptionHtml ? htmlToBlocks(descriptionHtml) : undefined;

    const imagePath = await resolveLegacyFile(options.legacyRoot, options.imageFolder, toStringValue(point.Image));
    let imageId;

    if (imagePath && !options.dryRun) {
      const uploaded = await uploadImage(options, imagePath, `${slugify(title)}${path.extname(imagePath) || '.jpg'}`, title);
      imageId = uploaded?.id;
    }

    const legacyUrl = toStringValue(point.URL);
    const link = legacyUrl
      ? { url: normalizeHref(legacyUrl), anchor: 'Lees meer', target: getLinkTarget(legacyUrl, toStringValue(point.Target)) }
      : undefined;

    const data = { title, type, ...(description ? { description } : {}), ...(imageId ? { image: imageId } : {}), ...(link ? { link } : {}) };

    const existing = await findPoiByTitleAndType(options, title, type);

    if (options.dryRun) {
      pidToStrapiId.set(pid, existing ? { id: existing.id, documentId: existing.documentId } : { id: -pid, documentId: null });
      existing ? (poisUpdated += 1) : (poisCreated += 1);
      continue;
    }

    if (existing) {
      // PUT already publishes the update immediately (Strapi 5 REST default
      // behavior) — no separate publish call needed or available.
      await strapiRequest(options, `/api/pois/${existing.documentId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) });
      pidToStrapiId.set(pid, { id: existing.id, documentId: existing.documentId });
      poisUpdated += 1;
      continue;
    }

    const created = await strapiRequest(options, '/api/pois', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) });
    const createdEntry = created?.data;
    pidToStrapiId.set(pid, { id: createdEntry.id, documentId: createdEntry.documentId });
    poisCreated += 1;
  }

  let partnersLinked = 0;
  const partnersNotFound = [];

  for (const [lid, pidSet] of linkedPidsByLid.entries()) {
    const logie = logieById.get(lid);
    const slug = toStringValue(logie?.URL ?? null);
    if (!slug) continue;

    const poiIds = Array.from(pidSet)
      .map((pid) => pidToStrapiId.get(pid))
      .filter((entry) => entry && typeof entry.id === 'number')
      .map((entry) => entry.id);

    if (poiIds.length === 0) continue;

    const partner = await findPartnerBySlug(options, slug);
    if (!partner) {
      partnersNotFound.push(slug);
      continue;
    }

    if (options.dryRun) {
      partnersLinked += 1;
      continue;
    }

    await strapiRequest(options, `/api/partners/${partner.documentId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { pois: { connect: poiIds } } }),
    });
    partnersLinked += 1;
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        pointsParsed: points.length,
        linkRows: links.length,
        distinctLinkedPids: distinctPids.length,
        skippedUnknownType,
        poisCreated,
        poisUpdated,
        poisSkipped,
        partnersLinked,
        partnersNotFound,
      },
      null,
      2
    )
  );
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

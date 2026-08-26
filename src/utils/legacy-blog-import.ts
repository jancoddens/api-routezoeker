import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import mime from 'mime-types';
import type { Core } from '@strapi/strapi';

const execFileAsync = promisify(execFile);

// Legacy site (routezoeker.com, PHP) is still live and publicly reachable, so
// we fetch images over HTTP instead of guessing filesystem paths on the VPS.
// Override with --image-base-url if this ever changes.
const DEFAULT_IMAGE_BASE_URL = 'https://routezoeker.com';
// Gok voor waar profielafbeeldingen van de legacy 'Profiel'-tabel staan. Niet
// bevestigd — als dit fout is, faalt enkel de avatar-upload (best-effort),
// nooit de rest van de import.
const DEFAULT_PROFILE_IMAGE_PATH = '/images/profiel/';

type LegacyDbConfig = {
  host: string;
  user: string;
  password: string;
  database: string;
  port?: number;
};

type ImportOptions = {
  configPath: string;
  imageBaseUrl: string;
  profileImagePath: string;
  locale?: string;
  limit?: number;
  offset?: number;
  onlyIds?: number[];
  dryRun?: boolean;
  skipImages?: boolean;
  skipCategory?: string;
  // Pad (op de VPS) naar de map met legacy PHP-artikel-fragmenten
  // (descriptions_blog/<categorie>/<slug>.php, of <slug>.php in de root).
  // Wordt enkel gebruikt als fallback wanneer Lange_omschrijving leeg is.
  descriptionsPath?: string;
  hostOverride?: string;
  portOverride?: number;
  userOverride?: string;
  passwordOverride?: string;
  databaseOverride?: string;
};

type LegacyBlogRow = {
  ID: number | string;
  Actief: number | string | null;
  Profiel_id: number | string | null;
  Datum: string | null;
  Datum_aangepast: string | null;
  Categorie: string | null;
  Header: number | string | null;
  URL: string | null;
  Meta_title: string | null;
  Meta_description: string | null;
  Titel: string | null;
  Titel2: string | null;
  Korte_omschrijving: string | null;
  Intro: string | null;
  Lange_omschrijving: string | null;
  Afbeelding_top: string | null;
  Copy_top: string | null;
  Alt_top: string | null;
  Afbeelding_intro: string | null;
  Afbeelding_google: string | null;
  Alt_intro: string | null;
  Other_blogs: string | null;
};

type LegacyProfielRow = {
  ID: number | string;
  Gebruikersnaam: string | null;
  Naam: string | null;
  Voornaam: string | null;
  Email: string | null;
  Afbeelding: string | null;
};

type UploadFileEntity = {
  id: number;
  name: string;
  url: string;
  size?: number | string | null;
  folder?: { id?: number | null } | number | null;
  alternativeText?: string | null;
  caption?: string | null;
  width?: number | null;
  height?: number | null;
  formats?: Record<string, unknown> | null;
  hash?: string | null;
  ext?: string | null;
  mime?: string | null;
  previewUrl?: string | null;
  provider?: string | null;
  provider_metadata?: Record<string, unknown> | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

type UploadFolderEntity = {
  id: number;
  name: string;
};

type EntityReference = {
  id: number;
  slug?: string;
};

type ImportRowResult = {
  id: number;
  slug: string;
  status: 'created' | 'updated' | 'skipped' | 'error' | 'dry-run';
  message?: string;
};

type ImportSummary = {
  totalRows: number;
  created: number;
  updated: number;
  skipped: number;
  errors: number;
  authorsCreated: number;
  categoriesCreated: number;
  rows: ImportRowResult[];
  warnings: string[];
};

// ---------------------------------------------------------------------------
// Config / legacy DB access
// ---------------------------------------------------------------------------

const parsePhpConfig = async (configPath: string): Promise<LegacyDbConfig> => {
  const raw = await fs.readFile(configPath, 'utf8');
  const extract = (variable: string) => raw.match(new RegExp(`\\$${variable}\\s*=\\s*'([^']*)'`, 'i'))?.[1] ?? null;

  const host = extract('dbhost');
  const user = extract('dbuser');
  const password = extract('dbpass');
  const database = extract('dbname');

  if (!host || !user || password === null || !database) {
    throw new Error(`Could not parse database credentials from ${configPath}`);
  }

  return { host, user, password, database };
};

// Elke query geeft één kolom terug: een JSON-string per rij, opgebouwd door
// MySQL zelf via JSON_OBJECT(). Zo kan multi-line HTML (met \r\n) de
// rij-per-regel parsing niet corrumperen. --raw is verplicht, anders past
// mysql zijn eigen batch-escaping toe bovenop de JSON-escaping van MySQL.
const runJsonRowQuery = async <T,>(config: LegacyDbConfig, sql: string): Promise<T[]> => {
  const args = ['--batch', '--raw', '--skip-column-names', '-h', config.host, '-u', config.user, '-D', config.database, '-e', sql];

  if (config.port) {
    args.splice(6, 0, '-P', String(config.port));
  }

  const { stdout } = await execFileAsync('mysql', args, {
    env: { ...process.env, MYSQL_PWD: config.password },
    maxBuffer: 1024 * 1024 * 100,
  });

  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
};

const BLOG_COLUMNS = [
  'ID', 'Actief', 'Profiel_id', 'Datum', 'Datum_aangepast', 'Categorie', 'Header', 'URL',
  'Meta_title', 'Meta_description', 'Titel', 'Titel2', 'Korte_omschrijving', 'Intro',
  'Lange_omschrijving', 'Afbeelding_top', 'Copy_top', 'Alt_top', 'Afbeelding_intro',
  'Afbeelding_google', 'Alt_intro', 'Other_blogs',
];

const PROFIEL_COLUMNS = ['ID', 'Gebruikersnaam', 'Naam', 'Voornaam', 'Email', 'Afbeelding'];

const buildJsonObjectExpr = (columns: string[]) =>
  `JSON_OBJECT(${columns.map((column) => `'${column}', \`${column}\``).join(', ')})`;

const fetchLegacyBlogRows = async (config: LegacyDbConfig): Promise<LegacyBlogRow[]> =>
  runJsonRowQuery<LegacyBlogRow>(config, `SELECT ${buildJsonObjectExpr(BLOG_COLUMNS)} FROM \`Blog\` ORDER BY \`ID\` ASC`);

const fetchLegacyProfielRow = async (config: LegacyDbConfig, profielId: number): Promise<LegacyProfielRow | null> => {
  const rows = await runJsonRowQuery<LegacyProfielRow>(
    config,
    `SELECT ${buildJsonObjectExpr(PROFIEL_COLUMNS)} FROM \`Profiel\` WHERE \`ID\` = ${Number(profielId)} LIMIT 1`
  );
  return rows[0] ?? null;
};

// ---------------------------------------------------------------------------
// Small string / HTML helpers
// ---------------------------------------------------------------------------

const normalizeWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim();

const decodeHtmlEntities = (value: string) =>
  value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lsquo;|&rsquo;/gi, "'")
    .replace(/&ldquo;|&rdquo;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');

const stripHtmlTags = (value: string) => normalizeWhitespace(decodeHtmlEntities(value.replace(/<[^>]+>/g, ' ')));
// Zelfde als stripHtmlTags, maar zonder trim() — gebruikt op de tekststukken
// tussen inline-tags (vóór/na een <a>/<strong>/<em>) zodat een spatie in de
// brontekst (bv. "bij: <strong>iets</strong> is") niet verloren gaat. Zonder
// dit plakken twee opeenvolgende <span>-elementen in de frontend aan elkaar:
// "bij:iets" i.p.v. "bij: iets".
const stripHtmlTagsKeepEdges = (value: string) =>
  decodeHtmlEntities(value.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');

const toStringValue = (value: unknown): string | null => {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
};

const slugify = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const truncate = (value: string, maxLength: number) =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength - 1).trim()}…`;

const toIsoDate = (value: string | null): string | undefined => {
  if (!value) {
    return undefined;
  }
  const parsed = new Date(value.replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
};

// ---------------------------------------------------------------------------
// HTML -> Strapi "blocks" content conversion
// ---------------------------------------------------------------------------

type InlineNode = Record<string, unknown>;
type BlockNode = Record<string, unknown>;

// Legacy pagina's die (nog) niet op de nieuwe site bestaan (interne links
// zoals "/wandelroutes/..." uit descriptions_blog-bestanden) verwijzen we
// door naar de oude site i.p.v. ze te laten 404'en op nieuw.routezoeker.com.
// legacyBaseUrl is enkel gezet wanneer we HTML uit een descriptions_blog
// PHP-bestand parsen (zie htmlToBlocks); voor DB-velden (Intro/Lange_omschrijving)
// blijft dit ongemoeid (root-relatieve links blijven root-relatief).
const normalizeHref = (href: string, legacyBaseUrl?: string) => {
  const trimmed = decodeHtmlEntities(href.trim());
  if (legacyBaseUrl && trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    return `${legacyBaseUrl}${trimmed}`;
  }
  return trimmed;
};
const getLinkTarget = (href: string) => (/^https?:\/\//i.test(href) ? '_blank' : '_self');
const getLinkRel = (href: string) => (/^https?:\/\//i.test(href) ? 'noopener noreferrer' : '');
// Strapi's blocks-veld accepteert enkel absolute (http/https) of root-relatieve
// ("/pad") urls. Legacy in-paginaverwijzingen zoals "#route1" (ankers naar
// een sectie die in de nieuwe opbouw toch niet bestaat) vallen hierbuiten —
// die zetten we om naar gewone tekst i.p.v. een link, anders weigert Strapi
// de hele blogpost.
const isValidBlocksLinkUrl = (href: string) => /^https?:\/\//i.test(href) || href.startsWith('/');

// Eén-staps inline tokenizer: link / bold / italic op het hoogste niveau.
// Geneste opmaak binnenin (bv. <strong> in een <a>) wordt platgeslagen naar
// tekst — voor deze blogcontent (grotendeels vlakke HTML) is dat voldoende.
const INLINE_PATTERN =
  /<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>|<(strong|b)\b[^>]*>([\s\S]*?)<\/\4>|<(em|i)\b[^>]*>([\s\S]*?)<\/\6>/gi;

const htmlInlineToChildren = (value: string, legacyBaseUrl?: string): InlineNode[] => {
  const children: InlineNode[] = [];
  let lastIndex = 0;

  for (const match of value.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    const before = stripHtmlTagsKeepEdges(value.slice(lastIndex, index));
    if (before) {
      children.push({ type: 'text', text: before });
    }

    if (match[2] !== undefined) {
      // link
      const href = normalizeHref(match[2] ?? '', legacyBaseUrl);
      const linkText = stripHtmlTags(match[3] ?? '');
      if (href && linkText && isValidBlocksLinkUrl(href)) {
        children.push({
          type: 'link',
          url: href,
          target: getLinkTarget(href),
          rel: getLinkRel(href),
          children: [{ type: 'text', text: linkText }],
        });
      } else if (linkText) {
        children.push({ type: 'text', text: linkText });
      }
    } else if (match[4] !== undefined) {
      // bold
      const boldText = stripHtmlTags(match[5] ?? '');
      if (boldText) {
        children.push({ type: 'text', text: boldText, bold: true });
      }
    } else if (match[6] !== undefined) {
      // italic
      const italicText = stripHtmlTags(match[7] ?? '');
      if (italicText) {
        children.push({ type: 'text', text: italicText, italic: true });
      }
    }

    lastIndex = index + match[0].length;
  }

  const after = stripHtmlTagsKeepEdges(value.slice(lastIndex));
  if (after) {
    children.push({ type: 'text', text: after });
  }

  return children.length > 0 ? children : [{ type: 'text', text: '' }];
};

const LIST_ITEM_PATTERN = /<li[^>]*>([\s\S]*?)<\/li>/gi;

const htmlListToBlock = (tagName: string, innerHtml: string, legacyBaseUrl?: string): BlockNode | null => {
  const items = Array.from(innerHtml.matchAll(LIST_ITEM_PATTERN))
    .map((match) => stripHtmlTags(match[1] ?? '') && match[1])
    .filter((value): value is string => Boolean(value));

  if (items.length === 0) {
    return null;
  }

  return {
    type: 'list',
    format: tagName.toLowerCase() === 'ol' ? 'ordered' : 'unordered',
    children: items.map((item) => ({
      type: 'list-item',
      children: htmlInlineToChildren(item, legacyBaseUrl),
    })),
  };
};

// Haalt de waarde van één attribuut (bv. src, alt) uit een ruwe
// attribuut-string van een <img ...> tag.
const extractAttr = (attrs: string, name: string): string | null => {
  const match = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  return match ? decodeHtmlEntities(match[2] ?? '').trim() || null : null;
};

// Top-level block segmenter: knipt de HTML op in headings / lijsten /
// paragrafen / afbeeldingen, en behandelt alle overige tekst (incl. tekst
// buiten <p> tags, en tekst binnen <div>/<span> wrappers) als losse
// paragrafen. <img> levert een "pending" image-block op (__legacySrc) —
// die wordt pas na upload (async) omgezet naar een echt Strapi image-block,
// zie resolveImageBlocksInZones.
const BLOCK_PATTERN =
  /<(h[2-6])[^>]*>([\s\S]*?)<\/\1>|<(ol|ul)[^>]*>([\s\S]*?)<\/\3>|<p[^>]*>([\s\S]*?)<\/p>|<img\b([^>]*)>/gi;

const paragraphsFromLooseText = (value: string, legacyBaseUrl?: string): BlockNode[] =>
  value
    .replace(/<br\s*\/?>/gi, '\n')
    .split(/\n{2,}|\n/)
    .filter((chunk) => stripHtmlTags(chunk))
    .map((chunk) => ({ type: 'paragraph', children: htmlInlineToChildren(chunk, legacyBaseUrl) }));

// legacyBaseUrl (optioneel): wanneer gezet, worden root-relatieve links
// ("/pad") omgezet naar absolute links naar de oude site (zie normalizeHref
// hierboven) — gebruikt wanneer html afkomstig is uit een descriptions_blog
// PHP-bestand. Voor DB-velden (Intro/Lange_omschrijving) laten we dit weg.
export const htmlToBlocks = (html: string | null | undefined, legacyBaseUrl?: string): BlockNode[] => {
  const value = (html ?? '').replace(/\r\n?/g, '\n').trim();
  if (!value) {
    return [];
  }

  const blocks: BlockNode[] = [];
  let lastIndex = 0;

  for (const match of value.matchAll(BLOCK_PATTERN)) {
    const index = match.index ?? 0;
    const loose = value.slice(lastIndex, index);
    blocks.push(...paragraphsFromLooseText(loose, legacyBaseUrl));

    if (match[1] !== undefined) {
      // heading
      const level = Math.min(6, Math.max(1, Number(match[1].slice(1)) || 2));
      const text = htmlInlineToChildren(match[2] ?? '', legacyBaseUrl);
      if (text.some((node) => toStringValue((node as { text?: string }).text))) {
        blocks.push({ type: 'heading', level, children: text });
      }
    } else if (match[3] !== undefined) {
      // list
      const listBlock = htmlListToBlock(match[3], match[4] ?? '', legacyBaseUrl);
      if (listBlock) {
        blocks.push(listBlock);
      }
    } else if (match[5] !== undefined) {
      // paragraph
      blocks.push(...paragraphsFromLooseText(match[5] ?? '', legacyBaseUrl));
    } else if (match[6] !== undefined) {
      // image (pending upload)
      const src = extractAttr(match[6] ?? '', 'src');
      const alt = extractAttr(match[6] ?? '', 'alt');
      if (src) {
        blocks.push({ type: 'image', __legacySrc: src, __legacyAlt: alt, children: [{ type: 'text', text: '' }] });
      }
    }

    lastIndex = index + match[0].length;
  }

  blocks.push(...paragraphsFromLooseText(value.slice(lastIndex), legacyBaseUrl));

  return blocks.filter((block) => {
    if (block.type !== 'paragraph') {
      return true;
    }
    const children = (block.children as InlineNode[]) ?? [];
    return children.some((child) => toStringValue((child as { text?: string }).text));
  });
};

// ---------------------------------------------------------------------------
// descriptions_blog PHP-fragmenten -> bruikbare HTML
// ---------------------------------------------------------------------------

// De descriptions_blog/*.php bestanden zijn geen losse pagina's, maar
// Bootstrap-opgemaakte content-fragmenten (section/container/row/col) die
// ergens in een legacy pagina-template werden ge-include't. Deze functie
// filtert de layout-wrapper en decoratieve elementen weg zodat enkel
// headings/paragrafen/lijsten/afbeeldingen overblijven — precies wat
// htmlToBlocks verwacht.
const stripPhpPageChrome = (raw: string): string =>
  raw
    // php-tags (voor de zekerheid, niet gezien in de voorbeelden maar kan voorkomen)
    .replace(/<\?php[\s\S]*?\?>/gi, '')
    // scripts/styles/comments
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    // decoratieve icoontjes, bv. <i class="icn-flower ..."></i>
    .replace(/<i\b[^>]*class="[^"]*\bicn-[^"]*"[^>]*>[\s\S]*?<\/i>/gi, '')
    // CTA-knoppen (bv. "Ontdek de suggestie routes") zijn geen artikelinhoud
    .replace(/<a\b[^>]*class="[^"]*\bbtn\b[^"]*"[^>]*>[\s\S]*?<\/a>/gi, '')
    // lightbox-omhulsel rond afbeeldingen: <a data-glightbox ...><img .../></a>
    // -> enkel de <img> behouden
    .replace(/<a\b[^>]*data-glightbox[^>]*>([\s\S]*?)<\/a>/gi, '$1')
    .replace(/<\/?figure\b[^>]*>/gi, '')
    // layout-wrappers weg (inhoud blijft staan, enkel de tags verdwijnen)
    .replace(/<\/?(?:div|section)\b[^>]*>/gi, '');

export const legacyDescriptionHtmlToBlocks = (raw: string, legacyBaseUrl: string): BlockNode[] =>
  htmlToBlocks(stripPhpPageChrome(raw), legacyBaseUrl);

// ---------------------------------------------------------------------------
// Media download + upload
// ---------------------------------------------------------------------------

const sanitizeUploadFilename = (value: string) => {
  const normalized = path.basename(value).normalize('NFC');
  const originalExtension = path.extname(normalized);
  const unsafeCharsPattern = /[<>:"/\\|?*\x00-\x1f]/g;
  const sanitizedExtension = originalExtension.replace(unsafeCharsPattern, '');
  const baseName = path.basename(normalized, originalExtension);
  const sanitizedBaseName = baseName
    .replace(unsafeCharsPattern, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const safeBaseName = sanitizedBaseName && sanitizedBaseName !== '.' && sanitizedBaseName !== '..' ? sanitizedBaseName : 'file';
  const maxBaseLength = Math.max(1, 255 - sanitizedExtension.length);
  return `${safeBaseName.slice(0, maxBaseLength)}${sanitizedExtension}` || 'file';
};

const downloadRemoteFile = async (url: string): Promise<{ filepath: string; size: number } | null> => {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length === 0) {
      return null;
    }
    const extension = path.extname(new URL(url).pathname) || '.jpg';
    const tmpPath = path.join(
      os.tmpdir(),
      `legacy-blog-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}${extension}`
    );
    await fs.writeFile(tmpPath, buffer);
    return { filepath: tmpPath, size: buffer.length };
  } catch {
    return null;
  }
};

const uploadMediaFromUrl = async (
  strapi: Core.Strapi,
  url: string,
  mediaName: string,
  folderName: string,
  cache: Map<string, UploadFileEntity | null>,
  dryRun?: boolean
): Promise<UploadFileEntity | null> => {
  if (cache.has(url)) {
    return cache.get(url) ?? null;
  }

  if (dryRun) {
    cache.set(url, null);
    return null;
  }

  const sanitizedMediaName = sanitizeUploadFilename(mediaName);
  const folder = (await strapi.db.query('plugin::upload.folder').findOne({
    where: { name: folderName },
  })) as UploadFolderEntity | null;

  const existingCandidates = (await strapi.db.query('plugin::upload.file').findMany({
    where: { name: sanitizedMediaName },
    populate: { folder: true },
  })) as UploadFileEntity[];

  const existing =
    existingCandidates.find((candidate) => {
      const candidateFolderId =
        typeof candidate.folder === 'object' ? candidate.folder?.id ?? null : candidate.folder ?? null;
      return candidateFolderId === (folder?.id ?? null);
    }) ?? null;

  if (existing) {
    cache.set(url, existing);
    return existing;
  }

  const downloaded = await downloadRemoteFile(url);
  if (!downloaded) {
    cache.set(url, null);
    return null;
  }

  try {
    const uploaded = await strapi.plugin('upload').service('upload').upload({
      data: { fileInfo: { folder: folder?.id } },
      files: {
        filepath: downloaded.filepath,
        originalFilename: sanitizedMediaName,
        mimetype: mime.lookup(downloaded.filepath) || 'application/octet-stream',
        size: downloaded.size,
      },
    });
    const uploadedFile = Array.isArray(uploaded) ? ((uploaded[0] as UploadFileEntity | undefined) ?? null) : null;
    cache.set(url, uploadedFile);
    return uploadedFile;
  } catch (error) {
    strapi.log.warn(`[legacy-blog-import] Kon afbeelding niet uploaden (${url}): ${(error as Error)?.message}`);
    cache.set(url, null);
    return null;
  } finally {
    await fs.unlink(downloaded.filepath).catch(() => undefined);
  }
};

// ---------------------------------------------------------------------------
// Author / category resolution
// ---------------------------------------------------------------------------

const ensureAuthor = async (
  strapi: Core.Strapi,
  legacyConfig: LegacyDbConfig,
  profielId: number,
  cache: Map<number, EntityReference>,
  mediaCache: Map<string, UploadFileEntity | null>,
  options: ImportOptions,
  summary: ImportSummary
): Promise<EntityReference | null> => {
  if (cache.has(profielId)) {
    return cache.get(profielId) ?? null;
  }

  const profielRow = await fetchLegacyProfielRow(legacyConfig, profielId);
  const displayName = toStringValue(profielRow?.Gebruikersnaam) || `Profiel ${profielId}`;
  const slug = `${slugify(displayName)}-${profielId}`;

  const existing = (await strapi.entityService.findMany('api::author.author', {
    filters: { slug: { $eq: slug } },
    limit: 1,
  })) as unknown as EntityReference[];

  if (Array.isArray(existing) && existing[0]) {
    cache.set(profielId, existing[0]);
    return existing[0];
  }

  if (options.dryRun) {
    const placeholder = { id: 0, slug };
    cache.set(profielId, placeholder);
    return placeholder;
  }

  let avatarId: number | undefined;
  const avatarFile = toStringValue(profielRow?.Afbeelding);
  if (avatarFile && !options.skipImages) {
    const avatarUrl = `${options.imageBaseUrl}${options.profileImagePath}${avatarFile}`;
    const uploaded = await uploadMediaFromUrl(strapi, avatarUrl, avatarFile, 'Authors', mediaCache, options.dryRun);
    avatarId = uploaded?.id;
    if (!uploaded) {
      summary.warnings.push(
        `Profiel ${profielId} (${displayName}): avatar niet gevonden op ${avatarUrl} — auteur aangemaakt zonder foto.`
      );
    }
  }

  const created = (await strapi.entityService.create('api::author.author', {
    data: {
      name: displayName,
      slug,
      avatar: avatarId,
      bio: [],
      publishedAt: new Date().toISOString(),
    } as never,
    locale: options.locale,
  })) as unknown as EntityReference;

  summary.authorsCreated += 1;
  cache.set(profielId, created);
  return created;
};

const ensureCategory = async (
  strapi: Core.Strapi,
  categoryName: string,
  cache: Map<string, EntityReference>,
  options: ImportOptions,
  summary: ImportSummary
): Promise<EntityReference | null> => {
  const key = categoryName.toLowerCase();
  if (cache.has(key)) {
    return cache.get(key) ?? null;
  }

  const slug = slugify(categoryName);

  const existing = (await strapi.entityService.findMany('api::blog-category.blog-category', {
    filters: { slug: { $eq: slug } },
    limit: 1,
  })) as unknown as EntityReference[];

  if (Array.isArray(existing) && existing[0]) {
    cache.set(key, existing[0]);
    return existing[0];
  }

  if (options.dryRun) {
    const placeholder = { id: 0, slug };
    cache.set(key, placeholder);
    return placeholder;
  }

  const created = (await strapi.entityService.create('api::blog-category.blog-category', {
    data: {
      title: categoryName,
      slug,
      excerpt: [],
      publishedAt: new Date().toISOString(),
    } as never,
    locale: options.locale,
  })) as unknown as EntityReference;

  summary.categoriesCreated += 1;
  cache.set(key, created);
  return created;
};

// ---------------------------------------------------------------------------
// descriptions_blog: matchend PHP-bestand opzoeken op VPS-schijf
// ---------------------------------------------------------------------------

// Zoekt <descriptionsPath>/<slug>.php (root) of <descriptionsPath>/<elke-submap>/<slug>.php
// (bv. wandeltips/, fietstips/, logietips/). We matchen puur op bestandsnaam,
// niet op categorie-submap, want de legacy Categorie-waarde in de DB komt
// niet altijd 1-op-1 overeen met de mapnaam.
const findDescriptionFile = async (descriptionsPath: string, slug: string): Promise<string | null> => {
  const target = `${slug}.php`;

  try {
    const rootEntries = await fs.readdir(descriptionsPath, { withFileTypes: true });

    const rootMatch = rootEntries.find((entry) => entry.isFile() && entry.name === target);
    if (rootMatch) {
      return path.join(descriptionsPath, rootMatch.name);
    }

    const subdirs = rootEntries.filter((entry) => entry.isDirectory());
    for (const dir of subdirs) {
      const dirPath = path.join(descriptionsPath, dir.name);
      try {
        const dirEntries = await fs.readdir(dirPath, { withFileTypes: true });
        const match = dirEntries.find((entry) => entry.isFile() && entry.name === target);
        if (match) {
          return path.join(dirPath, match.name);
        }
      } catch {
        // submap niet leesbaar, negeren en verdergaan
      }
    }
  } catch {
    return null;
  }

  return null;
};

// ---------------------------------------------------------------------------
// "Pending" image-blocks (uit htmlToBlocks) uploaden en vervangen door
// echte Strapi blocks image-nodes. Blocks-velden bevatten geen live
// media-relatie: de volledige media-attributen moeten inline in de JSON
// staan, vandaar dat we hier de upload-response 1-op-1 in het block zetten.
// ---------------------------------------------------------------------------

const resolveImageBlocksInZones = async (
  zones: Array<{ __component: string; title?: string; content: BlockNode[]; max_width: string }>,
  strapi: Core.Strapi,
  options: ImportOptions,
  mediaCache: Map<string, UploadFileEntity | null>,
  summary: ImportSummary,
  legacyId: number
): Promise<void> => {
  for (const zone of zones) {
    const resolved: BlockNode[] = [];

    for (const block of zone.content) {
      const legacySrc = (block as { __legacySrc?: string }).__legacySrc;
      if (legacySrc === undefined) {
        resolved.push(block);
        continue;
      }

      if (options.skipImages) {
        continue;
      }

      const legacyAlt = (block as { __legacyAlt?: string | null }).__legacyAlt ?? null;
      const absoluteUrl = legacySrc.startsWith('/') ? `${options.imageBaseUrl}${legacySrc}` : legacySrc;
      const mediaName = path.basename(legacySrc);

      const uploaded = options.dryRun
        ? null
        : await uploadMediaFromUrl(strapi, absoluteUrl, mediaName, 'Blog', mediaCache, options.dryRun);

      if (options.dryRun) {
        continue;
      }

      if (!uploaded) {
        summary.warnings.push(`Blog ${legacyId}: afbeelding in artikeltekst niet gevonden op ${absoluteUrl} — overgeslagen.`);
        continue;
      }

      resolved.push({
        type: 'image',
        image: {
          name: uploaded.name,
          alternativeText: legacyAlt || uploaded.alternativeText || null,
          url: uploaded.url,
          caption: uploaded.caption || null,
          width: uploaded.width ?? 0,
          height: uploaded.height ?? 0,
          formats: uploaded.formats || null,
          hash: uploaded.hash || '',
          ext: uploaded.ext || path.extname(uploaded.name),
          mime: uploaded.mime || 'image/jpeg',
          size: uploaded.size ?? 0,
          previewUrl: uploaded.previewUrl || null,
          provider: uploaded.provider || 'local',
          provider_metadata: uploaded.provider_metadata || null,
          createdAt: uploaded.createdAt || new Date().toISOString(),
          updatedAt: uploaded.updatedAt || new Date().toISOString(),
        },
        children: [{ type: 'text', text: '' }],
      });
    }

    zone.content = resolved;
  }
};

// ---------------------------------------------------------------------------
// Main import
// ---------------------------------------------------------------------------

const buildContentDynamicZone = async (
  row: LegacyBlogRow,
  slug: string,
  strapi: Core.Strapi,
  options: ImportOptions,
  mediaCache: Map<string, UploadFileEntity | null>,
  summary: ImportSummary,
  legacyId: number
) => {
  const zones: Array<{ __component: string; title?: string; content: BlockNode[]; max_width: string }> = [];

  const introBlocks = htmlToBlocks(row.Intro);
  if (introBlocks.length > 0) {
    zones.push({ __component: 'page-blocks.text-section', content: introBlocks, max_width: 'default' });
  }

  let bodyBlocks = htmlToBlocks(row.Lange_omschrijving);

  // Fallback: bij een aantal (nieuwere) posts staat Lange_omschrijving leeg
  // in de DB omdat het artikel destijds rechtstreeks als PHP-paginafragment
  // werd gecodeerd (descriptions_blog/<categorie>/<slug>.php) i.p.v. in het
  // CMS-veld. Als --descriptions-path is meegegeven en er geen DB-body is,
  // proberen we dat bestand te vinden en om te zetten.
  if (bodyBlocks.length === 0 && options.descriptionsPath) {
    const descriptionFile = await findDescriptionFile(options.descriptionsPath, slug);
    if (descriptionFile) {
      try {
        const raw = await fs.readFile(descriptionFile, 'utf8');
        bodyBlocks = legacyDescriptionHtmlToBlocks(raw, options.imageBaseUrl);
        if (bodyBlocks.length === 0) {
          summary.warnings.push(`Blog ${legacyId} (${slug}): descriptions-bestand ${descriptionFile} gevonden maar leverde geen bruikbare content op.`);
        } else {
          summary.warnings.push(`Blog ${legacyId} (${slug}): body aangevuld vanuit ${descriptionFile} (Lange_omschrijving stond leeg in de DB).`);
        }
      } catch (error) {
        summary.warnings.push(`Blog ${legacyId} (${slug}): kon descriptions-bestand ${descriptionFile} niet lezen: ${(error as Error)?.message}`);
      }
    } else {
      summary.warnings.push(`Blog ${legacyId} (${slug}): Lange_omschrijving leeg en geen bijpassend bestand gevonden in --descriptions-path.`);
    }
  }

  if (bodyBlocks.length > 0) {
    zones.push({ __component: 'page-blocks.text-section', content: bodyBlocks, max_width: 'default' });
  }

  if (!options.dryRun) {
    await resolveImageBlocksInZones(zones, strapi, options, mediaCache, summary, legacyId);
  }

  return zones;
};

const resolveExcerpt = (row: LegacyBlogRow): string => {
  const fromKort = toStringValue(row.Korte_omschrijving);
  if (fromKort) {
    return truncate(stripHtmlTags(fromKort), 500);
  }
  const fromMeta = toStringValue(row.Meta_description);
  if (fromMeta) {
    return truncate(fromMeta, 500);
  }
  const fromIntro = toStringValue(row.Intro);
  return fromIntro ? truncate(stripHtmlTags(fromIntro), 300) : '';
};

const resolveCoverImageUrl = (row: LegacyBlogRow, imageBaseUrl: string): { url: string; name: string; alt: string | null } | null => {
  const relativePath = toStringValue(row.Afbeelding_top) || toStringValue(row.Afbeelding_intro);
  if (!relativePath) {
    return null;
  }
  const alt = toStringValue(row.Alt_top) || toStringValue(row.Alt_intro);
  return {
    url: `${imageBaseUrl}${relativePath.startsWith('/') ? relativePath : `/${relativePath}`}`,
    name: path.basename(relativePath),
    alt,
  };
};

export const importLegacyBlogs = async (strapi: Core.Strapi, rawOptions: Partial<ImportOptions>): Promise<ImportSummary> => {
  const options: ImportOptions = {
    configPath: rawOptions.configPath!,
    imageBaseUrl: (rawOptions.imageBaseUrl || DEFAULT_IMAGE_BASE_URL).replace(/\/$/, ''),
    profileImagePath: rawOptions.profileImagePath || DEFAULT_PROFILE_IMAGE_PATH,
    locale: rawOptions.locale,
    limit: rawOptions.limit,
    offset: rawOptions.offset,
    onlyIds: rawOptions.onlyIds,
    dryRun: rawOptions.dryRun,
    skipImages: rawOptions.skipImages,
    skipCategory: (rawOptions.skipCategory || 'all').toLowerCase(),
    descriptionsPath: rawOptions.descriptionsPath,
    hostOverride: rawOptions.hostOverride,
    portOverride: rawOptions.portOverride,
    userOverride: rawOptions.userOverride,
    passwordOverride: rawOptions.passwordOverride,
    databaseOverride: rawOptions.databaseOverride,
  };

  const parsedConfig = await parsePhpConfig(options.configPath);
  const legacyConfig: LegacyDbConfig = {
    host: options.hostOverride || parsedConfig.host,
    user: options.userOverride || parsedConfig.user,
    password: options.passwordOverride !== undefined ? options.passwordOverride : parsedConfig.password,
    database: options.databaseOverride || parsedConfig.database,
    port: options.portOverride,
  };

  const summary: ImportSummary = {
    totalRows: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    authorsCreated: 0,
    categoriesCreated: 0,
    rows: [],
    warnings: [],
  };

  const allRows = await fetchLegacyBlogRows(legacyConfig);
  summary.totalRows = allRows.length;

  let rows = allRows;
  if (options.onlyIds && options.onlyIds.length > 0) {
    const idSet = new Set(options.onlyIds);
    rows = rows.filter((row) => idSet.has(Number(row.ID)));
  }
  if (typeof options.offset === 'number') {
    rows = rows.slice(options.offset);
  }
  if (typeof options.limit === 'number') {
    rows = rows.slice(0, options.limit);
  }

  const authorCache = new Map<number, EntityReference>();
  const categoryCache = new Map<string, EntityReference>();
  const mediaCache = new Map<string, UploadFileEntity | null>();

  for (const row of rows) {
    const legacyId = Number(row.ID);

    try {
      const title = toStringValue(row.Titel) || toStringValue(row.Titel2) || `Blog ${legacyId}`;
      const slugSource = toStringValue(row.URL) || title;
      const slug = slugify(slugSource);

      if (!slug) {
        summary.skipped += 1;
        summary.rows.push({ id: legacyId, slug: '', status: 'skipped', message: 'Geen bruikbare slug (URL/titel leeg).' });
        continue;
      }

      const profielId = Number(row.Profiel_id) || 1;
      const author = await ensureAuthor(strapi, legacyConfig, profielId, authorCache, mediaCache, options, summary);

      const categoryName = toStringValue(row.Categorie);
      let categoryIds: number[] = [];
      if (categoryName && categoryName.toLowerCase() !== options.skipCategory) {
        const category = await ensureCategory(strapi, categoryName, categoryCache, options, summary);
        categoryIds = category ? [category.id] : [];
      }

      let coverImageId: number | undefined;
      const cover = resolveCoverImageUrl(row, options.imageBaseUrl);
      if (cover && !options.skipImages) {
        const uploaded = await uploadMediaFromUrl(strapi, cover.url, cover.name, 'Blog', mediaCache, options.dryRun);
        coverImageId = uploaded?.id;
        if (!uploaded && !options.dryRun) {
          summary.warnings.push(`Blog ${legacyId} (${slug}): cover-afbeelding niet gevonden op ${cover.url}.`);
        }
      }

      const metaTitle = toStringValue(row.Meta_title) || title;
      const excerpt = resolveExcerpt(row);
      const metaDescription = toStringValue(row.Meta_description) || excerpt;
      const isActive = toStringValue(row.Actief) === '1';
      // Datum van de oude site (wanneer geplaatst/aangepast). Strapi's
      // entityService negeert een handmatig meegegeven publishedAt bij
      // create/update (het zet er altijd "nu" in) — we zetten deze datum
      // daarom hieronder apart, rechtstreeks via db.query, na de create/update.
      const legacyPublishedAt = isActive ? toIsoDate(row.Datum_aangepast || row.Datum) : undefined;

      const content = await buildContentDynamicZone(row, slug, strapi, options, mediaCache, summary, legacyId);

      const data = {
        title,
        slug,
        excerpt,
        coverImage: coverImageId,
        categories: categoryIds,
        author: author?.id || undefined,
        featured: toStringValue(row.Header) === '1',
        seo: {
          meta_title: metaTitle,
          meta_description: metaDescription,
          robots: 'index, follow',
        },
        content,
        publishedAt: isActive ? legacyPublishedAt ?? new Date().toISOString() : undefined,
      };

      if (options.dryRun) {
        summary.rows.push({ id: legacyId, slug, status: 'dry-run' });
        continue;
      }

      const existing = (await strapi.entityService.findMany('api::blog-post.blog-post', {
        filters: { slug: { $eq: slug } },
        locale: options.locale,
        limit: 1,
      })) as unknown as EntityReference[];

      let savedId: number | undefined;

      if (Array.isArray(existing) && existing[0]) {
        await strapi.entityService.update('api::blog-post.blog-post', existing[0].id, { data: data as never });
        savedId = existing[0].id;
        summary.updated += 1;
        summary.rows.push({ id: legacyId, slug, status: 'updated' });
      } else {
        const createdPost = (await strapi.entityService.create('api::blog-post.blog-post', {
          data: data as never,
          locale: options.locale,
        })) as unknown as EntityReference;
        savedId = createdPost?.id;
        summary.created += 1;
        summary.rows.push({ id: legacyId, slug, status: 'created' });
      }

      if (savedId && legacyPublishedAt) {
        await strapi.db.query('api::blog-post.blog-post').update({
          where: { id: savedId },
          data: { publishedAt: legacyPublishedAt },
        });
      }
    } catch (error) {
      summary.errors += 1;
      const details = (error as { details?: { errors?: Array<{ path?: string[]; message?: string }> } })?.details?.errors;
      const detailText = Array.isArray(details) && details.length > 0
        ? details.map((detail) => `${(detail.path ?? []).join('.')}: ${detail.message}`).join(' | ')
        : undefined;
      const message = detailText || (error as Error)?.message || String(error);
      summary.rows.push({ id: legacyId, slug: '', status: 'error', message });
      strapi.log.error(`[legacy-blog-import] Blog ${legacyId} mislukt: ${message}`);
    }
  }

  return summary;
};

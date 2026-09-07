#!/usr/bin/env node

'use strict';

// Importeert rijen uit de legacy `Plaatsen`-tabel (front_routezoeker) als
// Strapi blog-posts, gekoppeld aan een blog-category. Gemaakt voor de
// "Ontdek overzetten" todo: de oude /ontdek pagina ("Ontdek de mooiste
// plekjes") haalde zijn 18 bestemmingen uit deze tabel via
// `Universe = 'Ontdek'`. Op de nieuwe site wordt dat nu gewoon een
// blog-category "Ontdek" (zie src/app/ontdek/page.tsx, een dunne wrapper
// rond de bestaande /blog/[subcategory] route).
//
// Zelfde aanpak als scripts/import-legacy-pois.js: geen directe
// database-connectie (lokaal of live), enkel een mysqldump `.sql` export
// (parsing hieronder) als bron, en de Strapi REST API als bestemming. De
// enige uitzondering is de cover-afbeelding: die staat niet lokaal op deze
// machine, dus die wordt via HTTP van de LIVE legacy site
// (https://www.routezoeker.com) gedownload en meteen naar Strapi geüpload.
//
// Herhaald draaien is veilig: posts en de categorie worden op slug
// opgezocht en bijgewerkt (PUT) in plaats van gedupliceerd.
//
// De `Description` kolom in de `Plaatsen`-tabel is voor veel rijen maar één
// dun paragraafje. De echte, rijkere pagina-inhoud (tussenkoppen, "Leuke
// weetjes", FAQ's, routekaartjes) zit voor nieuwere plekken in aparte PHP-
// paginafragmenten (zelfde patroon als de `descriptions_blog`-fragmenten bij
// de blogimport, maar dan voor plaatsen: bv. `descriptions_places/pijnven.php`).
// Geef `--descriptions-path <map>` mee met een map vol van die .php-bestanden
// (bestandsnaam = slug zonder koppeltekens, bv. `hoksentmolhem.php` voor
// slug `hoksent-molhem`) om die rijkere content te gebruiken in plaats van de
// dunne DB-tekst. Zonder deze vlag gebruikt het script gewoon `Description`.
//
// Vereist het `cheerio` package (voor het robuust parsen van deze niet-
// helemaal-geldige HTML-fragmenten): `npm install cheerio --save-dev`.
//
// Gebruik:
//   node scripts/import-legacy-plaatsen-as-blog.js \
//     --sql-dump ~/Downloads/Plaatsen.sql \
//     --descriptions-path ~/Downloads/descriptions_places \
//     --token <strapi-full-access-api-token> \
//     --dry-run
//
// Token: Strapi admin > Settings > API Tokens > Create new API Token >
// Token type: Full access. Zonder --dry-run is schrijftoegang nodig.
//
// --universe <naam>       : welke Universe-waarde te importeren (default: Ontdek)
// --category-slug <slug>  : blog-category slug om aan te koppelen (default: ontdek)
// --category-title <naam> : titel voor de blog-category als die nog niet bestaat (default: Ontdek)
// --legacy-base-url <url> : basis-URL om Image_top van te downloaden (default: https://www.routezoeker.com)
// --descriptions-path <map>: map met per-plaats PHP-paginafragmenten (optioneel)
// --skip-faq               : laat de "Veelgestelde vragen" van een PHP-fragment weg
// --skip-route-links       : laat de routekaartjes-lijst van een PHP-fragment weg
// --author-id <documentId>: optioneel, koppelt een bestaande Strapi author
// --limit <n>              : beperk het aantal te verwerken rijen (handig om te testen)

const fs = require('node:fs/promises');
const path = require('node:path');
const mime = require('mime-types');
const cheerio = require('cheerio');

const DEFAULT_BASE_URL = 'https://api.routezoeker.com';
const DEFAULT_LEGACY_BASE_URL = 'https://www.routezoeker.com';
const DEFAULT_UNIVERSE = 'Ontdek';
const DEFAULT_CATEGORY_SLUG = 'ontdek';
const DEFAULT_CATEGORY_TITLE = 'Ontdek';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const parseArgs = () => {
  const rawArgs = process.argv.slice(2);
  const options = {
    sqlDumpPath: undefined,
    baseUrl: process.env.STRAPI_BASE_URL || DEFAULT_BASE_URL,
    token: process.env.STRAPI_ADMIN_API_TOKEN,
    universe: DEFAULT_UNIVERSE,
    categorySlug: DEFAULT_CATEGORY_SLUG,
    categoryTitle: DEFAULT_CATEGORY_TITLE,
    legacyBaseUrl: DEFAULT_LEGACY_BASE_URL,
    descriptionsPath: undefined,
    skipFaq: false,
    skipRouteLinks: false,
    authorId: undefined,
    limit: undefined,
    dryRun: false,
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];

    if (arg === '--dry-run') {
      options.dryRun = true;
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

    if (arg === '--universe') {
      options.universe = rawArgs[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--category-slug') {
      options.categorySlug = rawArgs[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--category-title') {
      options.categoryTitle = rawArgs[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--legacy-base-url') {
      options.legacyBaseUrl = rawArgs[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--descriptions-path') {
      options.descriptionsPath = rawArgs[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--skip-faq') {
      options.skipFaq = true;
      continue;
    }

    if (arg === '--skip-route-links') {
      options.skipRouteLinks = true;
      continue;
    }

    if (arg === '--author-id') {
      options.authorId = rawArgs[index + 1];
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

  if (!options.sqlDumpPath) {
    throw new Error('--sql-dump /pad/naar/Plaatsen.sql is verplicht.');
  }

  if (!options.token) {
    throw new Error(
      '--token <strapi-api-token> is verplicht (of zet STRAPI_ADMIN_API_TOKEN). Maak een "Full access" token aan via Strapi admin > Settings > API Tokens.'
    );
  }

  options.baseUrl = options.baseUrl.replace(/\/+$/, '');
  options.legacyBaseUrl = options.legacyBaseUrl.replace(/\/+$/, '');

  return options;
};

// ---------------------------------------------------------------------------
// Small helpers (zelfde gedrag als scripts/import-legacy-pois.js)
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

// ---------------------------------------------------------------------------
// Legacy PHP-paginafragmenten (descriptions_places/<slug>.php)
// ---------------------------------------------------------------------------
// Deze bestanden zijn geen nette, geldige HTML (bootstrap-grids, schema.org
// FAQ-markup, af en toe een niet-gesloten of verkeerd gesloten tag, losse
// <?php ?>-snippets) — cheerio (in plaats van onze eigen regex-parser) leest
// dit betrouwbaar in ondanks die onvolkomenheden.

let descriptionsPathReadFailureWarned = false;

const findDescriptionFile = async (descriptionsPath, slug) => {
  if (!descriptionsPath) return null;

  let entries;
  try {
    entries = await fs.readdir(descriptionsPath);
  } catch (error) {
    if (!descriptionsPathReadFailureWarned) {
      descriptionsPathReadFailureWarned = true;
      console.error(
        `Waarschuwing: kan --descriptions-path map niet lezen ("${descriptionsPath}"): ${error.message}. ` +
          'Alle rijen vallen terug op de korte DB-tekst (usedThinDescription).'
      );
    }
    return null;
  }

  const byLowerName = new Map(entries.map((entry) => [entry.toLowerCase(), entry]));
  const candidates = Array.from(new Set([slug, slug.replace(/-/g, '')]));

  for (const candidate of candidates) {
    const match = byLowerName.get(`${candidate.toLowerCase()}.php`);
    if (match) return path.join(descriptionsPath, match);
  }

  return null;
};

// Parseert één PHP-paginafragment naar: doorlopende tekst (opgedeeld per
// tussenkop), FAQ vraag/antwoord-paren, en de routekaartjes-links.
const parsePlaceFragment = (rawHtml) => {
  const withoutPhpTags = rawHtml.replace(/<\?php[\s\S]*?\?>/gi, '');
  const $ = cheerio.load(withoutPhpTags);

  // 1) FAQ vraag/antwoord-paren (schema.org Question/Answer markup).
  const faqs = [];
  $('[itemtype="https://schema.org/Question"]').each((_, el) => {
    const $question = $(el);
    const question = normalizeWhitespace($question.find('[itemprop="name"]').first().text() || '');
    const $answer = $question.find('[itemprop="text"]').first();
    const answerHtml = $answer.length > 0 ? $.html($answer) : '';

    if (question && answerHtml.trim()) {
      faqs.push({ question, answerHtml });
    }
  });

  // 2) Routekaartjes: alleen anchors binnen een `.card`, niet losse inline
  // links in de lopende tekst (die verwijzen soms naar een regio-/
  // themapagina i.p.v. een specifieke route, bv. "/wandelroutes/vlaanderen/...").
  const routeLinks = [];
  const seenUrls = new Set();
  $('.card').each((_, cardEl) => {
    const $card = $(cardEl);
    const $anchor = $card
      .find('a[href^="/wandelroutes/"], a[href^="/fietsroutes/"], a[href^="/wandelnetwerken/"]')
      .first();
    const href = $anchor.attr('href');
    if (!href || seenUrls.has(href)) return;

    const label = normalizeWhitespace($card.find('h2, h3, h5').first().text() || $anchor.text() || '');
    if (!label) return;

    seenUrls.add(href);
    routeLinks.push({ label, url: href });
  });

  // 3) Doorlopende tekst: verwijder eerst alles wat geen lopende prose is
  // (kaartjes, FAQ-blokken, video's, de kaart-placeholder), zodat de
  // resterende h2/h3/p/ul/ol-elementen in documentvolgorde de echte
  // artikeltekst vormen, per tussenkop gegroepeerd.
  $('iframe, script, style, .card, [itemtype="https://schema.org/Question"], [itemtype="https://schema.org/FAQPage"], #map, [id="map"]').remove();

  const sections = [];
  let current = { title: undefined, html: '' };

  const flushSection = () => {
    if (current.title || current.html.trim()) sections.push(current);
  };

  $('h2, h3, p, ul, ol').each((_, el) => {
    const tagName = el.tagName ? el.tagName.toLowerCase() : '';

    if (tagName === 'h2' || tagName === 'h3') {
      flushSection();
      current = { title: normalizeWhitespace($(el).text()), html: '' };
      return;
    }

    // Voorkom dubbeltellen van <p>/<ul> die binnen een <li> zouden zitten.
    if ($(el).parents('li').length > 0) return;

    current.html += $.html(el);
  });
  flushSection();

  return { sections, faqs, routeLinks };
};

// Zet de FAQ-paren om naar HTML die door htmlToBlocks verwerkt kan worden
// (elke vraag als eigen paragraaf, gevolgd door het antwoord — dat laatste
// behoudt eventuele geneste lijsten uit het antwoord).
const faqsToHtml = (faqs) => faqs.map((faq) => `<p>${faq.question}</p>${faq.answerHtml}`).join('');

// Zet de routekaartjes om naar een simpele linklijst.
const routeLinksToHtml = (routeLinks) =>
  `<ul>${routeLinks.map((link) => `<li><a href="${link.url}">${link.label}</a></li>`).join('')}</ul>`;

// ---------------------------------------------------------------------------
// mysqldump `.sql` parsing (geen DB-connectie nodig)
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

const findBlogCategoryBySlug = async (options, slug) => {
  const query = new URLSearchParams({
    'filters[slug][$eq]': slug,
    'pagination[pageSize]': '1',
    status: 'draft',
  });
  const body = await strapiRequest(options, `/api/blog-categories?${query.toString()}`);
  return body?.data?.[0] ?? null;
};

const ensureBlogCategory = async (options, slug, title) => {
  const existing = await findBlogCategoryBySlug(options, slug);
  if (existing) return existing;

  if (options.dryRun) {
    return { id: -1, documentId: null, slug, title };
  }

  const created = await strapiRequest(options, '/api/blog-categories', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { title, slug } }),
  });

  return created?.data;
};

const findBlogPostBySlug = async (options, slug) => {
  const query = new URLSearchParams({
    'filters[slug][$eq]': slug,
    'pagination[pageSize]': '1',
    status: 'draft',
  });
  const body = await strapiRequest(options, `/api/blog-posts?${query.toString()}`);
  return body?.data?.[0] ?? null;
};

const downloadRemoteFile = async (url) => {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const arrayBuffer = await response.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      contentType: response.headers.get('content-type') || undefined,
    };
  } catch {
    return null;
  }
};

const uploadImageBuffer = async (options, buffer, fileName, contentType, alternativeText) => {
  const blob = new Blob([buffer], { type: contentType || mime.lookup(fileName) || 'application/octet-stream' });
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

// ---------------------------------------------------------------------------
// Main import
// ---------------------------------------------------------------------------

const run = async () => {
  const options = parseArgs();

  const sqlText = await fs.readFile(options.sqlDumpPath, 'utf8');
  const plaatsen = parseSqlDumpTable(sqlText, 'Plaatsen');

  const matchingRows = plaatsen.filter(
    (row) => toStringValue(row.Universe)?.toLowerCase() === options.universe.toLowerCase()
  );
  const rowsToImport = typeof options.limit === 'number' ? matchingRows.slice(0, options.limit) : matchingRows;

  let descriptionsPathPhpFileCount;
  if (options.descriptionsPath) {
    try {
      const entries = await fs.readdir(options.descriptionsPath);
      descriptionsPathPhpFileCount = entries.filter((entry) => entry.toLowerCase().endsWith('.php')).length;
      console.error(
        `--descriptions-path: ${descriptionsPathPhpFileCount} .php-bestand(en) gevonden in "${options.descriptionsPath}".`
      );
    } catch (error) {
      descriptionsPathPhpFileCount = null;
      console.error(
        `Waarschuwing: --descriptions-path map niet gevonden of niet leesbaar ("${options.descriptionsPath}"): ${error.message}`
      );
    }
  }

  const category = await ensureBlogCategory(options, options.categorySlug, options.categoryTitle);

  let created = 0;
  let updated = 0;
  let skippedNoTitle = 0;
  let usedDescriptionFile = 0;
  let usedThinDescription = 0;
  const imagesDownloaded = [];
  const imagesFailed = [];

  for (const row of rowsToImport) {
    const title = toStringValue(row.Titel);

    if (!title) {
      skippedNoTitle += 1;
      continue;
    }

    const legacyUrl = toStringValue(row.URL);
    const slug = slugify((legacyUrl || title).replace(/\//g, '-'));
    const excerpt = toStringValue(row.Titel2) || undefined;
    const region = toStringValue(row.Provincie) || undefined;

    const descriptionFile = await findDescriptionFile(options.descriptionsPath, slug);
    const content = [];

    if (descriptionFile) {
      usedDescriptionFile += 1;
      const fragmentHtml = await fs.readFile(descriptionFile, 'utf8');
      const { sections, faqs, routeLinks } = parsePlaceFragment(fragmentHtml);

      for (const section of sections) {
        const blocks = htmlToBlocks(section.html);
        if (blocks.length === 0 && !section.title) continue;
        content.push({
          __component: 'page-blocks.text-section',
          ...(section.title ? { title: section.title } : {}),
          content: blocks,
        });
      }

      if (!options.skipFaq && faqs.length > 0) {
        content.push({
          __component: 'page-blocks.text-section',
          title: 'Veelgestelde vragen',
          content: htmlToBlocks(faqsToHtml(faqs)),
        });
      }

      if (!options.skipRouteLinks && routeLinks.length > 0) {
        content.push({
          __component: 'page-blocks.text-section',
          title: 'Ontdek deze routes',
          content: htmlToBlocks(routeLinksToHtml(routeLinks)),
        });
      }
    } else {
      const descriptionHtml = toStringValue(row.Description);
      if (descriptionHtml) {
        usedThinDescription += 1;
        content.push({ __component: 'page-blocks.text-section', content: htmlToBlocks(descriptionHtml) });
      }
    }

    const metaTitle = toStringValue(row.Meta_title);
    const metaDescription = toStringValue(row.Meta_description);
    const seo =
      metaTitle || metaDescription
        ? {
            ...(metaTitle ? { meta_title: metaTitle } : {}),
            ...(metaDescription ? { meta_description: metaDescription } : {}),
          }
        : undefined;

    let coverImageId;
    const legacyImagePath = toStringValue(row.Image_top);

    if (legacyImagePath && !options.dryRun) {
      const imageUrl = /^https?:\/\//i.test(legacyImagePath)
        ? legacyImagePath
        : `${options.legacyBaseUrl}${legacyImagePath.startsWith('/') ? '' : '/'}${legacyImagePath}`;
      const downloaded = await downloadRemoteFile(imageUrl);

      if (downloaded) {
        const fileName = legacyImagePath.split('/').pop() || `${slug}.jpg`;
        const alternativeText = toStringValue(row.Copy_top) || title;
        const uploaded = await uploadImageBuffer(options, downloaded.buffer, fileName, downloaded.contentType, alternativeText);
        coverImageId = uploaded?.id;
        imagesDownloaded.push(imageUrl);
      } else {
        imagesFailed.push(imageUrl);
      }
    }

    const data = {
      title,
      slug,
      ...(excerpt ? { excerpt } : {}),
      ...(region ? { region } : {}),
      content,
      ...(coverImageId ? { coverImage: coverImageId } : {}),
      ...(seo ? { seo } : {}),
      ...(options.authorId ? { author: options.authorId } : {}),
      categories: { connect: [category.id] },
    };

    if (options.dryRun) {
      const existing = await findBlogPostBySlug(options, slug);
      existing ? (updated += 1) : (created += 1);
      continue;
    }

    const existing = await findBlogPostBySlug(options, slug);

    if (existing) {
      // PUT publiceert de update meteen (Strapi 5 REST-standaardgedrag).
      await strapiRequest(options, `/api/blog-posts/${existing.documentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data }),
      });
      updated += 1;
      continue;
    }

    await strapiRequest(options, '/api/blog-posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data }),
    });
    created += 1;
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRun: options.dryRun,
        universe: options.universe,
        categorySlug: options.categorySlug,
        plaatsenParsed: plaatsen.length,
        matchingRows: matchingRows.length,
        rowsProcessed: rowsToImport.length,
        created,
        updated,
        skippedNoTitle,
        descriptionsPath: options.descriptionsPath || null,
        descriptionsPathPhpFileCount: descriptionsPathPhpFileCount ?? null,
        usedDescriptionFile,
        usedThinDescription,
        imagesDownloaded: imagesDownloaded.length,
        imagesFailed,
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

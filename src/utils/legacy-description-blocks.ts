import fs from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Gedeelde parser: legacy HTML (uit een DB-veld of een descriptions_*/*.php
// paginafragment) -> Strapi "blocks" content.
//
// Gebruikt door legacy-blog-import.ts (blog-post.content), en
// legacy-walk-import.ts / legacy-bike-import.ts (route.long_description).
// Bevat GEEN Strapi/upload-afhankelijkheden — image-blocks komen er als
// "pending" node uit (__legacySrc/__legacyAlt) en moeten via
// resolvePendingImageBlocks() omgezet worden naar een echt Strapi
// blocks image-node, met een door de aanroeper geleverde upload-functie
// (HTTP-fetch voor blog, lokaal bestand voor walk/bike).
// ---------------------------------------------------------------------------

export type InlineNode = Record<string, unknown>;
export type BlockNode = Record<string, unknown>;
export type DescriptionZone = { __component: string; title?: string; content: BlockNode[]; max_width: string };

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
    .replace(/&copy;/gi, '©')
    .replace(/&reg;/gi, '®')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&hellip;/gi, '…')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');

export const stripHtmlTags = (value: string) => normalizeWhitespace(decodeHtmlEntities(value.replace(/<[^>]+>/g, ' ')));
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

// Legacy pagina's die (nog) niet op de nieuwe site bestaan (interne links
// zoals "/wandelroutes/..." uit descriptions_*-bestanden) verwijzen we door
// naar de oude site i.p.v. ze te laten 404'en. legacyBaseUrl is enkel gezet
// wanneer we HTML uit een descriptions_*/*.php bestand parsen (zie
// legacyDescriptionHtmlToBlocks); voor DB-velden blijft dit ongemoeid.
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
// ("/pad") urls. Legacy in-paginaverwijzingen zoals "#route1" (ankers naar een
// sectie die in de nieuwe opbouw toch niet bestaat) vallen hierbuiten — die
// zetten we om naar gewone tekst i.p.v. een link, anders weigert Strapi het
// hele item.
const isValidBlocksLinkUrl = (href: string) => /^https?:\/\//i.test(href) || href.startsWith('/');

// Eén-staps inline tokenizer: link / bold / italic op het hoogste niveau.
// Geneste opmaak binnenin (bv. <strong> in een <a>) wordt platgeslagen naar
// tekst — voor deze content (grotendeels vlakke HTML) is dat voldoende.
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
// paragrafen. <img> levert een "pending" image-block op (__legacySrc) — die
// wordt pas na upload (async) omgezet naar een echt Strapi image-block, zie
// resolvePendingImageBlocks.
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
// hierboven) — gebruikt wanneer html afkomstig is uit een descriptions_*
// PHP-bestand. Voor DB-velden laten we dit weg.
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
// descriptions_blog / descriptions_walk / descriptions_bike PHP-fragmenten
// -> bruikbare HTML
// ---------------------------------------------------------------------------

// Deze bestanden zijn geen losse pagina's, maar Bootstrap-opgemaakte
// content-fragmenten (section/container/row/col) die ergens in een legacy
// pagina-template werden ge-include't. Deze functie filtert de
// layout-wrapper en decoratieve elementen weg zodat enkel
// headings/paragrafen/lijsten/afbeeldingen overblijven — precies wat
// htmlToBlocks verwacht.
const stripPhpPageChrome = (raw: string): string =>
  raw
    // php-tags (voor de zekerheid)
    .replace(/<\?php[\s\S]*?\?>/gi, '')
    // scripts/styles/comments
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    // decoratieve icoontjes, bv. <i class="icn-flower ..."></i>
    .replace(/<i\b[^>]*class="[^"]*\bicn-[^"]*"[^>]*>[\s\S]*?<\/i>/gi, '')
    // CTA-knoppen zijn geen artikelinhoud
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
// descriptions_*: matchend PHP-bestand opzoeken op schijf (VPS of anders)
// ---------------------------------------------------------------------------

// Zoekt <descriptionsPath>/<slug>.php (root) of
// <descriptionsPath>/<elke-submap>/<slug>.php (bv. blog's wandeltips/,
// fietstips/, logietips/ submappen — walk/bike hebben geen submappen, enkel
// bestanden in de root, wat hier ook gewoon werkt). We matchen puur op
// bestandsnaam, niet op categorie-submap.
export const findDescriptionFile = async (descriptionsPath: string, slug: string): Promise<string | null> => {
  const target = `${slug}.php`;

  try {
    const rootEntries = await fs.readdir(descriptionsPath, { withFileTypes: true });

    const rootMatch = rootEntries.find((entry) => entry.isFile() && entry.name === target);
    if (rootMatch) {
      return `${descriptionsPath}/${rootMatch.name}`;
    }

    const subdirs = rootEntries.filter((entry) => entry.isDirectory());
    for (const dir of subdirs) {
      const dirPath = `${descriptionsPath}/${dir.name}`;
      try {
        const dirEntries = await fs.readdir(dirPath, { withFileTypes: true });
        const match = dirEntries.find((entry) => entry.isFile() && entry.name === target);
        if (match) {
          return `${dirPath}/${match.name}`;
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
// "Pending" image-blocks (uit htmlToBlocks) omzetten naar echte Strapi
// blocks image-nodes. Blocks-velden bevatten geen live media-relatie: de
// volledige media-attributen moeten inline in de JSON staan. Deze functie
// is bewust ontkoppeld van Strapi/upload-specifics — de aanroeper levert
// een resolveImage-functie die de upload doet (HTTP-fetch voor blog, lokaal
// bestand voor walk/bike) en ofwel een kant-en-klaar image-block teruggeeft,
// ofwel null (block wordt dan gewoon weggelaten, bv. bij een mislukte
// upload of --skip-images).
export const resolvePendingImageBlocks = async (
  zones: DescriptionZone[],
  resolveImage: (legacySrc: string, legacyAlt: string | null) => Promise<BlockNode | null>
): Promise<void> => {
  for (const zone of zones) {
    const resolved: BlockNode[] = [];

    for (const block of zone.content) {
      const legacySrc = (block as { __legacySrc?: string }).__legacySrc;
      if (legacySrc === undefined) {
        resolved.push(block);
        continue;
      }

      const legacyAlt = (block as { __legacyAlt?: string | null }).__legacyAlt ?? null;
      const imageBlock = await resolveImage(legacySrc, legacyAlt);
      if (imageBlock) {
        resolved.push(imageBlock);
      }
    }

    zone.content = resolved;
  }
};

// Bouwt een volwaardig Strapi blocks image-node uit een reeds geüploade
// media-entity (het object dat strapi's upload-service teruggeeft). Zowel
// blog (HTTP-upload) als walk/bike (lokale upload) roepen dit aan nadat ze
// zelf de upload hebben gedaan.
export const buildImageBlockFromUploadedMedia = (
  uploaded: {
    name: string;
    url: string;
    alternativeText?: string | null;
    caption?: string | null;
    width?: number | null;
    height?: number | null;
    formats?: Record<string, unknown> | null;
    hash?: string | null;
    ext?: string | null;
    mime?: string | null;
    size?: number | string | null;
    previewUrl?: string | null;
    provider?: string | null;
    provider_metadata?: Record<string, unknown> | null;
    createdAt?: string | null;
    updatedAt?: string | null;
  },
  legacyAlt: string | null
): BlockNode => ({
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
    ext: uploaded.ext || '',
    mime: uploaded.mime || 'image/jpeg',
    size: Number(uploaded.size ?? 0),
    previewUrl: uploaded.previewUrl || null,
    provider: uploaded.provider || 'local',
    provider_metadata: uploaded.provider_metadata || null,
    createdAt: uploaded.createdAt || new Date().toISOString(),
    updatedAt: uploaded.updatedAt || new Date().toISOString(),
  },
  children: [{ type: 'text', text: '' }],
});

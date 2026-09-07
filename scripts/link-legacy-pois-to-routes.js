#!/usr/bin/env node

'use strict';

// Koppelt bestaande POI's (Gebouwen/Locaties/Wandelnetwerken) aan bestaande
// routes, via de Strapi REST API.
//
// De brontabel is `Points_route`: elke rij koppelt een Point (Pid) aan ofwel
// een wandeling (Wid), een fietsroute (Fid), of een logie (Lid) -- telkens
// is maar een van de drie kolommen != 0. De Lid-links (logies/partners)
// worden al afgehandeld door scripts/import-legacy-pois.js en hier bewust
// genegeerd; dit script behandelt enkel de Wid/Fid-links (routes).
//
// Dit script maakt GEEN nieuwe POI's aan: het verwacht dat de POI's al
// bestaan in Strapi (aangemaakt via import-legacy-pois.js) en zoekt ze op
// via title+type, net als dat script doet. Routes worden opgezocht via hun
// slug, afgeleid uit Wandelingen.URL / Fietsen.URL (dezelfde bron als
// import-legacy-walks/import-legacy-bikes gebruiken om de slug te zetten).
//
// Geen DB-connectie nodig (lokaal of op de VPS): de bron is een of meerdere
// mysqldump `.sql` exports (Points, Points_route, Wandelingen, Fietsen --
// los of gecombineerd aan te leveren via --sql-dump, meerdere keren op te
// geven), en het doelwit is Strapi's REST API over HTTPS met een API token.
//
// Gebruik:
//   node scripts/link-legacy-pois-to-routes.js \
//     --sql-dump ~/Downloads/Points.sql \
//     --sql-dump ~/Downloads/Points_route.sql \
//     --sql-dump ~/Downloads/Wandelingen.sql \
//     --sql-dump ~/Downloads/Fietsen.sql \
//     --token <strapi-full-access-api-token> \
//     --dry-run
//
// Maak het token aan via Strapi admin > Settings > API Tokens > Create new
// API Token > Token type: Full access. Zonder --dry-run is schrijftoegang
// nodig; --dry-run heeft enkel leestoegang nodig (het zoekt POI's en routes
// nog altijd echt op, enkel de uiteindelijke koppeling wordt niet weggeschreven).
//
// --limit <n> beperkt het aantal routes dat verwerkt wordt (handig om eerst
// een paar te testen voor je de volledige set draait).

const fs = require('node:fs/promises');

const DEFAULT_BASE_URL = 'https://api.routezoeker.com';
const POI_TYPES = ['Gebouwen', 'Locaties', 'Wandelnetwerken'];

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const parseArgs = () => {
  const rawArgs = process.argv.slice(2);
  const options = {
    sqlDumpPaths: [],
    baseUrl: process.env.STRAPI_BASE_URL || DEFAULT_BASE_URL,
    token: process.env.STRAPI_ADMIN_API_TOKEN,
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
      options.sqlDumpPaths.push(rawArgs[index + 1]);
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

    if (arg === '--limit') {
      options.limit = Number(rawArgs[index + 1]);
      index += 1;
      continue;
    }

    throw new Error(`Unexpected argument: ${arg}`);
  }

  if (options.sqlDumpPaths.length === 0) {
    throw new Error(
      'Minstens één --sql-dump /pad/naar/bestand.sql is verplicht (Points, Points_route, Wandelingen en/of Fietsen -- los of gecombineerd).'
    );
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
// Small helpers (identiek aan scripts/import-legacy-pois.js)
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

// ---------------------------------------------------------------------------
// mysqldump `.sql` parsing (geen DB-connectie nodig) -- identiek aan
// scripts/import-legacy-pois.js
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

  return { columns, rows };
};

const requireSqlDumpTable = (sqlText, table) => {
  const { columns, rows } = parseSqlDumpTable(sqlText, table);
  if (!columns) {
    throw new Error(`Geen "INSERT INTO \`${table}\`" statements gevonden in de opgegeven .sql-bestanden.`);
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

const findRouteBySlug = async (options, slug) => {
  const query = new URLSearchParams({
    'filters[slug][$eq]': slug,
    'pagination[pageSize]': '1',
    status: 'draft',
  });
  const body = await strapiRequest(options, `/api/routes?${query.toString()}`);
  return body?.data?.[0] ?? null;
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const run = async () => {
  const options = parseArgs();

  const sqlText = (
    await Promise.all(options.sqlDumpPaths.map((filePath) => fs.readFile(filePath, 'utf8')))
  ).join('\n');

  const points = requireSqlDumpTable(sqlText, 'Points');
  const pointsRoute = requireSqlDumpTable(sqlText, 'Points_route');
  const walks = parseSqlDumpTable(sqlText, 'Wandelingen').rows;
  const bikes = parseSqlDumpTable(sqlText, 'Fietsen').rows;

  if (walks.length === 0 && bikes.length === 0) {
    throw new Error(
      'Geen "Wandelingen" en geen "Fietsen" tabel gevonden -- geef minstens een van beide mee via --sql-dump, anders kunnen Wid/Fid niet naar een route-slug herleid worden.'
    );
  }

  const pointsById = new Map(points.map((row) => [Number(row.ID), row]));
  const walkSlugById = new Map(
    walks.map((row) => [Number(row.ID), toStringValue(row.URL)]).filter(([, slug]) => slug)
  );
  const bikeSlugById = new Map(
    bikes.map((row) => [Number(row.ID), toStringValue(row.URL)]).filter(([, slug]) => slug)
  );

  // Enkel Wid/Fid-links (routes). Lid-links (logies/partners) horen bij
  // scripts/import-legacy-pois.js en worden hier genegeerd.
  const routeLinks = pointsRoute.filter((row) => Number(row.Wid) !== 0 || Number(row.Fid) !== 0);

  const pidsByRouteSlug = new Map(); // slug -> Set<pid>
  let skippedUnknownRoute = 0;

  for (const link of routeLinks) {
    const wid = Number(link.Wid);
    const fid = Number(link.Fid);
    const pid = Number(link.Pid);

    const rawSlug = wid !== 0 ? walkSlugById.get(wid) : bikeSlugById.get(fid);
    const slug = rawSlug ? slugify(rawSlug) : null;

    if (!slug) {
      skippedUnknownRoute += 1;
      continue;
    }

    if (!pidsByRouteSlug.has(slug)) pidsByRouteSlug.set(slug, new Set());
    pidsByRouteSlug.get(slug).add(pid);
  }

  const routeSlugs =
    typeof options.limit === 'number'
      ? Array.from(pidsByRouteSlug.keys()).slice(0, options.limit)
      : Array.from(pidsByRouteSlug.keys());

  const pidToStrapiId = new Map(); // pid -> id (number) | null (niet gevonden/onbekend type)

  const resolvePoiId = async (pid) => {
    if (pidToStrapiId.has(pid)) return pidToStrapiId.get(pid);

    const point = pointsById.get(pid);
    const type = toStringValue(point?.Type);
    const title = toStringValue(point?.Title);

    if (!point || !POI_TYPES.includes(type) || !title) {
      pidToStrapiId.set(pid, null);
      return null;
    }

    const existing = await findPoiByTitleAndType(options, title, type);
    const id = existing ? existing.id : null;
    pidToStrapiId.set(pid, id);
    return id;
  };

  let routesLinked = 0;
  let poisConnected = 0;
  const routesNotFound = [];
  const poisNotFound = [];

  for (const slug of routeSlugs) {
    const pidSet = pidsByRouteSlug.get(slug);
    const poiIds = [];

    for (const pid of pidSet) {
      const id = await resolvePoiId(pid);
      if (typeof id === 'number') {
        poiIds.push(id);
      } else {
        poisNotFound.push({ pid, title: toStringValue(pointsById.get(pid)?.Title) ?? null });
      }
    }

    if (poiIds.length === 0) continue;

    const route = await findRouteBySlug(options, slug);
    if (!route) {
      routesNotFound.push(slug);
      continue;
    }

    if (options.dryRun) {
      routesLinked += 1;
      poisConnected += poiIds.length;
      continue;
    }

    // PUT met "connect" voegt toe aan de bestaande relatie i.p.v. te
    // overschrijven -- eerder handmatig gekoppelde POI's blijven dus staan,
    // en het script is veilig om meerdere keren te draaien.
    await strapiRequest(options, `/api/routes/${route.documentId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { pois: { connect: poiIds } } }),
    });

    routesLinked += 1;
    poisConnected += poiIds.length;
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        pointsParsed: points.length,
        walksParsed: walks.length,
        bikesParsed: bikes.length,
        linkRowsTotal: pointsRoute.length,
        routeLinkRows: routeLinks.length,
        skippedUnknownRoute,
        distinctRoutesWithLinks: pidsByRouteSlug.size,
        routesProcessed: routeSlugs.length,
        routesLinked,
        poisConnected,
        routesNotFoundCount: routesNotFound.length,
        routesNotFoundSample: routesNotFound.slice(0, 20),
        poisNotFoundCount: poisNotFound.length,
        poisNotFoundSample: poisNotFound.slice(0, 20),
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

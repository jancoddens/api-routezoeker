#!/usr/bin/env node

'use strict';

// Zet de oude logie-statistieken (tabel `Stat_logies` van de PHP-site) over
// naar de nieuwe site, zodat uitbaters op hun dashboard (/mijn-logies) ook de
// maanden van vóór de nieuwe website zien.
//
// - Leest `Logies` en `Stat_logies` uit de legacy MySQL-database (credentials
//   via config.php, zelfde manier als de andere import-scripts).
// - Koppelt elke oude logie aan een nieuwe Strapi-partner op slug
//   (Logies.URL = partner.slug), met fallbacks op titel.
// - Schrijft per logie per maand één rij in `partner_legacy_monthly_statistics`
//   (in dezelfde databank als partner_daily_statistics van de front-end).
//   REPLACE INTO: veilig om opnieuw te draaien, er wordt niets dubbel geteld.
//   Draai het dus nog eens op de dag van de domeinwissel.
//
// Gebruik:
//   node scripts/import-legacy-partner-stats.js --dry-run
//   node scripts/import-legacy-partner-stats.js
//   node scripts/import-legacy-partner-stats.js --map 12=nieuwe-slug,40=andere-slug
//   node scripts/import-legacy-partner-stats.js --config /pad/naar/config.php [--host --port --user --password --database]
//
// Kolommen in Stat_logies: Logie_views = vertoningen (lijsten/kaart/carrousel),
// Page_views = bezoeken aan de logiepagina, Logie_website = kliks naar website.

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { compileStrapi, createStrapi } = require('@strapi/strapi');

const execFileAsync = promisify(execFile);
const DEFAULT_CONFIG = '/var/www/vhosts/routezoeker.com/api.routezoeker.com/legacy-import/config.php';
const TARGET_TABLE = 'partner_legacy_monthly_statistics';

const parseArgs = () => {
  const args = process.argv.slice(2);
  const options = { configPath: DEFAULT_CONFIG, dryRun: false, manualMap: new Map(), overrides: {} };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = () => {
      i += 1;
      if (args[i] === undefined) throw new Error(`Waarde ontbreekt voor ${arg}`);
      return args[i];
    };

    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--config') options.configPath = next();
    else if (arg === '--host') options.overrides.host = next();
    else if (arg === '--port') options.overrides.port = next();
    else if (arg === '--user') options.overrides.user = next();
    else if (arg === '--password') options.overrides.password = next();
    else if (arg === '--database') options.overrides.database = next();
    else if (arg === '--map') {
      next()
        .split(',')
        .filter(Boolean)
        .forEach((pair) => {
          const [id, slug] = pair.split('=');
          if (!Number(id) || !slug) throw new Error(`Ongeldige --map waarde: ${pair}`);
          options.manualMap.set(Number(id), slug.trim());
        });
    } else throw new Error(`Onbekend argument: ${arg}`);
  }

  return options;
};

const parsePhpConfig = async (configPath) => {
  const raw = await fs.readFile(configPath, 'utf8');
  const extract = (name) => raw.match(new RegExp(`\\$${name}\\s*=\\s*'([^']*)'`, 'i'))?.[1] ?? null;
  return { host: extract('dbhost'), user: extract('dbuser'), password: extract('dbpass'), database: extract('dbname') };
};

const mysqlArgs = (config, extra) => {
  const args = ['--batch', '--raw', '--skip-column-names', '-h', config.host, '-u', config.user, '-D', config.database];
  if (config.port) args.push('-P', String(config.port));
  return [...args, ...extra];
};

const mysqlEnv = (config) => ({ ...process.env, MYSQL_PWD: config.password });

const queryJson = async (config, sql) => {
  const { stdout } = await execFileAsync('mysql', mysqlArgs(config, ['-e', sql]), {
    env: mysqlEnv(config),
    maxBuffer: 1024 * 1024 * 100,
  });
  return stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
};

const execSql = (config, sql) =>
  new Promise((resolve, reject) => {
    const child = execFile('mysql', mysqlArgs(config, []), { env: mysqlEnv(config), maxBuffer: 1024 * 1024 * 10 }, (error) =>
      error ? reject(error) : resolve(),
    );
    child.stdin.end(sql);
  });

const slugify = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' en ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const run = async () => {
  const options = parseArgs();
  const parsed = await parsePhpConfig(options.configPath);
  const db = { ...parsed, ...Object.fromEntries(Object.entries(options.overrides).filter(([, v]) => v)) };
  if (!db.host || !db.user || db.password == null || !db.database) {
    throw new Error(`Kon de databankgegevens niet lezen uit ${options.configPath}`);
  }

  const logies = await queryJson(
    db,
    "SELECT JSON_OBJECT('id', `ID`, 'title', `Titel`, 'url', `URL`, 'active', `Active`) FROM `Logies`",
  );
  const stats = await queryJson(
    db,
    "SELECT JSON_OBJECT('lid', `Lid`, 'month', `Month`, 'year', `Year`, 'logieViews', `Logie_views`, 'pageViews', `Page_views`, 'website', `Logie_website`) FROM `Stat_logies`",
  );

  const appContext = await compileStrapi();
  const strapi = createStrapi(appContext);
  let partners;
  try {
    await strapi.load();
    partners = await strapi.db.query('api::partner.partner').findMany({ select: ['documentId', 'slug', 'name'] });
  } finally {
    await strapi.destroy().catch(() => {});
  }

  const bySlug = new Map();
  const byName = new Map();
  partners.forEach((p) => {
    if (p.slug) bySlug.set(p.slug, p);
    if (p.name) byName.set(slugify(p.name), p);
  });

  const totals = new Map();
  stats.forEach((row) => {
    const t = totals.get(row.lid) ?? { months: 0, views: 0 };
    t.months += 1;
    t.views += Number(row.logieViews) || 0;
    totals.set(row.lid, t);
  });

  const mapping = new Map();
  const unmatched = [];
  const matchedBy = { manual: 0, slug: 0, slugZonderRoutes: 0, titel: 0 };

  logies.forEach((logie) => {
    const url = String(logie.url || '').trim();
    const candidates = [
      ['manual', options.manualMap.get(Number(logie.id))],
      ['slug', url],
      ['slugZonderRoutes', url.replace(/-routes$/, '')],
      ['titel', slugify(logie.title)],
    ];
    for (const [how, slug] of candidates) {
      const partner = slug && (bySlug.get(slug) || (how === 'titel' ? byName.get(slug) : undefined));
      if (partner) {
        mapping.set(Number(logie.id), { partner, how });
        matchedBy[how] += 1;
        return;
      }
    }
    if (totals.has(Number(logie.id))) {
      unmatched.push({ id: logie.id, titel: String(logie.title).trim(), url, actief: logie.active, ...totals.get(Number(logie.id)) });
    }
  });

  const rows = stats
    .filter((row) => mapping.has(Number(row.lid)) && row.year > 2000 && row.month >= 1 && row.month <= 12)
    .map((row) => ({
      documentId: mapping.get(Number(row.lid)).partner.documentId,
      lid: Number(row.lid),
      month: `${row.year}-${String(row.month).padStart(2, '0')}`,
      logieViews: Math.max(0, Number(row.logieViews) || 0),
      pageViews: Math.max(0, Number(row.pageViews) || 0),
      website: Math.max(0, Number(row.website) || 0),
    }));

  const statsWithoutLogie = [...totals.keys()].filter((lid) => !logies.some((l) => Number(l.id) === lid));

  const summary = {
    ok: true,
    dryRun: options.dryRun,
    oudeLogies: logies.length,
    nieuwePartners: new Set(partners.map((p) => p.documentId)).size,
    gekoppeld: mapping.size,
    gekoppeldVia: matchedBy,
    statistiekRijen: stats.length,
    teImporterenRijen: rows.length,
    nietGekoppeldMetStatistieken: unmatched.sort((a, b) => b.views - a.views),
    statistiekenZonderLogie: statsWithoutLogie,
  };

  if (!options.dryRun) {
    await execSql(
      db,
      `CREATE TABLE IF NOT EXISTS \`${TARGET_TABLE}\` (
        legacy_logie_id INT NOT NULL,
        month CHAR(7) NOT NULL,
        partner_document_id VARCHAR(255) NOT NULL,
        logie_views INT UNSIGNED NOT NULL DEFAULT 0,
        page_views INT UNSIGNED NOT NULL DEFAULT 0,
        website_clicks INT UNSIGNED NOT NULL DEFAULT 0,
        imported_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (legacy_logie_id, month),
        INDEX partner_legacy_monthly_partner_idx (partner_document_id)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
    );

    const esc = (value) => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    for (let i = 0; i < rows.length; i += 500) {
      const values = rows
        .slice(i, i + 500)
        .map((r) => `(${r.lid}, ${esc(r.month)}, ${esc(r.documentId)}, ${r.logieViews}, ${r.pageViews}, ${r.website})`)
        .join(',\n');
      await execSql(
        db,
        `REPLACE INTO \`${TARGET_TABLE}\` (legacy_logie_id, month, partner_document_id, logie_views, page_views, website_clicks) VALUES\n${values};`,
      );
    }
    summary.geimporteerd = rows.length;
  }

  console.log(JSON.stringify(summary, null, 2));
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

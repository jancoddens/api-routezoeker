#!/usr/bin/env node

'use strict';

// Vult de partnerabonnementen aan met de facturen uit het oude systeem
// (tabel `ZF_Orders` van de PHP-site), zodat het menu "Facturen" in de admin
// meteen de juiste vervaldagen en factuurgegevens toont.
//
// Per abonnement worden (enkel als ze nog leeg zijn, tenzij --overwrite):
//   billing_name     ← Bedrijf (of Naam)
//   billing_address  ← Adres + Postcode Gemeente
//   billing_vat      ← BTW
//   contact_email    ← Email
//   first_run        ← start van de eerste periode (of datum eerste factuur)
//   last_run         ← start van de laatst gefactureerde periode
//   run_count        ← aantal facturen (creditnota's niet meegeteld)
//   last_invoice     ← nummer van de laatste factuur
// Prijs en pakket staan niet in ZF_Orders en worden dus niet aangeraakt.
//
// Koppeling oude klant → abonnement: op naam van de partner (Naam/Bedrijf uit
// de factuur), het e-mailadres van de partner, en of de startdatum van het
// abonnement overeenkomt met een factuurdatum of periode. Facturen met
// hetzelfde e-mailadres horen bij dezelfde klant. Twijfelgevallen worden
// overgeslagen en in het rapport getoond; die koppel je met --map.
//
// Gebruik (op de server, in de API-map):
//   node scripts/import-legacy-orders.js                 # proefdraai: toont enkel wat er zou gebeuren
//   node scripts/import-legacy-orders.js --apply         # echt wegschrijven
//   node scripts/import-legacy-orders.js --file ZF_Orders.sql   # uit een phpMyAdmin-export i.p.v. de databank
//   node scripts/import-legacy-orders.js --map 7=info@bosgat.be,25="Château de Rienne"   # abonnement-ID = e-mail of naam in ZF_Orders
//   node scripts/import-legacy-orders.js --skip 13,59    # deze abonnementen niet aanraken
//   node scripts/import-legacy-orders.js --overwrite     # ook al ingevulde velden overschrijven
//   node scripts/import-legacy-orders.js --config /pad/naar/config.php [--host --port --user --password --database]

const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { compileStrapi, createStrapi } = require('@strapi/strapi');

const execFileAsync = promisify(execFile);
const DEFAULT_CONFIG = '/var/www/vhosts/routezoeker.com/httpdocs/config.php';
const SUB = 'api::partner-subscription.partner-subscription';
const NOT_LOGIES = new Set(['blog', 'partner', 'samenwerking']);

// ---------- argumenten ----------

const parseArgs = () => {
  const args = process.argv.slice(2);
  const options = { configPath: DEFAULT_CONFIG, apply: false, overwrite: false, file: null, map: new Map(), skip: new Set(), overrides: {} };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = () => {
      i += 1;
      if (args[i] === undefined) throw new Error(`Waarde ontbreekt voor ${arg}`);
      return args[i];
    };
    if (arg === '--apply') options.apply = true;
    else if (arg === '--dry-run') options.apply = false;
    else if (arg === '--overwrite') options.overwrite = true;
    else if (arg === '--file') options.file = next();
    else if (arg === '--config') options.configPath = next();
    else if (arg === '--host') options.overrides.host = next();
    else if (arg === '--port') options.overrides.port = next();
    else if (arg === '--user') options.overrides.user = next();
    else if (arg === '--password') options.overrides.password = next();
    else if (arg === '--database') options.overrides.database = next();
    else if (arg === '--skip') next().split(',').filter(Boolean).forEach((id) => options.skip.add(Number(id)));
    else if (arg === '--map') {
      next()
        .split(',')
        .filter(Boolean)
        .forEach((pair) => {
          const [id, ...rest] = pair.split('=');
          if (!id || !rest.length) throw new Error(`Ongeldige --map: ${pair} (gebruik ID=email of ID=naam)`);
          options.map.set(Number(id), rest.join('=').trim());
        });
    } else throw new Error(`Onbekende optie: ${arg}`);
  }
  return options;
};

// ---------- oude facturen inlezen ----------

const parsePhpConfig = async (configPath) => {
  const raw = await fs.readFile(configPath, 'utf8');
  const extract = (name) => raw.match(new RegExp(`\\$${name}\\s*=\\s*'([^']*)'`, 'i'))?.[1] ?? null;
  return { host: extract('dbhost'), user: extract('dbuser'), password: extract('dbpass'), database: extract('dbname') };
};

const readFromDatabase = async (options) => {
  const parsed = await parsePhpConfig(options.configPath);
  const db = { ...parsed, ...Object.fromEntries(Object.entries(options.overrides).filter(([, v]) => v)) };
  if (!db.host || !db.user || db.password == null || !db.database) {
    throw new Error(`Kon de databankgegevens niet lezen uit ${options.configPath}`);
  }
  const args = ['--batch', '--raw', '--skip-column-names', '-h', db.host, '-u', db.user, '-D', db.database];
  if (db.port) args.push('-P', String(db.port));
  const sql =
    "SELECT JSON_OBJECT('id',`ID`,'naam',`Naam`,'type',`Type`,'bedrijf',`Bedrijf`,'adres',`Adres`,'postcode',`Postcode`," +
    "'gemeente',`Gemeente`,'btw',`BTW`,'email',`Email`,'date',`Invoice_date`,'number',`Invoice_number`," +
    "'reference',`Reference`,'status',`Status_Invoice`) FROM `ZF_Orders`";
  const { stdout } = await execFileAsync('mysql', [...args, '-e', sql], {
    env: { ...process.env, MYSQL_PWD: db.password },
    maxBuffer: 1024 * 1024 * 50,
  });
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};

/** Leest de INSERT-regels uit een phpMyAdmin-export van ZF_Orders. */
const readFromDump = async (file) => {
  const raw = await fs.readFile(file, 'utf8');
  const rows = [];
  const inserts = raw.matchAll(/INSERT INTO `ZF_Orders` \(([^)]*)\) VALUES\s*([\s\S]*?\));\s*$/gm);
  for (const [, columnList, values] of inserts) {
    const columns = columnList.split(',').map((c) => c.trim().replace(/`/g, ''));
    let i = 0;
    while (i < values.length) {
      if (values[i] !== '(') {
        i += 1;
        continue;
      }
      i += 1;
      const fields = [];
      while (i < values.length && values[i] !== ')') {
        while (values[i] === ' ' || values[i] === ',' || values[i] === '\n' || values[i] === '\r') i += 1;
        if (values[i] === "'") {
          let out = '';
          i += 1;
          while (i < values.length) {
            const c = values[i];
            if (c === '\\') {
              const n = values[i + 1];
              out += n === 'n' ? '\n' : n === 'r' ? '\r' : n === 't' ? '\t' : n === '0' ? '' : n;
              i += 2;
            } else if (c === "'" && values[i + 1] === "'") {
              out += "'";
              i += 2;
            } else if (c === "'") {
              i += 1;
              break;
            } else {
              out += c;
              i += 1;
            }
          }
          fields.push(out);
        } else {
          let out = '';
          while (i < values.length && values[i] !== ',' && values[i] !== ')') out += values[i++];
          fields.push(out.trim() === 'NULL' ? null : out.trim());
        }
        while (values[i] === ' ' || values[i] === '\n' || values[i] === '\r') i += 1;
        if (values[i] === ',') i += 1;
      }
      i += 1;
      const r = Object.fromEntries(columns.map((c, idx) => [c, fields[idx]]));
      rows.push({
        id: Number(r.ID),
        naam: r.Naam,
        type: r.Type,
        bedrijf: r.Bedrijf,
        adres: r.Adres,
        postcode: r.Postcode,
        gemeente: r.Gemeente,
        btw: r.BTW,
        email: r.Email,
        date: r.Invoice_date,
        number: r.Invoice_number,
        reference: r.Reference,
        status: r.Status_Invoice,
      });
    }
  }
  if (!rows.length) throw new Error(`Geen ZF_Orders-rijen gevonden in ${file}`);
  return rows;
};

// ---------- tekst & koppeling ----------

const decodeEntities = (value) => {
  let s = String(value ?? '');
  for (let k = 0; k < 3; k += 1) {
    s = s
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;|&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  }
  return s.replace(/\s+/g, ' ').trim();
};

const STOP = new Set(
  (
    'b bb bnb en de het t the la le les l d du vakantiewoning vakantiewoningen vakantiehuis vakantieappartement ' +
    'vakantiehoeve vakantievilla hotel boutique charmehotel bv nv bvba vzw comm v logies huis in van kasteel ' +
    'verblijf appartement gastenkamers hoeve villa sauna spa'
  ).split(' '),
);

const norm = (value) =>
  decodeEntities(value)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/b&b/g, ' bnb ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const tokens = (value) => norm(value).split(' ').filter((t) => t.length > 1 && !STOP.has(t));

// Levenshtein-ratio, zoals difflib.SequenceMatcher ongeveer.
const ratio = (a, b) => {
  if (!a.length && !b.length) return 1;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return 1 - dp[a.length][b.length] / Math.max(a.length, b.length);
};

// 2 × langste gemeenschappelijke deelreeks / totale lengte (zoals difflib).
const lcsRatio = (a, b) => {
  if (!a.length || !b.length) return 0;
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [0];
    for (let j = 1; j <= b.length; j += 1) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  return (2 * prev[b.length]) / (a.length + b.length);
};

// Dice-coëfficiënt op lettergrepen van 2 tekens (vangt Koppenberg/Koppenherberg).
const dice = (a, b) => {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const grams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i += 1) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) || 0) + 1);
    return m;
  };
  const ga = grams(a);
  const gb = grams(b);
  let overlap = 0;
  for (const [g, n] of ga) overlap += Math.min(n, gb.get(g) || 0);
  return (2 * overlap) / (a.length - 1 + b.length - 1);
};

const similarity = (a, b) => {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return 0;
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const jaccard = inter / new Set([...ta, ...tb]).size;
  const ca = [...ta].join('');
  const cb = [...tb].join('');
  const seq = Math.max(ratio(ca, cb), dice(ca, cb), lcsRatio(ca, cb));
  const contained = Math.min(ca.length, cb.length) >= 4 && (ca.includes(cb) || cb.includes(ca)) ? 0.5 : 0;
  return Math.max(jaccard, seq >= 0.8 ? seq : 0, contained);
};

const periodStart = (reference) => {
  const m = String(reference || '').match(/(\d{2})-(\d{2})-(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

const day = (value) => (value ? String(value).slice(0, 10) : null);

// ---------- hoofdprogramma ----------

const run = async () => {
  const options = parseArgs();
  const orders = (options.file ? await readFromDump(options.file) : await readFromDatabase(options))
    .map((o) => ({ ...o, naam: decodeEntities(o.naam), bedrijf: decodeEntities(o.bedrijf), email: String(o.email || '').trim().toLowerCase() }))
    .filter((o) => !NOT_LOGIES.has(String(o.type || '').toLowerCase()))
    .filter((o) => String(o.status || '').toLowerCase() !== 'credit');

  // Klanten: facturen met hetzelfde e-mailadres én dezelfde naam samen. Eén
  // uitbater kan meerdere logies hebben onder hetzelfde e-mailadres; die
  // blijven dus apart. Naamvarianten (bv. Koppenberg/Koppenherberg) worden
  // bij de koppeling weer samengevoegd als ze hetzelfde e-mailadres hebben.
  const customers = new Map();
  for (const o of orders) {
    const key = `${o.email}|${norm(o.naam)}`;
    if (!customers.has(key)) customers.set(key, { key, email: o.email, orders: [] });
    customers.get(key).orders.push(o);
  }
  for (const c of customers.values()) {
    c.orders.sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.id - b.id);
    c.names = [...new Set(c.orders.flatMap((o) => [o.naam, o.bedrijf]).filter(Boolean))];
    c.dates = new Set(c.orders.flatMap((o) => [day(o.date), periodStart(o.reference)]).filter(Boolean));
    c.label = c.orders[c.orders.length - 1].naam;
  }

  const appContext = await compileStrapi();
  const strapi = createStrapi(appContext);
  await strapi.load();

  try {
    const rows = await strapi.db.query(SUB).findMany({ populate: { partner: { select: ['name', 'email', 'documentId'] } } });
    const subs = new Map();
    for (const row of rows) {
      if (!subs.has(row.documentId)) subs.set(row.documentId, { documentId: row.documentId, rows: [] });
      subs.get(row.documentId).rows.push(row);
    }

    const merge = (list) => {
      const all = list.flatMap((c) => c.orders).sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.id - b.id);
      return { key: list[0].email || list[0].key, label: all[all.length - 1].naam, orders: all };
    };

    const findCustomer = (value) => {
      const wanted = value.toLowerCase();
      const byEmail = [...customers.values()].filter((c) => c.email && c.email === wanted);
      if (byEmail.length) return merge(byEmail);
      const byName = [...customers.values()].filter((c) => c.names.some((n) => norm(n) === norm(value)));
      return byName.length ? merge(byName) : null;
    };

    const report = { updated: [], unchanged: [], unmatched: [], ambiguous: [], skipped: [] };

    for (const sub of subs.values()) {
      // Bij voorkeur de gepubliceerde versie als referentie.
      const main = sub.rows.find((r) => r.publishedAt) || sub.rows[0];
      const ids = sub.rows.map((r) => r.id);
      const name = main.partner?.name || sub.rows.find((r) => r.partner?.name)?.partner?.name || '';
      const partnerEmail = String(main.partner?.email || '').trim().toLowerCase();
      const label = `#${Math.min(...ids)} ${name || '(geen partner)'}`;

      if (ids.some((id) => options.skip.has(id))) {
        report.skipped.push(label);
        continue;
      }

      let customer = null;
      const mapped = ids.map((id) => options.map.get(id)).find(Boolean);
      if (mapped) {
        customer = findCustomer(mapped);
        if (!customer) {
          report.unmatched.push(`${label} (--map "${mapped}" niet gevonden in ZF_Orders)`);
          continue;
        }
      } else {
        const start = day(main.start_date);
        const candidates = [];
        for (const c of customers.values()) {
          const score = Math.max(0, ...c.names.map((n) => similarity(name, n)));
          const dateMatch = Boolean(start && c.dates.has(start));
          const emailMatch = Boolean(partnerEmail && partnerEmail === c.email && score >= 0.3);
          if (emailMatch || score >= 0.6 || (score >= 0.3 && dateMatch)) {
            candidates.push({ c, total: score + (dateMatch ? 0.3 : 0) + (emailMatch ? 1 : 0), score, dateMatch, emailMatch });
          }
        }
        candidates.sort((a, b) => b.total - a.total);
        if (!candidates.length) {
          report.unmatched.push(label);
          continue;
        }
        const best = candidates[0];
        const rival = candidates.find((x) => x !== best && !(best.c.email && x.c.email === best.c.email));
        if (rival && best.total - rival.total < 0.2) {
          report.ambiguous.push(`${label} → "${best.c.label}" (${best.c.email || 'geen e-mail'}) of "${rival.c.label}" (${rival.c.email || 'geen e-mail'})`);
          continue;
        }
        // Naamvarianten met hetzelfde e-mailadres samennemen.
        const siblings = best.c.email ? candidates.filter((x) => x.c.email === best.c.email && x.score >= 0.6).map((x) => x.c) : [];
        customer = merge([best.c, ...siblings.filter((c) => c !== best.c)]);
      }

      const last = customer.orders[customer.orders.length - 1];
      const first = customer.orders[0];
      const runDate = (o) => periodStart(o.reference) || day(o.date);
      const values = {
        billing_name: last.bedrijf || last.naam || null,
        billing_address: [String(last.adres || '').trim(), [last.postcode, last.gemeente].map((v) => String(v || '').trim()).filter(Boolean).join(' ')]
          .filter(Boolean)
          .join('\n') || null,
        billing_vat: String(last.btw || '').trim() || null,
        contact_email: last.email || null,
        first_run: runDate(first),
        last_run: customer.orders.map(runDate).sort().pop(),
        run_count: customer.orders.length,
        last_invoice: String(last.number || '') || null,
      };

      const data = {};
      for (const [field, value] of Object.entries(values)) {
        if (value == null || value === '') continue;
        const current = main[field];
        const isEmpty = current == null || current === '' || (field === 'run_count' && !current);
        if (options.overwrite ? String(current ?? '') !== String(value) : isEmpty) data[field] = value;
      }

      const line = `${label} ← "${customer.label}" (${customer.orders.length} factuur/facturen, laatste ${day(last.date)})`;
      if (!Object.keys(data).length) {
        report.unchanged.push(line);
        continue;
      }
      report.updated.push(`${line}\n      ${Object.entries(data).map(([k, v]) => `${k}=${String(v).replace(/\n/g, ', ')}`).join(' | ')}`);
      if (options.apply) {
        // Draft en gepubliceerde versie gelijk houden.
        for (const id of ids) await strapi.db.query(SUB).update({ where: { id }, data });
      }
    }

    const print = (title, list) => {
      console.log(`\n=== ${title} (${list.length}) ===`);
      list.forEach((l) => console.log(`  ${l}`));
    };
    print(options.apply ? 'Bijgewerkt' : 'Zou bijwerken (proefdraai)', report.updated);
    print('Al ingevuld, niets te doen', report.unchanged);
    print('Twijfel, niet aangeraakt (gebruik --map ID=email)', report.ambiguous);
    print('Geen oude factuur gevonden (gratis partner, of factuur onder andere naam → --map)', report.unmatched);
    if (report.skipped.length) print('Overgeslagen met --skip', report.skipped);
    if (!options.apply) console.log('\nDit was een proefdraai. Klopt het? Draai opnieuw met --apply om weg te schrijven.');
  } finally {
    await strapi.destroy().catch(() => {});
  }
};

run().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});

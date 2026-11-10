#!/usr/bin/env node

'use strict';

// Neemt de openstaande proforma's uit het oude systeem over (tabellen
// `ZF_Proforma` + `ZF_Proforma_line` van de PHP-site), zodat ze in het menu
// "Facturen" bij Proforma's staan en je ze daar kan opvolgen, herinneren en
// op betaald zetten (wat dan het abonnement verlengt).
//
// - Enkel proforma's met Status = 1 (nog niet omgezet naar een factuur).
// - Koppeling aan het abonnement via de logie: Logie_id → Logies.URL = slug
//   van de partner. Lukt dat niet, dan op naam + periode.
// - Overgeslagen (en in het rapport): periode is al betaald (last run van het
//   abonnement is even recent of recenter), er bestaat al een proforma voor die
//   periode, het nummer bestaat al, of er is geen abonnement gevonden.
// - Proforma's met meerdere logies (bv. Urban Gardens Gent en Ieper) worden één
//   proforma met meerdere regels; betaald zetten verlengt dan alle abonnementen.
// - Overgenomen proforma's krijgen status "verstuurd", met hun oude nummer,
//   datum en periode. Prijzen in de oude tabel zijn excl. btw.
//
// Gebruik (op de server, in de API-map, na de deploy):
//   node scripts/import-legacy-proformas.js            # proefdraai
//   node scripts/import-legacy-proformas.js --apply    # echt overnemen
//   node scripts/import-legacy-proformas.js --dir /pad/met/sql-exports   # ZF_Proforma.sql, ZF_Proforma_line.sql, Logies.sql
//   node scripts/import-legacy-proformas.js --skip 7,13   # deze oude proformanummers (ID) overslaan
//   node scripts/import-legacy-proformas.js --config /pad/naar/config.php [--host --port --user --password --database]

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { compileStrapi, createStrapi } = require('@strapi/strapi');

const execFileAsync = promisify(execFile);
const DEFAULT_CONFIG = '/var/www/vhosts/routezoeker.com/httpdocs/config.php';
const INVOICE = 'api::partner-invoice.partner-invoice';

const parseArgs = () => {
  const args = process.argv.slice(2);
  const options = { configPath: DEFAULT_CONFIG, apply: false, dir: null, skip: new Set(), overrides: {} };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = () => {
      i += 1;
      if (args[i] === undefined) throw new Error(`Waarde ontbreekt voor ${arg}`);
      return args[i];
    };
    if (arg === '--apply') options.apply = true;
    else if (arg === '--dry-run') options.apply = false;
    else if (arg === '--dir') options.dir = next();
    else if (arg === '--config') options.configPath = next();
    else if (arg === '--host') options.overrides.host = next();
    else if (arg === '--port') options.overrides.port = next();
    else if (arg === '--user') options.overrides.user = next();
    else if (arg === '--password') options.overrides.password = next();
    else if (arg === '--database') options.overrides.database = next();
    else if (arg === '--skip') next().split(',').filter(Boolean).forEach((id) => options.skip.add(String(id).trim()));
    else throw new Error(`Onbekende optie: ${arg}`);
  }
  return options;
};

// ---------- oude tabellen lezen ----------

const parsePhpConfig = async (configPath) => {
  const raw = await fs.readFile(configPath, 'utf8');
  const extract = (name) => raw.match(new RegExp(`\\$${name}\\s*=\\s*'([^']*)'`, 'i'))?.[1] ?? null;
  return { host: extract('dbhost'), user: extract('dbuser'), password: extract('dbpass'), database: extract('dbname') };
};

const queryTable = async (options, table, columns) => {
  const parsed = await parsePhpConfig(options.configPath);
  const db = { ...parsed, ...Object.fromEntries(Object.entries(options.overrides).filter(([, v]) => v)) };
  if (!db.host || !db.user || db.password == null || !db.database) {
    throw new Error(`Kon de databankgegevens niet lezen uit ${options.configPath}`);
  }
  const args = ['--batch', '--raw', '--skip-column-names', '-h', db.host, '-u', db.user, '-D', db.database];
  if (db.port) args.push('-P', String(db.port));
  const sql = `SELECT JSON_OBJECT(${columns.map((c) => `'${c}', \`${c}\``).join(', ')}) FROM \`${table}\``;
  const { stdout } = await execFileAsync('mysql', [...args, '-e', sql], {
    env: { ...process.env, MYSQL_PWD: db.password },
    maxBuffer: 1024 * 1024 * 100,
  });
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};

/** Leest de INSERT-regels van één tabel uit een phpMyAdmin-export. */
const readDump = async (file, table) => {
  const raw = await fs.readFile(file, 'utf8');
  const rows = [];
  const re = new RegExp(`INSERT INTO \`${table}\` \\(([^)]*)\\) VALUES\\s*([\\s\\S]*?\\));\\s*$`, 'gm');
  for (const [, columnList, values] of raw.matchAll(re)) {
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
        while (' ,\n\r'.includes(values[i])) i += 1;
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
        while (' \n\r'.includes(values[i])) i += 1;
        if (values[i] === ',') i += 1;
      }
      i += 1;
      rows.push(Object.fromEntries(columns.map((c, idx) => [c, fields[idx]])));
    }
  }
  return rows;
};

const findDump = async (dir, table) => {
  const files = await fs.readdir(dir);
  const exact = files.find((f) => f.toLowerCase() === `${table.toLowerCase()}.sql`);
  const loose = files.find((f) => f.toLowerCase().endsWith('.sql') && f.toLowerCase().includes(table.toLowerCase()) && !(table === 'ZF_Proforma' && f.toLowerCase().includes('line')));
  const file = exact || loose;
  if (!file) throw new Error(`Geen export voor ${table} gevonden in ${dir}`);
  return readDump(path.join(dir, file), table);
};

// ---------- tekst ----------

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
const similarity = (a, b) => {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return 0;
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const jaccard = inter / new Set([...ta, ...tb]).size;
  const ca = [...ta].join('');
  const cb = [...tb].join('');
  const seq = lcsRatio(ca, cb);
  const contained = Math.min(ca.length, cb.length) >= 4 && (ca.includes(cb) || cb.includes(ca)) ? 0.5 : 0;
  return Math.max(jaccard, seq >= 0.8 ? seq : 0, contained);
};

const periodFromReference = (reference) => {
  const m = [...String(reference || '').matchAll(/(\d{2})-(\d{2})-(\d{4})/g)];
  if (!m.length) return null;
  const toIso = (x) => `${x[3]}-${x[2]}-${x[1]}`;
  return { start: toIso(m[0]), end: m[1] ? toIso(m[1]) : null };
};

const addDays = (date, days) => {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
};
const addMonths = (date, months) => {
  const [y, m, d] = date.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
};
const round2 = (n) => Math.round(n * 100) / 100;
const day = (v) => (v ? String(v).slice(0, 10) : null);
const nl = (date) => (date ? date.split('-').reverse().join('/') : '');

// ---------- hoofdprogramma ----------

const run = async () => {
  const options = parseArgs();

  const proformaCols = ['ID', 'Logie_id', 'Status', 'Naam', 'Bedrijf', 'Adres', 'Postcode', 'Gemeente', 'BTW', 'Email', 'Facturatie', 'Invoice_date', 'Invoice_number', 'Reference', 'Status_Invoice'];
  const lineCols = ['ID', 'ID_order', 'ID_logie', 'Product', 'Quantity', 'Price', 'BTW_perc', 'Discount'];
  const [proformas, lines, logies] = options.dir
    ? await Promise.all([findDump(options.dir, 'ZF_Proforma'), findDump(options.dir, 'ZF_Proforma_line'), findDump(options.dir, 'Logies').catch(() => [])])
    : await Promise.all([
        queryTable(options, 'ZF_Proforma', proformaCols),
        queryTable(options, 'ZF_Proforma_line', lineCols),
        queryTable(options, 'Logies', ['ID', 'URL', 'Titel']),
      ]);

  const logieUrl = new Map(logies.map((l) => [String(l.ID), String(l.URL || '').trim()]));
  const linesByOrder = new Map();
  for (const l of lines) {
    const key = String(l.ID_order);
    if (!linesByOrder.has(key)) linesByOrder.set(key, []);
    linesByOrder.get(key).push(l);
  }

  const appContext = await compileStrapi();
  const strapi = createStrapi(appContext);
  await strapi.load();

  try {
    const inv = require(path.join(appContext.distDir, 'src/utils/partner-invoicing.js'));
    const settings = await inv.getSettings(strapi);
    const overview = await inv.getOverview(strapi);
    const subs = overview.subscriptions;
    const partners = await strapi.db.query('api::partner.partner').findMany({ select: ['documentId', 'slug', 'name'] });
    const partnerBySlug = new Map();
    for (const p of partners) if (p.slug && !partnerBySlug.has(p.slug)) partnerBySlug.set(p.slug, p.documentId);
    const subByPartner = new Map(subs.filter((s) => s.partnerDocumentId).map((s) => [s.partnerDocumentId, s]));

    const existingInvoices = await strapi.db.query(INVOICE).findMany({});
    const existingNumbers = new Set(existingInvoices.map((i) => String(i.number)));

    /** Abonnement bij een oude logie: via slug, anders op naam (+ periode als steun). */
    const findSub = (logieId, name, periodStart, used = new Set()) => {
      const slug = logieUrl.get(String(logieId));
      const viaSlug = slug && subByPartner.get(partnerBySlug.get(slug));
      if (viaSlug && !used.has(viaSlug.documentId)) return { sub: viaSlug, how: 'logie' };
      const scored = subs
        .map((s) => {
          const score = similarity(name, s.name);
          const anniversary = periodStart && s.nextRun && String(s.nextRun).slice(5, 10) === periodStart.slice(5, 10);
          return { s, score, total: score + (anniversary ? 0.3 : 0), anniversary };
        })
        .filter((x) => !used.has(x.s.documentId))
        .filter((x) => x.score >= 0.6 || (x.score >= 0.3 && x.anniversary))
        .sort((a, b) => b.total - a.total);
      if (!scored.length) return null;
      // Bij een proforma met meerdere logies (bv. "Urban Gardens Gent en Ieper") mag een
      // twijfel tussen die logies: elke regel krijgt dan een ander abonnement.
      if (scored[1] && scored[0].total - scored[1].total < 0.2 && !used.multi) return { ambiguous: scored.slice(0, 2).map((x) => x.s.name) };
      return { sub: scored[0].s, how: 'naam' };
    };

    const report = { created: [], paid: [], exists: [], unmatched: [], skipped: [] };

    const open = proformas.filter((p) => String(p.Status) === '1').sort((a, b) => Number(a.ID) - Number(b.ID));
    for (const p of open) {
      const name = decodeEntities(p.Naam);
      // Nummer zoals in het oude systeem: JJJJMMDD + ID (4 cijfers). Ontbreekt het, dan zelf samenstellen.
      let number = String(p.Invoice_number || '').trim();
      if (!/^\d{12}$/.test(number)) number = `${String(day(p.Invoice_date)).replace(/-/g, '')}${String(p.ID).padStart(4, '0')}`;
      const label = `${number} ${name} (${day(p.Invoice_date)})`;
      if (options.skip.has(String(p.ID)) || options.skip.has(number)) {
        report.skipped.push(label);
        continue;
      }
      if (existingNumbers.has(number)) {
        report.exists.push(`${label}: nummer bestaat al`);
        continue;
      }

      // Regels → abonnementen. Dubbele regels (zelfde logie, product en prijs) één keer.
      const rawLines = linesByOrder.get(String(p.ID)) || [];
      const seen = new Set();
      const resolved = [];
      const used = new Set();
      used.multi = new Set(rawLines.map((l) => Number(l.ID_logie) || Number(p.Logie_id))).size > 1;
      let problem = null;
      const period = periodFromReference(p.Reference);
      for (const l of rawLines.length ? rawLines : [{ ID_logie: p.Logie_id, Product: 'Advertentie Routezoeker.com (jaar)', Quantity: 1, Price: null, BTW_perc: 21, Discount: 0 }]) {
        const logieId = Number(l.ID_logie) || Number(p.Logie_id);
        const productName = decodeEntities(l.Product);
        const lineName = productName.includes(' - ') ? productName.split(' - ').slice(1).join(' - ') : name;
        const key = `${logieId}|${productName}|${l.Price}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const match = findSub(logieId, rawLines.length > 1 ? lineName : name, period?.start, used);
        if (!match || match.ambiguous) {
          problem = match?.ambiguous ? `twijfel tussen ${match.ambiguous.join(' en ')}` : `geen abonnement voor "${lineName}"`;
          break;
        }
        used.add(match.sub.documentId);
        resolved.push({ line: l, sub: match.sub, how: match.how, productName });
      }
      if (problem) {
        report.unmatched.push(`${label}: ${problem}`);
        continue;
      }
      if (resolved.some((r) => r.line.Price == null)) {
        report.unmatched.push(`${label}: geen proformaregels gevonden`);
        continue;
      }

      const primary = resolved[0].sub;
      const periodStart = period?.start || primary.nextRun;
      if (!periodStart) {
        report.unmatched.push(`${label}: geen periode`);
        continue;
      }
      const periodEnd = addDays(addMonths(periodStart, settings.period_months || 12), -1);

      // Al betaald? (last run van het abonnement even recent of recenter dan deze periode)
      const alreadyPaid = resolved.filter((r) => r.sub.lastRun && String(r.sub.lastRun).slice(0, 10) >= periodStart);
      if (alreadyPaid.length === resolved.length) {
        report.paid.push(`${label}: periode ${nl(periodStart)} al betaald (last run ${nl(day(alreadyPaid[0].sub.lastRun))})`);
        continue;
      }
      // Al een proforma voor deze periode in het nieuwe systeem?
      const subIds = resolved.map((r) => r.sub.documentId);
      const dup = existingInvoices.find(
        (i) =>
          i.status_invoice !== 'geannuleerd' &&
          day(i.period_start) === periodStart &&
          inv.invoiceSubscriptions(i).some((id) => subIds.includes(id)),
      );
      if (dup) {
        report.exists.push(`${label}: er staat al proforma ${dup.number} (${dup.status_invoice}) voor deze periode`);
        continue;
      }

      const invoiceLines = resolved.map((r) => {
        const qty = Number(r.line.Quantity) || 1;
        const price = Number(r.line.Price) * qty;
        const discount = Number(r.line.Discount) || 0;
        const amount = round2(price * (1 - discount / 100));
        return {
          subscription_document_id: r.sub.documentId,
          partner_name: r.sub.name,
          description: `${r.productName} (${nl(periodStart)} – ${nl(periodEnd)})`,
          price: round2(price),
          discount,
          vat_rate: Number(r.line.BTW_perc) || 0,
          amount_excl: amount,
        };
      });
      const totalExcl = round2(invoiceLines.reduce((s, l) => s + l.amount_excl, 0));
      const totalVat = round2(invoiceLines.reduce((s, l) => s + (l.amount_excl * l.vat_rate) / 100, 0));
      const vatRates = [...new Set(invoiceLines.map((l) => l.vat_rate))];
      const email = String(p.Email || '').trim() || (String(p.Facturatie || '').includes('@') ? String(p.Facturatie).trim() : '') || primary.email || '';
      const invoiceDate = day(p.Invoice_date);

      const data = {
        number: Number(number),
        status_invoice: 'verstuurd',
        partner_name: name,
        partner_document_id: primary.partnerDocumentId,
        subscription_document_id: primary.documentId,
        invoice_date: invoiceDate,
        due_date: addDays(invoiceDate, settings.payment_term_days || 30),
        period_start: periodStart,
        period_end: periodEnd,
        package: primary.package,
        description: invoiceLines.map((l) => l.description).join('\n'),
        price: round2(invoiceLines.reduce((s, l) => s + l.price, 0)),
        discount: invoiceLines.length === 1 ? invoiceLines[0].discount : 0,
        vat_rate: vatRates.length === 1 ? vatRates[0] : Number(settings.vat_rate),
        total_excl: totalExcl,
        total_vat: totalVat,
        total_incl: round2(totalExcl + totalVat),
        billing_name: decodeEntities(p.Bedrijf) || name,
        billing_address: [String(p.Adres || '').trim(), [p.Postcode, p.Gemeente].map((v) => String(v || '').trim()).filter(Boolean).join(' ')]
          .filter(Boolean)
          .join('\n'),
        billing_vat: String(p.BTW || '').trim().replace(/^[-–.\s]+$/, ''),
        billing_email: email,
        sent_at: `${invoiceDate}T09:00:00.000Z`,
        sent_to: email,
        reminder_count: 0,
        renewed_subscription: false,
        lines: invoiceLines.length > 1 ? invoiceLines : null,
        history: `${new Date().toISOString().slice(0, 16).replace('T', ' ')} Overgenomen uit het oude systeem (proforma ${p.ID}, ${p.Status_Invoice || 'open'})`,
      };

      const subsLabel = resolved.map((r) => `${r.sub.name}${r.how === 'naam' ? ' (op naam)' : ''}`).join(' + ');
      const overdue = data.due_date < new Date().toISOString().slice(0, 10) ? ' – over vervaldatum' : '';
      report.created.push(`${label} → ${subsLabel}: ${nl(periodStart)}, € ${data.total_incl.toFixed(2)} incl. btw${overdue}`);
      if (options.apply) {
        await strapi.documents(INVOICE).create({ data });
        existingNumbers.add(number);
        existingInvoices.push({ ...data });
      }
    }

    const print = (title, list) => {
      console.log(`\n=== ${title} (${list.length}) ===`);
      list.forEach((l) => console.log(`  ${l}`));
    };
    print(options.apply ? 'Overgenomen' : 'Zou overnemen (proefdraai)', report.created);
    print('Niet overgenomen: periode al betaald', report.paid);
    print('Niet overgenomen: bestaat al in het nieuwe systeem', report.exists);
    print('Niet overgenomen: geen (duidelijk) abonnement', report.unmatched);
    if (report.skipped.length) print('Overgeslagen met --skip', report.skipped);
    if (!options.apply) console.log('\nDit was een proefdraai. Klopt het? Draai opnieuw met --apply om over te nemen.');
  } finally {
    await strapi.destroy().catch(() => {});
  }
};

run().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});

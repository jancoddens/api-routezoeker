import type { Core } from '@strapi/strapi';
import PDFDocument from 'pdfkit';

// Facturatie partnerabonnementen.
// Strapi maakt en verstuurt de proforma's en volgt op wie betaald heeft.
// De officiële factuur maak je daarna in Octopus; het Octopus-nummer kan je bij
// de proforma noteren wanneer je ze als betaald markeert.

const SUB = 'api::partner-subscription.partner-subscription';
const INVOICE = 'api::partner-invoice.partner-invoice';
const SETTINGS = 'api::invoice-setting.invoice-setting';

const siteUrl = () => (process.env.FRONTEND_URL || 'https://www.routezoeker.com').replace(/\/+$/, '');
const fromAddress = () => process.env.SMTP_FROM || process.env.SMTP_USER || 'info@routezoeker.com';
const replyTo = () => process.env.SMTP_REPLY_TO || 'info@routezoeker.com';

export const DEFAULT_SETTINGS = {
  company_name: 'Routezoeker',
  company_address: '',
  company_vat: '',
  company_iban: '',
  company_bic: '',
  company_email: 'info@routezoeker.com',
  company_phone: '',
  company_website: 'www.routezoeker.com',
  vat_rate: 21,
  prices_include_vat: false,
  vat_note: '',
  payment_term_days: 30,
  period_months: 12,
  remind_days_before: 30,
  from_name: 'Jan van Routezoeker',
  bcc_email: '',
  mail_subject: 'Proforma {nummer} – je partnerpagina op Routezoeker',
  mail_body: `Dag,

In bijlage vind je de proforma {nummer} voor de jaarlijkse advertentie van {naam} op Routezoeker.com, voor de periode {periode}.

Hier kan je nogmaals je advertentiepagina zien: {pagina}
Wil je graag nieuwe of extra foto's, of wijzigingen in de tekst? Laat het maar weten.

Te betalen: {bedrag}
Gelieve dit bedrag vóór {vervaldatum} over te schrijven op {iban} met vermelding "{mededeling}".

Na ontvangst van je betaling krijg je de officiële factuur.

Vragen? Antwoord gewoon op deze mail.

Met vriendelijke groeten,
Jan Coddens
Routezoeker.com`,
  reminder_subject: 'Herinnering: proforma {nummer} – Routezoeker',
  reminder_body: `Dag,

Volgens onze gegevens staat de proforma {nummer} voor {naam} ({bedrag}, vervaldatum {vervaldatum}) nog open. Je vindt ze opnieuw in bijlage.

Gelieve het bedrag over te schrijven op {iban} met vermelding "{mededeling}". Heb je intussen al betaald? Dan mag je deze mail negeren.

Met vriendelijke groeten,
Jan Coddens
Routezoeker.com`,
  pdf_footer: 'Dit is een proforma en geen factuur. Na ontvangst van de betaling ontvang je de officiële factuur.',
};

// ---------- datums & bedragen ----------

const today = () => new Date().toISOString().slice(0, 10);

const addMonths = (date: string, months: number) => {
  const [y, m, d] = date.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
};

const addDays = (date: string, days: number) => {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
};

const round2 = (n: number) => Math.round(n * 100) / 100;

const money = (n: number | string | null | undefined) =>
  `€ ${Number(n || 0).toLocaleString('nl-BE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const nlDate = (date?: string | null) => {
  if (!date) return '';
  const [y, m, d] = String(date).slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};

export const computeTotals = (price: number, discount: number, vatRate: number, inclVat: boolean) => {
  const net = price * (1 - (discount || 0) / 100);
  if (inclVat) {
    const incl = round2(net);
    const excl = round2(incl / (1 + vatRate / 100));
    return { total_excl: excl, total_vat: round2(incl - excl), total_incl: incl };
  }
  const excl = round2(net);
  const vat = round2((excl * vatRate) / 100);
  return { total_excl: excl, total_vat: vat, total_incl: round2(excl + vat) };
};

/** Gestructureerde mededeling (+++123/4567/89012+++) op basis van het proformanummer. */
export const structuredReference = (number: number) => {
  const base = String(number).padStart(10, '0').slice(-10);
  const check = Number(base) % 97 || 97;
  const s = base + String(check).padStart(2, '0');
  return `+++${s.slice(0, 3)}/${s.slice(3, 7)}/${s.slice(7)}+++`;
};

// ---------- instellingen ----------

export const getSettings = async (strapi: Core.Strapi) => {
  const stored = await strapi.documents(SETTINGS as any).findFirst({});
  const clean = Object.fromEntries(Object.entries(stored || {}).filter(([, v]) => v !== null && v !== ''));
  return { ...DEFAULT_SETTINGS, ...clean } as typeof DEFAULT_SETTINGS & { next_number?: number };
};

export const ensureInvoiceSetup = async (strapi: Core.Strapi) => {
  try {
    const stored = await strapi.documents(SETTINGS as any).findFirst({});
    if (!stored) await strapi.documents(SETTINGS as any).create({ data: DEFAULT_SETTINGS as any });
    // Oude standaardtekst (zonder link naar de advertentiepagina) vervangen door de nieuwe,
    // maar enkel als je ze zelf nog niet aangepast had.
    else if (String(stored.mail_body || '').includes('Bedankt om partner te zijn van Routezoeker. In bijlage vind je de proforma {nummer} voor {pakket}')) {
      await strapi.documents(SETTINGS as any).update({ documentId: stored.documentId, data: { mail_body: DEFAULT_SETTINGS.mail_body } as any });
    }
  } catch (error: any) {
    strapi.log.error(`Factuurinstellingen aanmaken mislukt: ${error?.message}`);
  }
};

// ---------- regels ----------

/**
 * Een proforma kan meerdere regels hebben (bv. één proforma voor twee logies
 * van dezelfde uitbater). `lines` = [{ subscription_document_id, description,
 * price, discount, vat_rate, amount_excl }], prijzen excl. btw. Zonder `lines`
 * is het een proforma met één regel (de velden op de proforma zelf).
 */
const invoiceLines = (invoice: any): any[] => {
  const raw = typeof invoice?.lines === 'string' ? safeJson(invoice.lines) : invoice?.lines;
  return Array.isArray(raw) ? raw : [];
};

const safeJson = (value: string) => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

/** Alle abonnementen waarop een proforma betrekking heeft. */
export const invoiceSubscriptions = (invoice: any): string[] =>
  [...new Set([invoice.subscription_document_id, ...invoiceLines(invoice).map((l) => l.subscription_document_id)].filter(Boolean))] as string[];

// ---------- overzicht ----------

const formatAddress = (a: any) => {
  if (!a) return '';
  const street = [a.street, a.house_number].filter(Boolean).join(' ');
  const city = [a.postal_code, a.city?.name || a.city?.title].filter(Boolean).join(' ');
  return [street, city].filter(Boolean).join('\n');
};

/** Alle abonnementen (gepubliceerde versie), met partner, volgende vervaldag en laatste proforma. */
export const getOverview = async (strapi: Core.Strapi) => {
  const settings = await getSettings(strapi);
  const subs = await strapi.db.query(SUB).findMany({
    where: { publishedAt: { $notNull: true } },
    populate: { partner: { populate: { address: { populate: ['city'] } } } },
  });
  const invoices = await strapi.db.query(INVOICE).findMany({ orderBy: { number: 'desc' } });

  const horizon = addDays(today(), settings.remind_days_before || 30);
  const rows = subs.map((s: any) => {
    const subInvoices = invoices.filter((i: any) => invoiceSubscriptions(i).includes(s.documentId));
    const latest = subInvoices[0] || null;
    const nextRun = s.last_run
      ? addMonths(String(s.last_run), settings.period_months || 12)
      : s.first_run || s.start_date || null;
    const open = subInvoices.filter((i: any) => ['concept', 'verstuurd'].includes(i.status_invoice));
    // Gratis partners krijgen geen proforma.
    const isActive = s.status_subscription === 'active' && s.package !== 'Free';
    // Al een proforma (open of betaald) voor de volgende periode? Dan niet meer "te factureren".
    const lastRun = s.last_run ? String(s.last_run).slice(0, 10) : '';
    const pending = subInvoices.find(
      (i: any) => ['concept', 'verstuurd'].includes(i.status_invoice) && String(i.period_start).slice(0, 10) > lastRun,
    );
    const due = Boolean(isActive && nextRun && String(nextRun) <= horizon && !pending);
    return {
      documentId: s.documentId,
      id: s.id,
      name: s.partner?.name || '(geen partner)',
      partnerDocumentId: s.partner?.documentId || null,
      package: s.package,
      status: s.status_subscription,
      firstRun: s.first_run || s.start_date,
      lastRun: s.last_run,
      nextRun,
      price: s.price != null ? Number(s.price) : null,
      discount: s.discount || 0,
      count: s.run_count || 0,
      email: s.contact_email || s.partner?.email || '',
      billingName: s.billing_name || s.partner?.name || '',
      billingAddress: s.billing_address || formatAddress(s.partner?.address),
      billingVat: s.billing_vat || '',
      notes: s.notes || '',
      due,
      overdue: Boolean(isActive && nextRun && String(nextRun) < today() && !pending),
      pendingInvoice: pending ? { id: pending.id, number: pending.number, status: pending.status_invoice } : null,
      openInvoices: open.length,
      latestInvoice: latest && {
        id: latest.id,
        number: latest.number,
        status: latest.status_invoice,
        total: Number(latest.total_incl || 0),
        dueDate: latest.due_date,
        sentAt: latest.sent_at,
      },
    };
  });

  rows.sort((a: any, b: any) => String(a.nextRun || '9999').localeCompare(String(b.nextRun || '9999')));

  return {
    today: today(),
    settings: {
      vat_rate: Number(settings.vat_rate),
      prices_include_vat: settings.prices_include_vat,
      period_months: settings.period_months,
      complete: Boolean(settings.company_iban && settings.company_address),
    },
    subscriptions: rows,
    invoices: invoices.map((i: any) => ({
      id: i.id,
      number: i.number,
      status: i.status_invoice,
      name: i.partner_name,
      subscriptionDocumentId: i.subscription_document_id,
      invoiceDate: i.invoice_date,
      dueDate: i.due_date,
      periodStart: i.period_start,
      periodEnd: i.period_end,
      total: Number(i.total_incl || 0),
      sentAt: i.sent_at,
      sentTo: i.sent_to,
      email: i.billing_email,
      paidAt: i.paid_at,
      reminders: i.reminder_count || 0,
      octopus: i.octopus_number,
      overdue: i.status_invoice === 'verstuurd' && i.due_date && String(i.due_date) < today(),
    })),
  };
};

// ---------- proforma aanmaken ----------

const nextNumber = async (strapi: Core.Strapi, settings: any) => {
  const last = await strapi.db.query(INVOICE).findOne({ orderBy: { number: 'desc' }, select: ['number'] });
  const lastNumber = Number(last?.number) || 0;
  const start = Number(settings.next_number) || 1;
  // Nummering zoals in het oude systeem: JJJJMMDD + volgnummer van 4 cijfers
  // (bv. 202611100220). Het volgnummer loopt door, de datum is die van vandaag.
  if (String(Math.max(lastNumber, start)).length === 12) {
    const seq = Math.max(lastNumber ? (lastNumber % 10000) + 1 : 0, start >= 1e11 ? start % 10000 : 0, 1);
    const ymd = today().replace(/-/g, '');
    return Number(`${ymd}${String(seq % 10000).padStart(4, '0')}`);
  }
  return Math.max(lastNumber + 1, start);
};

const stamp = (line: string) => `${new Date().toISOString().slice(0, 16).replace('T', ' ')} ${line}`;
const appendHistory = (history: string | null | undefined, line: string) => [history, stamp(line)].filter(Boolean).join('\n');

export type CreateInput = {
  subscriptionDocumentId: string;
  price?: number;
  discount?: number;
  description?: string;
  periodStart?: string;
};

export const createInvoice = async (strapi: Core.Strapi, input: CreateInput) => {
  const settings = await getSettings(strapi);
  const overview = await getOverview(strapi);
  const sub = overview.subscriptions.find((s: any) => s.documentId === input.subscriptionDocumentId);
  if (!sub) throw new Error('Abonnement niet gevonden (is het gepubliceerd?)');

  const months = settings.period_months || 12;
  const periodStart = input.periodStart || sub.nextRun || today();
  const periodEnd = addDays(addMonths(periodStart, months), -1);
  const price = input.price ?? sub.price;
  if (price == null || Number.isNaN(Number(price))) throw new Error('Geen prijs ingevuld voor dit abonnement');
  const discount = input.discount ?? sub.discount ?? 0;

  const existing = await strapi.db.query(INVOICE).findOne({
    where: {
      subscription_document_id: sub.documentId,
      period_start: periodStart,
      status_invoice: { $ne: 'geannuleerd' },
    },
  });
  if (existing) throw new Error(`Er bestaat al proforma ${existing.number} voor deze periode`);

  const vatRate = Number(settings.vat_rate);
  const totals = computeTotals(Number(price), Number(discount), vatRate, Boolean(settings.prices_include_vat));
  const number = await nextNumber(strapi, settings);
  const invoiceDate = today();

  const invoice: any = await strapi.documents(INVOICE as any).create({
    data: {
      number,
      status_invoice: 'concept',
      partner_name: sub.name,
      partner_document_id: sub.partnerDocumentId,
      subscription_document_id: sub.documentId,
      invoice_date: invoiceDate,
      due_date: addDays(invoiceDate, settings.payment_term_days || 30),
      period_start: periodStart,
      period_end: periodEnd,
      package: sub.package,
      description:
        input.description ||
        `Partnerpagina Routezoeker.com – pakket ${sub.package || ''}`.trim() + ` (${nlDate(periodStart)} – ${nlDate(periodEnd)})`,
      price: Number(price),
      discount: Number(discount) || 0,
      vat_rate: vatRate,
      ...totals,
      billing_name: sub.billingName,
      billing_address: sub.billingAddress,
      billing_vat: sub.billingVat,
      billing_email: sub.email,
      reminder_count: 0,
      // Het abonnement wordt pas verlengd als de proforma betaald is (zie updateStatus).
      renewed_subscription: false,
      history: stamp('Proforma aangemaakt'),
    } as any,
  });

  return invoice;
};

// ---------- status ----------

export const updateStatus = async (
  strapi: Core.Strapi,
  id: number,
  body: { status?: string; paidAt?: string; octopus?: string; notes?: string },
) => {
  const invoice = await strapi.db.query(INVOICE).findOne({ where: { id } });
  if (!invoice) throw new Error('Proforma niet gevonden');
  const data: any = {};
  let line = '';
  if (body.status === 'betaald') {
    data.status_invoice = 'betaald';
    data.paid_at = body.paidAt || today();
    line = `Betaald op ${nlDate(data.paid_at)}`;
    const snapshot = invoice.renewed_subscription ? null : await applyRenewal(strapi, invoice);
    if (snapshot) {
      data.renewed_subscription = true;
      data.renewal_snapshot = snapshot;
      line += ' (abonnement verlengd)';
    }
  } else if (body.status === 'geannuleerd') {
    data.status_invoice = 'geannuleerd';
    line = 'Geannuleerd';
    if (invoice.renewed_subscription) {
      await undoRenewal(strapi, invoice);
      data.renewed_subscription = false;
      data.renewal_snapshot = null;
    }
  } else if (body.status === 'verstuurd' || body.status === 'concept') {
    data.status_invoice = body.status;
    data.paid_at = null;
    line = `Status terug op ${body.status}`;
    if (invoice.renewed_subscription) {
      await undoRenewal(strapi, invoice);
      data.renewed_subscription = false;
      data.renewal_snapshot = null;
      line += ' (verlenging teruggedraaid)';
    }
  }
  if (body.octopus !== undefined) {
    data.octopus_number = body.octopus || null;
    if (body.octopus) line = [line, `Octopus-factuur ${body.octopus}`].filter(Boolean).join(', ');
  }
  if (body.notes !== undefined) data.notes = body.notes;
  if (line) data.history = appendHistory(invoice.history, line);
  return strapi.db.query(INVOICE).update({ where: { id }, data });
};

/** Bij betaling: last run = start van de betaalde periode (nooit terug in de tijd), count +1. Geeft de vorige waarden terug. */
const applyRenewal = async (strapi: Core.Strapi, invoice: any) => {
  const subs = invoiceSubscriptions(invoice);
  if (!subs.length || !invoice.period_start) return null;
  const rows = await strapi.db.query(SUB).findMany({ where: { documentId: { $in: subs } } });
  if (!rows.length) return null;
  const snapshot: Record<string, any> = {};
  for (const row of rows) {
    snapshot[row.documentId] = snapshot[row.documentId] || {
      first_run: row.first_run || null,
      last_run: row.last_run || null,
      run_count: row.run_count || 0,
      last_invoice: row.last_invoice || null,
    };
    const start = String(invoice.period_start).slice(0, 10);
    const current = row.last_run ? String(row.last_run).slice(0, 10) : '';
    await strapi.db.query(SUB).update({
      where: { id: row.id },
      data: {
        first_run: row.first_run || start,
        last_run: start > current ? start : row.last_run,
        run_count: (row.run_count || 0) + 1,
        last_invoice: String(invoice.number),
      },
    });
  }
  return snapshot;
};

/** Bij annuleren of terugzetten: het abonnement terugzetten naar de vorige run. */
const undoRenewal = async (strapi: Core.Strapi, invoice: any) => {
  const settings = await getSettings(strapi);
  const snapshot = typeof invoice.renewal_snapshot === 'string' ? safeJson(invoice.renewal_snapshot) : invoice.renewal_snapshot;
  if (snapshot && typeof snapshot === 'object' && Object.keys(snapshot).length) {
    // Exact terugzetten naar de waarden van vóór de betaling.
    for (const [documentId, previous] of Object.entries<any>(snapshot)) {
      await strapi.db.query(SUB).updateMany({ where: { documentId }, data: previous });
    }
    return;
  }
  const rows = await strapi.db.query(SUB).findMany({ where: { documentId: { $in: invoiceSubscriptions(invoice) } } });
  for (const row of rows) {
    if (String(row.last_run).slice(0, 10) !== String(invoice.period_start).slice(0, 10)) {
      // Last run was niet door deze proforma verschoven: enkel de teller terugzetten.
      await strapi.db.query(SUB).update({ where: { id: row.id }, data: { run_count: Math.max(0, (row.run_count || 1) - 1) } });
      continue;
    }
    const previous = await strapi.db.query(INVOICE).findOne({
      where: {
        subscription_document_id: row.documentId,
        id: { $ne: invoice.id },
        renewed_subscription: true,
        status_invoice: { $ne: 'geannuleerd' },
      },
      orderBy: { period_start: 'desc' },
    });
    const count = Math.max(0, (row.run_count || 1) - 1);
    await strapi.db.query(SUB).update({
      where: { id: row.id },
      data: {
        run_count: count,
        last_run: previous?.period_start || (count ? addMonths(String(row.last_run), -(settings.period_months || 12)) : null),
        last_invoice: previous ? String(previous.number) : row.last_invoice === String(invoice.number) ? null : row.last_invoice,
      },
    });
  }
};

// ---------- PDF ----------

export const renderPdf = async (strapi: Core.Strapi, id: number) => {
  const invoice = await strapi.db.query(INVOICE).findOne({ where: { id } });
  if (!invoice) throw new Error('Proforma niet gevonden');
  const s = await getSettings(strapi);

  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Proforma ${invoice.number}`, Author: s.company_name } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const green = '#2f7d32';
  const grey = '#666666';
  const left = 50;
  const right = 545;

  // Kop
  doc.fillColor(green).font('Helvetica-Bold').fontSize(22).text(s.company_name || 'Routezoeker', left, 50);
  doc.fillColor('#000').fontSize(18).text('PROFORMA', left, 50, { width: right - left, align: 'right' });
  doc.font('Helvetica').fontSize(10).fillColor(grey).text(`Nr. ${invoice.number}`, left, 74, { width: right - left, align: 'right' });

  // Verkoper
  const seller = [
    s.company_address,
    s.company_vat && `Btw: ${s.company_vat}`,
    s.company_email,
    s.company_phone,
    s.company_website,
  ]
    .filter(Boolean)
    .join('\n');
  doc.fillColor('#000').fontSize(9.5).text(seller, left, 82, { width: 230, lineGap: 1.5 });

  // Klant
  const clientTop = 150;
  doc.fontSize(8.5).fillColor(grey).text('PROFORMA VOOR', 320, clientTop);
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(11).text(invoice.billing_name || invoice.partner_name || '', 320, clientTop + 13, { width: 225 });
  doc.font('Helvetica').fontSize(10).text(
    [invoice.billing_address, invoice.billing_vat && `Btw: ${invoice.billing_vat}`].filter(Boolean).join('\n'),
    { width: 225, lineGap: 1.5 },
  );

  // Gegevens
  const metaTop = 245;
  const meta: [string, string][] = [
    ['Datum', nlDate(invoice.invoice_date)],
    ['Vervaldatum', nlDate(invoice.due_date)],
    ['Periode', `${nlDate(invoice.period_start)} – ${nlDate(invoice.period_end)}`],
    ['Mededeling', structuredReference(invoice.number)],
  ];
  meta.forEach(([label, value], index) => {
    const y = metaTop + index * 15;
    doc.fontSize(9.5).fillColor(grey).text(label, left, y, { width: 90 });
    doc.fillColor('#000').text(value, left + 90, y, { width: 250 });
  });

  // Tabel
  let y = metaTop + 85;
  doc.rect(left, y, right - left, 22).fill('#eef5ee');
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(9.5);
  doc.text('Omschrijving', left + 8, y + 7);
  doc.text('Bedrag', right - 108, y + 7, { width: 100, align: 'right' });
  y += 30;
  doc.font('Helvetica').fontSize(10);
  const lines = invoiceLines(invoice);
  const rows: { description: string; price: number; discount: number; amount: number }[] = lines.length
    ? lines.map((l) => ({
        description: l.description || '',
        price: Number(l.price) || 0,
        discount: Number(l.discount) || 0,
        amount: Number(l.amount_excl ?? (Number(l.price) || 0) * (1 - (Number(l.discount) || 0) / 100)),
      }))
    : [
        (() => {
          const price = s.prices_include_vat ? Number(invoice.price) / (1 + Number(invoice.vat_rate) / 100) : Number(invoice.price);
          return { description: invoice.description || '', price, discount: Number(invoice.discount) || 0, amount: Number(invoice.total_excl) };
        })(),
      ];
  for (const row of rows) {
    const descHeight = doc.heightOfString(row.description, { width: 340 });
    doc.fillColor('#000').text(row.description, left + 8, y, { width: 340 });
    doc.text(money(round2(row.price)), right - 108, y, { width: 100, align: 'right' });
    y += Math.max(descHeight, 14) + 6;
    if (row.discount) {
      doc.fillColor(grey).text(`Korting ${row.discount}%`, left + 8, y, { width: 340 });
      doc.text(`– ${money(round2(row.price - row.amount))}`, right - 108, y, { width: 100, align: 'right' });
      doc.fillColor('#000');
      y += 20;
    }
  }
  doc.moveTo(left, y + 4).lineTo(right, y + 4).strokeColor('#dddddd').stroke();
  y += 14;

  const totalRow = (label: string, value: string, bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11.5 : 10);
    doc.text(label, right - 260, y, { width: 150, align: 'right' });
    doc.text(value, right - 108, y, { width: 100, align: 'right' });
    y += bold ? 20 : 16;
  };
  totalRow('Totaal excl. btw', money(invoice.total_excl));
  totalRow(`Btw ${Number(invoice.vat_rate)}%`, money(invoice.total_vat));
  totalRow('Te betalen', money(invoice.total_incl), true);
  if (s.vat_note) {
    doc.font('Helvetica').fontSize(9).fillColor(grey).text(s.vat_note, left, y + 4, { width: right - left });
    y += 20;
  }

  // Betaling
  y += 20;
  doc.rect(left, y, right - left, 74).fill('#f7f7f7');
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(10).text('Betaling', left + 12, y + 10);
  doc.font('Helvetica').fontSize(9.5).text(
    `Gelieve ${money(invoice.total_incl)} vóór ${nlDate(invoice.due_date)} over te schrijven op ${s.company_iban || '[IBAN invullen in Factuurinstellingen]'}${s.company_bic ? ` (BIC ${s.company_bic})` : ''} met de gestructureerde mededeling:`,
    left + 12,
    y + 25,
    { width: right - left - 24, lineGap: 1.5 },
  );
  doc.font('Helvetica-Bold').fontSize(10.5).text(structuredReference(invoice.number), { width: right - left - 24 });

  // Voet
  if (s.pdf_footer) {
    doc.fontSize(8.5).fillColor(grey).text(s.pdf_footer, left, 770, { width: right - left, align: 'center' });
  }

  doc.end();
  const buffer = await done;
  return { buffer, filename: `Proforma-${invoice.number}-${String(invoice.partner_name || '').replace(/[^\w-]+/g, '-')}.pdf`.replace(/-+\.pdf$/, '.pdf'), invoice };
};

// ---------- mail ----------

const escapeHtml = (value: string) =>
  value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

const textToHtml = (text: string) =>
  `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222">${escapeHtml(text)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
    .replace(/\n/g, '<br>')}</div>`;

/** Link naar de partnerpagina op de site (/logies/<slug>), Nederlandstalige versie bij voorkeur. */
const partnerPageUrl = async (strapi: Core.Strapi, invoice: any) => {
  if (!invoice.partner_document_id) return '';
  const rows = await strapi.db
    .query('api::partner.partner')
    .findMany({ where: { documentId: invoice.partner_document_id }, select: ['slug', 'locale', 'publishedAt'] });
  const pick =
    rows.find((r: any) => r.publishedAt && r.locale === 'nl') ||
    rows.find((r: any) => r.publishedAt) ||
    rows.find((r: any) => r.locale === 'nl') ||
    rows[0];
  return pick?.slug ? `${siteUrl()}/logies/${pick.slug}` : '';
};

const fillTemplate = (template: string, invoice: any, s: any, page = '') => {
  const values: Record<string, string> = {
    pagina: page || siteUrl(),
    nummer: String(invoice.number),
    naam: invoice.partner_name || '',
    pakket: invoice.package ? `het pakket ${invoice.package}` : 'je partnerpagina',
    periode: `${nlDate(invoice.period_start)} tot ${nlDate(invoice.period_end)}`,
    bedrag: money(invoice.total_incl),
    vervaldatum: nlDate(invoice.due_date),
    iban: s.company_iban || '[IBAN]',
    mededeling: structuredReference(invoice.number),
  };
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in values ? values[name] : match));
};

export const sendInvoiceMail = async (
  strapi: Core.Strapi,
  id: number,
  opts: { kind: 'invoice' | 'reminder'; testTo?: string; to?: string },
) => {
  const s = await getSettings(strapi);
  const { buffer, filename, invoice } = await renderPdf(strapi, id);
  if (invoice.status_invoice === 'geannuleerd') throw new Error('Deze proforma is geannuleerd');
  if (!s.company_iban && !opts.testTo) throw new Error('Vul eerst je IBAN en adres in onder Factuurinstellingen');

  const to = opts.testTo || opts.to || invoice.billing_email;
  if (!to) throw new Error('Geen e-mailadres: vul contact_email in bij het abonnement');

  const subjectTpl = opts.kind === 'reminder' ? s.reminder_subject : s.mail_subject;
  const bodyTpl = opts.kind === 'reminder' ? s.reminder_body : s.mail_body;
  const page = await partnerPageUrl(strapi, invoice);
  const subject = (opts.testTo ? '[TEST] ' : '') + fillTemplate(subjectTpl, invoice, s, page);
  const text = fillTemplate(bodyTpl, invoice, s, page);

  await strapi.plugin('email').service('email').send({
    to,
    ...(s.bcc_email && !opts.testTo ? { bcc: s.bcc_email } : {}),
    from: `${s.from_name} <${fromAddress()}>`,
    replyTo: replyTo(),
    subject,
    text,
    html: textToHtml(text),
    attachments: [{ filename, content: buffer, contentType: 'application/pdf' }],
  });

  if (!opts.testTo) {
    const now = new Date().toISOString();
    const data: any =
      opts.kind === 'reminder'
        ? {
            reminder_count: (invoice.reminder_count || 0) + 1,
            last_reminder_at: now,
            history: appendHistory(invoice.history, `Herinnering verstuurd naar ${to}`),
          }
        : {
            status_invoice: invoice.status_invoice === 'betaald' ? 'betaald' : 'verstuurd',
            sent_at: now,
            sent_to: to,
            billing_email: invoice.billing_email || to,
            history: appendHistory(invoice.history, `Verstuurd naar ${to}`),
          };
    await strapi.db.query(INVOICE).update({ where: { id }, data });
  }
  return { to, subject };
};

// ---------- online / offline ----------

/**
 * Partner offline halen of terug online zetten. De site toont een partner
 * enkel als het abonnement "active" of "expired" is, gestart is en de
 * einddatum niet voorbij is. Offline = status "paused" + einddatum gisteren.
 * Draft en gepubliceerde versie worden allebei aangepast.
 */
export const setSubscriptionOnline = async (strapi: Core.Strapi, documentId: string, online: boolean) => {
  const rows = await strapi.db.query(SUB).findMany({ where: { documentId } });
  if (!rows.length) throw new Error('Abonnement niet gevonden');
  const stampLine = stamp(online ? 'Terug online gezet' : 'Offline gehaald');
  for (const row of rows) {
    await strapi.db.query(SUB).update({
      where: { id: row.id },
      data: online
        ? { status_subscription: 'active', end_date: null, notes: [row.notes, stampLine].filter(Boolean).join('\n') }
        : { status_subscription: 'paused', end_date: addDays(today(), -1), notes: [row.notes, stampLine].filter(Boolean).join('\n') },
    });
  }
  return { documentId, online };
};


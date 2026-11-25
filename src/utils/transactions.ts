import type { Core } from '@strapi/strapi';
import { updateStatus } from './partner-invoicing';

// Bankbewegingen (menu "Financieel", zie src/admin/pages/Transactions.tsx).
// Bedragen worden altijd positief bewaard; "direction" (in/uit) bepaalt het teken.

const UID = 'api::transaction.transaction';
const INVOICE = 'api::partner-invoice.partner-invoice';

const round2 = (n: number) => Math.round(n * 100) / 100;

const toRow = (t: any) => ({
  id: t.id,
  number: t.number,
  date: t.date ? String(t.date).slice(0, 10) : null,
  title: t.title || '',
  direction: t.direction === 'uit' ? 'uit' : 'in',
  subtype: t.subtype || '',
  amount: Number(t.amount || 0),
  notes: t.notes || '',
  // Uit het oude systeem: factuurdatum, order-ID en bestandsnaam van het bewijsstuk.
  invoiceDate: t.invoice_date ? String(t.invoice_date).slice(0, 10) : null,
  orderId: t.order_id || null,
  attachment: t.attachment || '',
  invoiceId: t.invoice_id || null,
});

export const listTransactions = async (strapi: Core.Strapi) => {
  const rows = await strapi.db.query(UID).findMany({ orderBy: [{ date: 'desc' }, { number: 'desc' }] });
  const invoices = await strapi.db.query(INVOICE).findMany({
    select: ['id', 'number', 'partner_name', 'total_incl', 'status_invoice'],
    orderBy: { number: 'desc' },
  });
  const byId = new Map(invoices.map((i: any) => [i.id, i]));
  const items = rows.map((row: any) => {
    const tx: any = toRow(row);
    const inv: any = tx.invoiceId ? byId.get(tx.invoiceId) : null;
    tx.invoiceNumber = inv ? inv.number : null;
    return tx;
  });
  // Proforma's die nog op betaling wachten: om te koppelen bij een nieuwe inkomst.
  const openInvoices = invoices
    .filter((i: any) => i.status_invoice === 'concept' || i.status_invoice === 'verstuurd')
    .map((i: any) => ({ id: i.id, number: i.number, name: i.partner_name || '', total: Number(i.total_incl || 0) }));
  const balance = round2(items.reduce((sum, t) => sum + (t.direction === 'uit' ? -t.amount : t.amount), 0));
  const subtypes = [...new Set(items.map((t) => t.subtype).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'nl'));
  return { balance, subtypes, items, openInvoices };
};

const clean = (body: any) => {
  const date = String(body.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Geef een geldige datum');
  const title = String(body.title || '').trim();
  if (!title) throw new Error('Geef een titel');
  let amount = Number(String(body.amount ?? '').replace(',', '.'));
  if (!Number.isFinite(amount) || amount === 0) throw new Error('Geef een bedrag');
  let direction = body.direction === 'uit' ? 'uit' : 'in';
  // Negatief bedrag ingegeven = uitgave.
  if (amount < 0) {
    amount = -amount;
    direction = 'uit';
  }
  return {
    date,
    title,
    direction,
    subtype: String(body.subtype || '').trim() || null,
    amount: round2(amount),
    notes: String(body.notes || '').trim() || null,
  };
};

// Inkomst gekoppeld aan een proforma: de proforma gaat op "betaald" (met de
// datum van de transactie), waardoor ook het abonnement verlengd wordt. Het
// Octopus-nummer vul je daarna in bij Facturen ("Te boeken in Octopus").
const linkInvoice = async (strapi: Core.Strapi, data: any, invoiceId: unknown) => {
  if (invoiceId === undefined) return;
  const id = invoiceId ? Number(invoiceId) : null;
  if (!id) {
    data.invoice_id = null;
    return;
  }
  if (data.direction !== 'in') throw new Error('Enkel een inkomst kan aan een proforma gekoppeld worden');
  const invoice = await strapi.db.query(INVOICE).findOne({ where: { id } });
  if (!invoice) throw new Error('Proforma niet gevonden');
  if (invoice.status_invoice === 'geannuleerd') throw new Error(`Proforma ${invoice.number} is geannuleerd`);
  if (invoice.status_invoice !== 'betaald') {
    await updateStatus(strapi, id, { status: 'betaald', paidAt: data.date });
  }
  data.invoice_id = id;
};

export const createTransaction = async (strapi: Core.Strapi, body: any) => {
  const data: any = clean(body);
  await linkInvoice(strapi, data, body.invoiceId);
  const last = await strapi.db.query(UID).findOne({ orderBy: { number: 'desc' }, select: ['number'] });
  data.number = body.number ? Number(body.number) : (last?.number || 0) + 1;
  return toRow(await strapi.db.query(UID).create({ data }));
};

export const updateTransaction = async (strapi: Core.Strapi, id: number, body: any) => {
  const existing = await strapi.db.query(UID).findOne({ where: { id } });
  if (!existing) throw new Error('Transactie niet gevonden');
  const data: any = clean(body);
  // Al gekoppeld aan dezelfde proforma? Dan niets opnieuw op betaald zetten.
  if (body.invoiceId !== undefined && Number(body.invoiceId || 0) !== Number(existing.invoice_id || 0)) {
    await linkInvoice(strapi, data, body.invoiceId);
  }
  return toRow(await strapi.db.query(UID).update({ where: { id }, data }));
};

export const deleteTransaction = async (strapi: Core.Strapi, id: number) => {
  const existing = await strapi.db.query(UID).findOne({ where: { id } });
  if (!existing) throw new Error('Transactie niet gevonden');
  await strapi.db.query(UID).delete({ where: { id } });
  return { ok: true };
};

// Eenmalige import uit het oude systeem (tabel ZF_Transactions). Koppelt op het
// F-ID ("number"): bestaande nummers worden bijgewerkt, nieuwe aangemaakt.
// Mag dus veilig opnieuw gedraaid worden.
export const importTransactions = async (strapi: Core.Strapi, rows: any[]) => {
  if (!Array.isArray(rows) || !rows.length) throw new Error('Geen rijen ontvangen');
  if (rows.length > 1000) throw new Error('Maximaal 1000 rijen per keer');
  let created = 0;
  let updated = 0;
  const errors: string[] = [];
  for (const row of rows) {
    try {
      const number = Number(row.number);
      if (!Number.isInteger(number) || number <= 0) throw new Error('geen geldig F-ID');
      const data: any = {
        ...clean(row),
        number,
        invoice_date: /^\d{4}-\d{2}-\d{2}$/.test(String(row.invoice_date || '')) ? row.invoice_date : null,
        order_id: row.order_id ? Number(row.order_id) : null,
        attachment: row.attachment ? String(row.attachment).slice(0, 255) : null,
      };
      const existing = await strapi.db.query(UID).findOne({ where: { number } });
      if (existing) {
        await strapi.db.query(UID).update({ where: { id: existing.id }, data });
        updated += 1;
      } else {
        await strapi.db.query(UID).create({ data });
        created += 1;
      }
    } catch (error: any) {
      errors.push(`${row?.number ?? '?'}: ${error?.message || error}`);
    }
  }
  return { created, updated, errors };
};

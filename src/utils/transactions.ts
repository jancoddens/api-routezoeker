import type { Core } from '@strapi/strapi';

// Bankbewegingen (menu "Financieel", zie src/admin/pages/Transactions.tsx).
// Bedragen worden altijd positief bewaard; "direction" (in/uit) bepaalt het teken.

const UID = 'api::transaction.transaction';

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
});

export const listTransactions = async (strapi: Core.Strapi) => {
  const rows = await strapi.db.query(UID).findMany({ orderBy: [{ date: 'desc' }, { number: 'desc' }] });
  const items = rows.map(toRow);
  const balance = round2(items.reduce((sum, t) => sum + (t.direction === 'uit' ? -t.amount : t.amount), 0));
  const subtypes = [...new Set(items.map((t) => t.subtype).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'nl'));
  return { balance, subtypes, items };
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

export const createTransaction = async (strapi: Core.Strapi, body: any) => {
  const data: any = clean(body);
  const last = await strapi.db.query(UID).findOne({ orderBy: { number: 'desc' }, select: ['number'] });
  data.number = body.number ? Number(body.number) : (last?.number || 0) + 1;
  return toRow(await strapi.db.query(UID).create({ data }));
};

export const updateTransaction = async (strapi: Core.Strapi, id: number, body: any) => {
  const existing = await strapi.db.query(UID).findOne({ where: { id } });
  if (!existing) throw new Error('Transactie niet gevonden');
  return toRow(await strapi.db.query(UID).update({ where: { id }, data: clean(body) }));
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

import * as React from 'react';
import { Box } from '@strapi/design-system';

// Overzicht van wat je in Octopus moet boeken: klant, factuurgegevens, product, prijzen, referentie.
// Gebruikt in Financieel ("Te boeken") en Facturen ("Direct in Octopus").

export type InvoiceBooking = {
  number: number;
  reference: string;
  customer: string;
  address: string;
  vat: string;
  email: string;
  invoiceDate: string | null;
  dueDate: string | null;
  paidAt: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  lines: { description: string; amountExcl: number; discount: number }[];
  vatRate: number;
  totalExcl: number;
  totalVat: number;
  totalIncl: number;
};

export type TxBooking = {
  date: string | null;
  title: string;
  direction: 'in' | 'uit';
  subtype: string;
  amount: number;
  notes: string;
  invoiceDate?: string | null;
  orderId?: number | null;
  attachment?: string;
};

const money = (n?: number | null) =>
  n == null ? '–' : `€ ${Number(n).toLocaleString('nl-BE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const copy = (text: string) => {
  try {
    navigator.clipboard?.writeText(text);
  } catch {}
};

export const BookingDetails = ({ invoice, tx }: { invoice?: InvoiceBooking | null; tx?: TxBooking | null }) => {
  const rows: [string, string, boolean?][] = [];
  if (invoice) {
    rows.push(
      ['Klant', invoice.customer],
      ['Adres', invoice.address || '–'],
      ['Btw-nummer', invoice.vat || '–'],
      ['E-mail', invoice.email || '–'],
      ['Proforma', `${invoice.number} · ${invoice.invoiceDate || '–'}`],
      ['Vervaldatum', invoice.dueDate || '–'],
      ['Referentie', invoice.reference],
      ['Periode', `${invoice.periodStart || '–'} – ${invoice.periodEnd || '–'}`],
    );
    invoice.lines.forEach((l, n) =>
      rows.push([
        invoice.lines.length > 1 ? `Product ${n + 1}` : 'Product',
        `${l.description}${l.discount ? ` (-${l.discount}%)` : ''} · ${money(l.amountExcl)} excl.`,
      ]),
    );
    rows.push(
      ['Excl. btw', money(invoice.totalExcl)],
      [`Btw ${invoice.vatRate}%`, money(invoice.totalVat)],
      ['Incl. btw', money(invoice.totalIncl), true],
    );
    if (invoice.paidAt) rows.push(['Betaald op', invoice.paidAt]);
  }
  if (tx) {
    const sign = tx.direction === 'in' ? '+' : '-';
    if (invoice) {
      rows.push(['Op de rekening', `${tx.date || '–'} · ${sign} ${money(tx.amount)}`]);
    } else {
      rows.push(
        ['Datum', tx.date || '–'],
        ['Omschrijving', tx.title],
        ['Type', tx.direction === 'in' ? 'Inkomst' : 'Uitgave'],
        ['Subtype', tx.subtype || '–'],
        ['Bedrag', `${sign} ${money(tx.amount)}`, true],
      );
      if (tx.invoiceDate) rows.push(['Factuurdatum', tx.invoiceDate]);
      if (tx.attachment) rows.push(['Bewijsstuk', tx.attachment]);
      if (tx.orderId) rows.push(['Order', String(tx.orderId)]);
      if (tx.notes) rows.push(['Notitie', tx.notes]);
    }
  }

  return (
    <Box background="neutral100" padding={4} hasRadius>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
        <tbody>
          {rows.map(([label, value, strong]) => (
            <tr key={label}>
              <td style={{ padding: '4px 12px 4px 0', color: '#666687', verticalAlign: 'top', whiteSpace: 'nowrap' }}>{label}</td>
              <td style={{ padding: '4px 0', verticalAlign: 'top', whiteSpace: 'pre-line', fontWeight: strong ? 600 : undefined }}>
                {value}
              </td>
              <td style={{ padding: '4px 0 4px 8px', verticalAlign: 'top', textAlign: 'right' }}>
                {value && value !== '–' && (
                  <button
                    type="button"
                    title="Kopiëren"
                    onClick={() => copy(value)}
                    style={{ background: 'none', border: 0, cursor: 'pointer', color: '#4945ff', fontSize: 12 }}
                  >
                    kopieer
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Box>
  );
};

export default BookingDetails;

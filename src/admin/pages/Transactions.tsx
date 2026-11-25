import * as React from 'react';
import { Layouts, Page, useFetchClient, useNotification } from '@strapi/strapi/admin';
import {
  Badge,
  Box,
  Button,
  Field,
  Flex,
  Modal,
  Searchbar,
  SingleSelect,
  SingleSelectOption,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
  Typography,
} from '@strapi/design-system';
import { BookingDetails } from '../components/BookingDetails';

// Overzicht bankbewegingen (menu "Financieel"), zoals "Transactions overview" in het oude systeem.
// Alles wordt manueel ingegeven; het saldo is de som van alle inkomsten min uitgaven.

const API = '/transactions';

type Tx = {
  id: number;
  number: number | null;
  date: string | null;
  title: string;
  direction: 'in' | 'uit';
  subtype: string;
  amount: number;
  notes: string;
  invoiceDate?: string | null;
  orderId?: number | null;
  attachment?: string;
  invoiceId?: number | null;
  invoiceNumber?: number | null;
  octopusNumber?: string;
  bookedAt?: string | null;
  toBook?: boolean;
};

type OpenInvoice = { id: number; number: number; name: string; total: number };

type Data = { balance: number; subtypes: string[]; items: Tx[]; openInvoices: OpenInvoice[]; toBookCount: number };

type SortKey = 'number' | 'date' | 'title' | 'direction' | 'subtype' | 'amount';

const money = (n?: number | null) =>
  n == null ? '–' : `€ ${Number(n).toLocaleString('nl-BE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const today = () => new Date().toISOString().slice(0, 10);
const signed = (t: Tx) => (t.direction === 'uit' ? -t.amount : t.amount);

const TransactionsPage = () => {
  const { get, post, put, del } = useFetchClient();
  const { toggleNotification } = useNotification();
  const [data, setData] = React.useState<Data | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [search, setSearch] = React.useState('');
  const [perPage, setPerPage] = React.useState(25);
  const [page, setPage] = React.useState(1);
  const [sort, setSort] = React.useState<{ key: SortKey; asc: boolean }>({ key: 'date', asc: false });
  const [editing, setEditing] = React.useState<Partial<Tx> | null>(null);
  const [deleting, setDeleting] = React.useState<Tx | null>(null);
  const [booking, setBooking] = React.useState<Tx | null>(null);
  const [onlyToBook, setOnlyToBook] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const fail = (error: any, fallback: string) =>
    toggleNotification({ type: 'danger', message: error?.response?.data?.error?.message || error?.message || fallback });

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await get<any>(API);
      setData(res.data);
    } catch (error) {
      fail(error, 'Laden mislukt');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [get]);

  React.useEffect(() => {
    load();
  }, [load]);

  React.useEffect(() => setPage(1), [search, perPage, onlyToBook]);

  const q = search.trim().toLowerCase();
  const filtered = (data?.items || []).filter(
    (t) => (!onlyToBook || t.toBook) && (!q || `${t.number ?? ''} ${t.date} ${t.title} ${t.subtype} ${t.notes} ${t.amount} ${t.attachment || ''} ${t.octopusNumber || ''}`.toLowerCase().includes(q)),
  );
  const sorted = [...filtered].sort((a, b) => {
    const k = sort.key;
    const va: any = k === 'amount' ? signed(a) : (a as any)[k] ?? '';
    const vb: any = k === 'amount' ? signed(b) : (b as any)[k] ?? '';
    const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'nl');
    return (sort.asc ? cmp : -cmp) || (b.number || 0) - (a.number || 0);
  });
  const pages = Math.max(1, Math.ceil(sorted.length / perPage));
  const shown = sorted.slice((page - 1) * perPage, page * perPage);

  const year = today().slice(0, 4);
  const thisYear = (data?.items || []).filter((t) => String(t.date || '').startsWith(year));
  const inYear = thisYear.filter((t) => t.direction === 'in').reduce((s, t) => s + t.amount, 0);
  const outYear = thisYear.filter((t) => t.direction === 'uit').reduce((s, t) => s + t.amount, 0);
  const filteredTotal = filtered.reduce((s, t) => s + signed(t), 0);

  const save = async (tx: Partial<Tx>) => {
    setBusy(true);
    try {
      if (tx.id) await put(`${API}/${tx.id}`, tx);
      else await post(API, tx);
      toggleNotification({ type: 'success', message: tx.id ? 'Transactie aangepast' : 'Transactie toegevoegd' });
      setEditing(null);
      await load();
    } catch (error) {
      fail(error, 'Opslaan mislukt');
    } finally {
      setBusy(false);
    }
  };

  const book = async (tx: Tx, octopus: string) => {
    setBusy(true);
    try {
      await post(`${API}/${tx.id}/book`, { octopus });
      toggleNotification({ type: 'success', message: octopus ? `Geboekt in Octopus (${octopus})` : 'Terug op te boeken gezet' });
      setBooking(null);
      await load();
    } catch (error) {
      fail(error, 'Opslaan mislukt');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (tx: Tx) => {
    setBusy(true);
    try {
      await del(`${API}/${tx.id}`);
      toggleNotification({ type: 'success', message: 'Transactie verwijderd' });
      setDeleting(null);
      await load();
    } catch (error) {
      fail(error, 'Verwijderen mislukt');
    } finally {
      setBusy(false);
    }
  };

  const SortTh = ({ k, children }: { k: SortKey; children: React.ReactNode }) => (
    <Th>
      <button
        type="button"
        onClick={() => setSort((s) => ({ key: k, asc: s.key === k ? !s.asc : k === 'title' || k === 'subtype' }))}
        style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer' }}
      >
        <Typography variant="sigma" textColor="neutral600">
          {children} {sort.key === k ? (sort.asc ? '▲' : '▼') : ''}
        </Typography>
      </button>
    </Th>
  );

  return (
    <Page.Main>
      <Page.Title>Financieel</Page.Title>
      <Layouts.Header
        title="Transacties"
        subtitle="Bankbewegingen van Routezoeker (inkomsten en uitgaven)."
        primaryAction={
          <Button onClick={() => setEditing({ date: today(), direction: 'in' })}>+ Nieuwe transactie</Button>
        }
        secondaryAction={
          <Button variant="tertiary" onClick={load} loading={loading}>
            Vernieuwen
          </Button>
        }
      />
      <Layouts.Content>
        <Flex gap={4} marginBottom={6} wrap="wrap">
          <Kpi label="Saldo" value={money(data?.balance ?? null)} tone={(data?.balance || 0) < 0 ? 'danger' : undefined} />
          <Kpi label={`Inkomsten ${year}`} value={money(inYear)} />
          <Kpi label={`Uitgaven ${year}`} value={money(outYear)} />
          <Kpi label={`Resultaat ${year}`} value={money(inYear - outYear)} tone={inYear - outYear < 0 ? 'danger' : undefined} />
          <Kpi
            label="Te boeken in Octopus"
            value={String(data?.toBookCount ?? 0)}
            tone={data?.toBookCount ? 'danger' : undefined}
          />
        </Flex>

        <Flex justifyContent="space-between" alignItems="flex-end" gap={4} wrap="wrap" paddingBottom={4}>
          <Flex gap={2} alignItems="center">
            <Box width="90px">
              <SingleSelect
                aria-label="Per pagina"
                value={String(perPage)}
                onChange={(v: any) => setPerPage(Number(v))}
              >
                {[10, 25, 50, 100].map((n) => (
                  <SingleSelectOption key={n} value={String(n)}>
                    {n}
                  </SingleSelectOption>
                ))}
              </SingleSelect>
            </Box>
            <Typography textColor="neutral600">per pagina</Typography>
            <Button
              size="S"
              variant={onlyToBook ? 'secondary' : 'tertiary'}
              onClick={() => setOnlyToBook(!onlyToBook)}
            >
              Te boeken in Octopus ({data?.toBookCount ?? 0})
            </Button>
            {q && (
              <Typography textColor="neutral600">
                · {filtered.length} resultaten, totaal {money(filteredTotal)}
              </Typography>
            )}
          </Flex>
          <Box width="280px">
            <Searchbar
              name="search"
              value={search}
              onChange={(e: any) => setSearch(e.target.value)}
              onClear={() => setSearch('')}
              clearLabel="Wissen"
              placeholder="Zoeken…"
            >
              Zoeken
            </Searchbar>
          </Box>
        </Flex>

        <Table colCount={8} rowCount={shown.length + 1}>
          <Thead>
            <Tr>
              <SortTh k="number">F-ID</SortTh>
              <SortTh k="date">Datum</SortTh>
              <SortTh k="title">Titel</SortTh>
              <SortTh k="direction">Type</SortTh>
              <SortTh k="subtype">Subtype</SortTh>
              <SortTh k="amount">Bedrag</SortTh>
              <Th><Typography variant="sigma">Octopus</Typography></Th>
              <Th><Typography variant="sigma">Acties</Typography></Th>
            </Tr>
          </Thead>
          <Tbody>
            {shown.map((t) => (
              <Tr key={t.id}>
                <Td><Typography>{t.number ?? '–'}</Typography></Td>
                <Td><Typography>{t.date}</Typography></Td>
                <Td>
                  <Flex direction="column" alignItems="flex-start">
                    <Typography>{t.title}</Typography>
                    {t.notes && <Typography variant="pi" textColor="neutral500">{t.notes}</Typography>}
                    {t.invoiceNumber && (
                      <Typography variant="pi" textColor="success600">Proforma {t.invoiceNumber} (betaald)</Typography>
                    )}
                    {(t.attachment || t.orderId) && (
                      <Typography variant="pi" textColor="neutral500">
                        {[t.attachment && `Bewijsstuk: ${t.attachment}`, t.orderId && `order ${t.orderId}`].filter(Boolean).join(' · ')}
                      </Typography>
                    )}
                  </Flex>
                </Td>
                <Td>
                  {t.direction === 'in' ? (
                    <Badge backgroundColor="success100" textColor="success700">↑ In</Badge>
                  ) : (
                    <Badge backgroundColor="danger100" textColor="danger700">↓ Uit</Badge>
                  )}
                </Td>
                <Td><Typography>{t.subtype || '–'}</Typography></Td>
                <Td>
                  <Typography textColor={t.direction === 'in' ? 'success600' : 'danger600'} fontWeight="bold">
                    {t.direction === 'in' ? '+ ' : '- '}
                    {money(t.amount)}
                  </Typography>
                </Td>
                <Td>
                  {t.toBook ? (
                    <Button size="S" variant="danger-light" onClick={() => setBooking(t)}>Te boeken</Button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setBooking(t)}
                      style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer' }}
                      title="Octopus-nummer wijzigen"
                    >
                      <Typography variant="pi" textColor="success600">
                        ✓ {t.octopusNumber || 'geboekt'}
                      </Typography>
                    </button>
                  )}
                </Td>
                <Td>
                  <Flex gap={2}>
                    <Button size="S" variant="secondary" onClick={() => setEditing(t)}>Bewerken</Button>
                    <Button size="S" variant="danger-light" onClick={() => setDeleting(t)}>Verwijderen</Button>
                  </Flex>
                </Td>
              </Tr>
            ))}
            {!shown.length && (
              <Tr>
                <Td colSpan={8}>
                  <Box padding={4}>
                    <Typography textColor="neutral600">{loading ? 'Laden…' : 'Geen transacties gevonden.'}</Typography>
                  </Box>
                </Td>
              </Tr>
            )}
          </Tbody>
        </Table>

        {pages > 1 && (
          <Flex justifyContent="space-between" paddingTop={4}>
            <Typography textColor="neutral600">
              {(page - 1) * perPage + 1}–{Math.min(page * perPage, sorted.length)} van {sorted.length}
            </Typography>
            <Flex gap={2}>
              <Button size="S" variant="tertiary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Vorige</Button>
              <Typography>
                {page} / {pages}
              </Typography>
              <Button size="S" variant="tertiary" disabled={page >= pages} onClick={() => setPage(page + 1)}>Volgende</Button>
            </Flex>
          </Flex>
        )}
      </Layouts.Content>

      {editing && (
        <EditDialog
          tx={editing}
          subtypes={data?.subtypes || []}
          openInvoices={data?.openInvoices || []}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      )}

      {booking && <BookDialog tx={booking} busy={busy} onClose={() => setBooking(null)} onSave={book} />}

      {deleting && (
        <Modal.Root open onOpenChange={(open: boolean) => !open && setDeleting(null)}>
          <Modal.Content>
            <Modal.Header>
              <Modal.Title>Transactie {deleting.number ?? ''} verwijderen?</Modal.Title>
            </Modal.Header>
            <Modal.Body>
              <Typography>
                {deleting.date} · {deleting.title} · {deleting.direction === 'in' ? '+' : '-'} {money(deleting.amount)}. Dit kan
                niet ongedaan gemaakt worden.
              </Typography>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="tertiary" onClick={() => setDeleting(null)}>Annuleren</Button>
              <Button variant="danger" loading={busy} onClick={() => remove(deleting)}>Verwijderen</Button>
            </Modal.Footer>
          </Modal.Content>
        </Modal.Root>
      )}
    </Page.Main>
  );
};

const EditDialog = ({
  tx,
  subtypes,
  openInvoices,
  busy,
  onClose,
  onSave,
}: {
  tx: Partial<Tx>;
  subtypes: string[];
  openInvoices: OpenInvoice[];
  busy: boolean;
  onClose: () => void;
  onSave: (tx: Partial<Tx>) => void;
}) => {
  const [date, setDate] = React.useState(tx.date || today());
  const [title, setTitle] = React.useState(tx.title || '');
  const [direction, setDirection] = React.useState<'in' | 'uit'>(tx.direction || 'in');
  const [subtype, setSubtype] = React.useState(tx.subtype || '');
  const [amount, setAmount] = React.useState(tx.amount != null ? String(tx.amount) : '');
  const [notes, setNotes] = React.useState(tx.notes || '');
  const [invoiceId, setInvoiceId] = React.useState(tx.invoiceId ? String(tx.invoiceId) : '');
  const amountNum = Number(amount.replace(',', '.')) || 0;
  // Proforma's met hetzelfde bedrag eerst.
  const invoiceOptions = [...openInvoices].sort(
    (a, b) => Number(Math.abs(b.total - amountNum) < 0.01) - Number(Math.abs(a.total - amountNum) < 0.01) || b.number - a.number,
  );
  const pickInvoice = (value: string) => {
    setInvoiceId(value);
    const inv = openInvoices.find((i) => String(i.id) === value);
    if (inv) {
      if (!title.trim()) setTitle(inv.name);
      if (!amount) setAmount(String(inv.total));
      if (!subtype) setSubtype('Logie');
    }
  };

  return (
    <Modal.Root open onOpenChange={(open: boolean) => !open && onClose()}>
      <Modal.Content>
        <Modal.Header>
          <Modal.Title>{tx.id ? `Transactie ${tx.number ?? ''} bewerken` : 'Nieuwe transactie'}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Flex direction="column" gap={4} alignItems="stretch">
            <Flex gap={2}>
              <Button variant={direction === 'in' ? 'success' : 'tertiary'} onClick={() => setDirection('in')}>↑ Inkomst</Button>
              <Button variant={direction === 'uit' ? 'danger' : 'tertiary'} onClick={() => setDirection('uit')}>↓ Uitgave</Button>
            </Flex>
            <Flex gap={4}>
              <Field.Root name="date" width="50%">
                <Field.Label>Datum</Field.Label>
                <Field.Input type="date" value={date} onChange={(e: any) => setDate(e.target.value)} />
              </Field.Root>
              <Field.Root name="amount" width="50%" hint="Positief bedrag, bv. 119,79">
                <Field.Label>Bedrag (€)</Field.Label>
                <Field.Input inputMode="decimal" value={amount} onChange={(e: any) => setAmount(e.target.value)} />
                <Field.Hint />
              </Field.Root>
            </Flex>
            <Field.Root name="title" hint="Bv. naam van de partner of de omschrijving op het uittreksel">
              <Field.Label>Titel</Field.Label>
              <Field.Input value={title} onChange={(e: any) => setTitle(e.target.value)} />
              <Field.Hint />
            </Field.Root>
            <Field.Root name="subtype" hint="Kies een bestaand subtype of typ een nieuw">
              <Field.Label>Subtype</Field.Label>
              <Field.Input list="tx-subtypes" value={subtype} onChange={(e: any) => setSubtype(e.target.value)} />
              <datalist id="tx-subtypes">
                {subtypes.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
              <Field.Hint />
            </Field.Root>
            {direction === 'in' && !tx.invoiceId && (
              <Field.Root
                name="invoice"
                hint="Kies je een proforma, dan gaat die op betaald en wordt het abonnement verlengd. Daarna staat hij bij Facturen als 'Te boeken in Octopus'."
              >
                <Field.Label>Betaling van proforma (optioneel)</Field.Label>
                <SingleSelect
                  value={invoiceId}
                  placeholder="Geen proforma"
                  onClear={() => setInvoiceId('')}
                  onChange={(v: any) => pickInvoice(String(v))}
                >
                  {invoiceOptions.map((i) => (
                    <SingleSelectOption key={i.id} value={String(i.id)}>
                      {`${i.number} · ${i.name} · ${money(i.total)}${amountNum && Math.abs(i.total - amountNum) < 0.01 ? ' ✓ zelfde bedrag' : ''}`}
                    </SingleSelectOption>
                  ))}
                </SingleSelect>
                <Field.Hint />
              </Field.Root>
            )}
            {tx.invoiceNumber && (
              <Typography variant="omega" textColor="success600">Gekoppeld aan proforma {tx.invoiceNumber} (betaald).</Typography>
            )}
            <Field.Root name="notes">
              <Field.Label>Notitie (optioneel)</Field.Label>
              <Field.Input value={notes} onChange={(e: any) => setNotes(e.target.value)} />
            </Field.Root>
          </Flex>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="tertiary" onClick={onClose}>Annuleren</Button>
          <Button
            loading={busy}
            disabled={!date || !title.trim() || !amount}
            onClick={() =>
              onSave({
                id: tx.id,
                date,
                title,
                direction,
                subtype,
                amount: amount.replace(',', '.') as any,
                notes,
                ...(!tx.invoiceId && invoiceId && direction === 'in' ? { invoiceId: Number(invoiceId) } : {}),
              } as any)
            }
          >
            Opslaan
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
};

const BookDialog = ({
  tx,
  busy,
  onClose,
  onSave,
}: {
  tx: Tx;
  busy: boolean;
  onClose: () => void;
  onSave: (tx: Tx, octopus: string) => void;
}) => {
  const { get } = useFetchClient();
  const [octopus, setOctopus] = React.useState(tx.octopusNumber || '');
  const [info, setInfo] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    get<any>(`${API}/${tx.id}/booking`)
      .then((res) => setInfo(res.data))
      .catch(() => setInfo(null))
      .finally(() => setLoading(false));
  }, [get, tx.id]);

  const inv = info?.invoice;

  return (
    <Modal.Root open onOpenChange={(open: boolean) => !open && onClose()}>
      <Modal.Content>
        <Modal.Header>
          <Modal.Title>Boeken in Octopus – F-ID {tx.number ?? ''}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Flex direction="column" gap={4} alignItems="stretch">
            {loading ? (
              <Typography textColor="neutral600">Gegevens laden…</Typography>
            ) : (
              <BookingDetails invoice={inv} tx={tx} />
            )}
            {!loading && !inv && tx.direction === 'in' && (
              <Typography variant="pi" textColor="neutral600">
                Niet gekoppeld aan een proforma: klantgegevens en btw-opsplitsing zijn niet gekend.
              </Typography>
            )}
            <Field.Root
              name="octopus"
              hint={inv ? `Wordt ook bij proforma ${inv.number} ingevuld.` : 'Het boekingsnummer of factuurnummer in Octopus.'}
            >
              <Field.Label>Octopus-nummer</Field.Label>
              <Field.Input value={octopus} onChange={(e: any) => setOctopus(e.target.value)} />
              <Field.Hint />
            </Field.Root>
          </Flex>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="tertiary" onClick={onClose}>Annuleren</Button>
          <Flex gap={2}>
            {!tx.toBook && (
              <Button variant="danger-light" loading={busy} onClick={() => onSave(tx, '')}>Terug op te boeken</Button>
            )}
            <Button loading={busy} disabled={!octopus.trim()} onClick={() => onSave(tx, octopus.trim())}>Geboekt</Button>
          </Flex>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
};

const Kpi = ({ label, value, tone }: { label: string; value: string; tone?: 'danger' }) => (
  <Box background="neutral0" padding={4} hasRadius shadow="tableShadow" minWidth="200px">
    <Typography variant="sigma" textColor="neutral600">{label}</Typography>
    <Box paddingTop={1}>
      <Typography variant="beta" textColor={tone === 'danger' ? 'danger600' : 'neutral800'}>{value}</Typography>
    </Box>
  </Box>
);

export default TransactionsPage;

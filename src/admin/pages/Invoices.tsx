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
  Table,
  Tabs,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
  Typography,
} from '@strapi/design-system';

// Overzicht facturatie partnerabonnementen (menu "Facturen").
// Proforma's maken, mailen, herinneren en als betaald markeren.
// De officiële factuur maak je in Octopus; noteer het nummer bij "Betaald".

const API = '/partner-invoicing';

type Sub = {
  documentId: string;
  id: number;
  name: string;
  package?: string;
  status?: string;
  firstRun?: string;
  lastRun?: string;
  nextRun?: string;
  price: number | null;
  discount: number;
  count: number;
  email: string;
  due: boolean;
  overdue: boolean;
  openInvoices: number;
  latestInvoice: null | { id: number; number: number; status: string; total: number; dueDate?: string; sentAt?: string };
};

type Invoice = {
  id: number;
  number: number;
  status: string;
  name: string;
  invoiceDate?: string;
  dueDate?: string;
  periodStart?: string;
  periodEnd?: string;
  total: number;
  sentAt?: string;
  sentTo?: string;
  paidAt?: string;
  reminders: number;
  octopus?: string;
  overdue?: boolean;
  email?: string;
};

type Overview = {
  today: string;
  settings: { vat_rate: number; prices_include_vat: boolean; period_months: number; complete: boolean };
  subscriptions: Sub[];
  invoices: Invoice[];
};

const money = (n?: number | null) =>
  n == null ? '–' : `€ ${Number(n).toLocaleString('nl-BE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const d = (s?: string | null) => (s ? String(s).slice(0, 10) : '–');

const STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  concept: { bg: 'neutral150', fg: 'neutral700' },
  verstuurd: { bg: 'warning100', fg: 'warning700' },
  betaald: { bg: 'success100', fg: 'success700' },
  geannuleerd: { bg: 'danger100', fg: 'danger700' },
  active: { bg: 'success100', fg: 'success700' },
  paused: { bg: 'warning100', fg: 'warning700' },
  expired: { bg: 'danger100', fg: 'danger700' },
  draft: { bg: 'neutral150', fg: 'neutral700' },
};

const StatusBadge = ({ status, label }: { status?: string; label?: string }) => {
  const c = STATUS_COLORS[status || ''] || STATUS_COLORS.concept;
  return (
    <Badge backgroundColor={c.bg} textColor={c.fg}>
      {label || status || '–'}
    </Badge>
  );
};

type Dialog =
  | { type: 'create'; sub: Sub }
  | { type: 'send'; invoice: Invoice; kind: 'invoice' | 'reminder'; email?: string }
  | { type: 'paid'; invoice: Invoice }
  | { type: 'cancel'; invoice: Invoice }
  | { type: 'online'; sub: Sub; online: boolean }
  | null;

const InvoicesPage = () => {
  const { get, post } = useFetchClient();
  const { toggleNotification } = useNotification();
  const [data, setData] = React.useState<Overview | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [tab, setTab] = React.useState('subs');
  const [filter, setFilter] = React.useState<'all' | 'due' | 'active' | 'offline'>('due');
  const [invoiceFilter, setInvoiceFilter] = React.useState<'open' | 'all'>('open');
  const [search, setSearch] = React.useState('');
  const [dialog, setDialog] = React.useState<Dialog>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await get<any>(`${API}/overview`);
      setData(res.data);
    } catch (error: any) {
      toggleNotification({ type: 'danger', message: error?.response?.data?.error?.message || 'Laden mislukt' });
    } finally {
      setLoading(false);
    }
  }, [get, toggleNotification]);

  React.useEffect(() => {
    load();
  }, [load]);

  const fail = (error: any, fallback: string) =>
    toggleNotification({ type: 'danger', message: error?.response?.data?.error?.message || error?.message || fallback });

  const openPdf = async (id: number) => {
    // Eerst een leeg venster openen (anders blokkeert de popup-blocker het).
    const win = window.open('', '_blank');
    try {
      const res = await get<any>(`${API}/invoices/${id}/pdf`);
      const bytes = Uint8Array.from(atob(res.data.base64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      if (win) win.location.href = url;
      else window.location.href = url;
    } catch (error) {
      win?.close();
      fail(error, 'PDF maken mislukt');
    }
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      setDialog(null);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const q = search.trim().toLowerCase();
  const subs = (data?.subscriptions || []).filter((s) => {
    if (q && !`${s.id} ${s.name} ${s.email} ${s.package}`.toLowerCase().includes(q)) return false;
    if (filter === 'due') return s.due;
    if (filter === 'active') return s.status === 'active';
    if (filter === 'offline') return s.status === 'paused';
    return true;
  });
  const invoices = (data?.invoices || []).filter((i) => {
    if (q && !`${i.number} ${i.name} ${i.octopus || ''}`.toLowerCase().includes(q)) return false;
    if (invoiceFilter === 'open') return i.status === 'concept' || i.status === 'verstuurd';
    return true;
  });

  const dueCount = (data?.subscriptions || []).filter((s) => s.due).length;
  const openInvoices = (data?.invoices || []).filter((i) => i.status === 'concept' || i.status === 'verstuurd');
  const openTotal = openInvoices.reduce((sum, i) => sum + i.total, 0);
  const overdueCount = openInvoices.filter((i) => i.overdue).length;
  const year = (data?.today || '').slice(0, 4);
  const paidThisYear = (data?.invoices || [])
    .filter((i) => i.status === 'betaald' && String(i.paidAt || '').startsWith(year))
    .reduce((sum, i) => sum + i.total, 0);

  return (
    <Page.Main>
      <Page.Title>Facturen partners</Page.Title>
      <Layouts.Header
        title="Facturen partners"
        subtitle="Proforma's voor partnerabonnementen. De officiële factuur maak je in Octopus."
        primaryAction={
          <Button variant="tertiary" onClick={load} loading={loading}>
            Vernieuwen
          </Button>
        }
      />
      <Layouts.Content>
        {data && !data.settings.complete && (
          <Box background="warning100" padding={4} marginBottom={4} hasRadius>
            <Typography textColor="warning700">
              Vul eerst je adres en IBAN in onder Content Manager › Factuurinstellingen, anders kan je geen proforma's
              versturen.
            </Typography>
          </Box>
        )}

        <Flex gap={4} marginBottom={6} wrap="wrap">
          <Kpi label="Te factureren (30 dagen)" value={String(dueCount)} />
          <Kpi label="Openstaande proforma's" value={`${openInvoices.length} · ${money(openTotal)}`} />
          <Kpi label="Over vervaldatum" value={String(overdueCount)} tone={overdueCount ? 'danger' : undefined} />
          <Kpi label={`Betaald in ${year}`} value={money(paidThisYear)} />
        </Flex>

        <Tabs.Root value={tab} onValueChange={setTab}>
          <Flex justifyContent="space-between" alignItems="flex-end" gap={4} wrap="wrap">
            <Tabs.List aria-label="Facturen">
              <Tabs.Trigger value="subs">Abonnementen</Tabs.Trigger>
              <Tabs.Trigger value="invoices">Proforma's</Tabs.Trigger>
            </Tabs.List>
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

          <Tabs.Content value="subs">
            <Flex gap={2} paddingTop={4} paddingBottom={4}>
              <FilterButton active={filter === 'due'} onClick={() => setFilter('due')}>
                Te factureren ({dueCount})
              </FilterButton>
              <FilterButton active={filter === 'active'} onClick={() => setFilter('active')}>
                Actief
              </FilterButton>
              <FilterButton active={filter === 'offline'} onClick={() => setFilter('offline')}>
                Offline
              </FilterButton>
              <FilterButton active={filter === 'all'} onClick={() => setFilter('all')}>
                Alles ({data?.subscriptions.length || 0})
              </FilterButton>
            </Flex>
            <Table colCount={11} rowCount={subs.length + 1}>
              <Thead>
                <Tr>
                  <Th><Typography variant="sigma">ID</Typography></Th>
                  <Th><Typography variant="sigma">Naam</Typography></Th>
                  <Th><Typography variant="sigma">Pakket</Typography></Th>
                  <Th><Typography variant="sigma">First run</Typography></Th>
                  <Th><Typography variant="sigma">Next run</Typography></Th>
                  <Th><Typography variant="sigma">Last run</Typography></Th>
                  <Th><Typography variant="sigma">Status</Typography></Th>
                  <Th><Typography variant="sigma">Bedrag</Typography></Th>
                  <Th><Typography variant="sigma">Count</Typography></Th>
                  <Th><Typography variant="sigma">Proforma</Typography></Th>
                  <Th><Typography variant="sigma">Acties</Typography></Th>
                </Tr>
              </Thead>
              <Tbody>
                {subs.map((s) => (
                  <Tr key={s.documentId}>
                    <Td><Typography>{s.id}</Typography></Td>
                    <Td>
                      <Flex direction="column" alignItems="flex-start">
                        <Typography fontWeight="bold">{s.name}</Typography>
                        <Typography variant="pi" textColor={s.email ? 'neutral600' : 'danger600'}>
                          {s.email || 'geen e-mailadres'}
                        </Typography>
                      </Flex>
                    </Td>
                    <Td><Typography>{s.package || '–'}</Typography></Td>
                    <Td><Typography>{d(s.firstRun)}</Typography></Td>
                    <Td>
                      <Typography textColor={s.overdue ? 'danger600' : s.due ? 'warning600' : undefined} fontWeight={s.due ? 'bold' : undefined}>
                        {d(s.nextRun)}
                      </Typography>
                    </Td>
                    <Td><Typography>{d(s.lastRun)}</Typography></Td>
                    <Td><StatusBadge status={s.status} /></Td>
                    <Td>
                      <Typography>
                        {money(s.price)}
                        {s.discount ? ` (-${s.discount}%)` : ''}
                      </Typography>
                    </Td>
                    <Td><Typography>{s.count}</Typography></Td>
                    <Td>
                      {s.latestInvoice ? (
                        <Flex gap={2}>
                          <Button variant="ghost" size="S" onClick={() => openPdf(s.latestInvoice!.id)}>
                            Bekijk ({s.latestInvoice.number})
                          </Button>
                          <StatusBadge status={s.latestInvoice.status} />
                        </Flex>
                      ) : (
                        <Typography textColor="neutral500">–</Typography>
                      )}
                    </Td>
                    <Td>
                      <Flex gap={1}>
                        <Button size="S" variant={s.due ? 'default' : 'secondary'} onClick={() => setDialog({ type: 'create', sub: s })}>
                          Nieuwe proforma
                        </Button>
                        {s.status === 'paused' ? (
                          <Button size="S" variant="success-light" onClick={() => setDialog({ type: 'online', sub: s, online: true })}>
                            Online zetten
                          </Button>
                        ) : (
                          <Button size="S" variant="danger-light" onClick={() => setDialog({ type: 'online', sub: s, online: false })}>
                            Offline
                          </Button>
                        )}
                      </Flex>
                    </Td>
                  </Tr>
                ))}
                {!subs.length && (
                  <Tr>
                    <Td colSpan={11}>
                      <Box padding={4}>
                        <Typography textColor="neutral600">
                          {loading ? 'Laden…' : filter === 'due' ? 'Niets te factureren in de komende 30 dagen.' : 'Geen abonnementen gevonden.'}
                        </Typography>
                      </Box>
                    </Td>
                  </Tr>
                )}
              </Tbody>
            </Table>
          </Tabs.Content>

          <Tabs.Content value="invoices">
            <Flex gap={2} paddingTop={4} paddingBottom={4}>
              <FilterButton active={invoiceFilter === 'open'} onClick={() => setInvoiceFilter('open')}>
                Open ({openInvoices.length})
              </FilterButton>
              <FilterButton active={invoiceFilter === 'all'} onClick={() => setInvoiceFilter('all')}>
                Alles ({data?.invoices.length || 0})
              </FilterButton>
            </Flex>
            <Table colCount={9} rowCount={invoices.length + 1}>
              <Thead>
                <Tr>
                  <Th><Typography variant="sigma">Nr</Typography></Th>
                  <Th><Typography variant="sigma">Partner</Typography></Th>
                  <Th><Typography variant="sigma">Datum</Typography></Th>
                  <Th><Typography variant="sigma">Vervaldatum</Typography></Th>
                  <Th><Typography variant="sigma">Bedrag</Typography></Th>
                  <Th><Typography variant="sigma">Status</Typography></Th>
                  <Th><Typography variant="sigma">Verstuurd</Typography></Th>
                  <Th><Typography variant="sigma">Octopus</Typography></Th>
                  <Th><Typography variant="sigma">Acties</Typography></Th>
                </Tr>
              </Thead>
              <Tbody>
                {invoices.map((i) => (
                  <Tr key={i.id}>
                    <Td><Typography fontWeight="bold">{i.number}</Typography></Td>
                    <Td>
                      <Flex direction="column" alignItems="flex-start">
                        <Typography>{i.name}</Typography>
                        <Typography variant="pi" textColor="neutral600">
                          {d(i.periodStart)} – {d(i.periodEnd)}
                        </Typography>
                      </Flex>
                    </Td>
                    <Td><Typography>{d(i.invoiceDate)}</Typography></Td>
                    <Td>
                      <Typography textColor={i.overdue ? 'danger600' : undefined} fontWeight={i.overdue ? 'bold' : undefined}>
                        {d(i.dueDate)}
                      </Typography>
                    </Td>
                    <Td><Typography>{money(i.total)}</Typography></Td>
                    <Td>
                      <Flex gap={1}>
                        <StatusBadge status={i.status} />
                        {i.reminders > 0 && <Badge>{i.reminders}× herinnerd</Badge>}
                      </Flex>
                    </Td>
                    <Td>
                      <Typography variant="pi">{i.sentAt ? `${d(i.sentAt)} · ${i.sentTo || ''}` : '–'}</Typography>
                    </Td>
                    <Td>
                      <Typography variant="pi">
                        {i.octopus || '–'}
                        {i.paidAt ? ` · betaald ${d(i.paidAt)}` : ''}
                      </Typography>
                    </Td>
                    <Td>
                      <Flex gap={1} wrap="wrap">
                        <Button size="S" variant="ghost" onClick={() => openPdf(i.id)}>Bekijk</Button>
                        {i.status === 'concept' && (
                          <Button size="S" onClick={() => setDialog({ type: 'send', invoice: i, kind: 'invoice' })}>Mail</Button>
                        )}
                        {i.status === 'verstuurd' && (
                          <Button size="S" variant="secondary" onClick={() => setDialog({ type: 'send', invoice: i, kind: 'reminder' })}>
                            Herinnering
                          </Button>
                        )}
                        {(i.status === 'concept' || i.status === 'verstuurd') && (
                          <>
                            <Button size="S" variant="success-light" onClick={() => setDialog({ type: 'paid', invoice: i })}>Betaald</Button>
                            <Button size="S" variant="danger-light" onClick={() => setDialog({ type: 'cancel', invoice: i })}>Annuleer</Button>
                          </>
                        )}
                        {i.status === 'betaald' && (
                          <Button size="S" variant="tertiary" onClick={() => setDialog({ type: 'paid', invoice: i })}>Octopus-nr</Button>
                        )}
                      </Flex>
                    </Td>
                  </Tr>
                ))}
                {!invoices.length && (
                  <Tr>
                    <Td colSpan={9}>
                      <Box padding={4}>
                        <Typography textColor="neutral600">{loading ? 'Laden…' : "Geen proforma's."}</Typography>
                      </Box>
                    </Td>
                  </Tr>
                )}
              </Tbody>
            </Table>
          </Tabs.Content>
        </Tabs.Root>
      </Layouts.Content>

      {dialog?.type === 'create' && (
        <CreateDialog
          sub={dialog.sub}
          settings={data?.settings}
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={async (body, sendAfter) => {
            setBusy(true);
            try {
              const res = await post<any>(`${API}/invoices`, body);
              toggleNotification({ type: 'success', message: `Proforma ${res.data.number} aangemaakt` });
              setTab('invoices');
              await load();
              setDialog(
                sendAfter
                  ? {
                      type: 'send',
                      kind: 'invoice',
                      invoice: { id: res.data.id, number: res.data.number, status: 'concept', name: dialog.sub.name, email: res.data.billing_email, total: Number(res.data.total_incl), reminders: 0 },
                    }
                  : null,
              );
            } catch (error) {
              fail(error, 'Aanmaken mislukt');
            } finally {
              setBusy(false);
            }
          }}
        />
      )}

      {dialog?.type === 'send' && (
        <SendDialog
          invoice={dialog.invoice}
          kind={dialog.kind}
          busy={busy}
          onClose={() => setDialog(null)}
          onTest={async () => {
            setBusy(true);
            try {
              const res = await post<any>(`${API}/invoices/${dialog.invoice.id}/send`, { kind: dialog.kind, test: true });
              toggleNotification({ type: 'success', message: `Testmail verstuurd naar ${res.data.to}` });
            } catch (error) {
              fail(error, 'Testmail mislukt');
            } finally {
              setBusy(false);
            }
          }}
          onSend={(to) =>
            run(async () => {
              try {
                const res = await post<any>(`${API}/invoices/${dialog.invoice.id}/send`, { kind: dialog.kind, to });
                toggleNotification({ type: 'success', message: `Verstuurd naar ${res.data.to}` });
              } catch (error) {
                fail(error, 'Versturen mislukt');
                throw error;
              }
            }).catch(() => {})
          }
        />
      )}

      {dialog?.type === 'paid' && (
        <PaidDialog
          invoice={dialog.invoice}
          today={data?.today || ''}
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={(paidAt, octopus) =>
            run(async () => {
              try {
                await post<any>(`${API}/invoices/${dialog.invoice.id}/status`, { status: 'betaald', paidAt, octopus });
                toggleNotification({ type: 'success', message: `Proforma ${dialog.invoice.number} op betaald gezet` });
              } catch (error) {
                fail(error, 'Opslaan mislukt');
                throw error;
              }
            }).catch(() => {})
          }
        />
      )}

      {dialog?.type === 'online' && (
        <Modal.Root open onOpenChange={(open: boolean) => !open && setDialog(null)}>
          <Modal.Content>
            <Modal.Header>
              <Modal.Title>
                {dialog.sub.name} {dialog.online ? 'terug online zetten?' : 'offline halen?'}
              </Modal.Title>
            </Modal.Header>
            <Modal.Body>
              <Typography>
                {dialog.online
                  ? 'Het abonnement gaat terug op "active" en de einddatum wordt gewist. De partnerpagina en de vermeldingen bij de routes komen terug op de site.'
                  : 'Het abonnement gaat op "paused" met einddatum gisteren. De partnerpagina verdwijnt van de site (geeft een 404) en de partner staat niet meer bij de routes, op de logiespagina en in de sitemap. Openstaande proforma\'s blijven staan; annuleer ze zelf als ze niet meer betaald moeten worden.'}
              </Typography>
              <Box paddingTop={3}>
                <Typography variant="pi" textColor="neutral600">
                  De site ververst haar gegevens om het half uur, dus het kan tot 30 minuten duren voor je het ziet.
                </Typography>
              </Box>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="tertiary" onClick={() => setDialog(null)}>Terug</Button>
              <Button
                variant={dialog.online ? 'success' : 'danger'}
                loading={busy}
                onClick={() =>
                  run(async () => {
                    try {
                      await post<any>(`${API}/subscriptions/${dialog.sub.documentId}/online`, { online: dialog.online });
                      toggleNotification({ type: 'success', message: `${dialog.sub.name} is ${dialog.online ? 'terug online' : 'offline gehaald'}` });
                    } catch (error) {
                      fail(error, 'Aanpassen mislukt');
                      throw error;
                    }
                  }).catch(() => {})
                }
              >
                {dialog.online ? 'Online zetten' : 'Offline halen'}
              </Button>
            </Modal.Footer>
          </Modal.Content>
        </Modal.Root>
      )}

      {dialog?.type === 'cancel' && (
        <Modal.Root open onOpenChange={(open: boolean) => !open && setDialog(null)}>
          <Modal.Content>
            <Modal.Header>
              <Modal.Title>Proforma {dialog.invoice.number} annuleren?</Modal.Title>
            </Modal.Header>
            <Modal.Body>
              <Typography>
                De proforma blijft bewaard met status "geannuleerd". Was ze al betaald en het abonnement verlengd, dan wordt die
                verlenging teruggedraaid (last run en count).
              </Typography>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="tertiary" onClick={() => setDialog(null)}>Terug</Button>
              <Button
                variant="danger"
                loading={busy}
                onClick={() =>
                  run(async () => {
                    try {
                      await post<any>(`${API}/invoices/${dialog.invoice.id}/status`, { status: 'geannuleerd' });
                      toggleNotification({ type: 'success', message: `Proforma ${dialog.invoice.number} geannuleerd` });
                    } catch (error) {
                      fail(error, 'Annuleren mislukt');
                      throw error;
                    }
                  }).catch(() => {})
                }
              >
                Annuleren
              </Button>
            </Modal.Footer>
          </Modal.Content>
        </Modal.Root>
      )}
    </Page.Main>
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

const FilterButton = ({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) => (
  <Button size="S" variant={active ? 'secondary' : 'tertiary'} onClick={onClick}>
    {children}
  </Button>
);

const CreateDialog = ({
  sub,
  settings,
  busy,
  onClose,
  onSubmit,
}: {
  sub: Sub;
  settings?: Overview['settings'];
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: any, sendAfter: boolean) => void;
}) => {
  const [price, setPrice] = React.useState(sub.price != null ? String(sub.price) : '');
  const [discount, setDiscount] = React.useState(String(sub.discount || 0));
  const [periodStart, setPeriodStart] = React.useState(String(sub.nextRun || '').slice(0, 10));
  const [description, setDescription] = React.useState('');
  const [sendAfter, setSendAfter] = React.useState(true);

  return (
    <Modal.Root open onOpenChange={(open: boolean) => !open && onClose()}>
      <Modal.Content>
        <Modal.Header>
          <Modal.Title>Nieuwe proforma – {sub.name}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Flex direction="column" gap={4} alignItems="stretch">
            <Flex gap={4}>
              <Field.Root name="price" width="50%">
                <Field.Label>Prijs ({settings?.prices_include_vat ? 'incl.' : 'excl.'} btw)</Field.Label>
                <Field.Input type="number" step="0.01" value={price} onChange={(e: any) => setPrice(e.target.value)} />
              </Field.Root>
              <Field.Root name="discount" width="50%">
                <Field.Label>Korting %</Field.Label>
                <Field.Input type="number" value={discount} onChange={(e: any) => setDiscount(e.target.value)} />
              </Field.Root>
            </Flex>
            <Field.Root name="periodStart" hint={`Periode van ${settings?.period_months || 12} maanden vanaf deze datum`}>
              <Field.Label>Start periode</Field.Label>
              <Field.Input type="date" value={periodStart} onChange={(e: any) => setPeriodStart(e.target.value)} />
              <Field.Hint />
            </Field.Root>
            <Field.Root name="description" hint="Leeg laten voor de standaardomschrijving met pakket en periode">
              <Field.Label>Omschrijving (optioneel)</Field.Label>
              <Field.Input value={description} onChange={(e: any) => setDescription(e.target.value)} />
              <Field.Hint />
            </Field.Root>
            <Typography variant="omega" textColor="neutral600">
              Het abonnement wordt pas verlengd (last run = start periode, count +1) wanneer je de proforma op betaald zet.
            </Typography>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
              <input type="checkbox" checked={sendAfter} onChange={(e) => setSendAfter(e.target.checked)} />
              Daarna meteen het mailvenster openen
            </label>
          </Flex>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="tertiary" onClick={onClose}>Annuleren</Button>
          <Button
            loading={busy}
            disabled={!price}
            onClick={() =>
              onSubmit(
                {
                  subscriptionDocumentId: sub.documentId,
                  price: Number(price),
                  discount: Number(discount) || 0,
                  periodStart: periodStart || undefined,
                  description: description || undefined,
                },
                sendAfter,
              )
            }
          >
            Proforma maken
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
};

const SendDialog = ({
  invoice,
  kind,
  busy,
  onClose,
  onTest,
  onSend,
}: {
  invoice: Invoice;
  kind: 'invoice' | 'reminder';
  busy: boolean;
  onClose: () => void;
  onTest: () => void;
  onSend: (to?: string) => void;
}) => {
  const [to, setTo] = React.useState(invoice.sentTo || invoice.email || '');
  return (
    <Modal.Root open onOpenChange={(open: boolean) => !open && onClose()}>
      <Modal.Content>
        <Modal.Header>
          <Modal.Title>
            {kind === 'reminder' ? 'Herinnering' : 'Proforma'} {invoice.number} mailen – {invoice.name}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Flex direction="column" gap={4} alignItems="stretch">
            <Field.Root name="to" hint="Leeg = het contact_email van het abonnement">
              <Field.Label>Naar</Field.Label>
              <Field.Input type="email" value={to} onChange={(e: any) => setTo(e.target.value)} />
              <Field.Hint />
            </Field.Root>
            <Typography variant="omega" textColor="neutral600">
              De PDF gaat als bijlage mee. De mailtekst pas je aan in Content Manager › Factuurinstellingen. Met "Testmail
              naar mij" krijg je eerst zelf de mail, zonder dat de status verandert.
            </Typography>
          </Flex>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="tertiary" onClick={onTest} loading={busy}>Testmail naar mij</Button>
          <Button onClick={() => onSend(to || undefined)} loading={busy}>
            {kind === 'reminder' ? 'Herinnering versturen' : 'Versturen'}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
};

const PaidDialog = ({
  invoice,
  today,
  busy,
  onClose,
  onSubmit,
}: {
  invoice: Invoice;
  today: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (paidAt: string, octopus: string) => void;
}) => {
  const [paidAt, setPaidAt] = React.useState(String(invoice.paidAt || today).slice(0, 10));
  const [octopus, setOctopus] = React.useState(invoice.octopus || '');
  return (
    <Modal.Root open onOpenChange={(open: boolean) => !open && onClose()}>
      <Modal.Content>
        <Modal.Header>
          <Modal.Title>Proforma {invoice.number} betaald – {invoice.name}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Flex direction="column" gap={4} alignItems="stretch">
            <Field.Root name="paidAt">
              <Field.Label>Betaald op</Field.Label>
              <Field.Input type="date" value={paidAt} onChange={(e: any) => setPaidAt(e.target.value)} />
            </Field.Root>
            {invoice.status !== 'betaald' && (
              <Typography variant="omega" textColor="neutral600">
                Bij opslaan wordt het abonnement verlengd: last run wordt {d(invoice.periodStart)}, count +1.
              </Typography>
            )}
            <Field.Root name="octopus" hint="Het nummer van de officiële factuur in Octopus (mag je later nog invullen)">
              <Field.Label>Octopus-factuurnummer</Field.Label>
              <Field.Input value={octopus} onChange={(e: any) => setOctopus(e.target.value)} />
              <Field.Hint />
            </Field.Root>
          </Flex>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="tertiary" onClick={onClose}>Annuleren</Button>
          <Button variant="success" loading={busy} onClick={() => onSubmit(paidAt, octopus)}>Opslaan</Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
};

export default InvoicesPage;

import type { StrapiApp } from '@strapi/strapi/admin';
import { useFetchClient, useNotification } from '@strapi/strapi/admin';

// Knoppen in de lijst Prospects (Content Manager): vink prospects aan en kies
// "Verstuur eerste mail", "Verstuur opvolgmail" of "Testmail naar mij".
// De mailteksten pas je aan in Content Manager > Prospect mailteksten.

const PROSPECT = 'api::prospect.prospect';
const MAX = 25;

type Kind = 'first' | 'followup';

const names = (documents: any[]) =>
  documents
    .slice(0, 12)
    .map((d) => d.name)
    .join(', ') + (documents.length > 12 ? ` en ${documents.length - 12} andere` : '');

const makeSendAction = (kind: Kind) => {
  const SendAction = ({ documents, model }: { documents: any[]; model: string }) => {
    const { post } = useFetchClient();
    const { toggleNotification } = useNotification();
    if (model !== PROSPECT) return null;

    const label = kind === 'first' ? 'Verstuur eerste mail' : 'Verstuur opvolgmail';
    const tooMany = documents.length > MAX;

    return {
      label,
      variant: 'secondary' as const,
      disabled: tooMany,
      dialog: {
        type: 'dialog' as const,
        title: label,
        content: (
          <div style={{ display: 'grid', gap: 12, textAlign: 'left' }}>
            <p>
              {tooMany
                ? `Selecteer maximaal ${MAX} prospects per keer.`
                : `Je verstuurt ${kind === 'first' ? 'de eerste mail' : 'de opvolgmail'} naar ${documents.length} prospect${documents.length === 1 ? '' : 's'}:`}
            </p>
            {!tooMany && <p style={{ fontSize: 13 }}>{names(documents)}</p>}
            <p style={{ fontSize: 13 }}>
              Prospects die niet in aanmerking komen (geen e-mail, al gemaild, uitgeschreven, partner) worden overgeslagen.
              De mails vertrekken één voor één met 20 seconden pauze. De status wordt automatisch aangepast.
            </p>
          </div>
        ),
        confirmLabel: 'Versturen',
        onConfirm: async () => {
          if (tooMany) return;
          try {
            const { data } = await post('/prospect-mailer/send', { documentIds: documents.map((d) => d.documentId), kind });
            const skipped = data.skipped?.length
              ? ` Overgeslagen: ${data.skipped.map((s: any) => `${s.name} (${s.reason})`).join(', ')}.`
              : '';
            toggleNotification({
              type: data.queued?.length ? 'success' : 'warning',
              title: data.queued?.length ? `${data.queued.length} mail(s) worden verstuurd` : 'Geen mails verstuurd',
              message: `${data.queued?.length ? `Klaar binnen ongeveer ${Math.ceil((data.seconds || 0) / 60) || 1} minuut. Vernieuw de lijst om de status te zien.` : ''}${skipped} Nog ${data.remainingToday} toegelaten vandaag.`,
            });
          } catch (error: any) {
            toggleNotification({
              type: 'danger',
              message: error?.response?.data?.error?.message || 'Versturen is mislukt',
            });
          }
        },
      },
    };
  };
  return SendAction;
};

const TestAction = ({ documents, model }: { documents: any[]; model: string }) => {
  const { post } = useFetchClient();
  const { toggleNotification } = useNotification();
  if (model !== PROSPECT) return null;
  const first = documents[0];

  return {
    label: 'Testmail naar mij',
    variant: 'tertiary' as const,
    disabled: documents.length !== 1,
    dialog: {
      type: 'dialog' as const,
      title: 'Testmail naar mij',
      content: (
        <p style={{ textAlign: 'left' }}>
          {documents.length !== 1
            ? 'Selecteer precies één prospect om een testmail te sturen.'
            : `De eerste mail voor ${first?.name} gaat naar jouw eigen e-mailadres. De prospect krijgt niets en de status blijft gelijk.`}
        </p>
      ),
      confirmLabel: 'Stuur testmail',
      onConfirm: async () => {
        if (documents.length !== 1) return;
        try {
          const { data } = await post('/prospect-mailer/test', { documentId: first.documentId, kind: 'first' });
          toggleNotification({ type: 'success', message: `Testmail "${data.subject}" verstuurd naar ${data.to}` });
        } catch (error: any) {
          toggleNotification({ type: 'danger', message: error?.response?.data?.error?.message || 'Testmail is mislukt' });
        }
      },
    },
  };
};

export default {
  config: {
    locales: [],
  },
  bootstrap(app: StrapiApp) {
    const contentManager: any = app.getPlugin('content-manager');
    contentManager?.apis?.addBulkAction((actions: any[]) => [...actions, makeSendAction('first'), makeSendAction('followup'), TestAction]);
  },
};

// Uitschrijflink uit de prospectmails. Openbaar (geen login nodig), maar enkel
// met de persoonlijke code uit de mail.
// GET toont een bevestigingspagina met een knop (zo schrijven virusscanners die
// links openen niemand per ongeluk uit); POST schrijft uit, ook voor de
// "Uitschrijven"-knop van Gmail/Outlook (List-Unsubscribe-Post).
export default {
  routes: [
    {
      method: 'GET',
      path: '/prospects/unsubscribe/:token',
      handler: 'api::prospect.prospect.unsubscribePage',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/prospects/unsubscribe/:token',
      handler: 'api::prospect.prospect.unsubscribe',
      config: { auth: false },
    },
  ],
};

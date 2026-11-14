export default {
  type: 'content-api',
  routes: [
    {
      // Wordt aangeroepen door de front (met API-token) nadat het wegdek van
      // een route uit OpenStreetMap berekend is. Vult enkel een leeg
      // "verhard"-percentage in; bestaande waarden worden nooit overschreven.
      method: 'POST',
      path: '/routes/:documentId/surface-percentage',
      handler: 'route.setSurfacePercentage',
    },
    {
      // Bezoek van een routepagina (front: app/api/routes/[documentId]/view).
      // Verhoogt view_count rechtstreeks in de database, zodat er GEEN
      // "entry.update"-webhook vertrekt. Via een gewone PUT liet elke
      // bezoeker de cache van de site (Next + Cloudflare) leegmaken.
      method: 'POST',
      path: '/routes/:documentId/view',
      handler: 'route.registerView',
    },
  ],
};

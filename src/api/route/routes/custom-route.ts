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
  ],
};

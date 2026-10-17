/**
 * Routes voor het logie-dashboard: een aangemelde gebruiker kan enkel de
 * partners (logies) zien en bewerken waar hij als "manager" aan gekoppeld is.
 * De rechten voor de rol "Authenticated" worden automatisch gezet in
 * src/index.ts (ensurePartnerDashboardPermissions).
 */
export default {
  type: 'content-api',
  routes: [
    {
      method: 'GET',
      path: '/me/partners',
      handler: 'partner.myPartners',
    },
    {
      method: 'POST',
      path: '/me/partners/claim',
      handler: 'partner.claimPartnerInvite',
    },
    {
      // Publiek: toont enkel de naam van de logie bij een geldige code.
      method: 'GET',
      path: '/partner-invites/:code',
      handler: 'partner.partnerInvite',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/me/partners/:documentId',
      handler: 'partner.myPartner',
    },
    {
      method: 'PUT',
      path: '/me/partners/:documentId',
      handler: 'partner.updateMyPartner',
    },
    {
      method: 'POST',
      path: '/me/partners/:documentId/media',
      handler: 'partner.uploadMyPartnerMedia',
    },
  ],
};

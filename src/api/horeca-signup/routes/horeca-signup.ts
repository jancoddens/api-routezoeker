/**
 * Publieke endpoints voor /horeca-aanmelden op de website.
 *
 * GET  /api/horeca-signups/prices  -> prijzen van Horeca Basis / Plus
 *                                     (instelbaar in Factuurinstellingen)
 * POST /api/horeca-signups         -> aanmelding: maakt een partner (universe
 *                                     Horeca) + abonnement aan als concept
 */
export default {
  type: 'content-api',
  routes: [
    {
      method: 'GET',
      path: '/horeca-signups/prices',
      handler: 'horeca-signup.prices',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/horeca-signups',
      handler: 'horeca-signup.create',
      config: { auth: false },
    },
  ],
};

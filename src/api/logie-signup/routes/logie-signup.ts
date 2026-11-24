/**
 * Publieke endpoints voor /logie-aanmelden op de website.
 *
 * GET  /api/logie-signups/prices  -> prijzen van Starter / Pro / Full
 *                                    (instelbaar in Factuurinstellingen)
 * POST /api/logie-signups         -> aanmelding: maakt een partner (universe
 *                                    Logie) + abonnement aan als concept
 */
export default {
  type: 'content-api',
  routes: [
    {
      method: 'GET',
      path: '/logie-signups/prices',
      handler: 'logie-signup.prices',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/logie-signups',
      handler: 'logie-signup.create',
      config: { auth: false },
    },
  ],
};

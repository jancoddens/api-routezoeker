/**
 * Aanmelden als horecapartner via /horeca-aanmelden (zie routes/horeca-signup.ts).
 * De logica zit in src/utils/partner-signup.ts (gedeeld met /logie-aanmelden).
 */

import type { Core } from '@strapi/strapi';
import { HORECA_PACKAGES } from '../../../utils/horeca-packages';
import { createSignupController } from '../../../utils/partner-signup';

export default ({ strapi }: { strapi: Core.Strapi }) =>
  createSignupController(strapi, {
    universe: 'Horeca',
    label: 'horecazaak',
    page: 'horeca-aanmelden',
    packages: HORECA_PACKAGES,
    types: ['Café', 'Restaurant', 'Brasserie', 'Bar', 'Tearoom', 'Frituur', 'IJssalon', 'Popup bar'],
  });

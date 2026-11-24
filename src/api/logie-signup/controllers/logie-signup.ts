/**
 * Aanmelden als logiespartner via /logie-aanmelden (zie routes/logie-signup.ts).
 * De logica zit in src/utils/partner-signup.ts (gedeeld met /horeca-aanmelden).
 */

import type { Core } from '@strapi/strapi';
import { LOGIE_PACKAGES } from '../../../utils/horeca-packages';
import { createSignupController } from '../../../utils/partner-signup';

export default ({ strapi }: { strapi: Core.Strapi }) =>
  createSignupController(strapi, {
    universe: 'Logie',
    label: 'logie',
    page: 'logie-aanmelden',
    packages: LOGIE_PACKAGES,
    types: ['B&B', 'Vakantieverblijf', 'Hotel', 'Camping', 'Appartement', 'Kasteel'],
  });

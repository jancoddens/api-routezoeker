/**
 * prospect router
 *
 * Geef deze routes GEEN rechten voor Public of Authenticated in
 * Settings > Users & Permissions: prospects zijn enkel voor de admin.
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::prospect.prospect');

/**
 * prospect controller
 */

import { factories } from '@strapi/strapi';
import { unsubscribeByToken } from '../../../utils/prospect-mailer';

const page = (title: string, body: string) => `<!doctype html>
<html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${title} | Routezoeker</title>
<style>
body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#f4f7f4;color:#18231d}
main{max-width:520px;margin:12vh auto;padding:32px 24px;background:#fff;border:1px solid #d5ded7;border-radius:12px}
h1{font-size:22px;margin:0 0 12px}p{margin:0 0 16px}
button{font:inherit;font-weight:600;background:#1d6b4a;color:#fff;border:0;border-radius:8px;padding:10px 18px;cursor:pointer}
a{color:#1d6b4a}
</style></head><body><main>${body}</main></body></html>`;

const escapeHtml = (value: string) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

export default factories.createCoreController('api::prospect.prospect', ({ strapi }) => ({
  async unsubscribePage(ctx) {
    const token = String(ctx.params.token || '');
    const prospect = await strapi.db
      .query('api::prospect.prospect')
      .findOne({ where: { unsubscribe_token: token }, select: ['name', 'stage'] });
    ctx.type = 'text/html; charset=utf-8';
    if (!prospect) {
      ctx.status = 404;
      ctx.body = page('Link ongeldig', '<h1>Deze link werkt niet</h1><p>Mail ons gerust op <a href="mailto:info@routezoeker.com">info@routezoeker.com</a>, dan schrijven we je meteen uit.</p>');
      return;
    }
    if (prospect.stage === 'niet_contacteren') {
      ctx.body = page('Uitgeschreven', `<h1>Je bent uitgeschreven</h1><p>${escapeHtml(prospect.name)} krijgt geen mails meer van Routezoeker.</p>`);
      return;
    }
    ctx.body = page(
      'Uitschrijven',
      `<h1>Geen mails meer van Routezoeker?</h1><p>Klik op de knop en ${escapeHtml(prospect.name)} krijgt geen mails meer over een partnerpagina.</p>
       <form method="post"><button type="submit">Uitschrijven</button></form>`,
    );
  },

  async unsubscribe(ctx) {
    const prospect = await unsubscribeByToken(strapi, String(ctx.params.token || ''));
    ctx.type = 'text/html; charset=utf-8';
    if (!prospect) {
      ctx.status = 404;
      ctx.body = page('Link ongeldig', '<h1>Deze link werkt niet</h1><p>Mail ons gerust op <a href="mailto:info@routezoeker.com">info@routezoeker.com</a>, dan schrijven we je meteen uit.</p>');
      return;
    }
    ctx.body = page('Uitgeschreven', `<h1>Je bent uitgeschreven</h1><p>${escapeHtml(prospect.name)} krijgt geen mails meer van Routezoeker. Sorry voor het storen.</p>`);
  },
}));

'use strict';

/**
 * Overpass API met automatisch doorschakelen naar een andere server als er
 * een vol zit. Gedeeld door de knooppunten-syncs.
 */

const USER_AGENT = 'Routezoeker-knooppuntensync/1.0 (+https://www.routezoeker.com)';
const OVERPASS_URLS = process.env.OVERPASS_URL
  ? [process.env.OVERPASS_URL]
  : [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.private.coffee/api/interpreter',
      'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    ];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const overpass = async (query, log = console.log, attempt = 1) => {
  const url = OVERPASS_URLS[(attempt - 1) % OVERPASS_URLS.length];
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
      body: `data=${encodeURIComponent(query)}`,
    });
    if ([429, 502, 503, 504].includes(response.status)) throw new Error(`Overpass bezet (HTTP ${response.status})`);
    if (!response.ok) {
      const text = (await response.text()).replace(/\s+/g, ' ').slice(0, 200);
      throw new Error(`HTTP ${response.status}: ${text}`);
    }
    const json = await response.json();
    if (json.remark && /error|timed out|runtime/i.test(json.remark)) throw new Error(`Overpass: ${json.remark}`);
    return json;
  } catch (error) {
    if (attempt >= 8) throw error;
    const wait = attempt < OVERPASS_URLS.length ? 3000 : 20000 * Math.ceil(attempt / OVERPASS_URLS.length);
    log(`  ${new URL(url).host}: ${String(error.message).split('\n')[0]}; opnieuw over ${wait / 1000} s (poging ${attempt + 1})...`);
    await sleep(wait);
    return overpass(query, log, attempt + 1);
  }
};

module.exports = { overpass, sleep };

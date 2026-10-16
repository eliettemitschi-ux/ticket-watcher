// Eurostar Snap: reads the search page's date strip and time windows.
//
// Snap sells cheap seats in TIME WINDOWS ("Leaving between 13:00 - 20:01"),
// not exact trains, and the exact train is only confirmed 48h before travel.
// The search page is server-rendered, so a plain request already contains:
//   - a 5-day strip centred on the chosen day, each day with a price or none
//   - the time windows (with prices) for the chosen day
// No login and no JavaScript needed -- but the site sits behind an AWS WAF bot
// check, so callers must treat "no strip found" as "blocked", never as "no
// tickets".

const fetch = require('node-fetch');

const BASE = 'https://snap.eurostar.com/uk-en/search';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-GB,en;q=0.9',
  Accept: 'text/html,application/xhtml+xml',
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function searchUrl(route, dateIso) {
  return `${BASE}?adult=1&origin=${route.origin}&destination=${route.destination}&outbound=${dateIso}&outslot=13%3A00`;
}

function addDays(dateIso, n) {
  const d = new Date(`${dateIso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const stripNoise = (html) => String(html).replace(/<style[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
const textOf = (html) => stripNoise(html).replace(/<[^>]+>/g, ' ').replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/**
 * Pure: reads one search page.
 * @param {string} html
 * @param {string} chosenIso  the outbound date that was requested (gives the year)
 * @returns {{days: {date:string, price:number|null}[], slots: {window:string, price:number}[]} | null}
 *   null when the page has no date strip (blocked, or the layout changed)
 */
function parseSearchHtml(html, chosenIso) {
  const clean = stripNoise(html);
  const chunks = clean.split('data-testid="calendarDay"').slice(1);
  if (chunks.length === 0) return null;

  const days = [];
  for (const chunk of chunks) {
    const label = /aria-hidden="true">\s*([A-Za-z]{3}),\s*(\d{1,2})\s+([A-Za-z]{3})/.exec(chunk);
    if (!label) continue;
    const monthIdx = MONTHS.indexOf(label[3]);
    if (monthIdx < 0) continue;
    // The strip never spans more than a few days either side of the chosen
    // day, so the nearest matching date to it fixes the year.
    const chosen = new Date(`${chosenIso}T12:00:00Z`);
    let best = null;
    for (const y of [chosen.getUTCFullYear() - 1, chosen.getUTCFullYear(), chosen.getUTCFullYear() + 1]) {
      const cand = new Date(Date.UTC(y, monthIdx, Number(label[2]), 12));
      if (!best || Math.abs(cand - chosen) < Math.abs(best - chosen)) best = cand;
    }
    const priceBlock = chunk.split('data-testid="calendarDay-price"')[1] || '';
    const price = /£\s*(\d+(?:\.\d{1,2})?)/.exec(textOf(priceBlock.slice(0, 1500)));
    days.push({ date: best.toISOString().slice(0, 10), price: price ? Number(price[1]) : null });
  }
  if (days.length === 0) return null;

  const slots = [];
  const text = textOf(clean);
  for (const m of text.matchAll(/Leaving between (\d{2}:\d{2}) - (\d{2}:\d{2})[^£]{0,220}?£\s*(\d+(?:\.\d{1,2})?)/g)) {
    slots.push({ window: `${m[1]}-${m[2]}`, price: Number(m[3]) });
  }
  return { days, slots };
}

/** @returns {Promise<{status:number, parsed:object|null}>} */
async function fetchSearch(route, dateIso) {
  const res = await fetch(searchUrl(route, dateIso), { headers: HEADERS, timeout: 25000 });
  const html = await res.text();
  return { status: res.status, parsed: res.ok ? parseSearchHtml(html, dateIso) : null };
}

module.exports = { searchUrl, parseSearchHtml, fetchSearch, addDays, MONTHS };

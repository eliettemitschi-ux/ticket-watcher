// sohoplaceChecker.js
//
// @sohoplace's booking system (ticketing.sohoplace.org, an "Nliven"
// platform) exposes a clean, structured "get events by month" JSON API
// -- no HTML scraping needed, and it hands back real per-performance
// data including a genuine numeric price (lowestPricePoint), not just a
// sold-out/available guess from prose. Found live (2026-09-25) while
// adding Who's Afraid of Virginia Woolf.
//
// One request per calendar month the run spans (the API is month-scoped,
// recipe.months lists which to fetch, e.g. ["2026/09/01", "2026/10/01"]).

const fetch = require('node-fetch');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Safari/537.36 ticket-watcher/1.0 (personal availability checker)';

// Availability is reported as a named colour band, not a plain boolean --
// "Good"/"Medium"/"Low" all mean genuinely bookable (just with
// dwindling seats), so only these are ever read as available. Anything
// else (a value not seen before, or a performance simply missing from
// the response) defaults to sold_out rather than guessing -- a wrongly
// "available" read sends a false notification for a ticket that isn't
// really there, which is worse than a wrongly-cautious "sold_out" that
// just gets corrected on the next check.
const AVAILABLE_COLORS = new Set(['Good', 'Medium', 'Low']);

function formatLabel(localDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(localDate);
  if (!m) return localDate;
  const [, y, mo, d, hh, mm] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  const dateLabel = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const hour = Number(hh);
  const minute = Number(mm);
  const period = hour >= 12 ? 'pm' : 'am';
  const hour12 = ((hour + 11) % 12) + 1;
  const timeLabel = minute === 0 ? `${hour12}${period}` : `${hour12}.${String(minute).padStart(2, '0')}${period}`;
  return `${dateLabel}, ${timeLabel}`;
}

/**
 * @param {object} recipe { mode: 'sohoplace-api', eventTemplateCode, promoCode, months: string[] }
 * @returns {Promise<{label,state,snippet}[] | {state:'error', error:string}>}
 */
async function checkSohoplace(recipe) {
  const { eventTemplateCode, promoCode, months } = recipe;
  const seen = new Map(); // keyed by performance id, de-dupes if a month range ever overlaps

  for (const month of months) {
    const url =
      `https://ticketing.sohoplace.org/api/consumer/events/v2/getbymonth/${eventTemplateCode}` +
      `?requestedTime=${encodeURIComponent(month)}&salesChannel=Web&promoCode=${encodeURIComponent(promoCode || '')}`;
    const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }, timeout: 15000 });
    if (!res.ok) continue; // one bad month shouldn't fail the whole run -- report what the others found
    const json = await res.json().catch(() => null);
    for (const event of json?.events || []) {
      seen.set(event.id, event);
    }
  }

  if (seen.size === 0) {
    return { state: 'error', error: 'No performances found across any of the configured months' };
  }

  return [...seen.values()].map((event) => {
    const available = AVAILABLE_COLORS.has(event.availabilityColor);
    return {
      label: formatLabel(event.localDate),
      state: available ? 'available' : 'sold_out',
      snippet: available
        ? `${event.availabilityColor} availability, from £${event.lowestPricePoint}`
        : `${event.availabilityColor || 'Unavailable'}`,
    };
  });
}

module.exports = { checkSohoplace, formatLabel, AVAILABLE_COLORS };

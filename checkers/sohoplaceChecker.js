// sohoplaceChecker.js
//
// @sohoplace's booking system (ticketing.sohoplace.org, an "Nliven"
// platform) exposes a clean, structured "get events by month" JSON API
// -- no HTML scraping needed. First built around that alone, using its
// `availabilityColor`/`lowestPricePoint` fields.
//
// Real bug found live (2026-09-25/26): those summary fields are NOT a
// trustworthy live signal -- a performance confirmed genuinely sold out
// on its own real seat-selection page ("Performance Sold Out") still
// showed "Low availability, from £18.5" in the summary, identical to a
// performance that actually had seats. The real, reliable signal lives
// one level down: the per-performance `eventinventory` endpoint, which
// reports actual seat/GA-section counts and live price maps. A sold-out
// performance has empty seats/sections and no price maps; a genuinely
// bookable one has real entries and a real price -- confirmed against
// both a sold-out date (25 Sept) and a genuinely available one
// (19 Dec: 2 real seats, £95 full / £47.50 discounted -- nothing like
// the misleading £18.5 the summary showed for both).
//
// One getbymonth call per calendar month the run spans (to discover
// which performance ids exist and their dates), then one eventinventory
// call per performance found (heavier -- ~95 extra plain HTTP requests
// for this show's full run -- but still no browser needed, and done in
// small concurrent batches rather than one request at a time).

const fetch = require('node-fetch');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Safari/537.36 ticket-watcher/1.0 (personal availability checker)';

const INVENTORY_BATCH_SIZE = 10;

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

async function fetchMonthEvents(eventTemplateCode, promoCode, month) {
  const url =
    `https://ticketing.sohoplace.org/api/consumer/events/v2/getbymonth/${eventTemplateCode}` +
    `?requestedTime=${encodeURIComponent(month)}&salesChannel=Web&promoCode=${encodeURIComponent(promoCode || '')}`;
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }, timeout: 15000 });
  if (!res.ok) return [];
  const json = await res.json().catch(() => null);
  return json?.events || [];
}

// Pure classification logic, separated from the fetch so it can be unit
// tested against real captured fixtures (a confirmed sold-out response
// and a confirmed genuinely-available one) without mocking the network.
// A sold-out performance has no seat/GA-section entries and no live
// price map; a genuinely bookable one has real entries in both.
function classifyInventory(inv) {
  const hasRealInventory = (inv.mapSeats?.length || 0) > 0 || (inv.mapGASections?.length || 0) > 0;
  const priceMaps = inv.priceMaps || [];
  const available = hasRealInventory && priceMaps.length > 0;
  const price = priceMaps.length
    ? Math.min(...priceMaps.map((p) => (typeof p.discountedPrice === 'number' ? p.discountedPrice : p.price)))
    : null;
  return { available, price };
}

// Real, per-performance inventory -- the trustworthy signal (see header
// comment). Returns { available, price } or null on a fetch failure
// (treated as "couldn't confirm" by the caller, not as sold out).
async function fetchInventory(eventId, promoCode) {
  const url = `https://ticketing.sohoplace.org/api/consumer/eventinventory/${eventId}?promoCode=${encodeURIComponent(promoCode || '')}`;
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }, timeout: 15000 });
  if (!res.ok) return null;
  const inv = await res.json().catch(() => null);
  if (!inv) return null;
  return classifyInventory(inv);
}

async function mapWithConcurrency(items, batchSize, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    results.push(...(await Promise.all(batch.map(fn))));
  }
  return results;
}

/**
 * @param {object} recipe { mode: 'sohoplace-api', eventTemplateCode, promoCode, months: string[] }
 * @returns {Promise<{label,state,snippet}[] | {state:'error', error:string}>}
 */
async function checkSohoplace(recipe) {
  const { eventTemplateCode, promoCode, months } = recipe;
  const seen = new Map(); // keyed by performance id, de-dupes if a month range ever overlaps

  for (const month of months) {
    const events = await fetchMonthEvents(eventTemplateCode, promoCode, month);
    for (const event of events) seen.set(event.id, event);
  }

  if (seen.size === 0) {
    return { state: 'error', error: 'No performances found across any of the configured months' };
  }

  const events = [...seen.values()];
  const inventories = await mapWithConcurrency(events, INVENTORY_BATCH_SIZE, (event) =>
    fetchInventory(event.id, promoCode)
  );

  return events.map((event, i) => {
    const inv = inventories[i];
    // A failed inventory fetch fails open (available, no price) rather
    // than silently reporting sold_out for a performance that might
    // genuinely be bookable -- same principle as priceAllows() elsewhere
    // in this codebase: missing a real notification is worse than one
    // extra check next cycle.
    if (!inv) {
      return { label: formatLabel(event.localDate), state: 'available', snippet: 'Could not confirm live inventory this check' };
    }
    return {
      label: formatLabel(event.localDate),
      state: inv.available ? 'available' : 'sold_out',
      snippet: inv.available ? `Real seats available, from £${inv.price}` : 'Sold out (confirmed via live inventory)',
    };
  });
}

module.exports = { checkSohoplace, formatLabel, fetchInventory, classifyInventory };

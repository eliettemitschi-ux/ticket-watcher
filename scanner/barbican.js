// Barbican source for the scanner: crawls the filtered what's-on listing, and
// reads one event's bookability from its /node/<id>/instances endpoint (the
// same call the booking overlay makes, and what the main watcher already uses).

const fetch = require('node-fetch');
const { parseListing, groupByEvent, hasLoadMore, stripTags } = require('./parseListing');
const { extractInstances, isGeneralPresaleGated } = require('../checkers/htmlInstancesChecker');
const { parsePageOnSaleDates, parseOverlayTime, isRollingPlaceholder } = require('./dates');
const { londonToUtcMs } = require('./time');

const BASE = 'https://www.barbican.org.uk';
const USER_AGENT = 'Mozilla/5.0 (compatible; ticket-watcher/1.0; personal availability scanner)';
const MAX_PAGES = 80;

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function listingUrl(config, now, page) {
  const max = new Date(now.getTime());
  max.setUTCMonth(max.getUTCMonth() + config.barbican.monthsAhead);
  const params = new URLSearchParams();
  for (const id of Object.keys(config.barbican.artforms)) params.append(`af[${id}]`, id);
  params.set('dates[min]', isoDate(now));
  params.set('dates[max]', isoDate(max));
  if (page) params.set('page', String(page));
  return `${BASE}/whats-on?${params.toString()}`;
}

async function crawlListing(config, now = new Date()) {
  const cards = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetch(listingUrl(config, now, page), { headers: { 'User-Agent': USER_AGENT }, timeout: 20000 });
    if (!res.ok) throw new Error(`Listing page ${page} returned HTTP ${res.status}`);
    const html = await res.text();
    cards.push(...parseListing(html));
    if (!hasLoadMore(html)) return groupByEvent(cards);
  }
  throw new Error(`Listing did not finish within ${MAX_PAGES} pages`);
}

// "General Book from 6.21pm, Fri 02 Oct" -> "6.21pm, Fri 02 Oct"
function generalSaleTextFrom(html) {
  const text = stripTags(html);
  const m = /General\s+Book\s+from\s+(\d[^A-Z]{0,12}(?:am|pm)(?:,\s*[A-Z][a-z]{2}\s+\d{1,2}\s+[A-Z][a-z]{2})?)/.exec(text);
  return m ? m[1].trim() : null;
}

/**
 * Pure: classifies an instances-endpoint response body.
 * @returns {{state:'bookable'|'sold_out'|'gated'|'not_on_sale'|'error', generalSaleText?:string|null, error?:string}}
 */
function classifyInstancesResponse(raw) {
  let html = String(raw || '');
  try {
    const parsed = JSON.parse(html);
    if (typeof parsed === 'string') html = parsed;
  } catch {
    /* plain HTML */
  }
  const instances = extractInstances(html);
  if (instances.length === 0) {
    // Before general sale some events show only the booking overlay's
    // "General  Book from <time>" row, with the performance list hidden.
    if (isGeneralPresaleGated(html)) return { state: 'gated', generalSaleText: generalSaleTextFrom(html) };
    const text = stripTags(html);
    if (text.length < 200 || /unexpected error/i.test(text)) return { state: 'not_on_sale' };
    return { state: 'error', error: 'Unrecognised instances response (no performances found)' };
  }
  if (instances.every((i) => i.soldOut)) return { state: 'sold_out' };
  if (isGeneralPresaleGated(html)) return { state: 'gated', generalSaleText: generalSaleTextFrom(html) };
  return { state: 'bookable' };
}

async function readEvent(nodeId) {
  try {
    const res = await fetch(`${BASE}/node/${nodeId}/instances`, {
      headers: { Accept: 'application/json, text/html', 'User-Agent': USER_AGENT },
      timeout: 15000,
    });
    const body = await res.text();
    // Events with no performances on sale yet answer HTTP 500 with Drupal's
    // generic error page. A real outage looks identical, which is why
    // decide.js never lets an already-live show fall back to not_on_sale.
    if (res.status === 500 && /unexpected error/i.test(body)) return { state: 'not_on_sale' };
    if (!res.ok) return { state: 'error', error: `HTTP ${res.status}` };
    return classifyInstancesResponse(body);
  } catch (err) {
    return { state: 'error', error: err.message };
  }
}

const VENUE = 'Barbican';
const PAGE_RECHECK_MS = 6 * 3600000;

/**
 * Pure: combines what the booking widget and the show page say about when
 * general sale opens. The widget's time is the system of record when it is a
 * real (non-sliding) time; otherwise the show page's date is used, with no
 * time-of-day, so the heads-up fires at 8am on the day.
 */
function resolveOpens(overlayMs, pageDates) {
  const pub = pageDates && pageDates.public;
  const mem = pageDates && pageDates.members;
  const membersAt = mem ? new Date(londonToUtcMs(mem.y, mem.m0, mem.d, 10, 0)).toISOString() : null;
  if (overlayMs) return { at: new Date(overlayMs).toISOString(), precision: 'exact', source: 'booking widget', membersAt };
  if (pub) return { at: new Date(londonToUtcMs(pub.y, pub.m0, pub.d, 10, 0)).toISOString(), precision: 'date', source: 'show page', membersAt };
  return null;
}

// Adds opening-time info to a waiting show's reading. The show page is only
// re-fetched every few hours: dates there rarely change.
async function enrich(listing, reading, prev, nowMs) {
  if (reading.state !== 'gated' && reading.state !== 'not_on_sale') return reading;

  let overlayMs = null;
  if (reading.generalSaleText) {
    const o = parseOverlayTime(reading.generalSaleText, nowMs);
    if (o && !isRollingPlaceholder(o.ms, nowMs)) overlayMs = o.ms;
  }

  let pageDates = prev && prev.pageDates;
  let datesCheckedAt = prev && prev.datesCheckedAt;
  if (!datesCheckedAt || nowMs - Date.parse(datesCheckedAt) > PAGE_RECHECK_MS) {
    try {
      const res = await fetch(listing.url, { headers: { 'User-Agent': USER_AGENT }, timeout: 20000 });
      if (res.ok) {
        pageDates = parsePageOnSaleDates(stripTags(await res.text()), nowMs);
        datesCheckedAt = new Date(nowMs).toISOString();
      }
    } catch {
      /* keep whatever we had; retried next run */
    }
  }
  return { ...reading, pageDates, datesCheckedAt, opens: resolveOpens(overlayMs, pageDates) };
}

// Adapter interface used by scripts/run-scanner.js: crawl() returns
// Map<key, listing>; listings without a precomputed `reading` are passed to
// read() only when they need a fresh status check.
async function crawl(config, now) {
  const events = await crawlListing(config, now);
  const listings = new Map();
  for (const e of events.values()) {
    listings.set(e.href, { ...e, key: e.href, venue: VENUE, url: BASE + e.href, venueSignals: [] });
  }
  return listings;
}

async function read(listing) {
  return listing.nodeId ? readEvent(listing.nodeId) : { state: 'error', error: 'no node id in listing card' };
}

module.exports = { crawl, read, enrich, resolveOpens, VENUE, crawlListing, readEvent, classifyInstancesResponse, listingUrl, generalSaleTextFrom };

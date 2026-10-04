// National Theatre announcements. The NT's ticketing feed (nationalTheatre.js)
// only lists shows once they are on sale. Shows that are announced but not yet
// bookable exist only as production pages on www.nationaltheatre.org.uk,
// which say things like "Booking opens in November 2026". This module finds
// those pages through the site's own sitemap.
//
// The sitemap holds ~180 productions, mostly past ones, and a page is ~150KB,
// so pages are fetched in small batches: the first run works through the
// backlog silently (nothing alerts for what already existed), and after that
// only new URLs and still-upcoming shows are fetched.

const fetch = require('node-fetch');
const { stripTags } = require('./parseListing');
const { parseNtBookingText } = require('./dates');
const { londonToUtcMs } = require('./time');

const VENUE = 'National Theatre';
// www.nationaltheatre.org.uk refuses requests without browser-like headers.
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-GB,en;q=0.9',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

function parseSitemap(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<url>[\s\S]*?<\/url>/g)) {
    const url = (/<loc>([^<]+)<\/loc>/.exec(m[0]) || [])[1];
    const slug = url && (/\/productions\/([^/]+)\/?$/.exec(url) || [])[1];
    if (slug) out.push({ url, slug, lastmod: (/<lastmod>([^<]+)<\/lastmod>/.exec(m[0]) || [])[1] || null });
  }
  return out;
}

/**
 * Pure: reads a production page. A page is "upcoming" when it carries
 * booking-opens wording.
 * @returns {{title:string, upcoming:boolean, opens:object|null, venueSignals:string[], bookingLabel:string|null}}
 */
function parseProductionPage(html, nowMs) {
  const rawTitle = stripTags((/<title>([\s\S]*?)<\/title>/.exec(html) || [])[1] || '');
  // "West Side Story Tickets | Musical | ..." / "Ballet Shoes | UK Tour | ..."
  const title = rawTitle.split('|')[0].replace(/\s+Tickets\s*$/i, '').trim();
  const text = stripTags(html);
  const booking = parseNtBookingText(text, nowMs);

  let opens = null;
  if (booking) {
    if (booking.precision === 'month') {
      opens = { at: new Date(londonToUtcMs(booking.y, booking.m0, 1, 0, 0)).toISOString(), precision: 'month', label: booking.label, source: 'show page' };
    } else {
      opens = { at: new Date(booking.ms).toISOString(), precision: booking.precision, source: 'show page', label: booking.label };
    }
  }

  // The show copy states its theatre ("will play in the Olivier Theatre").
  const theatre = /\b(?:in|at)\s+the\s+(Olivier|Lyttelton|Dorfman)\b/i.exec(text.slice(text.search(/About the show/i) >= 0 ? text.search(/About the show/i) : 0));
  const venueSignals = theatre && /dorfman/i.test(theatre[1]) ? ['Dorfman Theatre (smallest auditorium)'] : [];

  // The description (usually names the cast) is kept so watchlist words like
  // an actor's name can match an announcement.
  const aboutAt = text.search(/About the show/i);
  const blurb = aboutAt >= 0 ? text.slice(aboutAt + 'About the show'.length, aboutAt + 900).trim() : '';

  return { title, rawTitle, blurb, upcoming: Boolean(booking), opens, venueSignals, bookingLabel: booking ? booking.label : null };
}

async function pool(items, size, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    })
  );
}

/**
 * @param {object} ntState  persisted `state.nt` ({known: {slug: {...}}}) -- mutated in place
 * @returns {Promise<Map>} pending listings (one per upcoming show)
 */
async function crawlAnnouncements(config, ntState, nowMs) {
  const cfg = config.nationalTheatre;
  const res = await fetch(cfg.sitemapUrl, { headers: HEADERS, timeout: 30000 });
  if (!res.ok) throw new Error(`NT sitemap returned HTTP ${res.status}`);
  const items = parseSitemap(await res.text());
  if (items.length < 20) throw new Error(`NT sitemap looks wrong (${items.length} productions)`);

  const firstRun = !ntState.known;
  ntState.known = ntState.known || {};
  const known = ntState.known;
  const nowIso = new Date(nowMs).toISOString();
  for (const it of items) {
    if (!known[it.slug]) known[it.slug] = { url: it.url, firstSeen: nowIso, baseline: firstRun, fetchedAt: null, upcoming: null };
    known[it.slug].lastmod = it.lastmod;
  }

  const recheckMs = cfg.pageRecheckHours * 3600000;
  const unfetched = Object.entries(known).filter(([, k]) => k.upcoming === null);
  // New (post-baseline) pages first, then the baseline backlog.
  unfetched.sort((a, b) => Number(a[1].baseline) - Number(b[1].baseline));
  const stale = Object.entries(known).filter(([, k]) => k.upcoming === true && nowMs - Date.parse(k.fetchedAt) > recheckMs);
  const batch = [...stale, ...unfetched].slice(0, cfg.maxPageFetchesPerRun);

  await pool(batch, 4, async ([slug, k]) => {
    try {
      const r = await fetch(k.url, { headers: HEADERS, timeout: 30000 });
      if (!r.ok) return;
      const page = parseProductionPage(await r.text(), nowMs);
      Object.assign(k, { fetchedAt: nowIso, upcoming: page.upcoming, title: page.title, rawTitle: page.rawTitle, blurb: page.blurb, opens: page.opens, venueSignals: page.venueSignals });
    } catch {
      /* retried next run */
    }
  });

  // UK tours have their own per-venue booking dates and aren't London shows.
  const skip = new RegExp(cfg.excludeTitlePattern, 'i');
  const listings = new Map();
  for (const [slug, k] of Object.entries(known)) {
    if (!k.upcoming || skip.test(k.rawTitle || k.title || '')) continue;
    listings.set(`ntp-${slug}`, {
      key: `ntp-${slug}`,
      venue: VENUE,
      url: k.url,
      nodeId: null,
      title: k.title || slug,
      tags: [],
      text: k.blurb || '',
      days: [],
      venueSignals: k.venueSignals || [],
      silent: Boolean(k.baseline),
      reading: { state: 'not_on_sale', opens: k.opens },
    });
  }
  return listings;
}

module.exports = { crawlAnnouncements, parseSitemap, parseProductionPage };

// shopifyCalendarChecker.js
//
// Watches an artist's own tour calendar page built from "calendar-date"
// blocks (maxrichtermusic.com/pages/calendar is one). Each block holds a day,
// a month and year, a title, a location and a ticket label (BUY TICKETS or
// SOLD OUT). It is plain server-rendered HTML, so no browser is needed.
//
// recipe.alertPattern (a regex source, matched case-insensitively against the
// location and title, e.g. "london") says which dates matter. Every date is
// still logged, but only matching ones are given a ticket state and allowed
// to raise a "new date added" alert; the rest read 'unknown' with alert:false.
//
// An empty page returns an error rather than "no dates", so a changed page can
// never look like a wiped calendar followed by a flood of "new" dates.

const fetch = require('node-fetch');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Safari/537.36 ticket-watcher/1.0 (personal availability checker)';

const text = (html, cls) => {
  const m = new RegExp(`<div class="${cls}[^"]*"[^>]*>([\\s\\S]*?)</div>`, 'i').exec(html);
  return m
    ? m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim()
    : '';
};

/** Pulls { day, month, title, location, tickets, href } out of the calendar page. */
function parseCalendar(html) {
  const out = [];
  for (const m of html.matchAll(/<a\b([^>]*)class="calendar-date"([^>]*)>([\s\S]*?)<\/a>/g)) {
    const attrs = `${m[1]} ${m[2]}`;
    const body = m[3];
    const href = /href="([^"]*)"/.exec(attrs);
    const entry = {
      day: text(body, 'calendar-day'),
      month: text(body, 'calendar-month'),
      title: text(body, 'calendar-title'),
      location: text(body, 'calendar-location'),
      tickets: text(body, 'calendar-tickets'),
      href: href ? href[1] : null,
    };
    if (entry.title || entry.location) out.push(entry);
  }
  return out;
}

const labelOf = (e) => [`${e.day} ${e.month}`.trim(), e.title, e.location].filter(Boolean).join(' - ');

function toPerformances(entries, alertPattern) {
  const re = alertPattern ? new RegExp(alertPattern, 'i') : null;
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    const label = labelOf(e);
    if (seen.has(label)) continue;
    seen.add(label);
    const watched = !re || re.test(`${e.location} ${e.title}`);
    let state = 'unknown';
    if (watched) {
      if (/sold[\s-]*out/i.test(e.tickets)) state = 'sold_out';
      else if (/buy|ticket|book/i.test(e.tickets)) state = 'available';
    }
    out.push({ label, state, matched: e.tickets || null, snippet: [e.tickets, e.href].filter(Boolean).join(' · ') || null, listing: true, alert: watched });
  }
  return out;
}

/**
 * @param {{calendarUrl: string, alertPattern?: string}} recipe
 */
async function checkShopifyCalendar(recipe) {
  try {
    const res = await fetch(recipe.calendarUrl, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return { state: 'error', error: `HTTP ${res.status} fetching the calendar page` };
    const entries = parseCalendar(await res.text());
    if (entries.length === 0) return { state: 'error', error: 'no dates found on the calendar page' };
    return toPerformances(entries, recipe.alertPattern);
  } catch (err) {
    return { state: 'error', error: err.message };
  }
}

module.exports = { checkShopifyCalendar, parseCalendar, toPerformances, labelOf };

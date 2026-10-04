// Reads on-sale dates out of the wording venues actually use. Each parser is
// built from a real string seen on the venue's site (see test/scanner.test.js)
// and returns null rather than guessing when the wording doesn't match.

const { londonToUtcMs, londonParts } = require('./time');

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function monthIndex(name) {
  const k = String(name || '').slice(0, 3).toLowerCase();
  return k in MONTHS ? MONTHS[k] : null;
}

// A date quoted without a year means its next occurrence (allowing a couple
// of days of lag so "today" and "yesterday" don't jump a year ahead).
function inferYear(d, m0, nowMs) {
  const year = londonParts(nowMs).y;
  const candidate = londonToUtcMs(year, m0, d, 12, 0);
  return candidate < nowMs - 2 * 86400000 ? year + 1 : year;
}

/**
 * Barbican show-page copy, e.g.
 *   "TICKETS GO ON SALE TO MEMBERS - WED 7 OCT TICKETS GO ON SALE TO PUBLIC - FRI 9 OCT"
 * @returns {{members: {y,m0,d}|null, public: {y,m0,d}|null}}
 */
function parsePageOnSaleDates(text, nowMs) {
  const out = { members: null, public: null };
  const re = /GO\s+ON\s+SALE\s+TO\s+(MEMBERS?|THE\s+PUBLIC|PUBLIC|GENERAL)\b[^A-Za-z0-9]{0,6}(?:(?:MON|TUE|WED|THU|FRI|SAT|SUN)[A-Z]*\.?\s+)?(\d{1,2})(?:ST|ND|RD|TH)?\s+([A-Z]{3,9})/gi;
  for (const m of String(text || '').matchAll(re)) {
    const m0 = monthIndex(m[3]);
    if (m0 === null) continue;
    const d = Number(m[2]);
    const slot = /^member/i.test(m[1]) ? 'members' : 'public';
    if (!out[slot]) out[slot] = { y: inferYear(d, m0, nowMs), m0, d };
  }
  return out;
}

/**
 * Barbican booking-overlay wording: "10.00am, Fri 09 Oct".
 * @returns {{ms:number}|null} the opening instant
 */
function parseOverlayTime(text, nowMs) {
  const m = /(\d{1,2})(?:[.:](\d{2}))?\s*(am|pm),?\s*(?:[A-Za-z]{3,9}\s+)?(\d{1,2})\s+([A-Za-z]{3,9})/i.exec(String(text || ''));
  if (!m) return null;
  const m0 = monthIndex(m[5]);
  if (m0 === null) return null;
  let hh = Number(m[1]) % 12;
  if (/pm/i.test(m[3])) hh += 12;
  const d = Number(m[4]);
  return { ms: londonToUtcMs(inferYear(d, m0, nowMs), m0, d, hh, Number(m[2] || 0)) };
}

// Some Barbican presale pages show a "general sale from <time>" that simply
// moves forward each time the page is loaded (seen live: 6.21pm, 6.26pm,
// 6.55pm across scans on the same evening). A time landing within the last
// hour or the next 30 minutes is that placeholder, not a schedule.
function isRollingPlaceholder(openMs, nowMs) {
  return openMs >= nowMs - 3600000 && openMs <= nowMs + 1800000;
}

/**
 * National Theatre production-page wording.
 *   "Booking opens in November 2026"                  -> month precision
 *   "Booking opens Tuesday 3 November 2026 at 10am"   -> exact / date
 * @returns {{precision:'month'|'date'|'exact', ms?:number, label:string}|null}
 */
function parseNtBookingText(text, nowMs) {
  const t = String(text || '');
  const monthly = /Booking\s+opens\s+in\s+([A-Za-z]{3,9})\s+(\d{4})/i.exec(t);
  if (monthly) {
    const m0 = monthIndex(monthly[1]);
    if (m0 !== null) return { precision: 'month', label: `${monthly[1]} ${monthly[2]}`, y: Number(monthly[2]), m0 };
  }
  const exact = /Booking\s+opens\s+(?:on\s+)?(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\.?,?\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})(?:\s+(\d{4}))?(?:\s*(?:at|from|,|-)\s*(\d{1,2})(?:[.:](\d{2}))?\s*(am|pm))?/i.exec(t);
  if (exact) {
    const m0 = monthIndex(exact[2]);
    if (m0 === null) return null;
    const d = Number(exact[1]);
    const y = exact[3] ? Number(exact[3]) : inferYear(d, m0, nowMs);
    if (exact[6]) {
      let hh = Number(exact[4]) % 12;
      if (/pm/i.test(exact[6])) hh += 12;
      return { precision: 'exact', ms: londonToUtcMs(y, m0, d, hh, Number(exact[5] || 0)), label: `${d} ${exact[2]} ${y}` };
    }
    return { precision: 'date', ms: londonToUtcMs(y, m0, d, 10, 0), label: `${d} ${exact[2]} ${y}` };
  }
  return null;
}

module.exports = { parsePageOnSaleDates, parseOverlayTime, isRollingPlaceholder, parseNtBookingText, monthIndex };

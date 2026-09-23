// checkers/parseMultiText.js
//
// Barbican's Murakami show has one date with two showtimes (a 5pm matinee
// and an 8.30pm evening). Golden Boy has a whole run of separate dates.
// Neither is "one status for the whole page" -- each date/time can sell
// out and reopen independently. This module is what turns a blob of
// rendered page text into a list of {label, state} entries, one per
// date/time it can find, instead of a single verdict for the page.
//
// It's a heuristic, not a real parser of Spektrix/whatever's actual
// booking calendar markup -- it looks for date-shaped and time-shaped
// text and reads the sold-out/available wording near each one. That's
// inherently less precise than a proper per-instance API would be (see
// discover.js for why we don't have one yet), so every result carries a
// snippet of what it actually matched, visible on the dashboard, to make
// a wrong read easy to spot and tune rather than a silent black box.

const { classify } = require('./classify');

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December|' +
  'Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec';

// "21 November 2026", "21st Nov 2026", "12 Dec" (year optional)
const DATE_RE = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTHS})\\.?(?:\\s+(\\d{4}))?\\b`, 'gi');
// "8.30pm", "8:30 pm", "5pm", "20:30"
const TIME_RE = /\b(\d{1,2})[:.]?(\d{2})?\s*(am|pm)\b|\b([01]\d|2[0-3]):([0-5]\d)\b/gi;

// Deliberately tiny: any bigger and one slot's lookback starts re-reading
// text that rightfully belongs to the PREVIOUS slot's forward-looking
// window (e.g. "13 Nov -- Sold Out / 14 Nov -- Book tickets" -- a lookback
// of more than a few characters from "14 Nov" reaches back into "Sold
// Out", which is the 13th's status, not the 14th's).
const LOOKBACK = 8;
const MAX_SEGMENT = 500; // cap on how far forward one slot's window can reach
const MAX_PERFORMANCES = 60; // sanity cap against garbage pages

// Most event pages follow the actual event's own info with a "related
// shows" rail -- Barbican's real page, for instance, has a "You might
// also like" section listing entirely different events, each with its
// own date and ticket status. Scanning past that point picks up OTHER
// events' dates/times as if they belonged to the one being watched (this
// is exactly what happened with the Murakami Jazz page -- an unrelated
// October screening showed up as a bogus extra "performance"). Cut the
// text off at the first heading that looks like one of these sections --
// every real venue page seen so far puts the actual event's own ticket
// info before it, never after.
//
// "more info for" and "recently announced" cover Southbank Centre's own
// reused cross-promo card component specifically -- real bug found live
// (2026-09-23) on the Dua Lipa & Patti Smith event page, which correctly
// read the real "Sold Out" performance but then also picked up a string
// of bogus "unknown" entries from unrelated seasonal promo cards further
// down the page ("More info for Autumn", "Find inspiring art..."). Those
// unrelated "unknown" entries would otherwise drag the whole event's
// aggregate dashboard badge down to "UNKNOWN" even though the one real
// performance is genuinely sold out -- the same class of bug fixed
// earlier for Barbican and National Theatre, just a different venue's
// own template.
const RELATED_SECTION_CUTOFF_RE =
  /you\s+(might|may)\s+also\s+like|related\s+(events?|shows?|performances?)|similar\s+(events?|shows?)|recommended\s+for\s+you|more\s+(events?|shows?)\s+(like\s+this|you\s+might\s+(like|enjoy))|more\s+info\s+for|recently\s+announced/i;

function trimAtRelatedSection(text) {
  const match = text.match(RELATED_SECTION_CUTOFF_RE);
  return match ? text.slice(0, match.index) : text;
}

// Mirror image of the cutoff above: some pages put a chunk of noise
// BEFORE the real per-performance list instead of after it -- a header
// date range ("Mon 21 Sep -- Sat 10 Oct 2026"), booking-fee prose, member
// presale windows, all mentioning dates/times that aren't real bookable
// slots. The National Theatre's booking page is like this: everything
// before its "Dates and times for <show>" heading is marketing copy, not
// performances. Only trims when that specific heading text is actually
// found -- so it's a strict improvement (more real structure recognised)
// rather than a guess that could misfire on a page without one.
const DATES_HEADING_CUTOFF_RE = /dates?\s+and\s+times?\s+for\b|\bdates?\s+and\s+times?\b/i;

function trimBeforeDatesHeading(text) {
  const match = text.match(DATES_HEADING_CUTOFF_RE);
  return match ? text.slice(match.index) : text;
}

// Real bug found live (2026-09-21) via the Electra/Persona test event:
// the National Theatre's booking page prints a "Mon 21 September 2026 at
// 7:00 pm" heading immediately before re-stating that EXACT same date
// and time as two separate lines, right before the real per-performance
// status. Left in, each performance ends up contributing two date tokens
// and two time tokens instead of one, which desyncs the "pair each time
// with whichever date precedes it" windowing below across the WRONG
// performances -- the right NUMBER of results, but attached to the
// wrong specific dates. That's worse than just noisy: it sent real
// notifications naming the wrong performance as available. Since the
// heading is purely redundant with what immediately follows, strip it
// outright rather than try to tokenize it correctly.
const WEEKDAY_DATE_AT_TIME_HEADING_RE = new RegExp(
  `\\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\\w*\\s+${DATE_RE.source}\\s+at\\s+${TIME_RE.source}`,
  'gi'
);

function stripWeekdayDateAtTimeHeadings(text) {
  return text.replace(WEEKDAY_DATE_AT_TIME_HEADING_RE, '');
}

// Real bug found live (2026-09-23) on Soundwalk Collective's page: "4 Feb
// 2027, 7.30pm" and "04 Feb 2027, 7.30pm" are the exact same performance
// mentioned twice in different formats (once in a blurb, once in the
// booking widget), but a bare leading-zero difference meant they normalized
// to two different keys and survived as two separate "performances" for
// the same slot -- doubling that entry's weight in the dashboard and, worse,
// capable of showing one copy as sold_out and the other as available at
// once. Stripping a leading zero off any 1-2 digit run collapses both
// spellings of the same day-of-month onto one key.
function normalizeLabel(label) {
  return label
    .toLowerCase()
    .replace(/[.:]/g, ' ')
    .replace(/\b0(\d)\b/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function findTokens(re, text) {
  const tokens = [];
  let m;
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  while ((m = r.exec(text))) {
    tokens.push({ index: m.index, text: m[0].trim() });
    if (tokens.length > 500) break; // pathological input guard
  }
  return tokens;
}

// "5pm (doors 4.30pm)" -- the door time isn't a bookable slot, it's just
// when the room opens for the show right next to it. Same idea for "Touch
// Tour at 5.30pm" (a pre-show accessibility slot some venues list right
// next to the main showtime) -- neither is a separate bookable
// performance, so both would otherwise generate a bogus extra "slot" for
// the same date, one without the real showtime's own sold-out/available
// text nearby (National Theatre's access performances do exactly this).
// Drop any time token immediately preceded by one of these lead-in words.
const PRE_SHOW_MARKERS = ['doors', 'touch tour'];

// Venue OPENING HOURS ("Sunday, 10am – 11pm Monday, closed") are a
// different shape of the same problem: real bug seen live (2026-09-23,
// and matches noise seen earlier in Bob Dylan's pre-fix data too) on
// Southbank Centre's "For your visit" section, which restates the
// event's own date right before its building hours -- the date/time
// windowing below then pairs that unrelated "10am"/"11pm" with the
// event's real date, inventing two bogus extra "performances". The
// word "closed" a little further along is the reliable tell (a real
// showtime is never followed by "<weekday>, closed" -- that's uniquely
// opening-hours phrasing), so this looks FORWARD from the time token
// rather than backward like the markers above.
const OPENING_HOURS_LOOKAHEAD = 40;
function looksLikeOpeningHours(timeToken, text) {
  const after = text.slice(timeToken.index, timeToken.index + OPENING_HOURS_LOOKAHEAD).toLowerCase();
  return /\bclosed\b/.test(after);
}

function dropDoorsTimes(timeTokens, text) {
  return timeTokens.filter((t) => {
    const before = text.slice(Math.max(0, t.index - 20), t.index).toLowerCase();
    if (PRE_SHOW_MARKERS.some((marker) => before.includes(marker))) return false;
    if (looksLikeOpeningHours(t, text)) return false;
    return true;
  });
}

// Bounds each slot's classification window by its NEIGHBOURS in the text
// rather than a fixed radius -- so the "Sold Out" sitting right after one
// showtime can't bleed into the very next showtime's own window just
// because they're close together on the page (which they usually are).
// "Thu 3 Dec - Tue 8 Dec 2026" is ONE run's date range, not two separate
// performances -- if it were split into two, they'd both read whatever
// single status word sits near the range (e.g. one solitary "Sold Out"
// button for the whole run) and one of the two would end up "unknown"
// simply for being the token further from that text. Detected narrowly:
// only when two date tokens are separated by nothing but a dash/"to" (no
// other words in between) are they collapsed into one label covering the
// whole span -- a page that puts real per-date status text between two
// dates (Golden Boy's "12 November 2026 -- Sold Out / 13 November...")
// has far more than a bare separator in that gap, so it's untouched.
const RANGE_GAP_RE = /^\s*(-|–|—|to)\s*$/i;

function mergeDateRanges(dateTokens, text) {
  if (dateTokens.length < 2) return dateTokens;
  const sorted = [...dateTokens].sort((a, b) => a.index - b.index);
  const merged = [];
  let i = 0;
  while (i < sorted.length) {
    let current = sorted[i];
    while (i + 1 < sorted.length) {
      const next = sorted[i + 1];
      const gap = text.slice(current.index + current.text.length, next.index);
      if (!RANGE_GAP_RE.test(gap)) break;
      current = { index: current.index, text: `${current.text} – ${next.text}` };
      i += 1;
    }
    merged.push(current);
    i += 1;
  }
  return merged;
}

function windowsForSortedEntries(entries, text) {
  const sorted = [...entries].sort((a, b) => a.index - b.index);
  return sorted.map((entry, i) => {
    const next = sorted[i + 1];
    const start = Math.max(0, entry.index - LOOKBACK);
    const naturalEnd = next ? next.index : text.length;
    const end = Math.min(naturalEnd, entry.index + entry.length + MAX_SEGMENT);
    return { ...entry, windowText: text.slice(start, end) };
  });
}

/**
 * @param {string} text  rendered ticket-widget (or whole page) text
 * @param {string} fallbackLabel  used when no date/time tokens are found at all
 * @returns {{label: string, state: string, matched: string|null, snippet: string|null}[]}
 *          Always at least one entry.
 */
function parseInstancesFromText(text, fallbackLabel) {
  const clean = trimAtRelatedSection(
    trimBeforeDatesHeading(stripWeekdayDateAtTimeHeadings((text || '').replace(/[ \t]+/g, ' ')))
  );
  const dateTokens = mergeDateRanges(findTokens(DATE_RE, clean), clean);
  const timeTokens = dropDoorsTimes(findTokens(TIME_RE, clean), clean);

  if (dateTokens.length === 0 && timeTokens.length === 0) {
    // No structure to find -- same single-performance behaviour as before.
    return [{ label: fallbackLabel, ...classify(clean) }];
  }

  const raw = [];

  if (dateTokens.length > 1) {
    // Multiple dates: associate each time with whichever date precedes it
    // (a run listed date-by-date, times nested under each date).
    const sortedDates = [...dateTokens].sort((a, b) => a.index - b.index);
    for (let i = 0; i < sortedDates.length; i++) {
      const date = sortedDates[i];
      const segmentEnd = i + 1 < sortedDates.length ? sortedDates[i + 1].index : clean.length;
      const timesInSegment = timeTokens.filter((t) => t.index > date.index && t.index < segmentEnd);

      if (timesInSegment.length === 0) {
        raw.push({ label: date.text, index: date.index, length: date.text.length });
      } else {
        for (const t of timesInSegment) {
          raw.push({ label: `${date.text}, ${t.text}`, index: t.index, length: t.text.length });
        }
      }
    }
  } else if (timeTokens.length > 0) {
    // Zero or one date on the page, but multiple (or one) times -- label
    // each time with the single date if there is one (Barbican's case:
    // "21 November 2026" + "5pm" + "8.30pm").
    const datePrefix = dateTokens.length === 1 ? `${dateTokens[0].text}, ` : '';
    for (const t of timeTokens) {
      raw.push({ label: `${datePrefix}${t.text}`, index: t.index, length: t.text.length });
    }
  } else {
    // Exactly one date, no time tokens at all -- one performance, that date.
    raw.push({ label: dateTokens[0].text, index: dateTokens[0].index, length: dateTokens[0].text.length });
  }

  // Classify each token from a window of text around it, then merge
  // duplicate labels (the same date/time often appears twice on a page --
  // once in a blurb, once in the actual booking widget) preferring
  // whichever occurrence actually matched sold-out/available wording.
  const byLabel = new Map();
  const withWindows = windowsForSortedEntries(raw.slice(0, MAX_PERFORMANCES), clean);
  for (const entry of withWindows) {
    const result = classify(entry.windowText);
    const key = normalizeLabel(entry.label);
    const existing = byLabel.get(key);
    if (!existing || (existing.state === 'unknown' && result.state !== 'unknown')) {
      byLabel.set(key, { label: entry.label, ...result });
    }
  }

  const performances = [...byLabel.values()];
  return performances.length ? performances : [{ label: fallbackLabel, ...classify(clean) }];
}

module.exports = {
  parseInstancesFromText,
  normalizeLabel,
  trimAtRelatedSection,
  trimBeforeDatesHeading,
  stripWeekdayDateAtTimeHeadings,
  DATE_RE,
  TIME_RE,
};

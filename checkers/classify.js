// classify.js
//
// Pure text -> status classifier. No network, no browser -- this is the
// bit that decides "does this text mean sold out or does it mean I can
// book?", and it's kept separate and dependency-free so it can be unit
// tested with plain strings (see test/classifier.test.js).

// Order matters: sold-out/unavailable phrases are checked first, because
// a page can legitimately contain the word "book" in a sentence like
// "This event is sold out -- book onto the waiting list" while still
// meaning no seats are available.
const SOLD_OUT_PATTERNS = [
  /sold\s*out/i,
  /fully\s*booked/i,
  /no\s+(longer\s+)?availability/i,
  /not\s+currently\s+available/i,
  /currently\s+unavailable/i,
  /tickets?\s+are\s+not\s+available/i,
  /no\s+tickets?\s+(currently\s+)?available/i,
  /no\s+seats?\s+available/i,
  /join\s+the\s+waiting\s+list/i,
  /waitlist/i,
  /waiting\s*list/i,
  /returns?\s+only/i, // Spektrix/theatre convention: only returned tickets, none released yet
  /event\s+(has\s+)?sold\s+out/i,
  /this\s+(performance|show|event)\s+is\s+sold\s+out/i,
];

const AVAILABLE_PATTERNS = [
  /book\s+(now|tickets?|online|your\s+seats?)/i,
  /choose\s+(your\s+)?seats?/i,
  /select\s+(your\s+)?(tickets?|performance|seats?)/i,
  /buy\s+tickets?/i,
  /add\s+to\s+basket/i,
  /continue\s+booking/i,
  /reserve\s+(your\s+)?seats?/i,
  /get\s+tickets?/i,
  /find\s+tickets?/i,
  /purchase\s+tickets?/i,
  /tickets?\s+available/i,
  /view\s+availability/i,
  /choose\s+a?\s*date/i,
  // Real gap found live (2026-09-23): some pages (Southbank Centre's
  // "Correspondences" event) never show an explicit "Book now"-style
  // CTA in their rendered marketing-page text at all -- the only signal
  // that seats are on sale is a plain price mention ("Tickets from
  // £41", "Standard entry from £41"). Without this, a genuinely
  // on-sale show read as "unknown" -- and worse, if it later sold out
  // and then came BACK on sale (exactly the transition this tool
  // exists to catch), it would have kept reading "unknown" forever
  // too, silently missing the one notification that mattered. Safe to
  // add: SOLD_OUT_PATTERNS is always checked first, so a page that's
  // genuinely sold out but still shows old pricing text is still
  // caught correctly as sold_out.
  /(tickets?|entry)\s+(from|start(?:ing)?\s+(?:at|from))\s+£\d/i,
];

// Phrases that mean "the page hasn't finished loading the real answer yet"
// -- worth recognising explicitly so callers can retry rather than log a
// confusing "unknown".
const PENDING_PATTERNS = [/checking\s+availability/i, /please\s+wait/i, /fetching/i, /loading/i];

function firstMatch(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return null;
}

function snippetAround(text, match, radius = 80) {
  if (!match) return null;
  const idx = text.toLowerCase().indexOf(match.toLowerCase());
  if (idx === -1) return match;
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + match.length + radius);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

/**
 * Classify a blob of page/widget text as sold out, available, pending
 * (still loading), or unknown (neither pattern set matched -- usually
 * means the recipe is looking at the wrong bit of the page).
 *
 * @param {string} text
 * @returns {{state: 'sold_out'|'available'|'pending'|'unknown', matched: string|null, snippet: string|null}}
 */
function classify(text) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return { state: 'unknown', matched: null, snippet: null };

  const soldOutMatch = firstMatch(clean, SOLD_OUT_PATTERNS);
  if (soldOutMatch) {
    return {
      state: 'sold_out',
      matched: soldOutMatch,
      snippet: snippetAround(clean, soldOutMatch),
    };
  }

  const availableMatch = firstMatch(clean, AVAILABLE_PATTERNS);
  if (availableMatch) {
    return {
      state: 'available',
      matched: availableMatch,
      snippet: snippetAround(clean, availableMatch),
    };
  }

  const pendingMatch = firstMatch(clean, PENDING_PATTERNS);
  if (pendingMatch) {
    return {
      state: 'pending',
      matched: pendingMatch,
      snippet: snippetAround(clean, pendingMatch),
    };
  }

  return { state: 'unknown', matched: null, snippet: clean.slice(0, 160) };
}

module.exports = { classify, SOLD_OUT_PATTERNS, AVAILABLE_PATTERNS, PENDING_PATTERNS };

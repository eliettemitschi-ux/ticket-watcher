// Decides whether a show is worth an alert. "Will it sell out fast" can't be
// known before tickets exist, so this uses visible proxies and returns the
// reasons -- the Scanner page shows them, so a result is never a black box.
//
//   watchlist  -- a name/keyword you asked for (always qualifies)
//   limitedRun -- few performance dates, so little capacity overall
//   presale    -- a members presale / general-sale gate exists (demand signal)
//   premiere   -- billed as a (UK/world/European) premiere
//   venue      -- a venue-specific signal supplied by the source (e.g. the
//                 National Theatre's smallest auditorium, the Dorfman)
//
// Qualifies if any watchlist word matches, or at least `minSignals` of the
// other signals are present.

const PREMIERE_RE = /\b(?:uk|world|european|london)\s+premiere\b/i;

function matchWatchlist(record, watchlist) {
  const haystack = `${record.title || ''} ${record.text || ''}`.toLowerCase();
  return (watchlist || []).filter((w) => w && haystack.includes(String(w).toLowerCase()));
}

function limitedRunMax(record, config) {
  const byVenue = config.limitedRunByVenue || {};
  return record.venue in byVenue ? byVenue[record.venue] : config.limitedRunMaxDates;
}

function signalsFor(record, config) {
  const dateCount = (record.days || []).length;
  return {
    watchlist: matchWatchlist(record, config.watchlist),
    limitedRun: dateCount > 0 && dateCount <= limitedRunMax(record, config),
    presale: Boolean(record.sawGate),
    premiere: PREMIERE_RE.test(`${record.title || ''} ${record.text || ''}`),
  };
}

function qualify(record, config) {
  const signals = signalsFor(record, config);
  const reasons = [];
  if (signals.watchlist.length) reasons.push(`on your watchlist (${signals.watchlist.join(', ')})`);
  const soft = [];
  if (signals.limitedRun) soft.push(`short run (${record.days.length} date${record.days.length === 1 ? '' : 's'})`);
  if (signals.presale) soft.push('presale / general-sale gate');
  if (signals.premiere) soft.push('premiere');
  soft.push(...(record.venueSignals || []));
  const softQualifies = soft.length >= config.minSignals;
  if (softQualifies) reasons.push(...soft);
  return { qualifies: signals.watchlist.length > 0 || softQualifies, reasons };
}

module.exports = { qualify, signalsFor, matchWatchlist };

// The alert state machine. Pure: takes the previous record (or null), a fresh
// reading and context, returns the next record. Three kinds of alert exist,
// each sent at most once per show, ever:
//
//   announced -- a new show appeared that isn't on sale yet
//   headsUp   -- its opening time is known and is about to arrive
//   open      -- it has actually become bookable
//
// Readings: 'bookable' | 'sold_out' | 'gated' | 'not_on_sale' | 'error'
//
// Rules:
//   - The first run for a venue (baselineRun) records everything and alerts
//     on nothing, so shows that were already on sale never flood the phone.
//   - 'error' readings change nothing: a failed fetch is not evidence.
//   - Barbican answers "no tickets yet" with generic error text that a
//     transient hiccup could also produce, so waiting -> bookable must hold
//     for `confirmReadings` consecutive checks before the 'open' alert.
//   - Shows already on sale the first time they're seen ("surprise drops")
//     are deliberately ignored: the scanner looks ahead, not at what's live.
//   - Only shows that were waiting can fire 'open'. sold_out -> bookable (a
//     returns batch) belongs to the main watcher, not the scanner.
//   - Eligibility: a show you've ticked ('on') always alerts, one you've
//     unticked ('off') never does, otherwise it alerts if it qualifies.

const { headsUpWindow } = require('./time');

function isEligible(selection, qualifies) {
  if (selection === 'on') return true;
  if (selection === 'off') return false;
  return Boolean(qualifies);
}

function nextRecord(prev, reading, ctx) {
  const { now, baselineRun, config, listing, qualifyFn, selection } = ctx;
  const base = prev || {
    firstSeen: now,
    wasWaiting: false,
    isAnnouncement: false,
    sawGate: false,
    alertedAt: null,
    announcedAlertedAt: null,
    headsUpAt: null,
    state: null,
    bookableStreak: 0,
  };

  const record = {
    ...base,
    key: listing.key,
    venue: listing.venue,
    url: listing.url,
    venueSignals: listing.venueSignals || [],
    nodeId: listing.nodeId || base.nodeId || null,
    title: listing.title,
    tags: listing.tags,
    text: listing.text,
    days: listing.days,
    manual: Boolean(listing.manual),
    selection: selection || 'auto',
    lastSeenInListing: now,
  };

  // A show already seen live (bookable / sold out) can't go back to "not on
  // sale yet": that reading is a venue outage or glitch, so it counts as an
  // error. Without this, an outage followed by recovery would look like
  // hundreds of shows "going on sale" at once.
  // (A show mid-confirmation -- waiting, then one bookable reading so far --
  // is still allowed to flicker back; that is what the confirmation is for.)
  const midConfirmation =
    base.state === 'bookable' && base.wasWaiting && !base.alertedAt && (base.bookableStreak || 0) < config.confirmReadings;
  if (reading.state === 'not_on_sale' && (base.state === 'bookable' || base.state === 'sold_out') && !midConfirmation) {
    reading = { state: 'error', error: 'on-sale show briefly reported not on sale (ignored)' };
  }

  if (reading.state === 'error') {
    const q = qualifyFn(record);
    const eligible = isEligible(record.selection, q.qualifies);
    return { record: { ...record, qualifies: q.qualifies, reasons: q.reasons, eligible, lastError: reading.error || 'check failed' }, alert: false };
  }

  record.lastError = null;
  record.lastChecked = now;
  record.state = reading.state;
  record.generalSaleText = reading.generalSaleText || null;
  if (reading.opens !== undefined) record.opens = reading.opens;
  if (reading.pageDates !== undefined) record.pageDates = reading.pageDates;
  if (reading.datesCheckedAt !== undefined) record.datesCheckedAt = reading.datesCheckedAt;

  const waitingNow = reading.state === 'gated' || reading.state === 'not_on_sale';
  if (waitingNow) record.wasWaiting = true;
  if (!prev && !baselineRun) {
    // A show that first appears AFTER the baseline is a new announcement.
    // Even if its first reading looks sold out (a members-only phase can read
    // that way), it still counts as waiting for general sale -- but one that
    // is already bookable on first sight is a surprise drop, which is ignored.
    if (reading.state !== 'bookable') record.wasWaiting = true;
    record.isAnnouncement = waitingNow && !listing.manual;
  }
  if (reading.state === 'gated') record.sawGate = true;

  record.bookableStreak = reading.state === 'bookable' ? (base.bookableStreak || 0) + 1 : 0;

  const q = qualifyFn(record);
  record.qualifies = q.qualifies;
  record.reasons = q.reasons;
  record.eligible = isEligible(record.selection, q.qualifies);

  let alert = false;
  if (reading.state === 'bookable' && !record.alertedAt && !baselineRun && record.eligible) {
    if (record.wasWaiting && record.bookableStreak >= config.confirmReadings) {
      alert = true;
      record.alertedAt = now;
    }
  }

  return { record, alert };
}

/**
 * The earlier-stage alerts, evaluated on every run from the record alone.
 * @returns {('announced'|'headsUp')[]}
 */
function dueAlerts(record, nowMs, config, baselineRun) {
  const kinds = [];
  if (baselineRun || !record.eligible) return kinds;
  const waiting = record.state === 'gated' || record.state === 'not_on_sale';
  if (!waiting) return kinds;

  if (record.isAnnouncement && !record.announcedAlertedAt) kinds.push('announced');

  if (record.opens && record.opens.precision !== 'month' && !record.headsUpAt) {
    const w = headsUpWindow(record.opens, config.headsUpHoursBefore);
    if (nowMs >= w.from && nowMs <= w.until) kinds.push('headsUp');
  }
  return kinds;
}

module.exports = { nextRecord, dueAlerts, isEligible };

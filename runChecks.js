// runChecks.js
//
// The actual "check every event, notify on newly-available performances"
// logic -- pulled out on its own so it can be run two ways:
//
//   1. `node check.js`, a short-lived process, for cron/Task Scheduler.
//   2. On a plain setInterval() *inside* server.js, so the dashboard can
//      check itself automatically with nothing extra to install or
//      configure -- see server.js's "automatic checking" section.
//
// Both call exactly the same code, so there's only one place that could
// have a bug in the actual checking/notifying logic.

const { chromium } = require('playwright');
const { launchBrowser } = require('./browser');
const store = require('./store');
const { checkEvent } = require('./checkers');
const { normalizeLabel, parseDateFromLabel } = require('./checkers/parseMultiText');
const { notifyAvailable } = require('./notify');

// Same gating rule everywhere an event has a timeFilter set (e.g.
// "8.30pm"): only performances whose label contains it are worth waking
// someone up for.
function timeFilterAllows(label, timeFilter) {
  if (!timeFilter) return true;
  return normalizeLabel(label).includes(normalizeLabel(timeFilter));
}

// Real gap found live (2026-09-25): @sohoplace's own API reports prices
// with a single decimal digit ("£18.5", not "£18.50") -- requiring
// exactly two digits after the point missed that price entirely,
// silently falling back through to just the whole-pound part ("18") by
// luck rather than reading the true value. \d{1,2} covers both shapes.
const PRICE_RE = /£\s*(\d+(?:\.\d{1,2})?)/;

// event.maxPrice (GBP) gates a notification by whatever price text
// happens to be in the performance's own snippet (see classify.js's
// snippetAround -- for venues like National Theatre, the price sits
// right next to the booking button/status, so it's reliably captured
// there without a dedicated price-scraping step). A performance whose
// price can't be found still notifies: this tool exists to catch
// availability, and silently swallowing a real one because the text
// didn't happen to carry a price would be a worse failure than an
// occasional notification above budget.
function priceAllows(perf, maxPrice) {
  if (!maxPrice) return true;
  const snippet = perf.snippet || '';
  const m = PRICE_RE.exec(snippet);
  if (!m) return true;
  return Number(m[1]) <= maxPrice;
}

// Global, applies to every event regardless of venue: performances whose
// date falls in one of these ranges (inclusive) don't notify, because
// the user can't make those dates. Everything outside the range(s)
// still notifies normally, and the dashboard still shows the real
// status either way -- this only gates the alert, same as timeFilter.
function dateAllows(label, blockedDateRanges) {
  if (!blockedDateRanges || blockedDateRanges.length === 0) return true;
  const date = parseDateFromLabel(label);
  if (!date) return true; // no date to check against -- don't block on a guess
  return !blockedDateRanges.some(({ start, end }) => {
    const s = new Date(`${start}T00:00:00Z`);
    const e = new Date(`${end}T23:59:59Z`);
    return date >= s && date <= e;
  });
}

function shouldNotify(perf, event, settings) {
  if (!timeFilterAllows(perf.label, event.timeFilter)) {
    return { allowed: false, reason: `doesn't match the "${event.timeFilter}" time filter` };
  }
  if (!priceAllows(perf, event.maxPrice)) {
    return { allowed: false, reason: `price is above the £${event.maxPrice} cap` };
  }
  if (!dateAllows(perf.label, settings?.blockedDateRanges)) {
    return { allowed: false, reason: 'falls in a blocked date range' };
  }
  return { allowed: true };
}

/**
 * Checks every configured event once, updates the store, and fires
 * notifications for anything newly available (respecting each event's
 * timeFilter). Never throws for an individual event's check failure --
 * that's recorded against the event instead -- but a totally unexpected
 * crash (e.g. the browser itself won't launch at all) does propagate, so
 * the caller knows this run didn't complete.
 *
 * @param {(...args: any[]) => void} [log]  defaults to console.log with a
 *   timestamp prefix; pass a no-op to run silently.
 * @returns {Promise<{checked: number, notified: number}>}
 */
async function runAllChecks(log) {
  const logFn = log || ((...args) => console.log(`[${new Date().toISOString()}]`, ...args));

  // Archived events (tickets already secured) are skipped entirely --
  // no check, no notification, nothing left to watch for. They stay in
  // the data file so their title survives under "Archive" as a personal
  // record, just out of the active rotation.
  const events = store.listEvents().filter((e) => !e.archived);
  if (events.length === 0) {
    logFn('No events configured yet -- add one from the dashboard or with discover.js.');
    return { checked: 0, notified: 0 };
  }

  // Launch the browser lazily and only once, shared across every event
  // that needs render mode (or falls back to it) this run.
  let browser = null;
  async function getBrowser() {
    if (!browser) browser = await launchBrowser(chromium);
    return browser;
  }

  let notifiedCount = 0;
  const settings = store.getSettings();

  try {
    for (const event of events) {
      let result;
      try {
        const mode = event.recipe?.mode;
        const needsBrowser = mode !== 'api' && mode !== 'html-instances';
        result = await checkEvent(event, { browser: needsBrowser ? await getBrowser() : undefined });
        // api / html-instances modes can still fall back to render on
        // failure -- checkers/index.js handles that itself, but it needs a
        // browser to do so.
        if (result?.state === 'error' && (mode === 'api' || mode === 'html-instances')) {
          result = await checkEvent(event, { browser: await getBrowser() });
        }
      } catch (err) {
        result = { state: 'error', error: err.message };
      }

      if (result.state === 'error') {
        logFn(`ERROR checking "${event.name}": ${result.error}`);
        store.recordCheckError(event.id, result.error);
        continue;
      }

      const { event: updated, newlyAvailable, anyChanged } = store.updatePerformances(event.id, result);

      logFn(
        `"${event.name}": ${result.length} performance(s)${anyChanged ? ' (changed)' : ''} -> ${updated.status.state}`
      );

      for (const perf of newlyAvailable) {
        const verdict = shouldNotify(perf, updated, settings);
        if (!verdict.allowed) {
          logFn(`  "${perf.label}" is now available but ${verdict.reason} -- not notifying`);
          continue;
        }
        const label = updated.performances.length > 1 ? perf.label : undefined;
        const outcome = await notifyAvailable(updated, label);
        notifiedCount += 1;
        logFn(`  -> notified for "${perf.label}":`, JSON.stringify(outcome));
      }
    }
  } finally {
    if (browser) await browser.close();
  }

  if (notifiedCount === 0) logFn('Done. No new availability.');
  else logFn(`Done. Sent ${notifiedCount} notification(s).`);

  return { checked: events.length, notified: notifiedCount };
}

module.exports = { runAllChecks, shouldNotify, timeFilterAllows, priceAllows, dateAllows };

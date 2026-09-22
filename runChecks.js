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
const { normalizeLabel } = require('./checkers/parseMultiText');
const { notifyAvailable } = require('./notify');

// Same gating rule everywhere an event has a timeFilter set (e.g.
// "8.30pm"): only performances whose label contains it are worth waking
// someone up for.
function shouldNotify(label, timeFilter) {
  if (!timeFilter) return true;
  return normalizeLabel(label).includes(normalizeLabel(timeFilter));
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

  const events = store.listEvents();
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
        if (!shouldNotify(perf.label, updated.timeFilter)) {
          logFn(`  "${perf.label}" is now available but doesn't match the "${updated.timeFilter}" filter -- not notifying`);
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

module.exports = { runAllChecks, shouldNotify };

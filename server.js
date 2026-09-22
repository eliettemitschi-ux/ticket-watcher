#!/usr/bin/env node
// server.js -- the dashboard: a status page plus a tiny REST API for
// adding, force-checking, and removing watched events. Run this as a
// long-lived process. As long as it's running, it also checks every
// event automatically on a timer (see "Automatic checking" below) --
// nothing else to install or schedule. check.js still exists if you'd
// rather run checks from a separate scheduler instead (Task
// Scheduler/cron) -- see the README -- but for most setups you don't
// need it.

require('dotenv').config();
const path = require('path');
const express = require('express');
const basicAuth = require('express-basic-auth');
const { chromium } = require('playwright');
const { launchBrowser } = require('./browser');

const store = require('./store');
const { checkEvent } = require('./checkers');
const { discoverRecipe } = require('./checkers/discover');
const { runAllChecks, shouldNotify } = require('./runChecks');
const { notifyAvailable, ntfyConfigured, emailConfigured } = require('./notify');

async function notifyNewlyAvailable(event, newlyAvailable) {
  const outcomes = [];
  for (const perf of newlyAvailable) {
    if (!shouldNotify(perf.label, event.timeFilter)) {
      console.log(`[check]   "${perf.label}" is now available but doesn't match the "${event.timeFilter}" filter -- not notifying`);
      continue;
    }
    // Only pass a performance label when the event actually has more than
    // one -- for a plain single-performance event it would just repeat
    // the event's own name back.
    const label = event.performances && event.performances.length > 1 ? perf.label : undefined;
    const outcome = await notifyAvailable(event, label);
    console.log(`[check]   notified for "${perf.label}":`, JSON.stringify(outcome));
    outcomes.push({ label: perf.label, outcome });
  }
  return outcomes;
}

const app = express();
const PORT = process.env.PORT || 3000;
const POLL_INTERVAL_MINUTES = Number(process.env.POLL_INTERVAL_MINUTES || 10);
// Set AUTO_CHECK=false in .env if you'd rather this dashboard NOT check
// anything on its own -- e.g. because you're running check.js from your
// own scheduler instead and don't want it checked twice.
const AUTO_CHECK = String(process.env.AUTO_CHECK ?? 'true').toLowerCase() !== 'false';

// Nothing here should ever legitimately take more than this. Without a
// guard, a hung Chromium launch (blocked by antivirus, a broken profile,
// etc.) leaves the HTTP request -- and the "Checking..." button on the
// page -- waiting forever with no error and no way to tell what's wrong.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function closeBrowserSafely(browser) {
  if (!browser) return;
  try {
    await withTimeout(browser.close(), 5000, 'Closing the browser');
  } catch (err) {
    console.warn('Could not close browser cleanly:', err.message);
  }
}

// Scoped, not global: viewing the dashboard and its GET endpoints stays
// open to anyone with the link (the whole point of sharing it), but every
// route that changes something -- add/remove/recheck an event, send a
// test notification -- requires DASHBOARD_USER/PASSWORD when they're set.
// Visiting /admin once as a real page load (not from a fetch() call) is
// what actually triggers the browser's native login prompt; after that,
// the browser caches those Basic-auth credentials for this origin and
// attaches them automatically to the dashboard's own fetch() calls too,
// so the buttons just work for you after that one login.
const requireAuth =
  process.env.DASHBOARD_USER && process.env.DASHBOARD_PASSWORD
    ? basicAuth({
        users: { [process.env.DASHBOARD_USER]: process.env.DASHBOARD_PASSWORD },
        challenge: true,
      })
    : (req, res, next) => next();

if (!(process.env.DASHBOARD_USER && process.env.DASHBOARD_PASSWORD)) {
  console.warn(
    'DASHBOARD_USER/DASHBOARD_PASSWORD not set in .env -- add/remove/recheck are unauthenticated. ' +
      'Fine for localhost-only use, not recommended if this dashboard is reachable from the internet.'
  );
}

// admin.html deliberately lives OUTSIDE public/ (not the static-served
// directory) -- if it sat in public/ alongside index.html, Express's
// static middleware would serve it directly at /admin.html to anyone,
// bypassing requireAuth entirely and defeating the whole point of this
// route.
app.get('/admin', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.use(express.json());
// no-store: this dashboard's HTML/CSS/JS get edited fairly often during
// development, and browsers (Firefox especially) can otherwise hang onto
// a stale cached copy of app.js indefinitely -- even across new tabs --
// making an update silently invisible with no error of any kind.
app.use(
  express.static(path.join(__dirname, 'public'), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.set('Cache-Control', 'no-store'),
  })
);

app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    notifications: { ntfy: ntfyConfigured(), email: emailConfigured() },
    pollIntervalMinutes: POLL_INTERVAL_MINUTES,
    autoCheck: AUTO_CHECK,
    // The topic name is meant to be handed out -- it's what the dashboard
    // itself tells visitors to subscribe to for the same alerts (see the
    // "Get notified yourself" section on the page) -- not a secret.
    ntfy: ntfyConfigured()
      ? { topic: process.env.NTFY_TOPIC, server: (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '') }
      : null,
  });
});

app.get('/api/events', (req, res) => {
  res.json(store.listEvents());
});

// Fires a real notification on every configured channel right now, using a
// fake event -- lets you confirm ntfy/email are wired up correctly without
// waiting for (or faking) an actual show going on sale.
app.post('/api/test-notify', requireAuth, async (req, res) => {
  console.log(
    `[test-notify] button clicked. NTFY_TOPIC=${process.env.NTFY_TOPIC || '(not set)'} ` +
      `NTFY_SERVER=${process.env.NTFY_SERVER || 'https://ntfy.sh (default)'}`
  );

  if (!ntfyConfigured() && !emailConfigured()) {
    console.log('[test-notify] nothing configured -- see NTFY_TOPIC / SMTP_* in .env');
    return res.status(400).json({
      error: 'No notification channel is configured yet -- fill in NTFY_TOPIC and/or the SMTP settings in .env first.',
    });
  }
  const outcome = await notifyAvailable({
    name: 'Test notification from Ticket Watcher',
    venue: null,
    url: 'https://www.barbican.org.uk/',
  });
  console.log('[test-notify] result:', JSON.stringify(outcome));
  res.json(outcome);
});

app.post('/api/events', requireAuth, async (req, res) => {
  const { url, name, venue, timeFilter } = req.body || {};
  if (!url || !name) {
    return res.status(400).json({ error: 'Both "url" and "name" are required.' });
  }

  let browser;
  try {
    console.log(`[add-event] loading ${url} ...`);
    browser = await withTimeout(launchBrowser(chromium), 20000, 'Launching the browser');
    const { recipe } = await withTimeout(discoverRecipe(url, browser), 45000, 'Loading the event page');

    const event = store.addEvent({ name, venue, url, recipe, timeFilter });

    // Run a real check straight away (rather than just trusting
    // discoverRecipe's one-shot read) so the dashboard shows the actual
    // per-date/per-time breakdown immediately instead of "unknown" until
    // the next poll.
    const result = await withTimeout(checkEvent(event, { browser }), 45000, 'Checking the event page');
    if (result.state === 'error') {
      store.recordCheckError(event.id, result.error);
      console.warn(`[add-event] added "${name}" but the first check failed: ${result.error}`);
    } else {
      store.updatePerformances(event.id, result);
      console.log(
        `[add-event] added "${name}", ${result.length} performance(s) found: ` +
          result.map((p) => `${p.label}=${p.state}`).join(', ')
      );
    }

    res.status(201).json(store.getEvent(event.id));
  } catch (err) {
    console.warn(`[add-event] failed: ${err.message}`);
    res.status(500).json({ error: `Could not add event: ${err.message}` });
  } finally {
    await closeBrowserSafely(browser);
  }
});

app.post('/api/events/:id/check', requireAuth, async (req, res) => {
  const event = store.getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'No such event.' });

  let browser;
  try {
    const mode = event.recipe?.mode || 'render';
    console.log(`[check] "${event.name}" (mode: ${mode}) ...`);
    const needsBrowser = mode !== 'api' && mode !== 'html-instances';
    if (needsBrowser) browser = await withTimeout(launchBrowser(chromium), 20000, 'Launching the browser');

    let result = await withTimeout(checkEvent(event, { browser }), 60000, 'Checking the event page');
    if (result.state === 'error' && (mode === 'api' || mode === 'html-instances')) {
      if (!browser) browser = await withTimeout(launchBrowser(chromium), 20000, 'Launching the browser');
      result = await withTimeout(checkEvent(event, { browser }), 60000, 'Checking the event page');
    }

    if (result.state === 'error') {
      console.warn(`[check] "${event.name}" errored: ${result.error}`);
      store.recordCheckError(event.id, result.error);
      return res.status(200).json({ ...store.getEvent(event.id), checkError: result.error });
    }

    const { event: updated, newlyAvailable, anyChanged } = store.updatePerformances(event.id, result);

    console.log(
      `[check] "${event.name}": ${result.length} performance(s)${anyChanged ? ' (changed)' : ''} -> ${updated.status.state}`
    );

    if (newlyAvailable.length > 0) {
      await notifyNewlyAvailable(updated, newlyAvailable);
    }

    res.json(updated);
  } catch (err) {
    console.warn(`[check] "${event.name}" failed: ${err.message}`);
    store.recordCheckError(event.id, err.message);
    res.status(500).json({ error: `Check failed: ${err.message}` });
  } finally {
    await closeBrowserSafely(browser);
  }
});

// Change (or clear) which performance's label an event's notifications
// are gated to, without re-checking or touching anything else.
app.patch('/api/events/:id', requireAuth, (req, res) => {
  const { timeFilter } = req.body || {};
  try {
    const updated = store.setTimeFilter(req.params.id, timeFilter);
    res.json(updated);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.delete('/api/events/:id', requireAuth, (req, res) => {
  const removed = store.removeEvent(req.params.id);
  if (!removed) return res.status(404).json({ error: 'No such event.' });
  res.status(204).end();
});

app.listen(PORT, () => {
  console.log(`Ticket watcher dashboard running on http://localhost:${PORT}`);
});

// --- Automatic checking --------------------------------------------------
// The whole point: as long as this process is running (which it needs to
// be anyway, for the dashboard itself), events get checked on their own,
// on this timer -- no Task Scheduler, no cron, no separate thing to
// remember to start. A guard flag skips a tick rather than overlapping if
// one run is somehow still going when the next is due.
let autoCheckRunning = false;
async function runAutoCheck() {
  if (autoCheckRunning) {
    console.log('[auto-check] previous run is still going -- skipping this tick');
    return;
  }
  autoCheckRunning = true;
  try {
    console.log('[auto-check] checking all events...');
    await runAllChecks((...args) => console.log('[auto-check]', ...args));
  } catch (err) {
    console.warn('[auto-check] run failed:', err.message);
  } finally {
    autoCheckRunning = false;
  }
}

if (AUTO_CHECK) {
  console.log(`[auto-check] enabled -- every event will be checked automatically every ${POLL_INTERVAL_MINUTES} minute(s).`);
  // A short delay so the first (heavier, real-browser) run doesn't
  // compete with the server still finishing its own startup.
  setTimeout(runAutoCheck, 15000);
  setInterval(runAutoCheck, POLL_INTERVAL_MINUTES * 60 * 1000);
} else {
  console.log('[auto-check] disabled (AUTO_CHECK=false in .env) -- run "node check.js" yourself, on your own schedule, instead.');
}

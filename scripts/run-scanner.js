#!/usr/bin/env node
// Upcoming-shows scanner. Looks AHEAD at Barbican and the National Theatre:
// shows that are announced but not yet bookable. Sends up to three alerts per
// flagged show, each at most once: "announced", a "heads-up" shortly before
// the opening time (when one is published), and "on sale now".
//
//   node scripts/run-scanner.js            real run (writes docs/scanner.json, sends alerts)
//   node scripts/run-scanner.js --dry-run  prints what it would do, writes/sends nothing
//
// A venue that fails (or returns a suspiciously small listing) is skipped for
// this run WITHOUT touching its saved state; the other venue still runs. The
// process only exits non-zero if every venue failed.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const barbican = require('../scanner/barbican');
const nationalTheatre = require('../scanner/nationalTheatre');
const { crawlAnnouncements } = require('../scanner/ntAnnouncements');
const { nextRecord, dueAlerts } = require('../scanner/decide');
const { qualify } = require('../scanner/qualify');
const { alertMessage } = require('../scanner/messages');
const { londonToUtcMs } = require('../scanner/time');
const { postNtfy } = require('../notify');

const ROOT = path.resolve(__dirname, '..');

// Personal settings (watchlist names, hand-added shows, thresholds) can live
// in the PRIVATE repo as private-data/config.json, so they never appear in the
// public one. Only these keys may be overridden from there.
const PRIVATE_OVERRIDES = ['watchlist', 'manual', 'minSignals', 'limitedRunMaxDates', 'headsUpHoursBefore'];
const config = { ...require('../scanner/config.json') };
const privateConfigFile = path.join(ROOT, 'private-data', 'config.json');
if (fs.existsSync(privateConfigFile)) {
  const personal = JSON.parse(fs.readFileSync(privateConfigFile, 'utf8'));
  for (const key of PRIVATE_OVERRIDES) if (key in personal) config[key] = personal[key];
}
// Scanner data is private: it lives in a separate PRIVATE repo, checked out at
// private-data/ by the workflow. docs/ is published publicly by GitHub Pages,
// so the scanner refuses to read or write anything there.
const STATE_FILE = path.resolve(ROOT, process.env.SCANNER_FILE_PATH || 'private-data/scanner.json');
const SELECTIONS_FILE = path.resolve(ROOT, process.env.SCANNER_SELECTIONS_PATH || config.selectionsFile);
const DRY_RUN = process.argv.includes('--dry-run');

for (const file of [STATE_FILE, SELECTIONS_FILE]) {
  if (!path.relative(path.join(ROOT, 'docs'), file).startsWith('..')) {
    console.error(`Refusing to use ${file}: scanner data must never be inside the public docs/ folder.`);
    process.exit(1);
  }
}
if (!fs.existsSync(path.dirname(STATE_FILE))) {
  console.error(`Scanner data folder ${path.dirname(STATE_FILE)} does not exist (private repo not checked out) -- skipping.`);
  process.exit(0);
}

const SOURCES = [barbican, nationalTheatre];
// Shows announced ahead of sale, per venue (listings with a precomputed reading).
const ANNOUNCERS = {
  'National Theatre': (state, nowMs) => crawlAnnouncements(config, state.nt, nowMs),
};

function scannerTopic() {
  if (process.env.NTFY_SCANNER_TOPIC) return process.env.NTFY_SCANNER_TOPIC;
  return process.env.NTFY_TOPIC ? `${process.env.NTFY_TOPIC}-scanner` : null;
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveState(state) {
  const tmp = `${STATE_FILE}.tmp${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

async function pool(items, size, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    })
  );
}

const isWaiting = (s) => s === 'gated' || s === 'not_on_sale';
const slug = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const normTitle = (t) => String(t || '').toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '');
const isPendingKey = (k) => /^(ntp|manual)-/.test(k);

// config.manual: [{ title, venue, opensAt: "2026-11-03 10:00" (London time), url? }]
function manualListings(venue) {
  const out = new Map();
  for (const m of config.manual || []) {
    if (m.venue !== venue) continue;
    const t = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(m.opensAt || '');
    if (!t) {
      console.error(`manual entry "${m.title}" has an unreadable opensAt (${m.opensAt}) -- expected "YYYY-MM-DD HH:MM"`);
      continue;
    }
    const ms = londonToUtcMs(Number(t[1]), Number(t[2]) - 1, Number(t[3]), Number(t[4]), Number(t[5]));
    const key = `manual-${slug(m.title)}`;
    out.set(key, {
      key, venue, url: m.url || '', nodeId: null, title: m.title, tags: [], text: '', days: [], venueSignals: [],
      manual: true,
      reading: { state: 'not_on_sale', opens: { at: new Date(ms).toISOString(), precision: 'exact', source: 'added by you' } },
    });
  }
  return out;
}

function needsRead(prev, nowMs) {
  if (!prev || !prev.state) return true;
  if (isWaiting(prev.state)) return true;
  if (prev.state === 'bookable' && prev.wasWaiting && !prev.alertedAt && (prev.bookableStreak || 0) < config.confirmReadings) return true;
  const ageHours = (nowMs - new Date(prev.lastChecked || 0).getTime()) / 3600000;
  return ageHours >= config.recheckOnSaleAfterHours;
}

// A show announced earlier (or added by hand) and the venue's live listing
// are the same show: when its tickets appear, continue the SAME record so the
// "on sale now" alert fires, rather than treating it as a surprise drop.
function linkPending(crawled, pending, events, venue) {
  const byTitle = new Map();
  for (const [k, l] of pending) byTitle.set(normTitle(l.title), k);
  for (const [k, rec] of Object.entries(events)) {
    if (rec.venue === venue && isPendingKey(k) && isWaiting(rec.state)) byTitle.set(normTitle(rec.title), k);
  }
  for (const [k, l] of [...crawled]) {
    const pk = byTitle.get(normTitle(l.title));
    if (!pk || pk === k || events[k] || crawled.has(pk)) continue;
    crawled.delete(k);
    const was = pending.get(pk) || events[pk];
    crawled.set(pk, { ...l, key: pk, manual: Boolean(was && was.manual) });
    pending.delete(pk);
  }
}

// Returns the alerts to send: [{ record, kind }].
async function processVenue(source, crawled, pending, state, baselineRun, selections, now, nowMs) {
  const venue = source.VENUE;
  const events = state.events;
  const priorActive = Object.values(events).filter(
    (e) => e.venue === venue && !isPendingKey(e.key) && e.lastSeenInListing && nowMs - new Date(e.lastSeenInListing).getTime() < 3 * 86400000
  ).length;
  if (crawled.size === 0 || (priorActive >= 20 && crawled.size < priorActive * 0.5)) {
    throw new Error(`${venue} listing looks wrong (${crawled.size} events, ~${priorActive} expected)`);
  }

  linkPending(crawled, pending, events, venue);
  const all = new Map([...pending, ...crawled]);
  const entries = [...all.values()];

  const toRead = entries.filter((l) => !l.reading && needsRead(events[l.key], nowMs));
  console.log(`${venue}: ${crawled.size} listed, ${pending.size} announced/added${baselineRun ? ' (BASELINE: recording only, no alerts)' : ''}; reading status for ${toRead.length}`);

  const readings = new Map();
  for (const l of entries) if (l.reading) readings.set(l.key, l.reading);
  await pool(toRead, 8, async (l) => readings.set(l.key, await source.read(l)));
  if (source.enrich) {
    await pool(entries.filter((l) => readings.has(l.key) && isWaiting(readings.get(l.key).state)), 4, async (l) => {
      readings.set(l.key, await source.enrich(l, readings.get(l.key), events[l.key], nowMs));
    });
  }

  const qualifyFn = (rec) => qualify(rec, config);
  const alerts = [];
  for (const l of entries) {
    const prev = events[l.key] || null;
    const selection = selections[l.key] || (l.manual || (prev && prev.manual) ? 'on' : 'auto');
    if (!readings.has(l.key)) {
      // Not re-read this cycle: refresh listing fields only. lastChecked and
      // the streak must stay untouched or the daily re-check never fires.
      const refreshed = { ...prev, nodeId: l.nodeId || prev.nodeId, title: l.title, tags: l.tags, text: l.text, days: l.days, url: l.url, venue: l.venue, venueSignals: l.venueSignals || [], selection, lastSeenInListing: now };
      const q = qualifyFn(refreshed);
      events[l.key] = { ...refreshed, qualifies: q.qualifies, reasons: q.reasons };
      continue;
    }
    const silent = baselineRun || Boolean(l.silent && !prev);
    const { record, alert } = nextRecord(prev, readings.get(l.key), { now, baselineRun: silent, config, listing: l, qualifyFn, selection });
    events[l.key] = record;

    const kinds = dueAlerts(record, nowMs, config, silent);
    if (kinds.includes('announced') && kinds.includes('headsUp')) kinds.splice(kinds.indexOf('announced'), 1);
    if (!kinds.includes('announced') && record.isAnnouncement && !record.announcedAlertedAt && record.eligible && kinds.includes('headsUp')) {
      record.announcedAlertedAt = now; // folded into the heads-up
    }
    for (const kind of kinds) {
      if (kind === 'announced') record.announcedAlertedAt = now;
      if (kind === 'headsUp') record.headsUpAt = now;
      alerts.push({ record, kind });
    }
    if (alert) alerts.push({ record, kind: 'open' });
  }

  // Announced / hand-added shows that stopped appearing and never matched a
  // live listing are dropped from the "coming up" view after a couple of days.
  for (const [k, rec] of Object.entries(events)) {
    if (rec.venue === venue && isPendingKey(k) && isWaiting(rec.state) && !all.has(k) && nowMs - new Date(rec.lastSeenInListing || 0).getTime() > 2 * 86400000) {
      rec.state = 'expired';
    }
  }
  return alerts;
}

async function main() {
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const nowMs = nowDate.getTime();
  const existing = readJson(STATE_FILE, null);
  const state = existing || { version: 2, baselineAt: now, events: {}, venues: {} };
  state.venues = state.venues || {};
  state.nt = state.nt || {};
  const selections = readJson(SELECTIONS_FILE, {});
  const alerts = [];
  let succeeded = 0;

  for (const source of SOURCES) {
    const venue = source.VENUE;
    // Baseline is per venue, so adding a venue later records its existing
    // programme silently instead of alerting on all of it.
    const baselineRun = !state.venues[venue];
    try {
      const crawled = await source.crawl(config, nowDate);
      let pending = new Map();
      if (ANNOUNCERS[venue]) {
        try {
          pending = await ANNOUNCERS[venue](state, nowMs);
        } catch (err) {
          console.error(`${venue}: announcements skipped this run -- ${err.message}`);
        }
      }
      for (const [k, l] of manualListings(venue)) pending.set(k, l);
      alerts.push(...(await processVenue(source, crawled, pending, state, baselineRun, selections, now, nowMs)));
      state.venues[venue] = state.venues[venue] || { baselineAt: now };
      state.venues[venue].lastScan = now;
      succeeded += 1;
    } catch (err) {
      console.error(`${venue}: skipped this run -- ${err.message}`);
      if (state.venues[venue]) state.venues[venue].lastError = err.message;
    }
  }

  if (succeeded === 0) {
    console.error('Every venue failed -- nothing saved.');
    process.exit(1);
  }

  const topic = scannerTopic();
  for (const { record, kind } of alerts) {
    const { title, message } = alertMessage(kind, record);
    console.log(`ALERT [${kind}] -> ${title}`);
    if (DRY_RUN) continue;
    try {
      if (!topic) throw new Error('no ntfy topic configured (NTFY_TOPIC / NTFY_SCANNER_TOPIC unset)');
      await postNtfy(topic, { title, message, url: record.url || undefined });
    } catch (err) {
      console.error(`  alert failed (${err.message}) -- will retry next run`);
      if (kind === 'announced') record.announcedAlertedAt = null;
      if (kind === 'headsUp') record.headsUpAt = null;
      if (kind === 'open') record.alertedAt = null;
    }
  }

  const cutoff = nowMs - config.forgetUnseenAfterDays * 86400000;
  for (const [key, rec] of Object.entries(state.events)) {
    if (!rec.alertedAt && new Date(rec.lastSeenInListing || 0).getTime() < cutoff) delete state.events[key];
  }

  const counts = {};
  for (const r of Object.values(state.events)) {
    const k = `${r.venue}:${r.state || 'unknown'}`;
    counts[k] = (counts[k] || 0) + 1;
  }
  console.log('State counts:', JSON.stringify(counts), '| alerts this run:', alerts.length);

  state.updatedAt = now;
  state.topic = topic;
  state.settings = {
    barbicanArtforms: Object.values(config.barbican.artforms),
    watchlist: config.watchlist,
    limitedRunMaxDates: config.limitedRunMaxDates,
    minSignals: config.minSignals,
    headsUpHoursBefore: config.headsUpHoursBefore,
  };
  if (DRY_RUN) console.log('(dry run: nothing written or sent)');
  else saveState(state);
}

main().catch((err) => {
  console.error('Scanner failed:', err.message);
  process.exit(1);
});

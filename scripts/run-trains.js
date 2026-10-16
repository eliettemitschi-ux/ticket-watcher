#!/usr/bin/env node
// Eurostar Snap watcher: alerts once when tickets appear on a day that had none
// (or a new time window appears on a day that had some). Notifications only.
//
//   node scripts/run-trains.js [--dry-run]
//
// State lives in the PRIVATE repo checkout (private-data/trains.json), never
// under docs/. A blocked or odd response changes nothing and never alerts: the
// run is just skipped, so "can't see Snap" is never mistaken for "no tickets".

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { fetchSearch, searchUrl } = require('../trains/snap');
const { centersFor, diffDays } = require('../trains/diff');
const { postNtfy } = require('../notify');

const config = require('../trains/config.json');
const ROOT = path.resolve(__dirname, '..');
const STATE_FILE = path.resolve(ROOT, process.env.TRAINS_FILE_PATH || 'private-data/trains.json');
const DRY_RUN = process.argv.includes('--dry-run');

const rel = path.relative(path.join(ROOT, 'docs'), STATE_FILE);
if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
  console.error('Refusing to keep train data inside the public docs/ folder.');
  process.exit(1);
}
if (!fs.existsSync(path.dirname(STATE_FILE))) {
  console.error('Private data folder is not checked out -- skipping.');
  process.exit(0);
}

const topic = () => process.env.NTFY_TRAINS_TOPIC || (process.env.NTFY_TOPIC ? `${process.env.NTFY_TOPIC}-trains` : null);
const todayLondon = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
const dayLabel = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${iso}T12:00:00Z`));

// One snapshot of a route: { date: { price, slots } } for every day in range.
// Returns null if anything came back blocked / unreadable.
async function snapshot(route, today) {
  const days = {};
  for (const center of centersFor(route.from, route.to, today)) {
    const { status, parsed } = await fetchSearch(route, center);
    if (!parsed) { console.error(`  ${route.name}: HTTP ${status}, no date strip for ${center} (blocked or layout changed)`); return null; }
    for (const d of parsed.days) if (d.date >= route.from && d.date <= route.to && d.date >= today) days[d.date] = { price: d.price, slots: [] };
  }
  for (const date of Object.keys(days)) {
    if (days[date].price === null) continue;
    const { status, parsed } = await fetchSearch(route, date);
    if (!parsed) { console.error(`  ${route.name}: HTTP ${status}, no results for ${date}`); return null; }
    days[date].slots = parsed.slots;
  }
  return days;
}

const slotText = (slots) => slots.map((s) => `£${s.price} (${s.window.replace('-', ' to ')})`).join(', ');

async function main() {
  const today = todayLondon();
  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : { routes: {} };
  state.routes = state.routes || {};
  let sent = 0;

  for (const route of config.routes) {
    if (route.to < today) continue;
    const prev = state.routes[route.id] ? state.routes[route.id].days : null;
    let next = await snapshot(route, today);
    if (!next) continue;

    let alerts = diffDays(prev, next);
    if (alerts.length) {
      // Look once more before alerting, so a one-off glitch can't ping you.
      const again = await snapshot(route, today);
      alerts = again ? diffDays(prev, again).filter((a) => alerts.some((b) => b.date === a.date && b.kind === a.kind)) : [];
      next = again || next;
    }

    for (const a of alerts) {
      const title = `Eurostar Snap: ${dayLabel(a.date)} ${a.kind === 'day' ? 'has tickets' : 'has a new time window'}`;
      const message = `${route.name} · ${slotText(a.kind === 'day' ? a.slots : a.newSlots) || `from £${a.price}`}\nSnap trains are confirmed 48 hours before travel.`;
      console.log(`ALERT -> ${title} | ${message.split('\n')[0]}`);
      if (DRY_RUN) continue;
      try {
        if (!topic()) throw new Error('no ntfy topic configured');
        await postNtfy(topic(), { title, message, url: searchUrl(route, a.date) });
        sent += 1;
      } catch (err) {
        console.error(`  alert failed (${err.message}) -- will retry next run`);
        next[a.date] = prev && prev[a.date] ? prev[a.date] : { price: null, slots: [] }; // forget it so it re-alerts
      }
    }

    const summary = Object.entries(next).map(([d, v]) => `${d.slice(5)}:${v.price === null ? '-' : '£' + v.price}`).join(' ');
    console.log(`${route.name}${prev ? '' : ' (baseline, no alerts)'}: ${summary} | alerts: ${alerts.length}`);
    state.routes[route.id] = { days: next, updatedAt: new Date().toISOString() };
  }

  if (!DRY_RUN) fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  if (sent) console.log(`Sent ${sent} notification(s).`);
}

main().catch((err) => { console.error('Snap watcher failed:', err.message); process.exit(1); });

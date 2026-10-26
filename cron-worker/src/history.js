// cron-worker/src/history.js
//
// Records how Eurostar Snap prices behave, for the owner's Stats tab. Once an
// hour (its own cron trigger, separate from the 5-minute alerts) it looks at the
// cheapest Snap price for every travel day in the next 21 days, London to Paris
// and Paris to London, and appends only what CHANGED to snap-history.json in the
// private repo. One Snap search covers five days, so a look costs about ten
// requests. No alerts, no notifications. The rules live in trains/history.js; the
// numbers are worked out in docs/stats.js when the tab is opened.
//
// "Can't see" is never recorded as "no tickets": if Snap does not answer or the
// page cannot be read, that route is skipped for the hour and the gap is logged
// ('b' when it starts, 'o' when it ends).

import { readJson, writeJson, todayLondon, fetchSearch } from './snap.js';
import { ROUTES as ROUTE_DEFS, centersForDates } from '../../trains/diff.js';
import { ROUTES, MAX_EVENTS, horizonDates, diffPrices, stamp } from '../../trains/history.js';

const HISTORY_FILE = 'snap-history.json';
// Rewritten at least this often even if nothing changed, so the Stats tab can tell the job is alive.
const HEARTBEAT_MS = 6 * 60 * 60 * 1000;

// Cheapest price for each watched day on one route ({date: price|null}), or null if any look failed.
async function lookAtRoute(routeId, today) {
  const route = ROUTE_DEFS[routeId];
  const dates = horizonDates(today);
  const prices = {};
  for (const center of centersForDates(dates)) {
    const { status, parsed } = await fetchSearch(route, center);
    if (!parsed) { console.error(`History ${routeId}: HTTP ${status}, no date strip for ${center}`); return null; }
    for (const d of parsed.days) if (dates.includes(d.date)) prices[d.date] = d.price;
  }
  for (const d of dates) if (!(d in prices)) { console.error(`History ${routeId}: ${d} missing from the strips`); return null; }
  return prices;
}

export async function runHistory(env, now = new Date()) {
  const today = todayLondon(now);
  const time = stamp(now);
  const { data, sha } = await readJson(env, HISTORY_FILE, null);
  const hist = data || { version: 1, since: time, horizonDays: horizonDates(today).length, last: {}, blocked: {}, events: [] };
  hist.last = hist.last || {};
  hist.blocked = hist.blocked || {};
  hist.events = hist.events || [];

  const added = [];
  let seen = 0;
  for (const routeId of ROUTES) {
    const prices = await lookAtRoute(routeId, today);
    if (!prices) {
      if (!hist.blocked[routeId]) { hist.blocked[routeId] = time; added.push([time, routeId, null, null, 'b']); }
      continue;
    }
    seen += 1;
    if (hist.blocked[routeId]) { delete hist.blocked[routeId]; added.push([time, routeId, null, null, 'o']); }
    added.push(...diffPrices(hist.last[routeId] || {}, prices, routeId, time));
    hist.last[routeId] = prices; // only today onwards, so days that have gone drop out by themselves
  }

  let capped = Boolean(hist.capped);
  if (added.length && hist.events.length + added.length > MAX_EVENTS) capped = true;
  if (!capped) hist.events.push(...added);
  hist.capped = capped;

  const stale = !hist.checkedAt || now - new Date(hist.checkedAt) >= HEARTBEAT_MS;
  const changed = added.length > 0;
  if (changed || stale) {
    hist.checkedAt = now.toISOString();
    await writeJson(env, HISTORY_FILE, hist, sha, changed ? 'History: update' : 'History: heartbeat', { pretty: false });
  }
  return { routesSeen: seen, events: capped ? 0 : added.length, capped, saved: changed || stale };
}

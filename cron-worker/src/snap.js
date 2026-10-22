// cron-worker/src/snap.js
//
// Eurostar Snap watcher, run every 5 minutes by index.js. It lives on
// Cloudflare rather than GitHub Actions because Snap's bot check (added
// 13 Oct 2026) answers GitHub's runners with HTTP 403 but still serves
// Cloudflare's network (tested 22 Oct 2026).
//
// Reads the trips you add in the site's owner-only Trains tab
// (snap-trips.json in the PRIVATE repo), checks Snap for every watched date,
// pushes news to ntfy, and keeps what it saw in snap-state.json (same repo)
// so the Trains tab can show it. The page reading and the "what counts as
// news" rules are shared with the Node tests (trains/snapParse.js, diff.js).

import { HEADERS, searchUrl, parseSearchHtml } from '../../trains/snapParse.js';
import { ROUTES, watchedDates, centersForDates, diffDays, alertText, channelsFor, topicFor } from '../../trains/diff.js';

const PRIVATE_API = 'https://api.github.com/repos/eliettemitschi-ux/ticket-watcher-private/contents';
const TRIPS_FILE = 'snap-trips.json';
const STATE_FILE = 'snap-state.json';
const BLOCKED_ALERT_AFTER_MS = 30 * 60 * 1000;
// The state file is only rewritten when something changes, plus this often as
// a heartbeat so the Trains tab can tell the watcher is still alive.
const HEARTBEAT_MS = 6 * 60 * 60 * 1000;

const todayLondon = (now) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(now);

function ghHeaders(env, raw) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'ticket-watcher-cron-worker',
  };
}

// Returns { data, sha }, or { data: fallback, sha: null } if the file doesn't exist yet.
async function readJson(env, file, fallback) {
  const res = await fetch(`${PRIVATE_API}/${file}`, { headers: ghHeaders(env, false) });
  if (res.status === 404) return { data: fallback, sha: null };
  if (!res.ok) throw new Error(`GitHub ${file}: ${res.status}`);
  const meta = await res.json();
  const bytes = Uint8Array.from(atob(meta.content.replace(/\n/g, '')), (c) => c.charCodeAt(0));
  return { data: JSON.parse(new TextDecoder().decode(bytes) || 'null') || fallback, sha: meta.sha };
}

async function writeJson(env, file, data, sha, message) {
  const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2) + '\n');
  const content = btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));
  const res = await fetch(`${PRIVATE_API}/${file}`, {
    method: 'PUT',
    headers: { ...ghHeaders(env, false), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content, ...(sha ? { sha } : {}) }),
  });
  if (!res.ok) throw new Error(`GitHub save ${file}: ${res.status}`);
}

async function fetchSearch(route, date) {
  const res = await fetch(searchUrl(route, date), { headers: HEADERS, signal: AbortSignal.timeout(20000) });
  const html = await res.text();
  return { status: res.status, parsed: res.ok ? parseSearchHtml(html, date) : null };
}

// One look at a route: { date: { price, slots } } for every watched date, or
// null if anything came back blocked / unreadable ("can't see" is never "no tickets").
async function snapshot(route, dates) {
  const days = {};
  const slotsFor = {};
  for (const center of centersForDates(dates)) {
    const { status, parsed } = await fetchSearch(route, center);
    if (!parsed) { console.error(`Snap ${route.name}: HTTP ${status}, no date strip for ${center}`); return null; }
    slotsFor[center] = parsed.slots;
    for (const d of parsed.days) if (dates.includes(d.date)) days[d.date] = { price: d.price, slots: [] };
  }
  for (const date of dates) {
    if (!days[date]) { console.error(`Snap ${route.name}: ${date} missing from the strip`); return null; }
    if (days[date].price === null) continue;
    if (!slotsFor[date]) {
      const { status, parsed } = await fetchSearch(route, date);
      if (!parsed) { console.error(`Snap ${route.name}: HTTP ${status}, no results for ${date}`); return null; }
      slotsFor[date] = parsed.slots;
    }
    days[date].slots = slotsFor[date];
  }
  return days;
}

async function notify(env, { title, message, click, topic }) {
  const server = (env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
  // JSON publishing, so the £ sign and accents survive (headers can't carry them).
  const res = await fetch(server, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: topic || env.NTFY_TRAINS_TOPIC, title, message, priority: 5, tags: ['train'], ...(click ? { click } : {}) }),
  });
  if (!res.ok) throw new Error(`ntfy responded ${res.status}`);
}

export async function runSnap(env, now = new Date()) {
  if (!env.NTFY_TRAINS_TOPIC) throw new Error('NTFY_TRAINS_TOPIC is not set');
  const today = todayLondon(now);
  const [{ data: tripsFile }, { data: state, sha }] = await Promise.all([
    readJson(env, TRIPS_FILE, { trips: [] }),
    readJson(env, STATE_FILE, { routes: {} }),
  ]);
  const before = JSON.stringify({ routes: state.routes, blocked: state.blocked || null });
  const watched = watchedDates(tripsFile.trips, today);
  let blocked = false;
  let sent = 0;

  for (const route of Object.values(ROUTES)) {
    const dates = watched[route.id];
    if (!dates.length) { delete state.routes[route.id]; continue; }
    const prev = (state.routes[route.id] && state.routes[route.id].days) || {};
    let next = await snapshot(route, dates);
    if (!next) { blocked = true; continue; }

    let alerts = diffDays(prev, next);
    if (alerts.length) {
      // Look once more before alerting, so a one-off glitch can't ping you.
      const again = await snapshot(route, dates);
      alerts = again ? diffDays(prev, again).filter((a) => alerts.some((b) => b.date === a.date && b.kind === a.kind)) : [];
      next = again || next;
    }
    const leg = route.id === 'london-paris' ? 'out' : 'back';
    for (const a of alerts) {
      try {
        // Each trip's own channel hears about its dates; trips without one use the main channel.
        for (const channel of channelsFor(tripsFile.trips, leg, a.date)) {
          await notify(env, { ...alertText(route, a), click: searchUrl(route, a.date), topic: topicFor(env.NTFY_TRAINS_TOPIC, channel) });
          sent += 1;
        }
      } catch (err) {
        console.error(`Snap alert failed (${err.message}), will retry next run`);
        next[a.date] = prev[a.date] || { price: null, slots: [] }; // forget it so it re-alerts
      }
    }
    state.routes[route.id] = { days: next };
  }

  // Being blocked once is normal noise; being blocked for half an hour means
  // Snap may have shut Cloudflare out too, which you need to know.
  if (blocked) {
    state.blocked = state.blocked || { since: now.toISOString(), alerted: false };
    if (!state.blocked.alerted && now - new Date(state.blocked.since) >= BLOCKED_ALERT_AFTER_MS) {
      await notify(env, { title: "Snap watcher can't see Eurostar", message: 'Snap has refused every check for 30 minutes, so you may miss tickets. You will get a message when it works again.' })
        .then(() => { state.blocked.alerted = true; })
        .catch((err) => console.error(`Snap blocked alert failed: ${err.message}`));
    }
  } else if (state.blocked) {
    if (state.blocked.alerted) {
      await notify(env, { title: 'Snap watcher is working again', message: 'Eurostar Snap is answering again, so alerts are back on.' })
        .catch((err) => console.error(`Snap recovery alert failed: ${err.message}`));
    }
    state.blocked = null;
  }

  const changed = JSON.stringify({ routes: state.routes, blocked: state.blocked || null }) !== before;
  const stale = !state.checkedAt || now - new Date(state.checkedAt) >= HEARTBEAT_MS;
  if (changed || stale) {
    state.checkedAt = now.toISOString();
    await writeJson(env, STATE_FILE, state, sha, changed ? 'Snap: update' : 'Snap: heartbeat');
  }
  return { watched, blocked, sent, saved: changed || stale };
}

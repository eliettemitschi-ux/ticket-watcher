// cron-worker/src/friend.js
//
// Lets a friend add and remove their OWN Snap journeys from a page on the site
// (docs/friend.html) without any access to the private repo. The Worker holds
// the repo token; the friend holds a personal key that the Worker maps to their
// alert channel and name (FRIEND_KEYS secret):
//   {"<key>": {"channel": "pierre", "name": "Pierre",
//              "maxDates": 4,          // optional, default 12, never more than 12
//              "passport": true,       // optional: show the passport reminder
//              "note": true}}          // optional: show the "personal link" note
// A bare string instead of an object is just the channel, with the defaults.
//
// What a key can do: list, add and remove journeys on its own channel, within
// the limits below. It cannot see anyone else's journeys or any other file.
// Every request is checked here; the page is just a convenience.
//
// A journey ("leg") is one From, one To and one day. Both stations must be a
// pair Snap sells (ALLOWED in trains/diff.js).
//
//   GET     -> { routes: [{from, to, label, dates: [{date, state, price?}]}], stations, allowed, ... }
//   POST    {from, to, date}                         adds one journey; saved at once
//   DELETE  ?from=paris&to=brussels&date=YYYY-MM-DD  removes one journey
//
// A friend has ONE trip in snap-trips.json (tagged with their channel) holding
// all their legs, so there is nothing for them to name or group. Trips saved in
// the older shape ({city, out, back}) are read as legs and rewritten as legs the
// next time that friend changes anything. The older request shapes (POST
// {city, out, back}, DELETE ?city&leg&date) are still accepted so that a page
// opened before an update keeps working.

import { readJson, writeJson, todayLondon } from './snap.js';
import { cleanChannel, topicFor, STATIONS, ALLOWED, ROUTES, legsOf } from '../../trains/diff.js';
import { addDays } from '../../trains/snapParse.js';

const TRIPS_FILE = 'snap-trips.json';
const STATE_FILE = 'snap-state.json';
const ALLOWED_ORIGIN = 'https://eliettemitschi-ux.github.io';
const MAX_DATES = 12; // most journeys per friend; a key can lower it
const MAX_DAYS_AHEAD = 120;

const cors = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin',
};
const reply = (body, status = 200) => Response.json(body, { status, headers: cors });
const fail = (status, message) => reply({ error: message }, status);

const isRealDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T12:00:00Z`).toISOString().startsWith(s);
const liveLegs = (trip, today) => legsOf(trip).filter((l) => l.date >= today);
const routeOf = (l) => `${l.from}-${l.to}`;
const legKey = (l) => `${routeOf(l)}|${l.date}`;

// The friend's settings for the key on this request, or null if it is not a known key.
function friendFor(request, env) {
  const key = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!key) return null;
  let keys = {};
  try { keys = JSON.parse(env.FRIEND_KEYS || '{}'); } catch { return null; }
  if (!Object.prototype.hasOwnProperty.call(keys, key)) return null;
  const entry = keys[key];
  const channel = cleanChannel(typeof entry === 'string' ? entry : entry && entry.channel);
  if (!channel) return null;
  const o = entry && typeof entry === 'object' ? entry : {};
  const cap = Number.isInteger(o.maxDates) && o.maxDates >= 1 ? Math.min(o.maxDates, MAX_DATES) : MAX_DATES;
  return { channel, name: o.name ? String(o.name).slice(0, 30) : '', maxDates: cap, passport: o.passport === true, note: o.note === true };
}

// Applies one change to the freshest snap-trips.json, retrying once if it
// changed underneath us. Trips with nothing left to watch (anyone's) are dropped.
async function change(env, today, apply) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, sha } = await readJson(env, TRIPS_FILE, { trips: [] });
    const next = apply(data.trips || []);
    if (next.error) return next;
    const trips = next.filter((t) => liveLegs(t, today).length);
    try {
      await writeJson(env, TRIPS_FILE, { trips }, sha, 'Friend: update Snap trips');
      return { trips };
    } catch (err) {
      if (attempt === 1 || !/ 409| 422/.test(err.message)) throw err;
    }
  }
  return { error: 'Could not save, please try again.' };
}

// The journeys in a POST body: {from, to, date}, or the older {city, out: [...], back: [...]}.
function legsFromBody(body) {
  if (body.from !== undefined || body.to !== undefined || body.date !== undefined) return [{ from: body.from, to: body.to, date: body.date }];
  const city = body.city === undefined ? 'paris' : body.city;
  const legs = [];
  for (const d of Array.isArray(body.out) ? body.out : []) legs.push({ from: 'london', to: city, date: d });
  for (const d of Array.isArray(body.back) ? body.back : []) legs.push({ from: city, to: 'london', date: d });
  return legs;
}

// Why a journey is refused, or '' if it is fine.
function problemWith(leg, today) {
  if (!STATIONS[leg.from] || !STATIONS[leg.to]) return 'Pick a station to travel from and to.';
  if (leg.from === leg.to) return 'Pick two different stations.';
  if (!ROUTES[routeOf(leg)]) return 'Snap does not sell that journey. Try a different station.';
  if (!isRealDate(leg.date)) return 'That date is not valid.';
  if (leg.date < today) return 'That date has already gone.';
  if (leg.date > addDays(today, MAX_DAYS_AHEAD)) return `Dates can be at most ${MAX_DAYS_AHEAD} days ahead.`;
  return '';
}

export async function handleFriend(request, env, now = new Date()) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const friend = friendFor(request, env);
  if (!friend) return fail(401, 'This link is not valid. Ask Eliette for a new one.');
  const { channel, name, maxDates, passport, note } = friend;
  const today = todayLondon(now);
  const url = new URL(request.url);
  const isMine = (t) => cleanChannel(t.channel) === channel;

  try {
    if (request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return fail(400, 'That did not come through. Please try again.'); }
      const added = legsFromBody(body);
      if (!added.length) return fail(400, 'Add at least one date.');
      for (const leg of added) {
        const problem = problemWith(leg, today);
        if (problem) return fail(400, problem);
      }
      const result = await change(env, today, (trips) => {
        const mine = trips.filter(isMine);
        const others = trips.filter((t) => !isMine(t));
        const legs = new Map();
        for (const t of mine) for (const l of liveLegs(t, today)) legs.set(legKey(l), l);
        for (const l of added) legs.set(legKey(l), { from: l.from, to: l.to, date: l.date });
        if (legs.size > maxDates) return { error: `You can watch up to ${maxDates} dates at once. Remove one first.` };
        const first = mine[0] || {};
        const sorted = [...legs.values()].sort((a, b) => legKey(a).localeCompare(legKey(b)));
        const trip = { id: first.id || `f${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`, channel, legs: sorted, addedAt: first.addedAt || now.toISOString() };
        return [...others, trip];
      });
      if (result.error) return fail(400, result.error);
    } else if (request.method === 'DELETE') {
      const p = url.searchParams;
      let from = p.get('from');
      let to = p.get('to');
      const date = p.get('date');
      if (!from && p.get('leg')) { // older pages: ?city=brussels&leg=out|back
        const city = p.get('city') || 'paris';
        from = p.get('leg') === 'out' ? 'london' : city;
        to = p.get('leg') === 'out' ? city : 'london';
      }
      if (!ROUTES[`${from}-${to}`] || !isRealDate(date)) return fail(400, 'Which date?');
      const result = await change(env, today, (trips) => trips.map((t) => (isMine(t)
        ? { id: t.id, channel: t.channel, addedAt: t.addedAt, legs: legsOf(t).filter((l) => !(l.from === from && l.to === to && l.date === date)) }
        : t)));
      if (result.error) return fail(400, result.error);
    } else if (request.method !== 'GET') {
      return fail(405, 'Not supported.');
    }

    // Always answer with the friend's own journeys (never anyone else's) and what the watcher last saw.
    const [{ data: file }, { data: state }] = await Promise.all([
      readJson(env, TRIPS_FILE, { trips: [] }),
      readJson(env, STATE_FILE, { routes: {} }),
    ]);
    const mine = (file.trips || []).filter(isMine).flatMap((t) => liveLegs(t, today));
    // One entry per route that has dates, in a fixed order (London first, then Paris, Brussels, Amsterdam).
    const routes = Object.values(ROUTES)
      .map((route) => {
        const dates = [...new Set(mine.filter((l) => routeOf(l) === route.id).map((l) => l.date))]
          .sort()
          .map((date) => {
            const day = state.routes && state.routes[route.id] && state.routes[route.id].days && state.routes[route.id].days[date];
            return !day ? { date, state: 'unknown' } : day.price === null ? { date, state: 'none' } : { date, state: 'tickets', price: day.price };
          });
        // city and leg are only there for pages opened before the From/To update (London routes only).
        const legacy = route.from === 'london' ? { city: route.to, leg: 'out' } : route.to === 'london' ? { city: route.from, leg: 'back' } : {};
        return { id: route.id, from: route.from, to: route.to, ...legacy, label: `${STATIONS[route.from].name} → ${STATIONS[route.to].name}`, dates };
      })
      .filter((r) => r.dates.length);
    const stations = Object.entries(STATIONS).map(([id, s]) => ({ id, name: s.name }));
    return reply({ channel, name, passport, note, topic: topicFor(env.NTFY_TRAINS_TOPIC, channel), today, maxDates, stations, allowed: ALLOWED, routes, checkedAt: state.checkedAt || null, blocked: Boolean(state.blocked) });
  } catch (err) {
    console.error('friend API failed:', err.message);
    return fail(500, 'Something went wrong. Please try again in a minute.');
  }
}

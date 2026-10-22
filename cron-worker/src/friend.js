// cron-worker/src/friend.js
//
// Lets a friend add and remove their OWN Snap dates from a page on the site
// (docs/friend.html) without any access to the private repo. The Worker holds
// the repo token; the friend holds a personal key that the Worker maps to their
// alert channel (FRIEND_KEYS secret: {"<key>": "pierre"}).
//
// What a key can do: list, add and remove trips tagged with its own channel,
// within the limits below. It cannot see anyone else's trips or any other
// file. Every request is checked here; the page is just a convenience.

import { readJson, writeJson, todayLondon } from './snap.js';
import { cleanChannel, topicFor } from '../../trains/diff.js';
import { addDays } from '../../trains/snapParse.js';

const TRIPS_FILE = 'snap-trips.json';
const STATE_FILE = 'snap-state.json';
const ALLOWED_ORIGIN = 'https://eliettemitschi-ux.github.io';
const MAX_DATES = 12; // live dates per friend, across all their trips
const MAX_DAYS_AHEAD = 120;
const ROUTE_OF = { out: 'london-paris', back: 'paris-london' };

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
const liveDates = (trip, today) => [...(trip.out || []), ...(trip.back || [])].filter((d) => d >= today);

function channelFor(request, env) {
  const key = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!key) return null;
  let keys = {};
  try { keys = JSON.parse(env.FRIEND_KEYS || '{}'); } catch { return null; }
  return Object.prototype.hasOwnProperty.call(keys, key) ? cleanChannel(keys[key]) || null : null;
}

// Applies one change to the freshest snap-trips.json, retrying once if it
// changed underneath us. Finished trips (anyone's) are dropped on the way.
async function change(env, today, apply) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, sha } = await readJson(env, TRIPS_FILE, { trips: [] });
    const next = apply(data.trips || []);
    if (next.error) return next;
    const trips = next.filter((t) => liveDates(t, today).length);
    try {
      await writeJson(env, TRIPS_FILE, { trips }, sha, 'Friend: update Snap trips');
      return { trips };
    } catch (err) {
      if (attempt === 1 || !/ 409| 422/.test(err.message)) throw err;
    }
  }
  return { error: 'Could not save, please try again.' };
}

export async function handleFriend(request, env, now = new Date()) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const channel = channelFor(request, env);
  if (!channel) return fail(401, 'This link is not valid. Ask Eliette for a new one.');
  const today = todayLondon(now);
  const url = new URL(request.url);

  try {
    if (request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return fail(400, 'That did not come through. Please try again.'); }
      const out = Array.isArray(body.out) ? body.out : [];
      const back = Array.isArray(body.back) ? body.back : [];
      const all = [...out, ...back];
      if (!all.length) return fail(400, 'Add at least one date.');
      if (!all.every(isRealDate)) return fail(400, 'One of those dates is not valid.');
      if (all.some((d) => d < today)) return fail(400, 'One of those dates has already gone.');
      if (all.some((d) => d > addDays(today, MAX_DAYS_AHEAD))) return fail(400, `Dates can be at most ${MAX_DAYS_AHEAD} days ahead.`);
      const result = await change(env, today, (trips) => {
        const mine = trips.filter((t) => cleanChannel(t.channel) === channel);
        const already = mine.reduce((n, t) => n + liveDates(t, today).length, 0);
        if (already + all.length > MAX_DATES) return { error: `You can watch up to ${MAX_DATES} dates at once. Remove one first.` };
        const trip = { id: `f${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`, out: [...new Set(out)].sort(), back: [...new Set(back)].sort(), channel, addedAt: now.toISOString() };
        return [...trips, trip];
      });
      if (result.error) return fail(400, result.error);
    } else if (request.method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (!id) return fail(400, 'Which trip?');
      const result = await change(env, today, (trips) => trips.filter((t) => !(t.id === id && cleanChannel(t.channel) === channel)));
      if (result.error) return fail(400, result.error);
    } else if (request.method !== 'GET') {
      return fail(405, 'Not supported.');
    }

    // Always answer with the friend's own trips (never anyone else's) and what the watcher last saw.
    const [{ data: file }, { data: state }] = await Promise.all([
      readJson(env, TRIPS_FILE, { trips: [] }),
      readJson(env, STATE_FILE, { routes: {} }),
    ]);
    const trips = (file.trips || [])
      .filter((t) => cleanChannel(t.channel) === channel && liveDates(t, today).length)
      .map((t) => {
        const seen = (leg) => Object.fromEntries((t[leg] || []).map((d) => {
          const day = state.routes && state.routes[ROUTE_OF[leg]] && state.routes[ROUTE_OF[leg]].days && state.routes[ROUTE_OF[leg]].days[d];
          return [d, !day ? { state: 'unknown' } : day.price === null ? { state: 'none' } : { state: 'tickets', price: day.price }];
        }));
        return { id: t.id, out: t.out || [], back: t.back || [], seen: { out: seen('out'), back: seen('back') } };
      });
    return reply({ channel, topic: topicFor(env.NTFY_TRAINS_TOPIC, channel), today, maxDates: MAX_DATES, trips, checkedAt: state.checkedAt || null, blocked: Boolean(state.blocked) });
  } catch (err) {
    console.error('friend API failed:', err.message);
    return fail(500, 'Something went wrong. Please try again in a minute.');
  }
}

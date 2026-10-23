// test/friendApi.test.mjs -- run with: node test/friendApi.test.mjs
// The Worker's friend API (cron-worker/src/friend.js) against a FAKE private
// repo. The point of these tests: a friend's key can manage trips on their own
// channel and NOTHING else (no sight of other trips, no removing them, limits
// enforced, unknown keys refused).

import { handleFriend } from '../cron-worker/src/friend.js';

let failures = 0;
function check(name, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (!pass) {
    console.log('  expected:', JSON.stringify(expected));
    console.log('  actual:  ', JSON.stringify(actual));
  }
}

const files = {};
let shaN = 0;
let saves = 0;
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
globalThis.fetch = async (url, opts = {}) => {
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const name = String(url).split('/contents/')[1];
  if (!name) throw new Error(`unexpected fetch ${url}`);
  if ((opts.method || 'GET') === 'GET') return files[name] ? json({ content: b64(files[name].text), sha: files[name].sha }) : json({}, 404);
  const body = JSON.parse(opts.body);
  files[name] = { text: Buffer.from(body.content, 'base64').toString('utf8'), sha: `sha${++shaN}` };
  saves += 1;
  return json({ content: { sha: files[name].sha } }, 201);
};

const env = { GITHUB_TOKEN: 't', NTFY_TRAINS_TOPIC: 'T-trains', FRIEND_KEYS: JSON.stringify({
  'PIERRE-KEY-0123456789': { channel: 'pierre', name: 'Pierre', passport: true },
  'MARIE-KEY-0123456789': 'marie',
  'ZELIE-KEY-0123456789': { channel: 'zelie', name: 'Zélie', maxDates: 4, note: true },
  'BIG-KEY-0123456789': { channel: 'big', maxDates: 99 },
  'ODD-KEY-0123456789': { channel: 'odd', maxDates: 'lots' },
}) };
const NOW = new Date('2026-10-22T12:00:00Z');
const PIERRE = 'PIERRE-KEY-0123456789';
const call = (method, key, { query = '', body } = {}) => handleFriend(
  new Request(`https://w.example/friend${query}`, { method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }),
  env,
  NOW,
);
const trips = () => JSON.parse(files['snap-trips.json'].text).trips;

files['snap-trips.json'] = { sha: 's0', text: JSON.stringify({ trips: [
  { id: 'mine', out: ['2026-11-05'], back: [] },
  { id: 'marie1', out: ['2026-11-20'], back: [], channel: 'marie' },
  { id: 'old', out: ['2020-01-01'], back: [], channel: 'pierre' },
] }) };
files['snap-state.json'] = { sha: 'st', text: JSON.stringify({ checkedAt: '2026-10-22T11:58:00Z', routes: { 'london-paris': { days: { '2026-11-08': { price: 45, slots: [] }, '2026-11-09': { price: null, slots: [] } } } } }) };

// --- Who is allowed in -----------------------------------------------------
let body2;
let r = await call('GET', null);
check('no key: refused', r.status, 401);
r = await call('GET', 'not-a-real-key');
check('wrong key: refused', r.status, 401);
r = await call('GET', '__proto__');
check('a key named like an object property: refused', r.status, 401);
check('refusals do not reveal trips', JSON.stringify(await r.json()).includes('2026'), false);
r = await call('OPTIONS', null);
check('browser preflight: allowed from the site only', [r.status, r.headers.get('access-control-allow-origin')], [204, 'https://eliettemitschi-ux.github.io']);

// --- Seeing your own trips only ---------------------------------------------
r = await call('GET', PIERRE);
let body = await r.json();
check('GET: pierre sees no trips yet (not yours, not marie, not the finished one)', [r.status, body.channel, body.topic, body.trips], [200, 'pierre', 'T-trains-pierre', []]);
check('GET: a key with a name returns it', body.name, 'Pierre');
check('GET: pierre has the passport reminder, no personal-link note, and the default cap', [body.passport, body.note, body.maxDates], [true, false, 12]);
r = await call('GET', 'ZELIE-KEY-0123456789');
body2 = await r.json();
check('GET: a friend with a cap of 4 gets the personal-link note, no passport reminder, and an accented name', [body2.name, body2.passport, body2.note, body2.maxDates, body2.topic], ['Zélie', false, true, 4, 'T-trains-zelie']);
r = await call('GET', 'BIG-KEY-0123456789');
check('GET: a cap above 12 is brought down to 12', (await r.json()).maxDates, 12);
r = await call('GET', 'ODD-KEY-0123456789');
check('GET: a nonsense cap falls back to 12', (await r.json()).maxDates, 12);
r = await call('GET', PIERRE);
body = await r.json();
r = await call('GET', 'MARIE-KEY-0123456789');
check('GET: a key that is just a channel string still works, with no name', [r.status, (await r.json()).name], [200, '']);
check('GET: says when the watcher last reported', body.checkedAt, '2026-10-22T11:58:00Z');

// --- Adding ------------------------------------------------------------------
r = await call('POST', PIERRE, { body: { out: ['2026-11-09', '2026-11-08'], back: ['2026-11-12'] } });
body = await r.json();
check('POST: adds a trip', [r.status, body.trips.length], [200, 1]);
check('POST: dates sorted, trip tagged with his channel', [body.trips[0].out, body.trips[0].back], [['2026-11-08', '2026-11-09'], ['2026-11-12']]);
check('POST: shows what the watcher saw for each date', [body.trips[0].seen.out['2026-11-08'], body.trips[0].seen.out['2026-11-09'], body.trips[0].seen.back['2026-11-12']], [{ state: 'tickets', price: 45 }, { state: 'none' }, { state: 'unknown' }]);
check('POST: saved with channel pierre', trips().find((t) => t.id === body.trips[0].id).channel, 'pierre');
check('POST: your own trip and marie\'s are untouched', [trips().some((t) => t.id === 'mine'), trips().some((t) => t.id === 'marie1')], [true, true]);
check('POST: finished trips are tidied away', trips().some((t) => t.id === 'old'), false);
check('GET: the response never includes anyone else\'s trip', JSON.stringify(body).includes('2026-11-20') || JSON.stringify(body).includes('"mine"'), false);
const pierreTripId = body.trips[0].id;

// --- Refusing bad input -----------------------------------------------------
const before = saves;
for (const [label, payload, msg] of [
  ['no dates', { out: [], back: [] }, /at least one date/],
  ['not a date', { out: ['next friday'] }, /not valid/],
  ['an impossible date', { out: ['2026-02-31'] }, /not valid/],
  ['a date in the past', { out: ['2026-10-01'] }, /already gone/],
  ['a date too far ahead', { out: ['2027-06-01'] }, /120 days/],
]) {
  r = await call('POST', PIERRE, { body: payload });
  check(`POST: ${label} is refused with a plain message`, [r.status, msg.test((await r.json()).error)], [400, true]);
}
check('refused requests save nothing', saves, before);

// --- The limit ---------------------------------------------------------------
const many = Array.from({ length: 9 }, (_, i) => `2026-12-${String(i + 1).padStart(2, '0')}`);
r = await call('POST', PIERRE, { body: { out: [...many, '2026-12-10'] } });
check('POST: 3 dates already + 10 more would be 13 and is refused', [r.status, /up to 12/.test((await r.json()).error)], [400, true]);
r = await call('POST', PIERRE, { body: { out: many } });
check('POST: filling up to exactly 12 is allowed', r.status, 200);
r = await call('POST', 'MARIE-KEY-0123456789', { body: { out: ['2026-11-25'] } });
check('limits are per friend: marie is not affected by pierre\'s dates', r.status, 200);

// --- A lower cap for some friends -----------------------------------------------
const ZELIE = 'ZELIE-KEY-0123456789';
r = await call('POST', ZELIE, { body: { out: ['2026-11-05', '2026-11-06'], back: ['2026-11-09'] } });
check('cap 4: three dates are allowed', r.status, 200);
r = await call('POST', ZELIE, { body: { back: ['2026-11-10', '2026-11-11'] } });
body = await r.json();
check('cap 4: a fifth date is refused, saying the cap', [r.status, body.error], [400, 'You can watch up to 4 dates at once. Remove one first.']);
r = await call('POST', ZELIE, { body: { back: ['2026-11-10'] } });
check('cap 4: exactly four is allowed', r.status, 200);
r = await call('POST', ZELIE, { body: { out: ['2026-12-20'] } });
check('cap 4: a fifth after that is refused too', r.status, 400);

// --- Removing ----------------------------------------------------------------
r = await call('DELETE', PIERRE, { query: '?id=mine' });
check('DELETE: pierre cannot remove your trip', [r.status, trips().some((t) => t.id === 'mine')], [200, true]);
r = await call('DELETE', PIERRE, { query: '?id=marie1' });
check('DELETE: pierre cannot remove marie\'s trip', trips().some((t) => t.id === 'marie1'), true);
r = await call('DELETE', PIERRE, { query: `?id=${pierreTripId}` });
body = await r.json();
check('DELETE: pierre can remove his own trip', [r.status, trips().some((t) => t.id === pierreTripId), body.trips.some((t) => t.id === pierreTripId)], [200, false, false]);
r = await call('DELETE', PIERRE);
check('DELETE: needs to say which trip', r.status, 400);
r = await call('PUT', PIERRE);
check('other methods are refused', r.status, 405);

if (failures > 0) { console.error(`\n${failures} test(s) failed.`); process.exit(1); }
console.log('\nAll friend API tests passed.');

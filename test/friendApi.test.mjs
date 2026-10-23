// test/friendApi.test.mjs -- run with: node test/friendApi.test.mjs
// The Worker's friend API (cron-worker/src/friend.js) against a FAKE private
// repo. A friend adds ONE journey (From, To, date) and it is saved at once; all of
// a friend's journeys live in ONE trip. The point of these tests: a key can
// manage journeys on its own channel and NOTHING else (no sight of other
// people's, no removing them, limits enforced, unknown keys refused, only
// journeys Snap sells), and older trips and older pages still work.

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

const env = {
  GITHUB_TOKEN: 't',
  NTFY_TRAINS_TOPIC: 'T-trains',
  FRIEND_KEYS: JSON.stringify({
    'PIERRE-KEY-0123456789': { channel: 'pierre', name: 'Pierre', passport: true },
    'MARIE-KEY-0123456789': 'marie',
    'ZELIE-KEY-0123456789': { channel: 'zelie', name: 'Zélie', maxDates: 4, note: true },
    'BIG-KEY-0123456789': { channel: 'big', maxDates: 99 },
    'ODD-KEY-0123456789': { channel: 'odd', maxDates: 'lots' },
  }),
};
const NOW = new Date('2026-10-22T12:00:00Z');
const PIERRE = 'PIERRE-KEY-0123456789';
const MARIE = 'MARIE-KEY-0123456789';
const ZELIE = 'ZELIE-KEY-0123456789';
const call = (method, key, { query = '', body } = {}) => handleFriend(
  new Request(`https://w.example/friend${query}`, { method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }),
  env,
  NOW,
);
const add = (key, from, to, date) => call('POST', key, { body: { from, to, date } });
const remove = (key, from, to, date) => call('DELETE', key, { query: `?from=${from}&to=${to}&date=${date}` });
const trips = () => JSON.parse(files['snap-trips.json'].text).trips;
const tripsOf = (channel) => trips().filter((t) => t.channel === channel);
const lists = (b) => b.routes.map((r) => [r.label, r.dates.map((e) => e.date)]);
const route = (b, id) => b.routes.find((r) => r.id === id) || { dates: [] };

files['snap-trips.json'] = { sha: 's0', text: JSON.stringify({ trips: [
  { id: 'mine', out: ['2026-11-05'], back: [] },
  { id: 'marie1', out: ['2026-11-20'], back: [], channel: 'marie' },
  { id: 'old', out: ['2020-01-01'], back: [], channel: 'pierre' },
] }) };
files['snap-state.json'] = { sha: 'st', text: JSON.stringify({ checkedAt: '2026-10-22T11:58:00Z', routes: {
  'london-paris': { days: { '2026-11-08': { price: 45, slots: [] }, '2026-11-09': { price: null, slots: [] } } },
  'paris-brussels': { days: { '2026-11-12': { price: 33, slots: [] } } },
} }) };

// --- Who is allowed in -----------------------------------------------------
let r = await call('GET', null);
check('no key: refused', r.status, 401);
r = await call('GET', 'not-a-real-key');
check('wrong key: refused', r.status, 401);
r = await call('GET', '__proto__');
check('a key named like an object property: refused', r.status, 401);
check('refusals do not reveal dates', JSON.stringify(await r.json()).includes('2026'), false);
r = await call('OPTIONS', null);
check('browser preflight: allowed from the site only', [r.status, r.headers.get('access-control-allow-origin')], [204, 'https://eliettemitschi-ux.github.io']);

// --- Seeing your own journeys only --------------------------------------------
r = await call('GET', PIERRE);
let body = await r.json();
check('GET: pierre sees nothing yet (not your dates, not marie\'s, not his finished one)', [r.status, body.channel, body.topic, body.routes], [200, 'pierre', 'T-trains-pierre', []]);
check('GET: the reply says which stations exist and where Snap goes from each', [body.stations.map((s) => s.id), body.allowed.brussels], [['london', 'paris', 'brussels', 'amsterdam'], ['london', 'paris']]);
check('GET: a key with a name returns it, and pierre has the passport reminder, no note, the default cap', [body.name, body.passport, body.note, body.maxDates], ['Pierre', true, false, 12]);
r = await call('GET', ZELIE);
let z = await r.json();
check('GET: a friend with a cap of 4 gets the note, no passport reminder, an accented name', [z.name, z.passport, z.note, z.maxDates, z.topic], ['Zélie', false, true, 4, 'T-trains-zelie']);
r = await call('GET', MARIE);
let m = await r.json();
check('GET: a key that is just a channel string still works, with no name, and only sees her own (old-style) date', [r.status, m.name, lists(m)], [200, '', [['London → Paris', ['2026-11-20']]]]);
r = await call('GET', 'BIG-KEY-0123456789');
check('GET: a cap above 12 is brought down to 12', (await r.json()).maxDates, 12);
r = await call('GET', 'ODD-KEY-0123456789');
check('GET: a nonsense cap falls back to 12', (await r.json()).maxDates, 12);
check('GET: says when the watcher last reported', (await (await call('GET', PIERRE)).json()).checkedAt, '2026-10-22T11:58:00Z');

// --- Adding one journey saves it ------------------------------------------------
r = await add(PIERRE, 'london', 'paris', '2026-11-08');
body = await r.json();
check('POST: one journey is added and answered with the new list', [r.status, lists(body)], [200, [['London → Paris', ['2026-11-08']]]]);
check('POST: it is saved in the repo as legs, in one trip tagged with his channel', tripsOf('pierre').map((t) => t.legs), [[{ from: 'london', to: 'paris', date: '2026-11-08' }]]);
check('POST: his finished date is tidied away', JSON.stringify(trips()).includes('2020'), false);
check('POST: your own trip and marie\'s are untouched', [trips().some((t) => t.id === 'mine' && t.out[0] === '2026-11-05'), trips().some((t) => t.id === 'marie1')], [true, true]);
const pierreTripId = tripsOf('pierre')[0].id;
await add(PIERRE, 'london', 'paris', '2026-11-09');
r = await add(PIERRE, 'paris', 'london', '2026-11-12');
body = await r.json();
check('POST: more journeys join the same single trip, listed route by route', [lists(body), tripsOf('pierre').length, tripsOf('pierre')[0].id === pierreTripId], [[['London → Paris', ['2026-11-08', '2026-11-09']], ['Paris → London', ['2026-11-12']]], 1, true]);
check('POST: shows what the watcher saw for each date', [route(body, 'london-paris').dates[0], route(body, 'london-paris').dates[1], route(body, 'paris-london').dates[0]], [{ date: '2026-11-08', state: 'tickets', price: 45 }, { date: '2026-11-09', state: 'none' }, { date: '2026-11-12', state: 'unknown' }]);
r = await add(PIERRE, 'london', 'paris', '2026-11-08');
check('POST: adding a journey already watched changes nothing', [r.status, lists(await r.json()).length, tripsOf('pierre')[0].legs.length], [200, 2, 3]);
check('GET: the response never includes anyone else\'s journeys', JSON.stringify(body).includes('2026-11-20') || JSON.stringify(body).includes('2026-11-05'), false);

// --- Any station Snap sells, not only London -------------------------------------
r = await add(PIERRE, 'paris', 'brussels', '2026-11-12');
body = await r.json();
check('stations: Paris to Brussels works, and shows its own status', [r.status, route(body, 'paris-brussels').label, route(body, 'paris-brussels').dates[0]], [200, 'Paris → Brussels', { date: '2026-11-12', state: 'tickets', price: 33 }]);
check('stations: routes come in a fixed order (London first, then Paris...)', body.routes.map((x) => x.id), ['london-paris', 'paris-london', 'paris-brussels']);
r = await add(PIERRE, 'amsterdam', 'london', '2026-11-13');
check('stations: Amsterdam to London works', [r.status, route(await r.json(), 'amsterdam-london').dates.length], [200, 1]);
check('stations: all the journeys stay in his one trip', [tripsOf('pierre').length, tripsOf('pierre')[0].legs.length], [1, 5]);

// --- Refusing bad input ---------------------------------------------------------
const before = saves;
for (const [label, send, msg] of [
  ['Brussels to Amsterdam (Snap does not sell it)', () => add(PIERRE, 'brussels', 'amsterdam', '2026-11-14'), /does not sell that journey/],
  ['the same station twice', () => add(PIERRE, 'london', 'london', '2026-11-14'), /two different stations/],
  ['a station we do not know', () => add(PIERRE, 'london', 'atlantis', '2026-11-14'), /Pick a station/],
  ['no stations at all', () => call('POST', PIERRE, { body: { date: '2026-11-14' } }), /Pick a station/],
  ['no date', () => call('POST', PIERRE, { body: { from: 'london', to: 'paris' } }), /not valid/],
  ['not a date', () => add(PIERRE, 'london', 'paris', 'next friday'), /not valid/],
  ['an impossible date', () => add(PIERRE, 'london', 'paris', '2026-02-31'), /not valid/],
  ['a date in the past', () => add(PIERRE, 'london', 'paris', '2026-10-01'), /already gone/],
  ['a date too far ahead', () => add(PIERRE, 'london', 'paris', '2027-06-01'), /120 days/],
]) {
  r = await send();
  check(`POST: ${label} is refused with a plain message`, [r.status, msg.test((await r.json()).error)], [400, true]);
}
check('refused requests save nothing', saves, before);

// --- The limit (pierre: 12) ----------------------------------------------------
const many = Array.from({ length: 8 }, (_, i) => `2026-12-${String(i + 1).padStart(2, '0')}`);
for (const d of many.slice(0, 7)) await add(PIERRE, 'london', 'paris', d);
r = await add(PIERRE, 'london', 'brussels', '2026-12-20');
check('limit 12: with 12 watched (5 + 7), a thirteenth on another route is refused', r.status, 400);
r = await add(PIERRE, 'london', 'paris', many[7]);
check('limit 12: one more past twelve is refused, in any route', [r.status, (await r.json()).error], [400, 'You can watch up to 12 dates at once. Remove one first.']);
r = await add(PIERRE, 'london', 'paris', '2026-12-01');
check('limit 12: re-adding a journey already watched is fine even when full', r.status, 200);
r = await add(MARIE, 'london', 'paris', '2026-11-25');
check('limits are per friend: marie is not affected by pierre\'s journeys', r.status, 200);

// --- A cap of 4: one journey at a time, like the page does -----------------------
await add(ZELIE, 'london', 'paris', '2026-12-11');
await add(ZELIE, 'london', 'paris', '2027-01-15');
await add(ZELIE, 'paris', 'london', '2026-12-13');
r = await add(ZELIE, 'paris', 'london', '2027-01-17');
z = await r.json();
check('cap 4: four journeys added one by one (two in December, two in January) are all saved', [r.status, lists(z)], [200, [['London → Paris', ['2026-12-11', '2027-01-15']], ['Paris → London', ['2026-12-13', '2027-01-17']]]]);
r = await add(ZELIE, 'london', 'brussels', '2026-12-20');
check('cap 4: a fifth, on a different route, is refused saying the cap', [r.status, (await r.json()).error], [400, 'You can watch up to 4 dates at once. Remove one first.']);
r = await add(ZELIE, 'london', 'paris', '2026-12-11');
check('cap 4: re-adding a watched journey is not a fifth', r.status, 200);
r = await remove(ZELIE, 'london', 'paris', '2027-01-15');
z = await r.json();
check('remove: just that journey goes, and a place is freed', [r.status, lists(z)], [200, [['London → Paris', ['2026-12-11']], ['Paris → London', ['2026-12-13', '2027-01-17']]]]);
r = await add(ZELIE, 'paris', 'amsterdam', '2026-12-20');
check('cap 4: the freed place can be used on any route', [r.status, route(await r.json(), 'paris-amsterdam').dates.length], [200, 1]);
r = await remove(ZELIE, 'london', 'paris', '2026-12-13');
check('remove: the direction matters (that date is only Paris to London)', lists(await r.json()).length, 3);
r = await remove(PIERRE, 'london', 'paris', '2026-11-05');
check('remove: pierre cannot remove a date from your own trip', trips().some((t) => t.id === 'mine' && t.out.includes('2026-11-05')), true);
r = await remove(PIERRE, 'london', 'paris', '2026-11-20');
check('remove: pierre cannot remove a date from marie\'s trip', trips().some((t) => t.channel === 'marie' && JSON.stringify(t).includes('2026-11-20')), true);
check('remove: removing is checked like adding (bad station, bad date, nothing)', [(await remove(PIERRE, 'brussels', 'amsterdam', '2026-11-08')).status, (await call('DELETE', PIERRE, { query: '?from=london&to=paris&date=whenever' })).status, (await call('DELETE', PIERRE)).status], [400, 400, 400]);
r = await remove(ZELIE, 'london', 'paris', '2026-12-11');
await remove(ZELIE, 'paris', 'london', '2026-12-13');
await remove(ZELIE, 'paris', 'london', '2027-01-17');
await remove(ZELIE, 'paris', 'amsterdam', '2026-12-20');
check('remove: taking away a friend\'s last journey removes their trip entirely', tripsOf('zelie').length, 0);

// --- Older trips and older pages keep working --------------------------------------
r = await call('GET', MARIE);
m = await r.json();
check('compat: an older-style trip (out/back, no legs) is read as journeys', lists(m), [['London → Paris', ['2026-11-20', '2026-11-25']]]);
check('compat: and rewritten as legs, keeping its id, when the friend next changes anything', [tripsOf('marie').length, tripsOf('marie')[0].id, tripsOf('marie')[0].out], [1, 'marie1', undefined]);
r = await call('POST', MARIE, { body: { city: 'brussels', out: ['2026-12-02'], back: ['2026-12-04'] } });
m = await r.json();
check('compat: an older page\'s add ({city, out, back}) still works', [r.status, lists(m).slice(1)], [200, [['London → Brussels', ['2026-12-02']], ['Brussels → London', ['2026-12-04']]]]);
r = await call('POST', MARIE, { body: { out: ['2026-12-06'] } });
check('compat: no city meant Paris', route(await r.json(), 'london-paris').dates.map((e) => e.date), ['2026-11-20', '2026-11-25', '2026-12-06']);
r = await call('POST', MARIE, { body: { city: 'atlantis', out: ['2026-12-06'] } });
check('compat: an unknown city is refused', r.status, 400);
r = await call('DELETE', MARIE, { query: '?city=brussels&leg=back&date=2026-12-04' });
check('compat: an older page\'s remove (?city&leg&date) still works', route(await r.json(), 'brussels-london').dates.length, 0);
body = await (await call('GET', MARIE)).json();
check('compat: London routes also carry city and leg for older pages; others do not', [route(body, 'london-brussels').city, route(body, 'london-brussels').leg, route(body, 'london-paris').city], ['brussels', 'out', 'paris']);
r = await add(MARIE, 'paris', 'brussels', '2026-12-08');
const pb = route(await r.json(), 'paris-brussels');
check('compat: a route between two other stations has no city or leg', [pb.dates.length, pb.city, pb.leg], [1, undefined, undefined]);

r = await call('PUT', PIERRE);
check('other methods are refused', r.status, 405);

if (failures > 0) { console.error(`\n${failures} test(s) failed.`); process.exit(1); }
console.log('\nAll friend API tests passed.');

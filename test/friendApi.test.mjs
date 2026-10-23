// test/friendApi.test.mjs -- run with: node test/friendApi.test.mjs
// The Worker's friend API (cron-worker/src/friend.js) against a FAKE private
// repo. A friend adds a date and it is saved at once; all of a friend's dates
// live in ONE trip. The point of these tests: a key can manage dates on its own
// channel and NOTHING else (no sight of other dates, no removing them, limits
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

const env = {
  GITHUB_TOKEN: 't',
  NTFY_TRAINS_TOPIC: 'T-trains',
  FRIEND_KEYS: JSON.stringify({
    'PIERRE-KEY-0123456789': { channel: 'pierre', name: 'Pierre', passport: true },
    'MARIE-KEY-0123456789': 'marie',
    'ZELIE-KEY-0123456789': { channel: 'zelie', name: 'Zélie', maxDates: 4, note: true },
    'GAB-KEY-0123456789': { channel: 'gab', name: 'Gabrielle', maxDates: 4, note: true },
    'BIG-KEY-0123456789': { channel: 'big', maxDates: 99 },
    'ODD-KEY-0123456789': { channel: 'odd', maxDates: 'lots' },
  }),
};
const NOW = new Date('2026-10-22T12:00:00Z');
const PIERRE = 'PIERRE-KEY-0123456789';
const ZELIE = 'ZELIE-KEY-0123456789';
const call = (method, key, { query = '', body } = {}) => handleFriend(
  new Request(`https://w.example/friend${query}`, { method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }),
  env,
  NOW,
);
const trips = () => JSON.parse(files['snap-trips.json'].text).trips;
const tripOf = (channel) => trips().filter((t) => t.channel === channel);
// The dates on one route of a reply, e.g. route(body, 'brussels', 'out'); dates(body) is the Paris pair.
const route = (b, city, leg) => ((b.routes || []).find((r) => r.city === city && r.leg === leg) || { dates: [] });
const dates = (b, city = 'paris') => [route(b, city, 'out').dates.map((e) => e.date), route(b, city, 'back').dates.map((e) => e.date)];

files['snap-trips.json'] = { sha: 's0', text: JSON.stringify({ trips: [
  { id: 'mine', out: ['2026-11-05'], back: [] },
  { id: 'marie1', out: ['2026-11-20'], back: [], channel: 'marie' },
  { id: 'old', out: ['2020-01-01'], back: [], channel: 'pierre' },
] }) };
files['snap-state.json'] = { sha: 'st', text: JSON.stringify({ checkedAt: '2026-10-22T11:58:00Z', routes: { 'london-paris': { days: { '2026-11-08': { price: 45, slots: [] }, '2026-11-09': { price: null, slots: [] } } } } }) };

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

// --- Seeing your own dates only ---------------------------------------------
r = await call('GET', PIERRE);
let body = await r.json();
check('GET: pierre sees nothing yet (not your dates, not marie\'s, not his finished one)', [r.status, body.channel, body.topic, body.routes], [200, 'pierre', 'T-trains-pierre', []]);
check('GET: a key with a name returns it', body.name, 'Pierre');
check('GET: pierre has the passport reminder, no personal-link note, and the default cap', [body.passport, body.note, body.maxDates], [true, false, 12]);
r = await call('GET', ZELIE);
let z = await r.json();
check('GET: a friend with a cap of 4 gets the note, no passport reminder, an accented name', [z.name, z.passport, z.note, z.maxDates, z.topic], ['Zélie', false, true, 4, 'T-trains-zelie']);
r = await call('GET', 'MARIE-KEY-0123456789');
check('GET: a key that is just a channel string still works, with no name', [r.status, (await r.json()).name], [200, '']);
r = await call('GET', 'BIG-KEY-0123456789');
check('GET: a cap above 12 is brought down to 12', (await r.json()).maxDates, 12);
r = await call('GET', 'ODD-KEY-0123456789');
check('GET: a nonsense cap falls back to 12', (await r.json()).maxDates, 12);
check('GET: says when the watcher last reported', (await (await call('GET', PIERRE)).json()).checkedAt, '2026-10-22T11:58:00Z');

// --- Adding one date saves it ---------------------------------------------------
r = await call('POST', PIERRE, { body: { out: ['2026-11-08'] } });
body = await r.json();
check('POST: one date is added and answered with the new list', [r.status, dates(body)], [200, [['2026-11-08'], []]]);
check('POST: the date is saved in the repo, tagged with his channel', tripOf('pierre').map((t) => [t.out, t.back]), [[['2026-11-08'], []]]);
check('POST: his finished date is tidied away', JSON.stringify(trips()).includes('2020'), false);
check('POST: your own trip and marie\'s are untouched', [trips().some((t) => t.id === 'mine'), trips().some((t) => t.id === 'marie1')], [true, true]);
const pierreTripId = tripOf('pierre')[0].id;
r = await call('POST', PIERRE, { body: { out: ['2026-11-09'], back: ['2026-11-12'] } });
body = await r.json();
check('POST: more dates are merged into the same single trip, in date order', [dates(body), tripOf('pierre').length, tripOf('pierre')[0].id === pierreTripId], [[['2026-11-08', '2026-11-09'], ['2026-11-12']], 1, true]);
check('POST: shows what the watcher saw for each date', [route(body, 'paris', 'out').dates[0], route(body, 'paris', 'out').dates[1], route(body, 'paris', 'back').dates[0]], [{ date: '2026-11-08', state: 'tickets', price: 45 }, { date: '2026-11-09', state: 'none' }, { date: '2026-11-12', state: 'unknown' }]);
r = await call('POST', PIERRE, { body: { out: ['2026-11-08'] } });
check('POST: adding a date already watched changes nothing', [r.status, dates(await r.json())], [200, [['2026-11-08', '2026-11-09'], ['2026-11-12']]]);
check('GET: the response never includes anyone else\'s dates', JSON.stringify(body).includes('2026-11-20') || JSON.stringify(body).includes('2026-11-05'), false);

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

// --- The limit (pierre: 12) ----------------------------------------------------
const many = Array.from({ length: 9 }, (_, i) => `2026-12-${String(i + 1).padStart(2, '0')}`);
r = await call('POST', PIERRE, { body: { out: [...many, '2026-12-10'] } });
check('limit 12: 3 dates already + 10 more would be 13 and is refused', [r.status, /up to 12/.test((await r.json()).error)], [400, true]);
r = await call('POST', PIERRE, { body: { out: many } });
check('limit 12: filling up to exactly 12 is allowed', r.status, 200);
r = await call('POST', PIERRE, { body: { out: ['2026-12-20'] } });
check('limit 12: one more is refused', r.status, 400);
r = await call('POST', PIERRE, { body: { out: ['2026-12-01'] } });
check('limit 12: re-adding a date already watched is fine even when full', r.status, 200);
r = await call('POST', 'MARIE-KEY-0123456789', { body: { out: ['2026-11-25'] } });
check('limits are per friend: marie is not affected by pierre\'s dates', r.status, 200);

// --- A cap of 4: one date at a time, like the page does --------------------------
for (const d of ['2026-12-11', '2027-01-15']) await call('POST', ZELIE, { body: { out: [d] } });
for (const d of ['2026-12-13', '2027-01-17']) r = await call('POST', ZELIE, { body: { back: [d] } });
z = await r.json();
check('cap 4: four dates added one by one (two in December, two in January) are all saved', [r.status, dates(z)], [200, [['2026-12-11', '2027-01-15'], ['2026-12-13', '2027-01-17']]]);
r = await call('POST', ZELIE, { body: { out: ['2026-12-20'] } });
check('cap 4: a fifth date is refused, saying the cap', [r.status, (await r.json()).error], [400, 'You can watch up to 4 dates at once. Remove one first.']);
r = await call('POST', ZELIE, { body: { out: ['2026-12-11'] } });
check('cap 4: re-adding a watched date is not a fifth date', r.status, 200);
check('cap 4: her four dates are still the only ones', dates(await (await call('GET', ZELIE)).json()), [['2026-12-11', '2027-01-15'], ['2026-12-13', '2027-01-17']]);
r = await call('POST', 'GAB-KEY-0123456789', { body: { out: ['2026-12-11', '2027-01-15'], back: ['2026-12-13', '2027-01-17'] } });
check('cap 4: four dates in one request are accepted too', [r.status, dates(await r.json())], [200, [['2026-12-11', '2027-01-15'], ['2026-12-13', '2027-01-17']]]);

// --- Removing one date -----------------------------------------------------------
r = await call('DELETE', ZELIE, { query: '?leg=out&date=2027-01-15' });
z = await r.json();
check('DELETE: removes just that date and leaves the others', [r.status, dates(z)], [200, [['2026-12-11'], ['2026-12-13', '2027-01-17']]]);
r = await call('POST', ZELIE, { body: { out: ['2026-12-20'] } });
check('DELETE: frees a place under the cap', r.status, 200);
r = await call('DELETE', ZELIE, { query: '?leg=back&date=2026-12-11' });
check('DELETE: the right direction matters (that date is only London to Paris)', dates(await r.json())[0].includes('2026-12-11'), true);
r = await call('DELETE', PIERRE, { query: '?leg=out&date=2026-11-05' });
check('DELETE: pierre cannot remove a date from your own trip', [r.status, trips().some((t) => t.id === 'mine' && t.out.includes('2026-11-05'))], [200, true]);
r = await call('DELETE', PIERRE, { query: '?leg=out&date=2026-11-20' });
check('DELETE: pierre cannot remove a date from marie\'s trip', trips().some((t) => t.id === 'marie1' && t.out.includes('2026-11-20')), true);
check('DELETE: gab\'s dates are separate from zélie\'s even on the same days', dates(await (await call('GET', 'GAB-KEY-0123456789')).json()), [['2026-12-11', '2027-01-15'], ['2026-12-13', '2027-01-17']]);
r = await call('DELETE', PIERRE);
check('DELETE: needs to say which date', r.status, 400);
r = await call('DELETE', PIERRE, { query: '?leg=sideways&date=2026-11-08' });
check('DELETE: needs a real direction', r.status, 400);
r = await call('DELETE', PIERRE, { query: '?leg=out&date=whenever' });
check('DELETE: needs a real date', r.status, 400);
for (const d of ['2026-11-09', '2026-11-08']) await call('DELETE', PIERRE, { query: `?leg=out&date=${d}` });
r = await call('DELETE', PIERRE, { query: '?leg=back&date=2026-11-12' });
for (const d of many) await call('DELETE', PIERRE, { query: `?leg=out&date=${d}` });
check('DELETE: removing a friend\'s last date removes their trip entirely', tripOf('pierre').length, 0);
// --- Brussels and Amsterdam ---------------------------------------------------------
check('cities: pierre starts with nothing watched', (await (await call('GET', PIERRE)).json()).routes, []);
r = await call('POST', PIERRE, { body: { city: 'brussels', out: ['2026-11-12'], back: ['2026-11-14'] } });
body = await r.json();
check('cities: Brussels dates are listed under London to Brussels and Brussels to London', [r.status, body.routes.map((x) => [x.label, x.dates.map((e) => e.date)])], [200, [['London → Brussels', ['2026-11-12']], ['Brussels → London', ['2026-11-14']]]]);
check('cities: a Brussels trip is saved with its city, tagged with his channel', tripOf('pierre').map((t) => [t.city, t.out, t.back]), [['brussels', ['2026-11-12'], ['2026-11-14']]]);
r = await call('POST', PIERRE, { body: { city: 'amsterdam', out: ['2026-11-12'] } });
body = await r.json();
check('cities: the same day in another city is a separate watch', [dates(body, 'brussels')[0], dates(body, 'amsterdam')[0], tripOf('pierre').length], [['2026-11-12'], ['2026-11-12'], 2]);
r = await call('POST', PIERRE, { body: { out: ['2026-11-12'] } });
body = await r.json();
check('cities: no city means Paris', [r.status, dates(body)], [200, [['2026-11-12'], []]]);
check('cities: one trip per city, three in all', tripOf('pierre').map((t) => t.city || 'paris').sort(), ['amsterdam', 'brussels', 'paris']);
check('cities: the reply lists routes in a fixed order, London to the city first', body.routes.map((x) => x.label), ['London → Paris', 'London → Brussels', 'Brussels → London', 'London → Amsterdam']);
r = await call('POST', PIERRE, { body: { city: 'atlantis', out: ['2026-11-12'] } });
check('cities: an unknown city is refused with the list to choose from', [r.status, (await r.json()).error], [400, 'Pick one of: Paris, Brussels, Amsterdam.']);
r = await call('DELETE', PIERRE, { query: '?city=brussels&leg=out&date=2026-11-12' });
body = await r.json();
check('cities: removing a date removes it from that city only', [dates(body, 'brussels'), dates(body, 'amsterdam')[0], dates(body)[0]], [[[], ['2026-11-14']], ['2026-11-12'], ['2026-11-12']]);
r = await call('DELETE', PIERRE, { query: '?city=atlantis&leg=out&date=2026-11-12' });
check('cities: removing in an unknown city is refused', r.status, 400);
r = await call('DELETE', PIERRE, { query: '?leg=out&date=2026-11-12' });
check('cities: removing with no city means Paris', dates(await r.json())[0], []);

// The cap of 4 counts every city together. At this point zélie has 4 Paris dates.
r = await call('POST', ZELIE, { body: { city: 'brussels', out: ['2026-11-30'] } });
z = await r.json();
check('cap 4: a Brussels date counts with her Paris dates, so a fifth is refused', [r.status, (z.error || '').includes('up to 4')], [400, true]);
for (const [leg, day] of [['out', '2026-12-11'], ['out', '2026-12-20'], ['back', '2026-12-13']]) await call('DELETE', ZELIE, { query: `?leg=${leg}&date=${day}` });
r = await call('POST', ZELIE, { body: { city: 'amsterdam', out: ['2026-11-30'], back: ['2026-12-02'] } });
check('cap 4: after removing three Paris dates, two Amsterdam dates fit (1 + 2 = 3)', [r.status, dates(await r.json(), 'amsterdam')], [200, [['2026-11-30'], ['2026-12-02']]]);
r = await call('POST', ZELIE, { body: { city: 'brussels', out: ['2026-11-30', '2026-12-01'] } });
check('cap 4: but two more in Brussels would be five and are refused', r.status, 400);
z = await (await call('GET', ZELIE)).json();
check('cap 4: her list is unchanged by the refused request', z.routes.map((x) => [x.label, x.dates.length]), [['Paris → London', 1], ['London → Amsterdam', 1], ['Amsterdam → London', 1]]);
r = await call('GET', 'GAB-KEY-0123456789');
check("cities: another friend's dates are never in someone else's list", JSON.stringify(z).includes('2027-01-15'), false);

r = await call('PUT', PIERRE);
check('other methods are refused', r.status, 405);

if (failures > 0) { console.error(`\n${failures} test(s) failed.`); process.exit(1); }
console.log('\nAll friend API tests passed.');

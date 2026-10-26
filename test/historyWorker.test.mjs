// test/historyWorker.test.mjs -- run with: node test/historyWorker.test.mjs
// The hourly price-history job (cron-worker/src/history.js) against a FAKE Snap
// and a FAKE private repo (a stubbed global fetch). Snap's pages are built so each
// travel day's cheapest price is whatever the test says. Covers: the first look,
// quiet hours writing nothing, each kind of change, a new day, Snap blocking one
// route (a gap, never "no tickets"), the six-hour heartbeat, and the size cap.

import { runHistory } from '../cron-worker/src/history.js';
import { addDays } from '../trains/snapParse.js';
import { MAX_EVENTS } from '../trains/history.js';

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

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const label = (iso) => { const d = new Date(`${iso}T12:00:00Z`); return `${DOW[d.getUTCDay()]}, ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };

// What Snap shows right now: price per travel day per route, and which routes are blocked.
const world = { prices: { 'london-paris': {}, 'paris-london': {} }, blocked: new Set() };
const snapRequests = [];
function pageFor(center, prices) {
  const cells = [-2, -1, 0, 1, 2].map((n) => {
    const d = addDays(center, n);
    const p = prices[d] === undefined ? null : prices[d];
    return `<div data-testid="calendarDay"><span aria-hidden="true">${label(d)}</span>${p === null ? '' : `<div data-testid="calendarDay-price"><span>£</span><span>${p}</span></div>`}</div>`;
  });
  return `<html><body>${cells.join('')}</body></html>`;
}

const files = {};
let shaN = 0;
let saves = [];
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (url.includes('/contents/')) {
    const name = url.split('/contents/')[1];
    if ((opts.method || 'GET') === 'GET') return files[name] ? json({ content: b64(files[name].text), sha: files[name].sha }) : json({}, 404);
    const body = JSON.parse(opts.body);
    files[name] = { text: Buffer.from(body.content, 'base64').toString('utf8'), sha: `sha${++shaN}` };
    saves.push(body.message);
    return json({ content: { sha: files[name].sha } }, 201);
  }
  if (url.startsWith('https://snap.eurostar.com/')) {
    snapRequests.push(url);
    const q = new URL(url).searchParams;
    const route = q.get('origin') === '7015400' ? 'london-paris' : 'paris-london';
    if (world.blocked.has(route)) return new Response('<html>Access denied</html>', { status: 403 });
    return new Response(pageFor(q.get('outbound'), world.prices[route]), { status: 200 });
  }
  throw new Error(`unexpected fetch ${url} (the history job must not send notifications)`);
};

const env = { GITHUB_TOKEN: 't', NTFY_TRAINS_TOPIC: 'TEST-trains' };
const at = (iso) => new Date(iso);
const hist = () => JSON.parse(files['snap-history.json'].text);
const kinds = (events) => events.map((e) => `${e[1][0]}${e[4]}:${(e[2] ? e[2].slice(5) : '')}${e[3] === null ? '' : `=${e[3]}`}`);

const D0 = '2026-10-26';
const day = (n) => addDays(D0, n);
// Days 0-6 on sale at 40+n pounds on London to Paris; Paris to London has only day 1 and 2.
for (let n = 0; n <= 6; n++) world.prices['london-paris'][day(n)] = 40 + n;
world.prices['paris-london'][day(1)] = 60;
world.prices['paris-london'][day(2)] = 61;

// --- 1. The first look -----------------------------------------------------------
let r = await runHistory(env, at('2026-10-26T10:07:30Z'));
let h = hist();
check('first look: both routes seen, a first-sighting event for each of 21 days on each route', [r.routesSeen, r.events, h.events.length, h.events.every((e) => e[4] === 'i')], [2, 42, 42, true]);
check('first look: the file records when it began, and the latest price of every watched day', [h.since, Object.keys(h.last['london-paris']).length, h.last['london-paris'][day(3)], h.last['london-paris'][day(10)]], ['2026-10-26T10:07Z', 21, 43, null]);
check('first look: nothing was blocked', h.blocked, {});
check('first look: five Snap searches per route, ten in all, each with the right stations', [snapRequests.length, snapRequests.filter((u) => u.includes('origin=7015400&destination=8727100')).length, snapRequests.filter((u) => u.includes('origin=8727100&destination=7015400')).length], [10, 5, 5]);
check('first look: saved once', saves, ['History: update']);

// --- 2. A quiet hour writes nothing ----------------------------------------------
saves = [];
snapRequests.length = 0;
r = await runHistory(env, at('2026-10-26T11:07:30Z'));
check('quiet hour: no events and no save (no commit every hour)', [r.events, r.saved, saves], [0, false, []]);

// --- 3. Each kind of change ---------------------------------------------------------
world.prices['london-paris'][day(3)] = 30; // price drops
world.prices['london-paris'][day(4)] = 55; // price rises
delete world.prices['london-paris'][day(0)]; // gone
world.prices['london-paris'][day(9)] = 99; // tickets appear
r = await runHistory(env, at('2026-10-26T12:07:30Z'));
h = hist();
check('changes: a drop, a rise, tickets gone and tickets appearing are each recorded, with the new price', kinds(h.events.slice(42)), ['lg:10-26', 'lc:10-29=30', 'lc:10-30=55', 'ln:11-04=99']);
check('changes: each carries the hour it was seen', h.events.slice(42).every((e) => e[0] === '2026-10-26T12:07Z'), true);
check('changes: the latest prices are updated', [h.last['london-paris'][day(3)], h.last['london-paris'][day(0)], h.last['london-paris'][day(9)]], [30, null, 99]);

// --- 4. A new day --------------------------------------------------------------------
saves = [];
r = await runHistory(env, at('2026-10-27T00:07:30Z'));
h = hist();
check('next day: yesterday leaves the window quietly, and the day that enters is a first sighting', kinds(h.events.slice(46)), ['li:11-16', 'pi:11-16']);
check('next day: the window still covers 21 days, starting today', [Object.keys(h.last['london-paris']).length, Object.keys(h.last['london-paris'])[0]], [21, '2026-10-27']);

// --- 5. Snap blocks one route: a gap, never "no tickets" ---------------------------------
world.blocked.add('paris-london');
saves = [];
const eventsBefore = hist().events.length;
r = await runHistory(env, at('2026-10-27T01:07:30Z'));
h = hist();
check('blocked: that route is skipped, the other is still looked at', [r.routesSeen, kinds(h.events.slice(eventsBefore))], [1, ['pb:']]);
check('blocked: the days on it are NOT recorded as gone', h.events.slice(eventsBefore).some((e) => e[4] === 'g'), false);
check('blocked: the last known prices on it are kept', h.last['paris-london'][day(1)], 60);
check('blocked: it is marked blocked since that hour', h.blocked, { 'paris-london': '2026-10-27T01:07Z' });
const afterFirstBlock = hist().events.length;
await runHistory(env, at('2026-10-27T02:07:30Z'));
check('blocked: still blocked an hour later records nothing new', hist().events.length, afterFirstBlock);
world.blocked.clear();
world.prices['paris-london'][day(1)] = 58; // it moved while we could not see
r = await runHistory(env, at('2026-10-27T03:07:30Z'));
h = hist();
check('blocked: when Snap answers again the gap is closed and the change seen meanwhile is recorded', kinds(h.events.slice(afterFirstBlock)), ['po:', 'pc:10-27=58']);
check('blocked: and the route is no longer marked blocked', h.blocked, {});

// --- 6. A page we cannot read counts as blocked too ---------------------------------------
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => (String(url).startsWith('https://snap.eurostar.com/') && String(url).includes('origin=7015400') ? new Response('<html>Just a moment... verifying you are human</html>', { status: 200 }) : realFetch(url, opts));
const before6 = hist().events.length;
await runHistory(env, at('2026-10-27T04:07:30Z'));
check('unreadable page: logged as a gap, not as every day being gone', kinds(hist().events.slice(before6)), ['lb:']);
globalThis.fetch = realFetch;
await runHistory(env, at('2026-10-27T05:07:30Z'));
check('unreadable page: and closed again when it reads', hist().blocked, {});

// --- 7. The heartbeat --------------------------------------------------------------------
saves = [];
await runHistory(env, at('2026-10-27T06:07:30Z'));
check('heartbeat: nothing changed within six hours, nothing saved', saves, []);
await runHistory(env, at('2026-10-27T11:30:00Z'));
check('heartbeat: after six quiet hours the file is refreshed so the Stats tab can see the job is alive', saves, ['History: heartbeat']);

// --- 8. The size limit ---------------------------------------------------------------------
const full = hist();
full.events = Array.from({ length: MAX_EVENTS - 2 }, (_, i) => ['2026-10-27T00:00Z', 'london-paris', day(1), 50, 'c']);
files['snap-history.json'] = { text: JSON.stringify(full), sha: 'full1' };
world.prices['london-paris'][day(5)] = 12;
world.prices['london-paris'][day(6)] = 13;
world.prices['london-paris'][day(7)] = 14;
r = await runHistory(env, at('2026-10-27T12:30:00Z'));
h = hist();
check('limit: going over the cap stops recording and says so, rather than growing forever', [r.capped, h.capped, h.events.length], [true, true, MAX_EVENTS - 2]);

if (failures > 0) { console.error(`\n${failures} test(s) failed.`); process.exit(1); }
console.log('\nAll history worker tests passed.');

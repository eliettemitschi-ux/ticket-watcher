// test/snapWorker.test.mjs -- run with: node test/snapWorker.test.mjs
// Runs the Cloudflare Worker's Snap watcher (cron-worker/src/snap.js) in Node
// against FAKE GitHub, Snap and ntfy (a stubbed global fetch). Snap always
// answers with the real captured page (Mon 19 Oct 2026 has £75 tickets).
// Covers: first sighting alerts; a repeat run is silent and saves nothing;
// a price drop; past dates ignored; blocked for 30 min alerts once, then
// "working again"; the state file never claims "no tickets" while blocked.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSnap } from '../cron-worker/src/snap.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const page = fs.readFileSync(path.join(here, 'fixtures', 'snap-search-2026-10-19.html'), 'utf8');

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

// --- Fakes -------------------------------------------------------------------
const files = {}; // private repo: name -> { text, sha }
let shaN = 0;
let snapMode = 'ok'; // 'ok' | 'blocked' | 'cheaper'
const pushes = [];
const snapUrls = [];
const saves = [];
const env = { GITHUB_TOKEN: 'test', NTFY_TRAINS_TOPIC: 'TEST-trains' };

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (url.startsWith('https://api.github.com/repos/eliettemitschi-ux/ticket-watcher-private/contents/')) {
    const name = url.split('/contents/')[1];
    if ((opts.method || 'GET') === 'GET') return files[name] ? json({ content: b64(files[name].text), sha: files[name].sha }) : json({ message: 'Not Found' }, 404);
    const body = JSON.parse(opts.body);
    if ((files[name] && files[name].sha) !== body.sha && !(files[name] === undefined && body.sha === undefined)) return json({ message: 'sha mismatch' }, 409);
    files[name] = { text: Buffer.from(body.content, 'base64').toString('utf8'), sha: `sha${++shaN}` };
    saves.push(body.message);
    return json({ content: { sha: files[name].sha } }, 201);
  }
  if (url.startsWith('https://snap.eurostar.com/')) {
    snapUrls.push(url);
    if (snapMode === 'blocked') return new Response('<html>Access denied</html>', { status: 403 });
    return new Response(snapMode === 'cheaper' ? page.replace(/>75</g, '>60<') : page, { status: 200 });
  }
  if (url === 'https://ntfy.sh') { pushes.push(JSON.parse(opts.body)); return json({ id: 'x' }); }
  throw new Error(`unexpected fetch ${url}`);
};

const at = (iso) => new Date(iso);
const state = () => JSON.parse(files['snap-state.json'].text);
const take = (arr) => arr.splice(0, arr.length);

// --- 1. First run with a trip whose date already has tickets ----------------
files['snap-trips.json'] = { text: JSON.stringify({ trips: [{ id: 't1', out: ['2026-10-19', '2026-10-15'], back: [] }] }), sha: 'trips1' };
let r = await runSnap(env, at('2026-10-16T09:00:00Z'));
let p = take(pushes);
check('first run: one alert, to the trains topic', p.map((x) => x.topic), ['TEST-trains']);
check('first run: no comparison line on a first alert', p[0].message.split('\n').length, 2);
check('first run: remembers the price it alerted', state().routes['london-paris'].days['2026-10-19'].alertedPrice, 75);
check('first run: says which day and the price', p[0].title, 'Snap London to Paris: Mon 19 Oct has tickets');
check('first run: lists both time windows, £ sign intact', p[0].message.split('\n')[0], '£85 (06:01 to 13:00), £75 (13:00 to 20:01)');
check('first run: tapping opens the Snap search for that day', p[0].click, 'https://snap.eurostar.com/uk-en/search?adult=1&origin=7015400&destination=8727100&outbound=2026-10-19&outslot=13%3A00');
check('first run: the past date (15 Oct) is not watched', Object.keys(state().routes['london-paris'].days), ['2026-10-19']);
check('first run: state saved once', take(saves), ['Snap: update']);
check('first run: nothing watched on the way back, so no Paris route', state().routes['paris-london'], undefined);

// --- 2. Same page five minutes later ------------------------------------------
r = await runSnap(env, at('2026-10-16T09:05:00Z'));
check('repeat: no alert', take(pushes).length, 0);
check('repeat: nothing saved (no commit every 5 minutes)', take(saves), []);

// --- 3. Price drop --------------------------------------------------------
snapMode = 'cheaper';
r = await runSnap(env, at('2026-10-16T09:10:00Z'));
p = take(pushes);
check('drop: one alert with the new price', p.map((x) => x.title), ['Snap London to Paris: Mon 19 Oct is now £60']);
check('drop: and how it compares with the last alert (£75)', p[0].message.split('\n')[1], 'Down £15 since the last alert (was £75)');
check('drop: the new price is remembered as the last alerted price', state().routes['london-paris'].days['2026-10-19'].alertedPrice, 60);
take(saves);

// --- 4. Blocked -------------------------------------------------------------
snapMode = 'blocked';
r = await runSnap(env, at('2026-10-16T10:00:00Z'));
check('blocked: reported as blocked, no alert yet', [r.blocked, take(pushes).length], [true, 0]);
check('blocked: last known prices kept, never wiped to "no tickets"', state().routes['london-paris'].days['2026-10-19'].price, 60);
r = await runSnap(env, at('2026-10-16T10:20:00Z'));
check('blocked 20 min: still quiet', take(pushes).length, 0);
r = await runSnap(env, at('2026-10-16T10:31:00Z'));
check('blocked 31 min: one warning', take(pushes).map((x) => x.title), ["Snap watcher can't see Eurostar"]);
r = await runSnap(env, at('2026-10-16T10:36:00Z'));
check('blocked 36 min: not warned twice', take(pushes).length, 0);
snapMode = 'cheaper';
r = await runSnap(env, at('2026-10-16T10:41:00Z'));
check('unblocked: says it is working again, and nothing else', take(pushes).map((x) => x.title), ['Snap watcher is working again']);
check('unblocked: blocked flag cleared', state().blocked, null);
take(saves);

// --- 5. Heartbeat and no trips --------------------------------------------
r = await runSnap(env, at('2026-10-16T17:00:00Z'));
check('heartbeat: saved after 6 quiet hours', take(saves), ['Snap: heartbeat']);
files['snap-trips.json'] = { text: JSON.stringify({ trips: [] }), sha: 'trips2' };
r = await runSnap(env, at('2026-10-16T17:05:00Z'));
check('no trips: no Snap requests, route dropped from state', state().routes, {});

// --- 6. Per-trip channels -----------------------------------------------------
snapMode = 'ok';
const topicsAfterFreshState = async (tripList, iso) => {
  delete files['snap-state.json'];
  files['snap-trips.json'] = { text: JSON.stringify({ trips: tripList }), sha: `trips-${iso}` };
  await runSnap(env, at(iso));
  return take(pushes).map((x) => x.topic);
};
check('channels: a trip with no channel alerts the main channel only', await topicsAfterFreshState([{ id: 'a', out: ['2026-10-19'] }], '2026-10-16T18:00:00Z'), ['TEST-trains']);
check('channels: a friend trip alerts only their channel, not the main one', await topicsAfterFreshState([{ id: 'b', out: ['2026-10-19'], channel: 'Pierre' }], '2026-10-16T18:10:00Z'), ['TEST-trains-pierre']);
check('channels: the same date in both trips alerts both channels', await topicsAfterFreshState([{ id: 'a', out: ['2026-10-19'] }, { id: 'b', out: ['2026-10-19'], channel: 'pierre' }], '2026-10-16T18:20:00Z'), ['TEST-trains', 'TEST-trains-pierre']);
take(saves);

// --- 7. Brussels and Amsterdam ------------------------------------------------------
snapUrls.length = 0;
delete files['snap-state.json'];
files['snap-trips.json'] = { text: JSON.stringify({ trips: [
  { id: 'p', out: ['2026-10-19'] },
  { id: 'b', city: 'brussels', out: ['2026-10-19'] },
  { id: 'a', city: 'amsterdam', out: ['2026-10-19'], channel: 'pierre' },
] }), sha: 'trips-cities' };
await runSnap(env, at('2026-10-16T19:00:00Z'));
p = take(pushes);
check('cities: each city\'s trip alerts with its own city name, to its own channel', p.map((x) => `${x.topic} | ${x.title}`), [
  'TEST-trains | Snap London to Paris: Mon 19 Oct has tickets',
  'TEST-trains | Snap London to Brussels: Mon 19 Oct has tickets',
  'TEST-trains-pierre | Snap London to Amsterdam: Mon 19 Oct has tickets',
]);
const asked = (code) => snapUrls.filter((u) => u.includes(`destination=${code}`)).length > 0;
check('cities: Snap was asked about London to each city with the right station codes', [asked('8727100'), asked('8814001'), asked('8400058')], [true, true, true]);
check('cities: the tapped link opens the right route', p[1].click, 'https://snap.eurostar.com/uk-en/search?adult=1&origin=7015400&destination=8814001&outbound=2026-10-19&outslot=13%3A00');
check('cities: no request goes to a return route nobody is watching', snapUrls.some((u) => u.includes('origin=8814001') || u.includes('origin=8400058') || u.includes('origin=8727100')), false);
check('cities: each route keeps its own memory', Object.keys(state().routes).sort(), ['london-amsterdam', 'london-brussels', 'london-paris']);
take(saves);
await runSnap(env, at('2026-10-16T19:05:00Z'));
check('cities: a second run with nothing new is quiet', take(pushes).length, 0);
snapMode = 'cheaper';
await runSnap(env, at('2026-10-16T19:10:00Z'));
p = take(pushes);
check('cities: a price drop is reported per city, each compared with its own last alert', p.map((x) => x.message.split('\n')[1]), ['Down £15 since the last alert (was £75)', 'Down £15 since the last alert (was £75)', 'Down £15 since the last alert (was £75)']);
snapMode = 'ok';

if (failures > 0) { console.error(`\n${failures} test(s) failed.`); process.exit(1); }
console.log('\nAll Snap Worker tests passed.');

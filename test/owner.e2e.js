// test/owner.e2e.js -- run with: node test/owner.e2e.js
// Drives the real page in headless Chromium against a FAKE GitHub API
// (page.route), covering: a visitor with no token sees no trace of the scanner;
// unlocking with a bad then good token; ticking / unticking and exactly what is
// saved; persistence across reloads; a rejected token; locking the device.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', 'docs');
const PORT = 4188;
const BASE = `http://localhost:${PORT}/`;
const API = 'https://api.github.com/repos/eliettemitschi-ux/ticket-watcher-private';
const tok = (s) => ('github_pat_' + s).padEnd(93, 'x');
const GOOD = tok('GOOD');
const NOREPO = tok('NOREPO'); // valid token, but the private repo wasn't selected when it was created
const NOFILES = tok('NOFILES'); // sees the repo, but Contents permission missing

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

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('nope'); }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

const iso = (ms) => new Date(Date.now() + ms).toISOString();
const rec = (key, title, extra) => ({
  key, venue: 'Barbican', url: 'https://www.barbican.org.uk/x', title, tags: [], days: ['d'], state: 'gated',
  qualifies: false, reasons: [], manual: false, opens: null, ...extra,
});
const scan = {
  updatedAt: iso(-120000),
  venues: { Barbican: {}, 'National Theatre': {} },
  events: {
    flagged: rec('flagged', 'Flagged Show', { qualifies: true, reasons: ['short run (1 date)', 'presale / general-sale gate'], opens: { at: iso(3 * 86400000), precision: 'exact' } }),
    plain: rec('plain', 'Plain Show', { state: 'not_on_sale', opens: { at: iso(30 * 86400000), precision: 'month', label: 'November 2026' } }),
    sold: rec('sold', 'Sold Out Show', { state: 'sold_out', venue: 'National Theatre', days: ['a', 'b', 'c'] }),
    live: rec('live', 'Already On Sale', { state: 'bookable', days: ['d', 'e'] }),
    opened: rec('opened', 'Opened Show', { state: 'bookable', alertedAt: iso(-3600000) }),
  },
};

// Polls until a condition holds (the page re-renders asynchronously).
async function until(fn, ms = 8000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out waiting for: ' + fn.toString().slice(0, 120));
}

// Fake GitHub: private repo contents + a log of every request.
function fakeGitHub() {
  const gh = { store: null, sha: 0, puts: [], requests: [], rejectAll: false, trips: null, tripPuts: [], snapState: null };
  gh.handler = async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const auth = req.headers().authorization;
    gh.requests.push(`${req.method()} ${url.pathname.replace('/repos/eliettemitschi-ux/ticket-watcher-private', '')}`);
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const path0 = url.pathname.replace('/repos/eliettemitschi-ux/ticket-watcher-private', '');
    if (auth === `Bearer ${NOREPO}`) return route.fulfill({ status: 404, headers: cors, body: '{"message":"Not Found"}' });
    if (auth === `Bearer ${NOFILES}`) {
      if (path0 === '' || path0 === '/') return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: '{"private":true}' });
      return route.fulfill({ status: 403, headers: cors, body: '{"message":"Resource not accessible by personal access token"}' });
    }
    if (gh.rejectAll || auth !== `Bearer ${GOOD}`) return route.fulfill({ status: 401, headers: cors, body: '{"message":"Bad credentials"}' });
    const p = url.pathname.replace('/repos/eliettemitschi-ux/ticket-watcher-private', '');
    if (p === '' || p === '/') return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: '{"private":true}' });
    if (p === '/contents/scanner.json') return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(scan) });
    if (p === '/contents/selections.json' && req.method() === 'GET') {
      if (gh.store === null) return route.fulfill({ status: 404, headers: cors, body: '{"message":"Not Found"}' });
      return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ sha: `sha${gh.sha}`, content: Buffer.from(gh.store).toString('base64').replace(/(.{60})/g, '$1\n') }) });
    }
    if (p === '/contents/selections.json' && req.method() === 'PUT') {
      const body = JSON.parse(req.postData());
      gh.store = Buffer.from(body.content, 'base64').toString('utf8');
      gh.sha += 1;
      gh.puts.push({ saved: JSON.parse(gh.store), sentSha: body.sha || null });
      return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ content: { sha: `sha${gh.sha}` } }) });
    }
    if (p === '/contents/snap-state.json') {
      if (!gh.snapState) return route.fulfill({ status: 404, headers: cors, body: '{"message":"Not Found"}' });
      return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(gh.snapState) });
    }
    if (p === '/contents/snap-trips.json' && req.method() === 'GET') {
      if (!gh.trips) return route.fulfill({ status: 404, headers: cors, body: '{"message":"Not Found"}' });
      return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ sha: `t${gh.tripPuts.length}`, content: Buffer.from(gh.trips).toString('base64') }) });
    }
    if (p === '/contents/snap-trips.json' && req.method() === 'PUT') {
      const body = JSON.parse(req.postData());
      gh.trips = Buffer.from(body.content, 'base64').toString('utf8');
      gh.tripPuts.push({ saved: JSON.parse(gh.trips), sentSha: body.sha || null });
      return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ content: { sha: `t${gh.tripPuts.length}` } }) });
    }
    return route.fulfill({ status: 404, headers: cors, body: '{}' });
  };
  return gh;
}

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const browser = await chromium.launch();
  const gh = fakeGitHub();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.route('https://api.github.com/**', gh.handler);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  // 1. A visitor with no token: no trace of the scanner at all.
  const loaded = [];
  page.on('request', (r) => loaded.push(new URL(r.url()).pathname));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  check('visitor: no owner tabs on the page', await page.locator('#owner-tabs').count(), 0);
  check('visitor: owner.js is never even downloaded', loaded.includes('/owner.js'), false);
  check('visitor: no request goes to GitHub', gh.requests.length, 0);
  check('visitor: the page source never mentions the private repo', (await page.content()).includes('ticket-watcher-private'), false);

  // 2. Unlock with #owner: bad token first.
  await page.goto(BASE + '#owner', { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#owner-token-input');
  const tryToken = async (value, pattern) => {
    await page.fill('#owner-token-input', value);
    await page.click('#owner-token-save');
    await page.waitForFunction((src) => new RegExp(src).test(document.getElementById('owner-token-msg').textContent), pattern);
    return page.locator('#owner-token-msg').textContent();
  };
  check('unlock: an invalid token says it is invalid or expired', /not valid or has expired/.test(await tryToken(tok('WRONG'), 'not valid or has expired')), true);
  check('unlock: a cut-off token says so', /cut off/.test(await tryToken('github_pat_short', 'cut off')), true);
  check('unlock: a token for the wrong repo says which repo to tick', /tick ticket-watcher-private/.test(await tryToken(NOREPO, 'tick ticket-watcher-private')), true);
  check('unlock: a token without file permission says which permission', /Contents to/.test(await tryToken(NOFILES, 'Contents to')), true);
  check('unlock: none of those unlocked anything', await page.locator('#owner-tabs').count(), 0);
  check('unlock: and nothing is stored', await page.evaluate(() => localStorage.getItem('twOwnerToken')), null);

  // 3. Good token.
  await page.fill('#owner-token-input', GOOD);
  await page.click('#owner-token-save');
  await page.waitForSelector('#owner-view:not([hidden])');
  await page.waitForSelector('#owner-watching .event-card');
  const watchingTitles = () => page.locator('#owner-watching .event-name').allTextContents();
  const listTitles = () => page.locator('#owner-rest .owner-row-title').allTextContents();
  check('unlock: the right token stores itself on this device', await page.evaluate(() => localStorage.getItem('twOwnerToken')), GOOD);
  check('scanner tab: a flagged upcoming show starts in Watching', await watchingTitles(), ['Flagged Show']);
  check('scanner tab: every other show is in the full list, upcoming first, then sold out, then on sale', await listTitles(), ['Plain Show', 'Sold Out Show', 'Already On Sale']);
  check('scanner tab: the show that already opened is listed separately', await page.locator('#owner-opened .event-card').count(), 1);
  check('scanner tab: a watched show is ticked', await page.locator('input[data-key="flagged"]').isChecked(), true);
  check('scanner tab: the others start unticked', await page.locator('input[data-key="plain"]').isChecked(), false);
  check('scanner tab: the watchlist is hidden while on the scanner tab', await page.locator('main').isHidden(), true);

  // Search and filters.
  await page.fill('#owner-search', 'sold');
  await until(async () => (await listTitles()).length === 1);
  check('search: typing narrows the list', await listTitles(), ['Sold Out Show']);
  await page.fill('#owner-search', 'nothing matches this');
  await until(async () => (await listTitles()).length === 0);
  check('search: no match says so', await page.locator('#owner-rest .empty-state').count(), 1);
  await page.fill('#owner-search', '');
  await page.click('#owner-status-chips .chip[data-status="on_sale"]');
  await until(async () => (await listTitles()).length === 1);
  check('filter: the "On sale" chip', await listTitles(), ['Already On Sale']);
  await page.click('#owner-status-chips .chip[data-status="all"]');
  await page.click('#owner-venue-chips .chip[data-venue="National Theatre"]');
  await until(async () => (await listTitles()).length === 1);
  check('filter: the venue chip', await listTitles(), ['Sold Out Show']);
  await page.click('#owner-venue-chips .chip[data-venue="all"]');
  await until(async () => (await listTitles()).length === 3);

  // 4. Ticks, what gets saved, and the show moving up into Watching.
  await page.click('input[data-key="plain"]');
  await until(() => gh.puts.length === 1);
  check('tick: ticking an upcoming show saves "on"', gh.puts[0].saved, { plain: 'on' });
  check('tick: the first save creates the file (no sha)', gh.puts[0].sentSha, null);
  await until(async () => (await watchingTitles()).length === 2);
  check('tick: the show moves up into Watching', await watchingTitles(), ['Flagged Show', 'Plain Show']);
  check('tick: and leaves the full list', await listTitles(), ['Sold Out Show', 'Already On Sale']);

  await page.click('input[data-key="sold"]');
  await until(() => gh.puts.length === 2);
  check('tick: ticking a SOLD-OUT show saves "on" too (watched for returns)', gh.puts[1].saved, { plain: 'on', sold: 'on' });
  check('tick: later saves quote the current file version', gh.puts[1].sentSha, 'sha1');
  await until(async () => (await watchingTitles()).length === 3);
  check('tick: it joins Watching, after the upcoming ones', await watchingTitles(), ['Flagged Show', 'Plain Show', 'Sold Out Show']);

  await page.click('input[data-key="flagged"]');
  await until(() => gh.puts.length === 3);
  check('tick: unticking a flagged show saves "off" alongside', gh.puts[2].saved, { plain: 'on', sold: 'on', flagged: 'off' });
  await until(async () => (await listTitles()).includes('Flagged Show'));
  check('tick: it drops back into the full list', (await watchingTitles()).includes('Flagged Show'), false);

  await page.click('input[data-key="flagged"]');
  await until(() => gh.puts.length === 4);
  check('tick: re-ticking a flagged show clears its override', gh.puts[3].saved, { plain: 'on', sold: 'on' });

  await page.click('input[data-key="sold"]');
  await until(() => gh.puts.length === 5);
  check('tick: unticking a watched sold-out show clears its override', gh.puts[4].saved, { plain: 'on' });
  await until(async () => (await watchingTitles()).length === 2);

  await page.screenshot({ path: path.join(process.env.TEMP || '.', 'owner-tab.png'), fullPage: true });

  // 5. Persistence: a reload keeps the device unlocked and shows the saved ticks.
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#owner-tabs');
  check('reload: the tabs are back without unlocking again', await page.locator('#owner-tabs button').count(), 3);
  await page.click('#owner-tabs button[data-tab="scanner"]');
  await page.waitForSelector('#owner-watching .event-card');
  check('reload: the saved tick is still in Watching', await watchingTitles(), ['Flagged Show', 'Plain Show']);
  await page.click('#owner-tabs button[data-tab="watchlist"]');
  check('tabs: switching back shows the normal watchlist', await page.locator('main').isVisible(), true);

  // 6. A failing save changes nothing.
  await page.click('#owner-tabs button[data-tab="scanner"]');
  await page.waitForSelector('#owner-watching .event-card');
  const putsBefore = gh.puts.length;
  await context.route('**/contents/selections.json', (route) => (route.request().method() === 'PUT' ? route.fulfill({ status: 500, headers: { 'access-control-allow-origin': '*' }, body: '{}' }) : route.fallback()));
  await page.click('input[data-key="plain"]');
  await page.waitForFunction(() => /Couldn.t save/.test(document.getElementById('owner-msg').textContent));
  check('failed save: a message is shown', await page.locator('#owner-msg').textContent().then((t) => /Nothing was changed/.test(t)), true);
  check('failed save: the show goes back to Watching, ticked', await watchingTitles(), ['Flagged Show', 'Plain Show']);
  check('failed save: nothing was written', gh.puts.length, putsBefore);

  // 6b. The Trains tab: add a trip, see what the watcher saw, stop watching.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
  const plus = (n) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const [out1, out2, back1] = [plus(14), plus(15), plus(18)];
  gh.trips = JSON.stringify({ trips: [{ id: 'old', out: ['2020-01-01'], back: [] }] }); // a finished trip
  gh.snapState = { checkedAt: iso(-180000), routes: { 'london-paris': { days: { [out1]: { price: 39, slots: [{ window: '06:01-13:00', price: 39 }] }, [out2]: { price: null, slots: [] } } } } };
  await page.click('#owner-tabs button[data-tab="trains"]');
  await page.waitForSelector('#owner-trains:not([hidden])');
  await until(async () => /Watcher OK/.test(await page.locator('#trains-status').textContent()));
  check('trains: the watcher status line shows it is healthy', /last update 3m ago/.test(await page.locator('#trains-status').textContent()), true);
  check('trains: the scanner and the watchlist are hidden', [await page.locator('#owner-view').isHidden(), await page.locator('main').isHidden()], [true, true]);
  check('trains: a finished trip is not listed', await page.locator('#trips-list .empty-state').count(), 1);
  check('trains: "Start watching" is off until a date is added', await page.locator('#trip-save').isDisabled(), true);
  await page.fill('#trip-out-date', out2);
  await page.click('button[data-add="out"]');
  await page.fill('#trip-out-date', out1);
  await page.click('button[data-add="out"]');
  await page.fill('#trip-back-date', back1);
  await page.click('button[data-add="back"]');
  check('trains: added dates show as chips, in date order', await page.locator('#trip-out-chips .chip').count(), 2);
  await page.fill('#trip-out-date', '2020-01-01');
  await page.click('button[data-add="out"]');
  check('trains: a past date is refused', /already gone/.test(await page.locator('#trains-msg').textContent()), true);
  check('trains: the form says alerts go to your main channel by default', /BARBICAN-1999-trains, your own channel/.test(await page.locator('#trip-channel-hint').textContent()), true);
  await page.fill('#trip-channel', 'Pierre!');
  check('trains: typing a friend name shows their channel', /BARBICAN-1999-trains-pierre. Send that name/.test(await page.locator('#trip-channel-hint').textContent()), true);
  await page.click('#trip-save');
  await until(() => gh.tripPuts.length === 1);
  const savedTrip = gh.tripPuts[0].saved.trips;
  check('trains: one trip saved with both directions, finished trips dropped', savedTrip.map((t) => [t.out, t.back]), [[[out1, out2], [back1]]]);
  check('trains: the friend channel is saved, cleaned up', savedTrip[0].channel, 'pierre');
  check('trains: the save quotes the file version it read', gh.tripPuts[0].sentSha, 't0');
  await until(async () => (await page.locator('#trips-list .event-card').count()) === 1);
  const cardText = await page.locator('#trips-list .event-card').textContent();
  check('trains: the card shows what the watcher saw for each date', [/From £39 · 1 time window/.test(cardText), /No Snap tickets yet/.test(cardText), /Not checked yet/.test(cardText)], [true, true, true]);
  check('trains: the form is cleared after saving', [await page.locator('#trip-out-chips .chip').count(), await page.locator('#trip-channel').inputValue()], [0, '']);
  check('trains: the card shows where that trip alerts', (await page.locator('#trips-list .event-card').textContent()).includes('BARBICAN-1999-trains-pierre'), true);
  await page.screenshot({ path: path.join(process.env.TEMP || '.', 'owner-trains.png'), fullPage: true });
  // A trip to another city: the labels follow the dropdown and the city is saved.
  await page.selectOption('#trip-city', 'amsterdam');
  check('trains: the direction labels follow the chosen city', [await page.locator('#trip-out-label').textContent(), await page.locator('#trip-back-label').textContent()], ['London → Amsterdam', 'Amsterdam → London']);
  await page.fill('#trip-out-date', plus(30));
  await page.click('button[data-add="out"]');
  await page.click('#trip-save');
  await until(() => gh.tripPuts.length === 2);
  const amsTrip = gh.tripPuts[1].saved.trips.find((t) => t.city === 'amsterdam');
  check('trains: a trip to Amsterdam is saved with its city, next to the Paris one', [amsTrip.out, gh.tripPuts[1].saved.trips.length, gh.tripPuts[1].saved.trips.find((t) => t.id !== amsTrip.id).city], [[plus(30)], 2, undefined]);
  await until(async () => (await page.locator('#trips-list .event-card').count()) === 2);
  check('trains: both cards are listed, each with its own route names', [(await page.locator('#trips-list').textContent()).includes('London → Amsterdam'), (await page.locator('#trips-list').textContent()).includes('London → Paris')], [true, true]);
  await page.selectOption('#trip-city', 'paris');
  await page.click('button[data-trip-remove="' + amsTrip.id + '"]');
  await until(() => gh.tripPuts.length === 3);
  await page.click('button[data-trip-remove]');
  await until(() => gh.tripPuts.length === 4);
  check('trains: "Stop watching" removes the trip', gh.tripPuts[3].saved, { trips: [] });
  await until(async () => (await page.locator('#trips-list .empty-state').count()) === 1);
  gh.snapState = { ...gh.snapState, blocked: { since: iso(-3600000), alerted: true } };
  await page.click('#owner-tabs button[data-tab="scanner"]');
  await page.click('#owner-tabs button[data-tab="trains"]');
  await until(async () => /refusing checks/.test(await page.locator('#trains-status').textContent()));
  check('trains: a blocked watcher shows a warning', true, true);


  // 7. A rejected token (expired / revoked).
  gh.rejectAll = true;
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#owner-tabs');
  await page.click('#owner-tabs button[data-tab="scanner"]');
  await page.waitForFunction(() => /rejected/.test(document.getElementById('owner-msg').textContent));
  check('rejected token: tells you to unlock again', true, true);
  gh.rejectAll = false;

  // 8. Lock this device.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#owner-tabs');
  await page.click('#owner-tabs button[data-tab="scanner"]');
  await page.waitForSelector('#owner-lock');
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('#owner-lock')]);
  check('lock: the token is removed', await page.evaluate(() => localStorage.getItem('twOwnerToken')), null);
  check('lock: the tabs are gone', await page.locator('#owner-tabs').count(), 0);

  // 9. The five-tap gesture opens the unlock prompt too.
  await page.click('#settings-btn');
  for (let i = 0; i < 5; i++) await page.click('#settings-title');
  await page.waitForSelector('#owner-token-input');
  check('gesture: five taps on the Settings title offers to unlock', await page.locator('#owner-token-input').count(), 1);

  // 10. The same two ways in, on a real touch screen (iPhone-style device).
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  });
  await phone.route('https://api.github.com/**', gh.handler);
  const mobile = await phone.newPage();
  await mobile.goto(BASE, { waitUntil: 'networkidle' });
  await mobile.tap('#settings-btn');
  await mobile.waitForSelector('#settings-dialog[open]');
  await mobile.tap('#owner-signin');
  await mobile.waitForSelector('#owner-token-input');
  check('touch: the "Owner sign-in" link opens the unlock prompt', await mobile.locator('#owner-token-input').count(), 1);
  await mobile.tap('#owner-token-cancel');

  await mobile.tap('#settings-btn');
  await mobile.waitForSelector('#settings-dialog[open]');
  for (let i = 0; i < 5; i++) { await mobile.tap('#settings-title'); await mobile.waitForTimeout(350); }
  await mobile.waitForSelector('#owner-token-input');
  check('touch: five slow taps on the title also open it (350ms apart)', await mobile.locator('#owner-token-input').count(), 1);
  await mobile.fill('#owner-token-input', GOOD);
  await mobile.tap('#owner-token-save');
  await mobile.waitForSelector('#owner-view:not([hidden])');
  check('touch: unlocking from the phone shows the scanner tab', await mobile.locator('#owner-tabs button').count(), 3);

  check('no script errors anywhere', pageErrors, []);
  await browser.close();
  server.close();
  if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
  console.log('\nAll owner e2e checks passed.');
})().catch((err) => { console.error(err); server.close(); process.exit(1); });

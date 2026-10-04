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
const GOOD = 'github_pat_GOOD';

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
    live: rec('live', 'Already On Sale', { state: 'bookable' }),
    opened: rec('opened', 'Opened Show', { state: 'bookable', alertedAt: iso(-3600000) }),
  },
};

// Fake GitHub: private repo contents + a log of every request.
function fakeGitHub() {
  const gh = { store: null, sha: 0, puts: [], requests: [], rejectAll: false };
  gh.handler = async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const auth = req.headers().authorization;
    gh.requests.push(`${req.method()} ${url.pathname.replace('/repos/eliettemitschi-ux/ticket-watcher-private', '')}`);
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
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
  await page.fill('#owner-token-input', 'github_pat_WRONG');
  await page.click('#owner-token-save');
  await page.waitForFunction(() => /didn.t work/.test(document.getElementById('owner-token-msg').textContent));
  check('unlock: a wrong token is refused with a message', await page.locator('#owner-tabs').count(), 0);
  check('unlock: and nothing is stored', await page.evaluate(() => localStorage.getItem('twOwnerToken')), null);

  // 3. Good token.
  await page.fill('#owner-token-input', GOOD);
  await page.click('#owner-token-save');
  await page.waitForSelector('#owner-view:not([hidden])');
  await page.waitForSelector('#owner-upcoming .event-card');
  check('unlock: the right token stores itself on this device', await page.evaluate(() => localStorage.getItem('twOwnerToken')), GOOD);
  check('scanner tab: shows only upcoming shows (3 of the 4 records are hidden/opened)', await page.locator('#owner-upcoming .event-card').count(), 2);
  check('scanner tab: the show that already opened is listed separately', await page.locator('#owner-opened .event-card').count(), 1);
  check('scanner tab: soonest opening is listed first', await page.locator('#owner-upcoming .event-name').first().textContent(), 'Flagged Show');
  check('scanner tab: a flagged show starts ticked', await page.locator('input[data-key="flagged"]').isChecked(), true);
  check('scanner tab: an unflagged show starts unticked', await page.locator('input[data-key="plain"]').isChecked(), false);
  check('scanner tab: the watchlist is hidden while on the scanner tab', await page.locator('main').isHidden(), true);

  // 4. Ticks and exactly what gets saved.
  await page.check('input[data-key="plain"]');
  await page.waitForFunction(() => /Saved/.test(document.getElementById('owner-msg').textContent));
  check('tick: ticking an unflagged show saves "on"', gh.puts[gh.puts.length - 1].saved, { plain: 'on' });
  check('tick: the first save creates the file (no sha)', gh.puts[0].sentSha, null);

  await page.uncheck('input[data-key="flagged"]');
  await page.waitForFunction(() => document.querySelectorAll('.event-card.dim').length === 1 && /Saved/.test(document.getElementById('owner-msg').textContent));
  check('tick: unticking a flagged show saves "off" alongside', gh.puts[gh.puts.length - 1].saved, { plain: 'on', flagged: 'off' });
  check('tick: later saves quote the current file version', gh.puts[gh.puts.length - 1].sentSha, 'sha1');

  await page.check('input[data-key="flagged"]');
  await page.waitForFunction(() => Array.from(document.querySelectorAll('input[data-key]')).every((b) => b.checked));
  await page.waitForFunction(() => /Saved/.test(document.getElementById('owner-msg').textContent));
  check('tick: re-ticking a flagged show clears its override', gh.puts[gh.puts.length - 1].saved, { plain: 'on' });

  await page.screenshot({ path: path.join(process.env.TEMP || '.', 'owner-tab.png') });

  // 5. Persistence: a reload keeps the device unlocked and shows the saved ticks.
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#owner-tabs');
  check('reload: the tabs are back without unlocking again', await page.locator('#owner-tabs button').count(), 2);
  await page.click('#owner-tabs button[data-tab="scanner"]');
  await page.waitForSelector('#owner-upcoming .event-card');
  check('reload: the saved tick is still ticked', await page.locator('input[data-key="plain"]').isChecked(), true);
  await page.click('#owner-tabs button[data-tab="watchlist"]');
  check('tabs: switching back shows the normal watchlist', await page.locator('main').isVisible(), true);

  // 6. A failing save changes nothing.
  await page.click('#owner-tabs button[data-tab="scanner"]');
  await page.waitForSelector('#owner-upcoming .event-card');
  const putsBefore = gh.puts.length;
  await context.route('**/contents/selections.json', (route) => (route.request().method() === 'PUT' ? route.fulfill({ status: 500, headers: { 'access-control-allow-origin': '*' }, body: '{}' }) : route.fallback()));
  await page.click('input[data-key="plain"]'); // a plain click: uncheck() would fight the page's revert
  await page.waitForFunction(() => /Couldn.t save/.test(document.getElementById('owner-msg').textContent));
  check('failed save: a message is shown', await page.locator('#owner-msg').textContent().then((t) => /Nothing was changed/.test(t)), true);
  check('failed save: the box goes back to ticked', await page.locator('input[data-key="plain"]').isChecked(), true);
  check('failed save: nothing was written', gh.puts.length, putsBefore);

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

  check('no script errors anywhere', pageErrors, []);
  await browser.close();
  server.close();
  if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
  console.log('\nAll owner e2e checks passed.');
})().catch((err) => { console.error(err); server.close(); process.exit(1); });

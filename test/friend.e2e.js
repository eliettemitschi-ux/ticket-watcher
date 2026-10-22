// test/friend.e2e.js -- run with: node test/friend.e2e.js
// Drives docs/friend.html in headless Chromium against a FAKE Worker
// (page.route). Covers: no link = no access; the key in the link is kept and
// removed from the address bar; a refused key; adding dates; removing a trip;
// error messages from the Worker are shown as written.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', 'docs');
const PORT = 4189;
const BASE = `http://localhost:${PORT}/friend.html`;
const API = 'https://ticket-watcher-cron.eliettemitschi.workers.dev/friend';
const KEY = 'PIERRE-KEY-0123456789';

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

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('nope'); }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

async function until(fn, ms = 8000) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('timed out waiting for: ' + fn.toString().slice(0, 120));
}

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
const plus = (n) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

function fakeWorker() {
  const w = { trips: [], calls: [], rejectKey: false, failNext: null };
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'content-type': 'application/json' };
  const view = () => ({ channel: 'pierre', topic: 'BARBICAN-1999-trains-pierre', today, maxDates: 12, checkedAt: new Date().toISOString(), blocked: false, trips: w.trips });
  w.handler = async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    w.calls.push({ method: req.method(), auth: req.headers().authorization, url: req.url(), body: req.postData() ? JSON.parse(req.postData()) : null });
    if (w.rejectKey || req.headers().authorization !== `Bearer ${KEY}`) return route.fulfill({ status: 401, headers: cors, body: '{"error":"This link is not valid. Ask Eliette for a new one."}' });
    if (w.failNext) { const f = w.failNext; w.failNext = null; return route.fulfill({ status: 400, headers: cors, body: JSON.stringify({ error: f }) }); }
    if (req.method() === 'POST') {
      const b = JSON.parse(req.postData());
      w.trips.push({ id: `f${w.trips.length + 1}`, out: b.out, back: b.back, seen: { out: Object.fromEntries(b.out.map((d, i) => [d, i ? { state: 'none' } : { state: 'tickets', price: 39 }])), back: Object.fromEntries(b.back.map((d) => [d, { state: 'unknown' }])) } });
    }
    if (req.method() === 'DELETE') w.trips = w.trips.filter((t) => t.id !== new URL(req.url()).searchParams.get('id'));
    return route.fulfill({ status: 200, headers: cors, body: JSON.stringify(view()) });
  };
  return w;
}

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const browser = await chromium.launch();
  const worker = fakeWorker();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.route(`${API}**`, worker.handler);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  // 1. Opened with no link at all.
  await page.goto(BASE, { waitUntil: 'networkidle' });
  check('no link: asks for the personal link', await page.locator('#no-key').isVisible(), true);
  check('no link: the form is not shown', await page.locator('#friend-view').isHidden(), true);
  check('no link: nothing was sent to the Worker', worker.calls.length, 0);

  // 2. A garbled key in the link is ignored.
  await page.goto(BASE + '#key=short', { waitUntil: 'networkidle' });
  check('a malformed key: treated as no link', await page.locator('#no-key').isVisible(), true);

  // 3. The real link (a blank page first: a hash-only change would not reload).
  await page.goto('about:blank');
  await page.goto(BASE + `#key=${KEY}`, { waitUntil: 'networkidle' });
  await until(async () => /BARBICAN-1999-trains-pierre/.test(await page.locator('#status').textContent()));
  check('link: the status shows his channel', await page.locator('#status').textContent(), 'Alerts go to BARBICAN-1999-trains-pierre · checks every 5 minutes');
  check('link: the key is removed from the address bar', page.url().includes('key='), false);
  check('link: the key is kept on this device', await page.evaluate(() => localStorage.getItem('twFriendKey')), KEY);
  check('link: the key goes to the Worker as a bearer token, not in the URL', [worker.calls[0].auth, worker.calls[0].url.includes(KEY)], [`Bearer ${KEY}`, false]);
  check('link: the topic to subscribe to is shown', await page.locator('#topic').textContent(), 'BARBICAN-1999-trains-pierre');
  check('link: nothing watched yet', await page.locator('#trips .empty-state').count(), 1);
  check('link: "Start watching" is off until a date is added', await page.locator('#save').isDisabled(), true);

  // 4. Come back later: the stored key works without the link.
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await until(async () => (await page.locator('#friend-view').isVisible()));
  check('reopen: no link needed on the same device', await page.locator('#friend-view').isVisible(), true);

  // 5. Add dates.
  const [o1, o2, b1] = [plus(14), plus(15), plus(18)];
  await page.fill('#out-date', o2);
  await page.click('button[data-add="out"]');
  await page.fill('#out-date', o1);
  await page.click('button[data-add="out"]');
  await page.fill('#back-date', b1);
  await page.click('button[data-add="back"]');
  check('add: dates show as chips', [await page.locator('#out-chips .chip').count(), await page.locator('#back-chips .chip').count()], [2, 1]);
  await page.fill('#out-date', '2020-01-01');
  await page.click('button[data-add="out"]');
  check('add: a past date is refused on the page', /already gone/.test(await page.locator('#msg').textContent()), true);
  await page.click('#save');
  await until(async () => (await page.locator('#trips .event-card').count()) === 1);
  const post = worker.calls.find((c) => c.method === 'POST');
  check('add: the Worker is sent both lists, in date order', post.body, { out: [o1, o2], back: [b1] });
  const card = await page.locator('#trips .event-card').textContent();
  check('add: the card shows what the watcher saw for each date', [/From £39/.test(card), /No Snap tickets yet/.test(card), /Not checked yet/.test(card)], [true, true, true]);
  check('add: the form is cleared', await page.locator('#out-chips .chip').count(), 0);
  await page.screenshot({ path: path.join(process.env.TEMP || '.', 'friend-page.png'), fullPage: true });

  // 6. The Worker says no: its message is shown as written.
  await page.fill('#out-date', plus(20));
  await page.click('button[data-add="out"]');
  worker.failNext = 'You can watch up to 12 dates at once. Remove one first.';
  await page.click('#save');
  await until(async () => /up to 12 dates/.test(await page.locator('#msg').textContent()));
  check('limit: the Worker\'s message is shown', await page.locator('#msg').textContent(), 'You can watch up to 12 dates at once. Remove one first.');
  check('limit: the date is kept in the form so nothing is lost', await page.locator('#out-chips .chip').count(), 1);

  // 7. Remove.
  await page.click('button[data-remove]');
  await until(async () => (await page.locator('#trips .empty-state').count()) === 1);
  const del = worker.calls.find((c) => c.method === 'DELETE');
  check('remove: asks the Worker to remove that trip', new URL(del.url).searchParams.get('id'), 'f1');

  // 8. The key stops working (revoked): the page says so and forgets it.
  worker.rejectKey = true;
  await page.reload({ waitUntil: 'networkidle' });
  await until(async () => await page.locator('#no-key').isVisible());
  check('revoked key: the page asks for a new link', await page.locator('#no-key').isVisible(), true);
  check('revoked key: the stored key is forgotten', await page.evaluate(() => localStorage.getItem('twFriendKey')), null);

  check('no script errors anywhere', pageErrors, []);
  await browser.close();
  server.close();
  if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
  console.log('\nAll friend e2e checks passed.');
})().catch((err) => { console.error(err); server.close(); process.exit(1); });

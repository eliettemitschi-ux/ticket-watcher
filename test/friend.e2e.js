// test/friend.e2e.js -- run with: node test/friend.e2e.js
// Drives docs/friend.html in headless Chromium against a FAKE Worker
// (page.route). The flow under test is the simple one: pick a date, tap Add,
// it is saved and watched at once (no second "save" step). Covers: no link = no
// access; the key in the link is kept and removed from the address bar; a
// refused key; adding and removing single dates; errors shown next to the
// button; the per-friend notes and cap.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium, webkit, devices } = require('playwright');

// BROWSER=webkit runs the same checks in Safari's engine with an iPhone profile.
const SAFARI = process.env.BROWSER === 'webkit';

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
  const w = { out: [], back: [], calls: [], rejectKey: false, failNext: null, delayPostMs: 0, abortNext: false, profile: { passport: true, note: false, maxDates: 12 } };
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'content-type': 'application/json' };
  // The first date of each direction has tickets from 39 pounds, the rest have none yet.
  const entries = (dates) => dates.map((date, i) => (i === 0 ? { date, state: 'tickets', price: 39 } : { date, state: 'none' }));
  const view = () => ({ channel: 'pierre', name: 'Pierre', topic: 'BARBICAN-1999-trains-pierre', today, checkedAt: new Date().toISOString(), blocked: false, out: entries(w.out), back: entries(w.back), ...w.profile });
  w.handler = async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    w.calls.push({ method: req.method(), auth: req.headers().authorization, url: req.url(), body: req.postData() ? JSON.parse(req.postData()) : null });
    if (w.rejectKey || req.headers().authorization !== `Bearer ${KEY}`) return route.fulfill({ status: 401, headers: cors, body: '{"error":"This link is not valid. Ask Eliette for a new one."}' });
    if (w.abortNext && req.method() === 'POST') { w.abortNext = false; return route.abort('failed'); }
    if (w.delayPostMs && req.method() === 'POST') await new Promise((r) => setTimeout(r, w.delayPostMs));
    if (w.failNext) { const f = w.failNext; w.failNext = null; return route.fulfill({ status: 400, headers: cors, body: JSON.stringify({ error: f }) }); }
    if (req.method() === 'POST') {
      const b = JSON.parse(req.postData());
      for (const leg of ['out', 'back']) w[leg] = [...new Set([...w[leg], ...(b[leg] || [])])].sort();
    }
    if (req.method() === 'DELETE') {
      const q = new URL(req.url()).searchParams;
      w[q.get('leg')] = w[q.get('leg')].filter((d) => d !== q.get('date'));
    }
    return route.fulfill({ status: 200, headers: cors, body: JSON.stringify(view()) });
  };
  return w;
}

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const browser = await (SAFARI ? webkit : chromium).launch();
  const worker = fakeWorker();
  const context = await browser.newContext(SAFARI ? devices['iPhone 13'] : { viewport: { width: 390, height: 844 } });
  await context.route(`${API}**`, worker.handler);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  // 1. Opened with no link at all.
  await page.goto(BASE, { waitUntil: 'networkidle' });
  check('no link: asks for the personal link', await page.locator('#no-key').isVisible(), true);
  check('no link: the form is not shown', await page.locator('#friend-view').isHidden(), true);
  check('no link: nothing was sent to the Worker', worker.calls.length, 0);
  check('no link: the guide is hidden', await page.locator('#guide').isHidden(), true);
  check('no link: the passport and personal-link notes are hidden too', [await page.locator('#passport-note').isHidden(), await page.locator('#personal-note').isHidden()], [true, true]);
  check('no link: the page source never contains the channel name', (await page.content()).includes('trains-pierre'), false);

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
  check('title: the page is named after him', [await page.locator('h1').textContent(), await page.title()], ['Pierre Express', 'Pierre Express']);
  check('passport: the reminder is on his page', (await page.locator('#passport-note').textContent()).startsWith('Passport: required.'), true);
  check('notes: no personal-link note on his page', await page.locator('#personal-note').isHidden(), true);
  check('cap: the form says how many dates he can watch', await page.locator('#cap-note').textContent(), 'You can watch up to 12 dates at once (0 used).');
  check('guide: the steps show his own channel name', await page.locator('.topic-name').textContent(), 'BARBICAN-1999-trains-pierre');
  check('guide: setup steps, alert examples and FAQ are on the page', [await page.locator('#guide .ntfy-steps li').count(), await page.locator('#guide .alert-example').count(), await page.locator('#guide h3').count()], [4, 2, 4]);
  await page.evaluate(() => { navigator.clipboard.writeText = () => Promise.resolve(); });
  await page.click('#copy-topic');
  check('guide: the copy button confirms', await page.locator('#copied').textContent(), 'Copied');
  check('simple flow: there is no separate save button to forget', [await page.locator('#save').count(), await page.locator('#pending-note').count()], [0, 0]);
  check('simple flow: nothing watched yet', await page.locator('#trips .empty-state').count(), 1);

  // 4. Come back later: the stored key works without the link.
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await until(async () => (await page.locator('#friend-view').isVisible()));
  check('reopen: no link needed on the same device', await page.locator('#friend-view').isVisible(), true);

  // 5. Pick a date, tap Add: saved at once.
  const [o1, o2, b1] = [plus(14), plus(15), plus(18)];
  await page.click('button[data-add="out"]');
  check('add: tapping Add with no date says what to do, and sends nothing', [await page.locator('#msg').textContent(), worker.calls.filter((c) => c.method === 'POST').length], ['Pick a date first, then tap Add.', 0]);
  await page.fill('#out-date', '2020-01-01');
  await page.click('button[data-add="out"]');
  check('add: a past date is refused on the page, nothing sent', [await page.locator('#msg').textContent(), worker.calls.filter((c) => c.method === 'POST').length], ['That date has already gone.', 0]);
  await page.fill('#out-date', o1);
  await page.click('button[data-add="out"]');
  await until(async () => (await page.locator('#trips .watch-row').count()) === 1);
  const post = worker.calls.find((c) => c.method === 'POST');
  check('add: one tap sends exactly that one date', post.body, { out: [o1] });
  check('add: the date is in the Watching list straight away, with what the watcher saw', /From £39/.test(await page.locator('#trips').textContent()), true);
  check('add: a clear confirmation right under the Add buttons', /^Added .*You are now watching it\./.test(await page.locator('#msg').textContent()), true);
  check('add: the date box is cleared for the next one', await page.locator('#out-date').inputValue(), '');
  check('add: the count and cap line update', [await page.locator('#count').textContent(), await page.locator('#cap-note').textContent()], ['(1)', 'You can watch up to 12 dates at once (1 used).']);
  await page.fill('#out-date', o2);
  await page.click('button[data-add="out"]');
  await page.fill('#back-date', b1);
  await page.click('button[data-add="back"]');
  await until(async () => (await page.locator('#trips .watch-row').count()) === 3);
  check('add: both directions are listed, each under its own heading', await page.locator('#trips .trip-leg').allTextContents(), ['London → Paris', 'Paris → London']);
  check('add: a date with no tickets yet says so', /No Snap tickets yet/.test(await page.locator('#trips').textContent()), true);
  await page.screenshot({ path: path.join(process.env.TEMP || '.', 'friend-page.png'), fullPage: true });

  // 6. Things going wrong are shown next to the button and nothing is lost.
  await page.fill('#out-date', plus(20));
  worker.abortNext = true;
  await page.click('button[data-add="out"]');
  await until(async () => /Not added/.test(await page.locator('#msg').textContent()));
  check('network failure: says so, next to the button', await page.locator('#msg').textContent(), "Not added: Couldn't reach the server. Check your connection and try again.");
  check('network failure: the date stays in the box so it can be retried, and the button works again', [await page.locator('#out-date').inputValue(), await page.locator('button[data-add="out"]').isDisabled()], [plus(20), false]);
  worker.failNext = 'You can watch up to 12 dates at once. Remove one first.';
  await page.click('button[data-add="out"]');
  await until(async () => /up to 12 dates/.test(await page.locator('#msg').textContent()));
  check('limit: the Worker\'s message is shown as written', await page.locator('#msg').textContent(), 'Not added: You can watch up to 12 dates at once. Remove one first.');
  check('limit: the date is still in the box', await page.locator('#out-date').inputValue(), plus(20));

  // 7. While adding, the buttons wait; a second tap cannot double up.
  worker.delayPostMs = 900;
  const postsBefore = worker.calls.filter((c) => c.method === 'POST').length;
  await page.click('button[data-add="out"]');
  await until(async () => await page.locator('button[data-add="out"]').isDisabled());
  check('adding: the buttons are off while the save is in flight', [await page.locator('button[data-add="out"]').isDisabled(), await page.locator('button[data-add="back"]').isDisabled(), await page.locator('#trips button').first().isDisabled()], [true, true, true]);
  await until(async () => (await page.locator('#trips .watch-row').count()) === 4);
  worker.delayPostMs = 0;
  check('adding: exactly one request was sent', worker.calls.filter((c) => c.method === 'POST').length - postsBefore, 1);

  // 8. Remove one date.
  await page.locator('#trips .watch-row button').first().click();
  await until(async () => (await page.locator('#trips .watch-row').count()) === 3);
  const del = worker.calls.find((c) => c.method === 'DELETE');
  const q = new URL(del.url).searchParams;
  check('remove: asks the Worker to remove that one date', [q.get('leg'), q.get('date')], ['out', o1]);
  check('remove: a confirmation right under the Watching heading', /^Stopped watching/.test(await page.locator('#trips-msg').textContent()), true);

  // 9. A friend with a cap of 4, the personal-link note and no passport reminder.
  worker.profile = { passport: false, note: true, maxDates: 4 };
  await page.reload({ waitUntil: 'networkidle' });
  await until(async () => await page.locator('#personal-note').isVisible());
  check('friend: the personal-link note is shown, first on the page', await page.locator('#personal-note').textContent(), "This is your personal link. It's yours alone, like a toothbrush, so please don't share it.");
  check('friend: no passport reminder', await page.locator('#passport-note').isHidden(), true);
  check('friend: the cap of 4 and how many are used', await page.locator('#cap-note').textContent(), 'You can watch up to 4 dates at once (3 used).');

  // 10. The key stops working (revoked): the page says so and forgets it.
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

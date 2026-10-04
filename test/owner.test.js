// test/owner.test.js -- run with: node test/owner.test.js
// Unit tests for the pure helpers in docs/owner.js (the owner-only Scanner tab).

const owner = require('../docs/owner.js');

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

// Not-yet-on-sale shows (the only kind that can be flagged automatically)...
const flagged = { key: 'a', state: 'gated', qualifies: true, manual: false };
const plain = { key: 'b', state: 'not_on_sale', qualifies: false, manual: false };
const manual = { key: 'c', state: 'not_on_sale', qualifies: false, manual: true };
// ...and shows already on sale, which only ever alert if you tick them.
const liveFlagged = { key: 'd', state: 'bookable', qualifies: true, manual: false };
const soldOut = { key: 'e', state: 'sold_out', qualifies: false, manual: false };

// --- which shows alert by default ------------------------------------------
check('autoEligible: a flagged upcoming show alerts by default', owner.autoEligible(flagged), true);
check('autoEligible: an unflagged upcoming show does not', owner.autoEligible(plain), false);
check('autoEligible: a hand-added upcoming show alerts by default', owner.autoEligible(manual), true);
check('autoEligible: an on-sale show never alerts on its own, even if it "qualifies"', owner.autoEligible(liveFlagged), false);
check('autoEligible: a sold-out show does not either', owner.autoEligible(soldOut), false);

// --- overrides ------------------------------------------------------------------
check('effectiveEligible: no override follows the automatic rule', owner.effectiveEligible(plain, {}), false);
check('effectiveEligible: ticked "on" alerts even if unflagged', owner.effectiveEligible(plain, { b: 'on' }), true);
check('effectiveEligible: unticked "off" silences a flagged show', owner.effectiveEligible(flagged, { a: 'off' }), false);
check('effectiveEligible: ticking a sold-out show watches it for returns', owner.effectiveEligible(soldOut, { e: 'on' }), true);

// --- what a tick stores -----------------------------------------------------------
check('nextSelection: ticking an unflagged show stores "on"', owner.nextSelection(plain, true), 'on');
check('nextSelection: unticking a flagged show stores "off"', owner.nextSelection(flagged, false), 'off');
check('nextSelection: ticking a flagged show clears any override', owner.nextSelection(flagged, true), null);
check('nextSelection: unticking an unflagged show clears any override', owner.nextSelection(plain, false), null);
check('nextSelection: unticking a hand-added show stores "off"', owner.nextSelection(manual, false), 'off');
check('nextSelection: ticking a sold-out show stores "on"', owner.nextSelection(soldOut, true), 'on');
check('nextSelection: unticking a ticked sold-out show clears the override', owner.nextSelection(soldOut, false), null);

check('withSelection: adds an override', owner.withSelection({}, 'b', 'on'), { b: 'on' });
check('withSelection: null removes it', owner.withSelection({ b: 'on', a: 'off' }, 'b', null), { a: 'off' });
const original = { a: 'off' };
owner.withSelection(original, 'b', 'on');
check('withSelection: does not mutate its input', original, { a: 'off' });

// --- buckets, labels ----------------------------------------------------------------
check('statusOf: waiting shows are "upcoming"', [owner.statusOf(flagged), owner.statusOf(plain)], ['upcoming', 'upcoming']);
check('statusOf: sold out / on sale', [owner.statusOf(soldOut), owner.statusOf(liveFlagged)], ['sold_out', 'on_sale']);
check('watchLabel: an upcoming show is watched for opening', /goes on sale/.test(owner.watchLabel(plain)), true);
check('watchLabel: an on-sale show is watched for returns', /sold-out dates get tickets back/.test(owner.watchLabel(soldOut)), true);

// --- search and filters ----------------------------------------------------------------
const shows = [
  { key: '1', title: 'Some Woman', venue: 'National Theatre', tags: ['Dorfman Theatre'], state: 'bookable' },
  { key: '2', title: 'Bob Dylan', venue: 'Southbank', tags: [], state: 'sold_out' },
  { key: '3', title: 'Marcel Khalife', venue: 'Barbican', tags: ['Contemporary music'], state: 'gated' },
  { key: '4', title: 'Pam Tanowitz Dance: Pastoral', venue: 'Barbican', tags: ['Theatre & dance'], state: 'bookable' },
];
check('search: matches part of a title, any case', owner.filterRecords(shows, { query: 'khal' }).map((r) => r.key), ['3']);
check('search: every word must match (any order)', owner.filterRecords(shows, { query: 'dance pam' }).map((r) => r.key), ['4']);
check('search: venue and tags are searched too', owner.filterRecords(shows, { query: 'dorfman' }).map((r) => r.key), ['1']);
check('search: blank shows everything', owner.filterRecords(shows, { query: '  ' }).length, 4);
check('filter: by venue', owner.filterRecords(shows, { venue: 'Barbican' }).map((r) => r.key), ['3', '4']);
check('filter: by status', owner.filterRecords(shows, { status: 'sold_out' }).map((r) => r.key), ['2']);
check('filter: venue and status together', owner.filterRecords(shows, { venue: 'Barbican', status: 'upcoming' }).map((r) => r.key), ['3']);

// --- Watching vs everything else -------------------------------------------------------
const mix = [
  { key: 'w1', title: 'Zebra', venue: 'V', state: 'bookable', qualifies: false },
  { key: 'w2', title: 'Alpha', venue: 'V', state: 'sold_out', qualifies: false },
  { key: 'w3', title: 'Later', venue: 'V', state: 'not_on_sale', qualifies: true, opens: { at: '2026-11-01T00:00:00Z', precision: 'month' } },
  { key: 'w4', title: 'Sooner', venue: 'V', state: 'gated', qualifies: true, opens: { at: '2026-10-09T09:00:00Z', precision: 'exact' } },
  { key: 'w5', title: 'Opened', venue: 'V', state: 'bookable', qualifies: false, alertedAt: '2026-10-01T00:00:00Z' },
];
const g = owner.groupRecords(mix, { w1: 'on' });
check('group: ticked and flagged shows go to Watching, soonest opening first', g.watching.map((r) => r.key), ['w4', 'w3', 'w1']);
check('group: everything else is below, sold out before on sale', g.rest.map((r) => r.key), ['w2']);
check('group: shows that have already alerted as opened are left out of both', [...g.watching, ...g.rest].some((r) => r.key === 'w5'), false);
const g2 = owner.groupRecords(mix, { w3: 'off' });
check('group: unticking a flagged show moves it down', g2.rest.map((r) => r.key).includes('w3'), true);

// --- ordering ------------------------------------------------------------------------
const exact = { opens: { at: '2026-10-09T09:00:00.000Z', precision: 'exact' } };
const date = { opens: { at: '2026-10-12T09:00:00.000Z', precision: 'date' } };
const month = { opens: { at: '2026-11-01T00:00:00.000Z', precision: 'month' } };
const none = { opens: null };
const sorted = [none, month, date, exact].sort((x, y) => owner.sortKey(x) - owner.sortKey(y));
check('sortKey: soonest exact, then dated, then month-only, then unknown', sorted, [exact, date, month, none]);

// --- encoding (accents must survive the trip to GitHub and back) ----------------------
const text = JSON.stringify({ 'esmé/x': 'on', 'a’b': 'off' });
check('base64: round-trips accents and curly quotes', owner.base64ToUtf8(owner.utf8ToBase64(text)), text);
check('base64: tolerates the newlines GitHub puts in content', owner.base64ToUtf8(owner.utf8ToBase64('hello').replace(/(.{4})/g, '$1\n')), 'hello');

// --- token diagnosis: each failure must say what to do ---------------------------
const full = 'github_pat_' + 'A'.repeat(82);
check('diagnose: a good token passes', owner.diagnoseToken(full, 200, 200), null);
check('diagnose: a good token passes before the first scan exists (file 404)', owner.diagnoseToken(full, 200, 404), null);
check('diagnose: no answer from GitHub reads as a connection problem', /reach GitHub/.test(owner.diagnoseToken(full, null, null)), true);
check('diagnose: something that is not a token', /doesn't look like a GitHub token/.test(owner.diagnoseToken('hello world', 401, null)), true);
check('diagnose: a cut-off token names its length', owner.diagnoseToken('github_pat_' + 'A'.repeat(19), 401, null).includes('cut off (30 characters'), true);
check('diagnose: 401 means invalid or expired', /not valid or has expired/.test(owner.diagnoseToken(full, 401, null)), true);
check('diagnose: 404 means the private repo was not selected', /tick ticket-watcher-private/.test(owner.diagnoseToken(full, 404, null)), true);
check("diagnose: repo visible but files forbidden means Contents permission", /Contents to 'Read and write'/.test(owner.diagnoseToken(full, 200, 403)), true);

// --- markup safety ---------------------------------------------------------------------
const nasty = { key: 'k', title: '<img src=x onerror=alert(1)>', venue: '<b>V</b>', url: 'javascript:alert(1)', state: 'not_on_sale', opens: null, days: [], reasons: [], qualifies: false, manual: false, tags: [] };
for (const [name, html] of [['card', owner.watchingCard(nasty, {}, Date.now())], ['row', owner.compactRow(nasty, Date.now())]]) {
  check(`markup (${name}): a hostile title is escaped`, html.includes('<img'), false);
  check(`markup (${name}): a hostile venue is escaped`, html.includes('<b>V'), false);
  check(`markup (${name}): a non-https link is neutralised`, html.includes('javascript:'), false);
}

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
} else {
  console.log('\nAll owner tests passed.');
}

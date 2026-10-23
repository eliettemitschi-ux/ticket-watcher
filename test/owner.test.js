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

// --- Trains tab ---------------------------------------------------------------
check('trains: adding dates keeps them sorted and unique', owner.addDateTo(owner.addDateTo(['2026-11-06'], '2026-11-05'), '2026-11-06'), ['2026-11-05', '2026-11-06']);
check('trains: an empty or malformed date is ignored', [owner.addDateTo(['2026-11-05'], ''), owner.addDateTo([], '5 Nov')], [['2026-11-05'], []]);

const trip = { id: 't1', out: ['2026-11-05', '2026-11-06'], back: ['2026-11-09', '2026-11-10'] };
const gone = { id: 't0', out: ['2026-10-01'], back: [] };
check('trains: a trip with any date to come is live, a finished one is not', owner.liveTrips([gone, trip], '2026-11-07').map((t) => t.id), ['t1']);

const snapState = {
  checkedAt: '2026-10-22T09:00:00Z',
  routes: {
    'london-paris': { days: { '2026-11-05': { price: null, slots: [] }, '2026-11-06': { price: 45, slots: [{ window: '06:01-13:00', price: 45 }, { window: '13:00-20:01', price: 55 }] } } },
  },
};
check('trains: a date with tickets shows the price and windows', owner.dateStatus(snapState, 'out', '2026-11-06'), { cls: 'available', text: 'From £45 · 2 time windows' });
check('trains: a date checked with none says so', owner.dateStatus(snapState, 'out', '2026-11-05'), { cls: 'pending', text: 'No Snap tickets yet' });
check('trains: a date the watcher has not seen yet says so', owner.dateStatus(snapState, 'back', '2026-11-09'), { cls: 'unknown', text: 'Not checked yet' });
const card = owner.tripCard(trip, snapState, '2026-11-06');
check('trains: card shows both directions', [card.includes('London → Paris'), card.includes('Paris → London')], [true, true]);
check('trains: a date already gone is greyed, not given a status', card.includes('Thu 5 Nov · gone'), true);
check('trains: card has a remove button for that trip', card.includes('data-trip-remove="t1"'), true);
check('trains: a one-way trip shows only its direction', owner.tripCard({ id: 't2', out: ['2026-11-05'], back: [] }, null, '2026-10-22').includes('Paris → London'), false);
check('trains: a hostile trip id is escaped', owner.tripCard({ id: '"><img src=x>', out: ['2026-11-05'] }, null, '2026-10-22').includes('<img'), false);

check('trains: channel names are tidied the same way as the watcher does', [owner.cleanChannel('Pierre!'), owner.cleanChannel('')], ['pierre', '']);
const friendCard = owner.tripCard({ id: 'f1', out: ['2026-11-05'], channel: 'pierre' }, null, '2026-10-22');
check('trains: a friend trip card shows their channel', friendCard.includes('BARBICAN-1999-trains-pierre'), true);
check('trains: your own trip card says it is the main channel', card.includes('BARBICAN-1999-trains</code> (your main channel)'), true);
check('trains: a hostile channel name cannot inject markup', owner.tripCard({ id: 'x', out: ['2026-11-05'], channel: '<img src=x>' }, null, '2026-10-22').includes('<img'), false);

// Cities: a trip is London to or from one city; no city means Paris.
check('cities: a trip with no city, or an unknown one, is Paris', [owner.cityOfTrip({}), owner.cityOfTrip({ city: 'atlantis' }), owner.cityOfTrip({ city: 'brussels' })], ['paris', 'paris', 'brussels']);
const bxl = owner.tripCard({ id: 'b1', city: 'brussels', out: ['2026-11-05'], back: ['2026-11-09'] }, { routes: { 'london-brussels': { days: { '2026-11-05': { price: 38, slots: [] } } } } }, '2026-10-22');
check('cities: a Brussels card names the right route in each direction', [bxl.includes('London → Brussels'), bxl.includes('Brussels → London'), bxl.includes('London → Paris')], [true, true, false]);
check('cities: and shows what the watcher saw on that city route', bxl.includes('From £38'), true);
check('cities: a Paris card still says Paris', card.includes('London → Paris') && card.includes('Paris → London'), true);
check('cities: status is read from the right route', [owner.dateStatus({ routes: { 'brussels-london': { days: { '2026-11-09': { price: 41, slots: [] } } } } }, 'back', '2026-11-09', 'brussels').text, owner.dateStatus({ routes: { 'brussels-london': { days: { '2026-11-09': { price: 41, slots: [] } } } } }, 'back', '2026-11-09').text], ['From £41', 'Not checked yet']);

const now = Date.parse('2026-10-22T10:00:00Z');
check('watcher: healthy', owner.watcherLine(snapState, now), 'Watcher OK · checks every 5 minutes · last update 1h ago');
check('watcher: never ran', owner.watcherLine(null, now), "The watcher hasn't reported yet. It checks every 5 minutes.");
check('watcher: blocked is a warning', owner.watcherLine({ ...snapState, blocked: { since: '2026-10-22T08:30:00Z' } }, now).startsWith('⚠️ Snap has been refusing checks since Thu 22 Oct, 9:30am'), true);
check('watcher: silent for over 7 hours is a warning', owner.watcherLine({ ...snapState, checkedAt: '2026-10-22T01:00:00Z' }, now).startsWith('⚠️ No report from the watcher'), true);

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
} else {
  console.log('\nAll owner tests passed.');
}

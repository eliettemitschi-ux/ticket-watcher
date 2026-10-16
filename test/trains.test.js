// test/trains.test.js -- run with: node test/trains.test.js
// Uses a REAL Eurostar Snap search page (London to Paris, chosen day Mon 19 Oct
// 2026, captured 16 Oct 2026): only Monday has tickets (£75), in two windows.

const fs = require('fs');
const path = require('path');
const { parseSearchHtml, searchUrl } = require('../trains/snap');
const { centersFor, diffDays } = require('../trains/diff');

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

const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'snap-search-2026-10-19.html'), 'utf8');
const page = parseSearchHtml(html, '2026-10-19');

check('page: the five-day strip is read', page.days.map((d) => d.date), ['2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21']);
check('page: only Monday has a price', page.days.map((d) => d.price), [null, null, 75, null, null]);
check('page: both time windows are read with their prices', page.slots, [{ window: '06:01-13:00', price: 85 }, { window: '13:00-20:01', price: 75 }]);
check('page: a blocked / unrelated page is "no strip", never "no tickets"', parseSearchHtml('<html>Just a moment... verifying you are human</html>', '2026-10-19'), null);
check('page: the year follows the chosen day across New Year', parseSearchHtml(html.replace(/Mon, 19 Oct/g, 'Mon, 29 Dec'), '2026-12-30').days.some((d) => d.date === '2026-12-29'), true);
check('url: has the stations, the date and one adult', searchUrl({ origin: '7015400', destination: '8727100' }, '2026-10-21'), 'https://snap.eurostar.com/uk-en/search?adult=1&origin=7015400&destination=8727100&outbound=2026-10-21&outslot=13%3A00');

// Which dates to ask about: one request covers the chosen day plus two either side.
check('centers: Mon to Fri needs one request, centred on Wednesday', centersFor('2026-10-19', '2026-10-23', '2026-10-16'), ['2026-10-21']);
check('centers: a 10-day range needs two', centersFor('2026-10-19', '2026-10-28', '2026-10-16'), ['2026-10-21', '2026-10-26']);
check('centers: days already past are skipped', centersFor('2026-10-19', '2026-10-23', '2026-10-22'), ['2026-10-24']);
check('centers: a finished range needs none', centersFor('2026-10-19', '2026-10-23', '2026-10-30'), []);

// What counts as "new tickets".
const mon = { price: 75, slots: [{ window: '06:01-13:00', price: 85 }, { window: '13:00-20:01', price: 75 }] };
const none = { price: null, slots: [] };
const before = { '2026-10-19': mon, '2026-10-20': none, '2026-10-21': none };

check('diff: the first run (no previous) is a silent baseline', diffDays(null, { '2026-10-19': mon }), []);
check('diff: nothing changed, nothing to say', diffDays(before, before), []);
const tue = { price: 85, slots: [{ window: '06:01-13:00', price: 85 }] };
const a1 = diffDays(before, { ...before, '2026-10-20': tue });
check('diff: a day that had no tickets and now does is reported', a1.map((a) => [a.date, a.kind, a.price]), [['2026-10-20', 'day', 85]]);
const a2 = diffDays({ ...before, '2026-10-19': { price: 75, slots: [{ window: '13:00-20:01', price: 75 }] } }, before);
check('diff: a new time window on a day that already had tickets is reported', a2.map((a) => [a.date, a.kind, a.newSlots.map((s) => s.window)]), [['2026-10-19', 'slot', ['06:01-13:00']]]);
check('diff: tickets disappearing is not an alert', diffDays(before, { ...before, '2026-10-19': none }), []);
check('diff: a day that was already on sale is not reported again', diffDays({ ...before, '2026-10-20': tue }, { ...before, '2026-10-20': tue }), []);
const a3 = diffDays(before, { ...before, '2026-10-20': tue, '2026-10-21': tue });
check('diff: several new days give one alert each, in date order', a3.map((a) => a.date), ['2026-10-20', '2026-10-21']);
check('diff: a day that sold out and came back is reported again', diffDays({ ...before, '2026-10-20': none }, { ...before, '2026-10-20': tue }).length, 1);

if (failures > 0) { console.error(`\n${failures} test(s) failed.`); process.exit(1); }
console.log('\nAll trains tests passed.');

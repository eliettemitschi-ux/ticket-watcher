// test/history.test.js -- run with: node test/history.test.js
// The pure rules for the Snap price history (trains/history.js): which days are
// watched, and which changes become events.

const { HORIZON_DAYS, ROUTES, horizonDates, diffPrices, stamp } = require('../trains/history');

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

check('routes: London to Paris and back, nothing else', ROUTES, ['london-paris', 'paris-london']);
const days = horizonDates('2026-10-26');
check('days: today and the 20 after it', [days.length, days[0], days[20], HORIZON_DAYS], [21, '2026-10-26', '2026-11-15', 21]);
check('days: across a month end', horizonDates('2026-12-20').slice(10, 13), ['2026-12-30', '2026-12-31', '2027-01-01']);
check('stamp: minute precision in UTC', stamp(new Date('2026-10-26T10:07:42.123Z')), '2026-10-26T10:07Z');

const T = '2026-10-26T10:07Z';
const lp = 'london-paris';
check('first look: every day is a first sighting, with its price or null', diffPrices({}, { '2026-10-27': 45, '2026-11-14': null }, lp, T), [[T, lp, '2026-10-27', 45, 'i'], [T, lp, '2026-11-14', null, 'i']]);
check('nothing changed: nothing recorded', diffPrices({ '2026-10-27': 45, '2026-11-14': null }, { '2026-10-27': 45, '2026-11-14': null }, lp, T), []);
check('tickets appear on a day that had none', diffPrices({ '2026-11-14': null }, { '2026-11-14': 65 }, lp, T), [[T, lp, '2026-11-14', 65, 'n']]);
check('tickets disappear (sold out or closed)', diffPrices({ '2026-10-27': 45 }, { '2026-10-27': null }, lp, T), [[T, lp, '2026-10-27', null, 'g']]);
check('the cheapest price goes down, or up', diffPrices({ a: 65, b: 40 }, { a: 45, b: 55 }, lp, T), [[T, lp, 'a', 45, 'c'], [T, lp, 'b', 55, 'c']]);
check('a new day entering the window is a first sighting, others are untouched', diffPrices({ '2026-10-27': 45 }, { '2026-10-27': 45, '2026-11-16': null }, lp, T), [[T, lp, '2026-11-16', null, 'i']]);
check('days that left the window are not events', diffPrices({ '2026-10-25': 45, '2026-10-27': 45 }, { '2026-10-27': 45 }, lp, T), []);
check('events come out in date order', diffPrices({}, { '2026-11-02': null, '2026-10-30': 50 }, lp, T).map((e) => e[2]), ['2026-10-30', '2026-11-02']);

if (failures > 0) { console.error(`\n${failures} test(s) failed.`); process.exit(1); }
console.log('\nAll history tests passed.');

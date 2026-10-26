// test/stats.test.js -- run with: node test/stats.test.js
// The maths behind the Stats tab (docs/stats.js), on a small history built by hand
// so every answer can be checked against the log. Dates: 26 Oct 2026 is a Monday;
// UK clocks go back at 01:00 UTC on Sun 25 Oct, so 00:01 UTC is 01:01 London time
// on 24 and 25 Oct and 00:01 London time from 26 Oct.

const { analyse, html, median, mode } = require('../docs/stats.js');

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

const lp = 'london-paris';
const pl = 'paris-london';
const history = {
  since: '2026-10-20T00:00Z',
  checkedAt: '2026-10-27T11:30:00.000Z',
  blocked: {},
  events: [
    ['2026-10-20T00:00Z', lp, '2026-11-03', null, 'i'],
    ['2026-10-20T00:00Z', lp, '2026-11-04', null, 'i'],
    ['2026-10-20T00:00Z', lp, '2026-11-05', null, 'i'],
    ['2026-10-20T00:00Z', lp, '2026-11-06', null, 'i'],
    ['2026-10-20T00:00Z', lp, '2026-10-28', 75, 'i'], // already on sale when first seen
    ['2026-10-24T00:01Z', lp, '2026-11-03', 60, 'n'], // appears 10 days ahead, at 01:01 London
    ['2026-10-25T00:01Z', lp, '2026-11-04', 50, 'n'], // 10 days ahead, 01:01 London
    ['2026-10-26T00:01Z', lp, '2026-11-05', 40, 'n'], // 10 days ahead, 00:01 London
    ['2026-10-26T08:30Z', lp, '2026-11-03', 45, 'c'], // down 15, 56.5 hours after it appeared
    ['2026-10-27T12:01Z', lp, '2026-11-04', 70, 'c'], // up 20, 60 hours after it appeared
    ['2026-10-30T12:00Z', lp, '2026-11-05', null, 'g'], // gone with 6 days to go
    ['2026-11-02T09:00Z', lp, '2026-11-03', null, 'g'], // gone with 1 day to go
    ['2026-10-20T00:00Z', pl, '2026-11-03', null, 'i'],
    ['2026-10-27T00:01Z', pl, '2026-11-03', 35, 'n'], // 7 days ahead, 00:01 London
    ['2026-10-27T01:00Z', pl, null, null, 'b'], // Snap stopped answering for 4 hours
    ['2026-10-27T05:00Z', pl, null, null, 'o'],
  ],
};
const NOW = Date.parse('2026-10-27T12:00:00Z');
const s = analyse(history, NOW);
const a = s.routes[lp];

check('helpers: median and mode', [median([3, 1, 2]), median([4, 1, 2, 3]), median([]), mode([2, 2, 3]), mode([3, 2]), mode([])], [2, 2.5, null, 2, 2, null]);

check('header: when it started, how long, how many changes, when last checked', [s.since, s.daysCollected, s.events, s.hoursSinceCheck], ['2026-10-20T00:00Z', 7.5, 16, 0.5]);
check('header: hours Snap did not answer (4, from the gap markers)', s.gapHours, 4);

check('days: five London to Paris days watched; two on sale now; one not on sale yet; one already on sale when first seen', [a.tracked, a.lasts.onSaleNow, a.notOnSaleYet, a.alreadyOnSale], [5, 2, 1, 1]);
check('appear: three days appeared, each 10 days before travel (the already-on-sale day is not counted)', [a.appear.lead.n, a.appear.lead.median, a.appear.lead.min, a.appear.lead.max, a.appear.lead.mode, a.appear.lead.histogram], [3, 10, 10, 10, 10, [{ value: 10, count: 3 }]]);
check('appear: the hour is London time, so 00:01 UTC in summer is 01:01', [a.appear.hour.n, a.appear.hour.mode, a.appear.hour.histogram], [3, 1, [{ value: 0, count: 1 }, { value: 1, count: 2 }]]);
check('weekday: Tuesday has one date, appeared 10 days ahead, first price 60', a.byWeekday[1], { name: 'Tuesday', dates: 1, n: 1, medianLead: 10, medianFirstPrice: 60 });
check('weekday: Wednesday mixes an appeared day and an already-on-sale day; the price median covers both', a.byWeekday[2], { name: 'Wednesday', dates: 2, n: 1, medianLead: 10, medianFirstPrice: 62.5 });
check('weekday: Friday was watched but never appeared', a.byWeekday[4], { name: 'Friday', dates: 1, n: 0, medianLead: null, medianFirstPrice: null });
check('weekday: Monday and the weekend were not watched at all', [a.byWeekday[0].dates, a.byWeekday[5].dates, a.byWeekday[6].dates], [0, 0, 0]);

check('price: first prices of the four days that had one', a.price.firstPrice, { n: 4, median: 55, min: 40, max: 75 });
check('price: two changed, one dropped at some point, one rose', [a.price.withChange, a.price.anyDrop, a.price.anyRise], [2, 1, 1]);
check('price: net by the last look: one cheaper, one dearer', [a.price.netLower, a.price.netHigher], [1, 1]);
check('price: the median net change among those that changed, and how long they took to change', [a.price.medianNetChange, a.price.hoursToFirstChange], [2.5, { n: 2, median: 58.2 }]);
check('price: the biggest drop', a.price.biggestDrop, { date: '2026-11-03', from: 60, to: 45 });
check('lasts: one gone more than a day before travel, one within a day', [a.lasts.goneEarly, a.lasts.goneLate, a.lasts.returns], [1, 1, 0]);
check('lasts: tickets that went lasted a median 166.5 hours (225 and 108)', a.lasts.hours, { n: 2, median: 166.5 });

const b = s.routes[pl];
check('paris to london: one day, appeared 7 days ahead at 00:xx London time', [b.tracked, b.appear.lead.median, b.appear.hour.mode], [1, 7, 0]);

// --- Gaps and unusual logs ---------------------------------------------------------------
const stillBlocked = analyse({ ...history, events: [...history.events.slice(0, 14), ['2026-10-27T10:00Z', pl, null, null, 'b']], blocked: { [pl]: '2026-10-27T10:00Z' } }, NOW);
check('gaps: a route still blocked counts its hours up to now', stillBlocked.gapHours, 2);
const comeBack = analyse({ events: [['2026-10-20T00:00Z', lp, '2026-11-03', null, 'i'], ['2026-10-21T00:01Z', lp, '2026-11-03', 50, 'n'], ['2026-10-22T10:00Z', lp, '2026-11-03', null, 'g'], ['2026-10-23T10:00Z', lp, '2026-11-03', 55, 'n']] }, NOW).routes[lp];
check('returns: tickets that came back are counted, and the appearance is the first one', [comeBack.lasts.returns, comeBack.appear.lead.n, comeBack.lasts.onSaleNow, comeBack.lasts.goneEarly], [1, 1, 1, 1]);
const empty = analyse({}, NOW);
check('an empty or missing log does not break anything', [empty.events, empty.routes[lp].tracked, empty.routes[lp].appear.lead.n, analyse(null, NOW).gapHours], [0, 0, 0, 0]);

// --- What is shown ---------------------------------------------------------------------------
const page = html(s);
check('page: says how long it has been collecting, with the change count and gap hours', /Collecting since .* 7\.5 days · 16 changes logged · 4 hours Snap did not answer/.test(page), true);
check('page: lead time, with the number of days it rests on', page.includes('<strong>10 days before travel</strong> is the most common (median 10, from 10 to 10). Based on 3 days.'), true);
check('page: the busiest hour, in London time', page.includes('<strong>01:00–02:00</strong> London time (2 of 3)'), true);
check('page: small samples are flagged as hints', page.includes('few dates, treat as a hint'), true);
check('page: both routes appear', [page.includes('London → Paris'), page.includes('Paris → London')], [true, true]);
check('page: price lines', [page.includes('<strong>2 of 4</strong> days (50%) changed price'), page.includes('Biggest drop: Tue 3 Nov, £60 to £45.'), page.includes('typical net change was +£2.5')], [true, true, true]);
check('page: how long tickets last', page.includes('<strong>166.5 hours</strong>'), true);
check('page: a negative change reads as minus pounds, not pounds minus', html(analyse({ since: '2026-10-20T00:00Z', events: [['2026-10-20T00:00Z', lp, '2026-11-03', null, 'i'], ['2026-10-24T00:01Z', lp, '2026-11-03', 60, 'n'], ['2026-10-26T08:30Z', lp, '2026-11-03', 45, 'c']] }, NOW)).includes('typical net change was −£15'), true);
check('page: only weekdays that were watched are listed', [page.includes('Tuesday'), page.includes('Saturday')], [true, false]);
check('page: nothing to warn about when all is well', page.includes('form-msg error'), false);
const warned = html(analyse({ ...history, capped: true, blocked: { [pl]: '2026-10-27T10:00Z' }, checkedAt: '2026-10-26T00:00:00.000Z' }, NOW));
check('page: warns when the log is full, Snap is blocked, or the job looks stopped', [warned.includes('The log is full'), warned.includes('Snap is not answering for Paris → London'), warned.includes('hours ago, so the hourly job may have stopped')], [true, true, true]);
check('page: with nothing yet it says so plainly instead of showing empty charts', html(empty).includes('nothing to report yet'), true);

if (failures > 0) { console.error(`\n${failures} test(s) failed.`); process.exit(1); }
console.log('\nAll stats tests passed.');

// test/stats.test.js -- run with: node test/stats.test.js
// The maths behind the Stats tab (docs/stats.js), on a small history built by hand
// so every answer can be checked against the log. Dates: 26 Oct 2026 is a Monday;
// UK clocks go back at 01:00 UTC on Sun 25 Oct, so 00:01 UTC is 01:01 London time
// on 24 and 25 Oct and 00:01 London time from 26 Oct.

const { analyse, html, estimate, estimateHtml, compare, confidenceFor, median, mode } = require('../docs/stats.js');

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

// --- Direction comparison and the estimate for a chosen date ---------------------------------
// A second history, in winter (so UTC is London time). London to Paris: 20 dates whose tickets
// appeared 10 days ahead (16), 9 days (2) or 11 days (2) at 00:01. Paris to London: 10 dates, leads
// [10,10,10,9,11,10,12,8,10,10] at 01:30. The same ten travel days are in both directions.
const { addDays } = require('../trains/snapParse');
const day = (n) => addDays('2026-12-10', n);
const SINCE = '2026-11-01T00:00Z';
const at = (date, lead, time) => `${addDays(date, -lead)}T${time}Z`;
const events2 = [];
const leadsLP = Array.from({ length: 20 }, (_, i) => (i < 16 ? 10 : i < 18 ? 9 : 11));
const leadsPL = [10, 10, 10, 9, 11, 10, 12, 8, 10, 10];
leadsLP.forEach((lead, i) => {
  events2.push([SINCE, lp, day(i), null, 'i'], [at(day(i), lead, '00:01'), lp, day(i), 40 + (i % 5) * 5, 'n']);
  if (i < 6) events2.push([`${addDays(day(i), -lead + 2)}T09:00Z`, lp, day(i), 35 + (i % 5) * 5, 'c']); // six of them drop by 5
});
leadsPL.forEach((lead, i) => events2.push([SINCE, pl, day(i), null, 'i'], [at(day(i), lead, '01:30'), pl, day(i), 35 + (i % 5) * 5, 'n']));
events2.push([SINCE, lp, '2026-12-30', null, 'i']); // watched, never on sale yet
events2.push([SINCE, lp, '2026-11-30', 60, 'i'], ['2026-11-20T10:00Z', lp, '2026-11-30', null, 'g']); // on sale when first seen, then gone
const big = analyse({ since: SINCE, checkedAt: '2026-12-01T00:00:00.000Z', blocked: {}, events: events2 }, Date.parse('2026-12-01T00:30:00Z'));
const TODAY = '2026-12-01';

// How sure to be.
const conf = (leads) => confidenceFor(leads).level;
check('confidence: 20 dates all alike is High', conf(Array(20).fill(10)), 'High');
check('confidence: 20 dates but only 75% within a day is only Medium', conf([...Array(15).fill(10), ...Array(5).fill(14)]), 'Medium');
check('confidence: 8 dates with 5 close together is Medium', conf([10, 10, 10, 10, 10, 12, 8, 14]), 'Medium');
check('confidence: 8 dates scattered is Low', conf([10, 10, 10, 12, 8, 14, 6, 16]), 'Low');
check('confidence: 5 dates is Low however alike they are, and none is Low too', [conf(Array(5).fill(10)), conf([])], ['Low', 'Low']);

// London to Paris.
const lpEst = estimate(big.routes[lp], day(10), TODAY);
check('estimate: a day already on sale says so, with its price, and the usual pattern', [lpEst.kind, lpEst.status, lpEst.price, lpEst.typical, lpEst.usualDate, lpEst.n], ['estimate', 'on', 40, 10, day(0), 20]);
check('estimate: 90% had appeared by 10 days ahead, and 80% within 9 to 11 days', [lpEst.byLead, lpEst.byDate, lpEst.range, lpEst.earliest, lpEst.latest], [10, day(0), [9, 11], day(-1), day(1)]);
check('estimate: the usual hour is the most common one, with its share', [lpEst.hourMode, lpEst.hourCount, lpEst.hourN], [0, 20, 20]);
check('estimate: confidence is High with the numbers behind it', [lpEst.confidence.level, lpEst.confidence.n, lpEst.confidence.within1], ['High', 20, 1]);
const notYet = estimate(big.routes[lp], '2026-12-30', TODAY);
check('estimate: a watched day not on sale yet is "not-yet", expected on the usual day', [notYet.status, notYet.usualDate, notYet.daysAway], ['not-yet', '2026-12-20', 29]);
check('estimate: a day that has gone is "gone"', estimate(big.routes[lp], '2026-11-30', '2026-11-25').status, 'gone');
check('estimate: a day beyond what is watched is "unwatched"', [estimate(big.routes[lp], '2027-02-01', TODAY).status, estimate(big.routes[lp], '2027-02-01', TODAY).usualDate], ['unwatched', '2027-01-22']);
check('estimate: a past date and no date are handled', [estimate(big.routes[lp], '2026-11-01', TODAY).kind, estimate(big.routes[lp], '', TODAY).kind], ['past', 'pick']);
check('estimate: with fewer than 3 appearances it says there is not enough data', [estimate(a.byWeekday ? analyse({ events: history.events.filter((e) => e[1] === pl) }, NOW).routes[pl] : null, '2026-12-01', '2026-11-01').kind], ['thin']);

// Paris to London.
const plEst = estimate(big.routes[pl], day(5), TODAY);
check('estimate: Paris to London is its own estimate with its own confidence', [plEst.typical, plEst.confidence.level, plEst.confidence.n, plEst.confidence.within1, plEst.hourMode], [10, 'Medium', 10, 0.8, 1]);
check('estimate: with 10 dates the range is the full spread, and 90% appeared by 9 days ahead', [plEst.range, plEst.byLead], [[8, 12], 9]);

// The comparison.
const cmp = compare(big);
check('compare: typical lead in each direction', [cmp.timing.a.median, cmp.timing.b.median, cmp.timing.enough, cmp.timing.leadDiff], [10, 10, true, 0]);
check('compare: same-date timing: London to Paris was first on 8 dates, Paris to London on 2, median gap 1.5 hours', cmp.timing.paired, { n: 10, aEarlier: 8, bEarlier: 2, sameTime: 0, medianGapHours: 1.5 });
check('compare: same-date prices: Paris to London was cheaper on all 10, by £5', cmp.price.paired, { n: 10, aCheaper: 0, bCheaper: 10, equal: 0, medianDiff: -5 });
check('compare: price changes: London to Paris changed on 6 of 21 priced dates, Paris to London on none (28.6 points apart)', [cmp.changes.a.withChange, cmp.changes.a.n, cmp.changes.b.withChange, cmp.changes.shareDiff], [6, 21, 0, -28.6]);
const cmpPage = html(big);
check('compare page: no clear timing difference when the typical leads match', cmpPage.includes('No clear difference in how early tickets appear.'), true);
check('compare page: says which direction is usually cheaper and by how much', cmpPage.includes('Paris → London is usually cheaper: 10 of 10 dates, by a median of £5.'), true);
check('compare page: says which direction changes price more often', cmpPage.includes('Prices change more often in London → Paris (28.6 percentage points more).'), true);
check('compare page: the same-date timing in words', [cmpPage.includes('came first on 8'), cmpPage.includes('Paris → London on 2'), cmpPage.includes('median gap 1.5 hours, London → Paris first')], [true, true, true]);
check('compare page: the table has a row for each measure', ['Tickets appear', 'Most common hour', 'First price (median)', 'Changed price after appearing', 'Dropped at some point'].every((l) => cmpPage.includes(l)), true);
const earlyPage = html(analyse({ events: history.events }, NOW));
check('compare page: with too little data it says too early to tell instead of guessing', [earlyPage.includes('Too early to tell which direction appears earlier. It needs 8+ dates in each direction.'), earlyPage.includes('Too early to tell which direction is cheaper')], [true, true]);
const lateLead = analyse({ since: SINCE, events: [...events2.filter((e) => e[1] === lp), ...leadsPL.flatMap((lead, i) => [[SINCE, pl, day(i), null, 'i'], [at(day(i), lead + 3, '01:30'), pl, day(i), 35, 'n']])] }, NOW);
check('compare page: when one direction really appears earlier it says by how many days', html(lateLead).includes('Paris → London tends to appear about 3 days earlier.'), true);

// The calculator.
const est = (date, today) => estimateHtml(big, date, today);
const onSalePage = est(day(10), TODAY);
check('calculator: a day on sale shows its price and the usual pattern for both directions', [onSalePage.includes('On sale now</strong> (from £40)'), onSalePage.includes('about <strong>10 days before travel</strong>'), (onSalePage.match(/event-name/g) || []).length], [true, true, 2]);
check('calculator: confidence is a label plus the numbers', [onSalePage.includes('Confidence: High'), onSalePage.includes('Based on 20 dates; 100% within a day of the typical 10 days, range 9–11 days.'), onSalePage.includes('Confidence: Medium'), onSalePage.includes('Based on 10 dates; 80% within a day of the typical 10 days, range 8–12 days.')], [true, true, true, true]);
check('calculator: it gives the day tickets usually appear and the hour', [onSalePage.includes('is around <strong>Thu 10 Dec</strong>'), onSalePage.includes('most often at 00:00–01:00 London time (20 of 20)')], [true, true]);
check('calculator: a day not on sale yet says so while the usual day is still ahead', est('2026-12-30', TODAY).includes('<strong>Not on sale yet.</strong>'), true);
check('calculator: and says "later than usual" once 90% of dates would already have had tickets', est('2026-12-30', '2026-12-25').includes('later than usual'), true);
check('calculator: due about now when the usual day is today', est('2026-12-30', '2026-12-20').includes('due about now'), true);
check('calculator: a day further ahead than we watch is described as only the usual pattern', est('2027-02-01', TODAY).includes('further ahead than we watch'), true);
const nearPage = estimateHtml(big, '2026-12-25', '2026-12-15');
check('calculator: a near date that was never watched says there is no record (not that it is too far ahead); a watched one does not', [(nearPage.match(/No record for this date/g) || []).length, nearPage.includes('further ahead'), nearPage.includes('On sale now')], [1, false, true]);
check('calculator: a past date and no date give a plain prompt', [est('2026-11-01', TODAY).includes('already gone'), est('', TODAY).includes('Pick a travel date')], [true, true]);
check('calculator: a day that has gone says so', estimateHtml(big, '2026-11-30', '2026-11-25').includes('have gone'), true);
check('calculator: not enough data is said plainly', estimateHtml(analyse({ events: history.events.filter((e) => e[1] === pl) }, NOW), '2026-12-01', '2026-11-01').includes('Not enough data yet'), true);
check('calculator: the page has the date box for it', [cmpPage.includes('id="est-date"'), cmpPage.includes('id="est-body"')], [true, true]);

if (failures > 0) { console.error(`\n${failures} test(s) failed.`); process.exit(1); }
console.log('\nAll stats tests passed.');

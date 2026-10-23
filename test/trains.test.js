// test/trains.test.js -- run with: node test/trains.test.js
// Uses a REAL Eurostar Snap search page (London to Paris, chosen day Mon 19 Oct
// 2026, captured 16 Oct 2026): only Monday has tickets (£75), in two windows.

const fs = require('fs');
const path = require('path');
const { parseSearchHtml, searchUrl } = require('../trains/snap');
const { STATIONS, ALLOWED, legsOf, changeLine, watchedDates, centersForDates, diffDays, alertText, ROUTES, cleanChannel, topicFor, channelsFor } = require('../trains/diff');

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

// Which dates to watch, from the trips added in the Trains tab.
const trips = [
  { id: 't1', out: ['2026-11-06', '2026-11-05'], back: ['2026-11-09', '2026-11-10'] },
  { id: 't2', out: ['2026-11-05', '2026-10-01', 'nonsense'], back: [] },
];
const noOthers = Object.fromEntries(Object.keys(ROUTES).filter((id) => id !== 'london-paris' && id !== 'paris-london').map((id) => [id, []]));
const sorted = (o) => Object.fromEntries(Object.entries(o).sort());
check('watch: out is London to Paris, back is Paris to London, sorted and unique', sorted(watchedDates(trips, '2026-10-22')), sorted({ 'london-paris': ['2026-11-05', '2026-11-06'], 'paris-london': ['2026-11-09', '2026-11-10'], ...noOthers }));
check('watch: past dates are dropped', sorted(watchedDates(trips, '2026-11-06')), sorted({ 'london-paris': ['2026-11-06'], 'paris-london': ['2026-11-09', '2026-11-10'], ...noOthers }));
check('watch: no trips, nothing to watch', sorted(watchedDates(undefined, '2026-10-22')), sorted({ 'london-paris': [], 'paris-london': [], ...noOthers }));

// Journeys: a leg is one From, one To and one day. Trips saved the older way ({city, out, back}) are still read.
const oldTrip = { id: 'b', city: 'brussels', out: ['2026-11-12'], back: ['2026-11-14'] };
check('legs: an older trip becomes legs (out is London to the city, back is the city to London)', legsOf(oldTrip), [{ from: 'london', to: 'brussels', date: '2026-11-12' }, { from: 'brussels', to: 'london', date: '2026-11-14' }]);
check('legs: no city, or one we do not know, means Paris', [legsOf({ out: ['2026-11-12'] })[0].to, legsOf({ city: 'atlantis', out: ['2026-11-12'] })[0].to], ['paris', 'paris']);
const newTrip = { id: 'n', legs: [{ from: 'paris', to: 'brussels', date: '2026-11-20' }, { from: 'brussels', to: 'amsterdam', date: '2026-11-21' }, { from: 'london', to: 'london', date: '2026-11-22' }, { from: 'london', to: 'paris', date: 'soon' }] };
check('legs: new-style legs are read, and journeys Snap does not sell (or bad dates) are ignored', legsOf(newTrip), [{ from: 'paris', to: 'brussels', date: '2026-11-20' }]);
check('legs: a trip can mix the old and new styles', legsOf({ out: ['2026-11-12'], legs: [{ from: 'paris', to: 'amsterdam', date: '2026-11-13' }] }).map((l) => `${l.from}-${l.to}`), ['paris-amsterdam', 'london-paris']);
const w = watchedDates([oldTrip, newTrip, { legs: [{ from: 'london', to: 'brussels', date: '2026-11-12' }, { from: 'amsterdam', to: 'paris', date: '2026-10-01' }] }], '2026-10-22');
check('legs: watching is per route, de-duplicated, and past dates are dropped', [w['london-brussels'], w['brussels-london'], w['paris-brussels'], w['amsterdam-paris'], w['brussels-amsterdam']], [['2026-11-12'], ['2026-11-14'], ['2026-11-20'], [], undefined]);
check('stations: the four stations and their Snap codes', Object.entries(STATIONS).map(([id, c]) => [id, c.code]), [['london', '7015400'], ['paris', '8727100'], ['brussels', '8814001'], ['amsterdam', '8400058']]);
check('stations: where Snap goes from each (tested live): London and Paris reach the others, Brussels and Amsterdam only London and Paris', ALLOWED, { london: ['paris', 'brussels', 'amsterdam'], paris: ['london', 'brussels', 'amsterdam'], brussels: ['london', 'paris'], amsterdam: ['london', 'paris'] });
check('stations: every allowed journey also works the other way round', Object.entries(ALLOWED).every(([from, tos]) => tos.every((to) => ALLOWED[to].includes(from))), true);
check('stations: ten routes, each with its own stations and name', Object.values(ROUTES).map((r) => [r.id, r.name, r.origin, r.destination]), [
  ['london-paris', 'London to Paris', '7015400', '8727100'], ['london-brussels', 'London to Brussels', '7015400', '8814001'], ['london-amsterdam', 'London to Amsterdam', '7015400', '8400058'],
  ['paris-london', 'Paris to London', '8727100', '7015400'], ['paris-brussels', 'Paris to Brussels', '8727100', '8814001'], ['paris-amsterdam', 'Paris to Amsterdam', '8727100', '8400058'],
  ['brussels-london', 'Brussels to London', '8814001', '7015400'], ['brussels-paris', 'Brussels to Paris', '8814001', '8727100'],
  ['amsterdam-london', 'Amsterdam to London', '8400058', '7015400'], ['amsterdam-paris', 'Amsterdam to Paris', '8400058', '8727100'],
]);
check('stations: alert titles use the right station names, whichever way', [alertText(ROUTES['paris-brussels'], { date: '2026-11-12', kind: 'day', price: 40, current: 40, slots: [{ window: '06:01-13:00', price: 40 }], newSlots: [] }).title, alertText(ROUTES['amsterdam-paris'], { date: '2026-11-12', kind: 'day', price: 40, current: 40, slots: [], newSlots: [] }).title], ['Snap Paris to Brussels: Thu 12 Nov has tickets', 'Snap Amsterdam to Paris: Thu 12 Nov has tickets']);
check('legs: channels follow the route (a Brussels trip does not alert on the same Paris day)', [channelsFor([{ legs: [{ from: 'london', to: 'brussels', date: '2026-11-12' }], channel: 'pierre' }], 'london-paris', '2026-11-12'), channelsFor([{ legs: [{ from: 'london', to: 'brussels', date: '2026-11-12' }], channel: 'pierre' }], 'london-brussels', '2026-11-12'), channelsFor([{ out: ['2026-11-12'], channel: 'pierre' }, { legs: [{ from: 'london', to: 'paris', date: '2026-11-12' }] }], 'london-paris', '2026-11-12')], [[], ['pierre'], ['pierre', '']]);

// Per-trip channels: a trip's alerts go to <main>-<name>, or the main channel if it has no name.
check('channel: names are lower-cased and stripped to letters, digits and dashes', [cleanChannel('Pierre!'), cleanChannel(' -Marie Claire- '), cleanChannel(undefined)], ['pierre', 'marieclaire', '']);
check('channel: topic names', [topicFor('BARBICAN-1999-trains', ''), topicFor('BARBICAN-1999-trains', 'pierre')], ['BARBICAN-1999-trains', 'BARBICAN-1999-trains-pierre']);
const shared = [{ out: ['2026-11-05'] }, { out: ['2026-11-05', '2026-11-06'], channel: 'Pierre' }];
check('channel: a date watched by two trips alerts both channels', channelsFor(shared, 'london-paris', '2026-11-05'), ['', 'pierre']);
check('channel: a date only in the friend trip alerts only their channel', channelsFor(shared, 'london-paris', '2026-11-06'), ['pierre']);
check('channel: the right direction is used', channelsFor(shared, 'paris-london', '2026-11-05'), []);

// Which dates to ask about: one request covers the chosen day plus two either side.
check('centers: two days next to each other need one request', centersForDates(['2026-11-05', '2026-11-06']), ['2026-11-07']);
check('centers: dates up to 4 days apart share a request', centersForDates(['2026-11-05', '2026-11-09']), ['2026-11-07']);
check('centers: dates 5 days apart need two', centersForDates(['2026-11-10', '2026-11-05']), ['2026-11-07', '2026-11-12']);
check('centers: no dates, no requests', centersForDates([]), []);

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
check('diff: an empty previous ({}) reports tickets already on sale', diffDays({}, { '2026-10-19': mon }).map((a) => a.kind), ['day']);
const cheaper = { price: 60, slots: [{ window: '06:01-13:00', price: 85 }, { window: '13:00-20:01', price: 60 }] };
const a4 = diffDays(before, { ...before, '2026-10-19': cheaper });
check('diff: a lower price on a day already on sale is a drop', a4.map((a) => [a.date, a.kind, a.price, a.was]), [['2026-10-19', 'drop', 60, 75]]);
check('diff: a higher price is not an alert', diffDays(before, { ...before, '2026-10-19': { ...mon, price: 90 } }), []);
const a5 = diffDays(
  { ...before, '2026-10-19': { price: 75, slots: [{ window: '13:00-20:01', price: 75 }] } },
  { ...before, '2026-10-19': { price: 60, slots: [{ window: '06:01-13:00', price: 60 }, { window: '13:00-20:01', price: 75 }] } },
);
check('diff: a new window that is also cheaper gives one alert, as a new window', a5.map((a) => a.kind), ['slot']);

// What the notification says.
const lp = ROUTES['london-paris'];
check('text: tickets appearing', alertText(lp, a1[0]), { title: 'Snap London to Paris: Tue 20 Oct has tickets', message: '£85 (06:01 to 13:00)\nSnap trains are confirmed 48 hours before travel.' });
check('text: a price drop lists the windows, then how it compares with the last check', alertText(lp, a4[0]).message, '£85 (06:01 to 13:00), £60 (13:00 to 20:01)\nDown £15 since the last check (was £75)\nSnap trains are confirmed 48 hours before travel.');
check('text: a drop title gives the new price', alertText(lp, a4[0]).title, 'Snap London to Paris: Mon 19 Oct is now £60');

// Price change since the last alert (within £10 reads as "about the same").
check('change: nothing to compare with says nothing', changeLine(45, null), '');
check('change: down since the last alert', changeLine(45, { price: 65, kind: 'alert' }), 'Down £20 since the last alert (was £65)');
check('change: up since the last alert', changeLine(85, { price: 65, kind: 'alert' }), 'Up £20 since the last alert (was £65)');
check('change: within £10 is about the same', [changeLine(75, { price: 65, kind: 'alert' }), changeLine(55, { price: 65, kind: 'alert' }), changeLine(65, { price: 65, kind: 'alert' })], ['About the same as the last alert (£65)', 'About the same as the last alert (£65)', 'About the same as the last alert (£65)']);
check('change: £11 is a real move', changeLine(76, { price: 65, kind: 'alert' }), 'Up £11 since the last alert (was £65)');
check('change: a price seen but never alerted says "last check"', changeLine(45, { price: 65, kind: 'check' }), 'Down £20 since the last check (was £65)');
const reAlert = alertText(lp, { date: '2026-10-30', kind: 'slot', price: 75, current: 45, slots: [], newSlots: [{ window: '13:00-20:01', price: 75 }] }, { price: 65, kind: 'alert' });
check('text: the comparison uses the day cheapest price, not the new window price', reAlert.message.split('\n')[1], 'Down £20 since the last alert (was £65)');
check('text: a first alert for a date has no comparison line', alertText(lp, a1[0], null).message.split('\n').length, 2);
check('text: a new window lists only the new one', alertText(ROUTES['paris-london'], a2[0]).title, 'Snap Paris to London: Mon 19 Oct has a new time window');

if (failures > 0) { console.error(`\n${failures} test(s) failed.`); process.exit(1); }
console.log('\nAll trains tests passed.');

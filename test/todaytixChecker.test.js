// test/todaytixChecker.test.js -- run with: node test/todaytixChecker.test.js
//
// Exercises the pure parseShowtimes() against a fixture shaped like the
// real page data captured 2026-11-01 (The Lives of Others). checkTodaytix()
// itself does a real network fetch, which a unit test shouldn't.

const { parseShowtimes } = require('../checkers/todaytixChecker');
const { shouldNotify } = require('../runChecks');

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

const price = (value) => ({ lowPrice: { value, currency: 'GBP' }, priceBands: [] });
const page = (initialShowtimes) =>
  `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { initialShowtimes } },
  })}</script></html>`;

const html = page([
  { localDate: '2026-12-09', localTime: '14:30', regularTickets: price(110), lotteryTickets: null },
  { localDate: '2026-11-10', localTime: '19:30', regularTickets: null, lotteryTickets: price(35) },
  { localDate: '2026-12-14', localTime: '19:30', regularTickets: price(54.5), lotteryTickets: null },
  { localDate: '2026-11-02', localTime: '19:30', regularTickets: null, lotteryTickets: null },
]);

const perfs = parseShowtimes(html);
check('regular tickets are available with their price', perfs[0], {
  label: '9 Dec 2026, 2.30pm',
  state: 'available',
  snippet: 'Regular tickets from £110',
});
check('lottery-only is sold_out by default', perfs[1].state, 'sold_out');
check('fractional price keeps pence', perfs[2].snippet, 'Regular tickets from £54.50');
check('no tickets at all is sold_out', perfs[3].state, 'sold_out');
check('includeLottery makes lottery-only available', parseShowtimes(html, { includeLottery: true })[1].snippet, 'Lottery tickets from £35');

// The label and snippet must work with the existing cap and date gates.
const settings = { blockedDateRanges: [{ start: '2026-12-04', end: '2026-12-13' }] };
check('cap: £110 over a £60 cap is blocked', shouldNotify(perfs[0], { maxPrice: 60 }, {}).allowed, false);
check('cap: £54.50 under a £60 cap is allowed', shouldNotify(perfs[2], { maxPrice: 60 }, settings).allowed, true);
check('blocked dates: 9 Dec is blocked even if cheap', shouldNotify({ ...perfs[0], snippet: 'Regular tickets from £40' }, { maxPrice: 60 }, settings).allowed, false);

let threw = '';
try { parseShowtimes('<html>Just a moment...</html>'); } catch (e) { threw = e.message; }
check('page without __NEXT_DATA__ throws a clear error', /__NEXT_DATA__/.test(threw), true);
threw = '';
try { parseShowtimes(page([])); } catch (e) { threw = e.message; }
check('empty showtimes throws', /No showtimes/.test(threw), true);

if (failures) {
  console.log(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log('\nAll todaytixChecker tests passed.');

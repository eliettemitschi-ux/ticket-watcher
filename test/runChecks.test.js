// test/runChecks.test.js -- run with: node test/runChecks.test.js
const assert = require('assert');
const { shouldNotify, priceAllows, dateAllows } = require('../runChecks');

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

// --- priceAllows: the maxPrice cap ---
{
  check('priceAllows: no cap set, always allowed', priceAllows({ snippet: '£120 Book tickets' }, null), true);
  check('priceAllows: price under cap, allowed', priceAllows({ snippet: 'Standard entry from £41 Book tickets' }, 50), true);
  check('priceAllows: price at cap, allowed', priceAllows({ snippet: '£50 + £4 booking fee Book tickets' }, 50), true);
  check('priceAllows: price over cap, blocked', priceAllows({ snippet: '£120 + £4 booking fee Book tickets' }, 50), false);
  check('priceAllows: no price found in snippet, fails open (allowed)', priceAllows({ snippet: 'Book tickets' }, 50), true);
  // Real case seen live (2026-09-24) on Electra/Persona: two genuine
  // returns appeared at £120 and £92, both above a £50 cap -- both
  // should be correctly blocked, not just one.
  check('priceAllows: real NT snippet at £92, blocked by £50 cap', priceAllows({ snippet: 'er 2026 1:00 pm £92 + £4 booking fee Book tickets Wed 07 October 2026' }, 50), false);
}

// --- dateAllows: the global blocked-date-range gate ---
{
  const ranges = [{ start: '2026-10-06', end: '2026-10-18' }];
  check('dateAllows: no ranges configured, always allowed', dateAllows('07 October 2026, 1:00 pm', []), true);
  check('dateAllows: date inside the blocked range, blocked', dateAllows('07 October 2026, 1:00 pm', ranges), false);
  check('dateAllows: date on the start boundary, blocked', dateAllows('06 October 2026, 7:00 pm', ranges), false);
  check('dateAllows: date on the end boundary, blocked', dateAllows('18 October 2026, 7:00 pm', ranges), false);
  check('dateAllows: date just before the range, allowed', dateAllows('05 October 2026, 7:00 pm', ranges), true);
  check('dateAllows: date just after the range, allowed', dateAllows('19 October 2026, 7:00 pm', ranges), true);
  check('dateAllows: unrelated month, allowed', dateAllows('21 November 2026, 5pm', ranges), true);
  check('dateAllows: no parseable date in label, fails open (allowed)', dateAllows('Some Simple Event', ranges), true);
}

// --- shouldNotify: the three gates combined ---
{
  const settings = { blockedDateRanges: [{ start: '2026-10-06', end: '2026-10-18' }] };

  // Real case seen live (2026-09-24): the National Theatre event, capped
  // at £50, with a performance that's both over-budget AND inside the
  // blocked window -- either reason alone should block it.
  const ntEvent = { timeFilter: null, maxPrice: 50 };
  const overBudgetInBlockedWindow = { label: '07 October 2026, 1:00 pm', snippet: '£92 + £4 booking fee Book tickets' };
  check(
    'shouldNotify: NT performance over budget AND in blocked window -- blocked',
    shouldNotify(overBudgetInBlockedWindow, ntEvent, settings).allowed,
    false
  );

  const cheapOutsideWindow = { label: '20 October 2026, 7:00 pm', snippet: '£35 + £4 booking fee Book tickets' };
  check(
    'shouldNotify: NT performance under budget AND outside blocked window -- allowed',
    shouldNotify(cheapOutsideWindow, ntEvent, settings).allowed,
    true
  );

  const cheapInsideWindow = { label: '10 October 2026, 7:00 pm', snippet: '£35 + £4 booking fee Book tickets' };
  check(
    'shouldNotify: NT performance under budget but INSIDE blocked window -- still blocked (date wins)',
    shouldNotify(cheapInsideWindow, ntEvent, settings).allowed,
    false
  );

  // An event with no maxPrice (e.g. Barbican, Southbank) is unaffected by
  // the price gate -- only the global date window can block it.
  const barbicanEvent = { timeFilter: null, maxPrice: null };
  const expensiveOutsideWindow = { label: '21 November 2026, 8.30pm', snippet: 'From £200. Book tickets.' };
  check(
    'shouldNotify: event with no maxPrice ignores price entirely',
    shouldNotify(expensiveOutsideWindow, barbicanEvent, settings).allowed,
    true
  );
  const anyPriceInsideWindow = { label: '10 October 2026, 8.30pm', snippet: 'From £200. Book tickets.' };
  check(
    'shouldNotify: event with no maxPrice is still blocked by the date window',
    shouldNotify(anyPriceInsideWindow, barbicanEvent, settings).allowed,
    false
  );
}

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
} else {
  console.log('\nAll runChecks tests passed.');
}

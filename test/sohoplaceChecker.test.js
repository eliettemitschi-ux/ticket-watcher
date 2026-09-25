// test/sohoplaceChecker.test.js -- run with: node test/sohoplaceChecker.test.js
//
// Only exercises the pure formatLabel() and AVAILABLE_COLORS logic --
// checkSohoplace() itself makes real network calls (getbymonth API),
// which isn't something a unit test should be doing.

const assert = require('assert');
const { formatLabel, AVAILABLE_COLORS } = require('../checkers/sohoplaceChecker');

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

check('formatLabel formats an evening performance', formatLabel('2026-09-25T19:00:00'), '25 Sept 2026, 7pm');
check('formatLabel formats a matinee with minutes', formatLabel('2026-10-03T13:30:00'), '3 Oct 2026, 1.30pm');
check('formatLabel falls back to the raw string when unparseable', formatLabel('not-a-date'), 'not-a-date');

// Real case found live (2026-09-25): availability is a named colour band,
// not a boolean -- "Low" (very few seats) is still genuinely bookable,
// only a value outside this known-good set should ever read sold_out.
check('AVAILABLE_COLORS: Good/Medium/Low are all genuinely bookable', ['Good', 'Medium', 'Low'].every((c) => AVAILABLE_COLORS.has(c)), true);
check('AVAILABLE_COLORS: an unrecognised value is not treated as available', AVAILABLE_COLORS.has('SoldOut'), false);
check('AVAILABLE_COLORS: undefined/missing is not treated as available', AVAILABLE_COLORS.has(undefined), false);

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
} else {
  console.log('\nAll sohoplaceChecker tests passed.');
}

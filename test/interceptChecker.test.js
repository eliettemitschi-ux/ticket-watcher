// test/interceptChecker.test.js -- run with: node test/interceptChecker.test.js
// Uses the REAL productionseasons response captured from secure.southbankcentre.co.uk
// (Bob Dylan, 4 Oct 2026), which is wrapped as { productions: [...] }.

const fs = require('fs');
const path = require('path');
const { seasonsFrom, performancesFromSeasons } = require('../checkers/interceptChecker');

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

const real = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'southbank-productionseasons.json'), 'utf8'));
const wanted = new Set(['141878', '141911']);

// The current shape (wrapped) -- this is the one that broke Bob Dylan.
const seasons = seasonsFrom(real);
check('wrapped response: seasons are found', Array.isArray(seasons) && seasons.length, 2);
const perfs = performancesFromSeasons(seasons, wanted);
check('wrapped response: all 10 performances are read', perfs.length, 10);
check('wrapped response: a sold-out run reads sold_out', [...new Set(perfs.map((p) => p.state))], ['sold_out']);
check('wrapped response: two seasons get the production title in the label', perfs[0].label, 'Bob Dylan, Thursday 3 December 2026, 8:00pm');

// The original shape (a bare array) must keep working.
check('legacy bare array: still understood', seasonsFrom(real.productions).length, 2);
check('legacy bare array: same performances', performancesFromSeasons(seasonsFrom(real.productions), wanted).length, 10);

// A season filter that matches only one season.
const one = performancesFromSeasons(seasons, new Set(['141878']));
check('single season: only its performances, plain labels', [one.length, one[0].label], [5, 'Thursday 3 December 2026, 8:00pm']);

// Tickets appearing: flip one real performance to bookable.
const open = JSON.parse(JSON.stringify(real));
Object.assign(open.productions[0].performances[0], { isOnSale: true, performanceStatusMessage: '' });
const after = performancesFromSeasons(seasonsFrom(open), wanted);
check('on sale: a bookable performance reads available', after[0].state, 'available');
check('on sale: the others stay sold_out', after.slice(1).every((p) => p.state === 'sold_out'), true);

// Unusable responses are rejected rather than guessed at.
check('unknown shape is not mistaken for data', seasonsFrom({ somethingElse: [] }), null);
check('null is not mistaken for data', seasonsFrom(null), null);

if (failures > 0) { console.error(`\n${failures} test(s) failed.`); process.exit(1); }
console.log('\nAll interceptChecker tests passed.');

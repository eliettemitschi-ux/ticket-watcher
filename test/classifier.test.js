// test/classifier.test.js
//
// Zero-dependency sanity check for checkers/classify.js, run with
// `npm test`. This is the one part of the whole system that can be
// tested without a network connection or a browser, so it's worth
// keeping honest as the sold-out/available keyword lists evolve.

const assert = require('assert');
const { classify } = require('../checkers/classify');

const cases = [
  { text: 'This event is Sold Out. Join the waiting list for returns.', expect: 'sold_out' },
  { text: 'FULLY BOOKED', expect: 'sold_out' },
  { text: 'Sorry, tickets are not available for this performance.', expect: 'sold_out' },
  { text: 'Standard  From £34   Book tickets', expect: 'available' },
  { text: 'Choose your seats to continue', expect: 'available' },
  { text: 'Add to basket', expect: 'available' },
  { text: 'Checking availability...', expect: 'pending' },
  { text: '', expect: 'unknown' },
  { text: 'Welcome to the Barbican. Explore our upcoming season.', expect: 'unknown' },
  // Regression case: "book" appears inside a sold-out sentence and must
  // not be misread as an available-tickets signal.
  { text: 'This performance is sold out. Book onto our waiting list instead.', expect: 'sold_out' },
  // Real bug found live (2026-09-23): Southbank Centre's "Correspondences"
  // event page never shows an explicit "Book now"-style CTA, only a
  // plain price -- without recognising this, a genuinely on-sale show
  // read as "unknown" forever, including for the exact sold-out-then-
  // available transition this tool exists to catch.
  { text: 'Standard entry from £41 Ticket prices may be adjusted without notice to reflect demand.', expect: 'available' },
  { text: 'Tickets from £15', expect: 'available' },
  // A page that's genuinely sold out but still shows old pricing text
  // nearby must still read sold_out -- sold-out patterns are checked
  // first, this locks that priority in as a real guarantee, not luck.
  { text: 'Standard entry from £41. Sold out -- join the waiting list.', expect: 'sold_out' },
];

let failures = 0;
for (const { text, expect } of cases) {
  const { state } = classify(text);
  const pass = state === expect;
  if (!pass) failures += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  expected=${expect} got=${state}  "${text.slice(0, 60)}"`);
}

if (failures > 0) {
  console.error(`\n${failures} of ${cases.length} classifier test(s) failed.`);
  process.exit(1);
} else {
  console.log(`\nAll ${cases.length} classifier tests passed.`);
}

// test/sohoplaceChecker.test.js -- run with: node test/sohoplaceChecker.test.js
//
// Exercises the pure formatLabel() and classifyInventory() logic --
// checkSohoplace()/fetchInventory() themselves make real network calls
// (getbymonth / eventinventory APIs), which isn't something a unit test
// should be doing.

const assert = require('assert');
const { formatLabel, classifyInventory } = require('../checkers/sohoplaceChecker');

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

// Real bug found live (2026-09-25/26) on Who's Afraid of Virginia Woolf:
// the getbymonth summary API reported "Low availability, from £18.5" for
// BOTH of these performances -- one confirmed genuinely sold out on its
// own seat-selection page ("Performance Sold Out"), one confirmed
// genuinely bookable (2 real seats, £95/£47.50). classifyInventory()
// must tell them apart using the real per-performance inventory, not the
// misleading summary fields.
{
  // Real captured response for performance 2020444 (25 Sept 2026, 7pm) --
  // confirmed sold out on its own page.
  const soldOutInventory = {
    eventId: 2020444,
    priceTypes: [{ id: 41432, displayName: 'Admission', isDefault: true }],
    priceMaps: [],
    mapGASections: [],
    mapSeats: [],
  };
  const soldOut = classifyInventory(soldOutInventory);
  check('classifyInventory: confirmed sold-out performance reads unavailable', soldOut.available, false);
  check('classifyInventory: confirmed sold-out performance has no price', soldOut.price, null);

  // Real captured response for performance 2020517 (19 Dec 2026, 7pm) --
  // confirmed genuinely bookable, 2 real seats.
  const availableInventory = {
    eventId: 2020517,
    priceMaps: [
      {
        price: 95,
        displayPrice: 95,
        discountedPrice: 47.5,
        discountedDisplayPrice: 47.5,
        zone: 'Price Band A',
      },
    ],
    mapGASections: [],
    mapSeats: [{ id: 1 }, { id: 2 }],
  };
  const available = classifyInventory(availableInventory);
  check('classifyInventory: confirmed available performance reads available', available.available, true);
  check('classifyInventory: real discounted price used, not the misleading £18.5 summary figure', available.price, 47.5);
}

// GA (general admission) sections count as real inventory too, not just
// individual seats -- some venues/performances sell GA-only.
check(
  'classifyInventory: GA sections alone (no individual seats) still count as real inventory',
  classifyInventory({ priceMaps: [{ price: 30 }], mapGASections: [{ id: 1 }], mapSeats: [] }).available,
  true
);

// Seats/sections present but genuinely no price map (e.g. a comp-only or
// not-yet-priced performance) must not read as available -- no price
// means nothing a member of the public can actually buy.
check(
  'classifyInventory: seats present but no price map does not read as available',
  classifyInventory({ priceMaps: [], mapGASections: [], mapSeats: [{ id: 1 }] }).available,
  false
);

// Multiple price tiers -- the real "from" price is the cheapest one,
// preferring each tier's discounted price when present.
check(
  'classifyInventory: picks the lowest price across multiple tiers',
  classifyInventory({
    priceMaps: [
      { price: 95, discountedPrice: 47.5 },
      { price: 150, discountedPrice: 150 },
      { price: 65 }, // no discountedPrice field at all -- falls back to price
    ],
    mapGASections: [],
    mapSeats: [{ id: 1 }],
  }).price,
  47.5
);

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
} else {
  console.log('\nAll sohoplaceChecker tests passed.');
}

// test/htmlInstancesChecker.test.js
//
// Zero-dependency sanity check for checkers/htmlInstancesChecker.js's pure
// parsing logic (extractInstances, formatLabel), run with
// `node test/htmlInstancesChecker.test.js`. No network needed -- these
// fixtures are trimmed real fragments captured from Barbican's and Golden
// Boy's own per-performance endpoints (see HANDOFF.md).

const assert = require('assert');
const { extractInstances, formatLabel, isGeneralPresaleGated } = require('../checkers/htmlInstancesChecker');

const BARBICAN_FRAGMENT = `
  <div class="instance-listing">
    <div class="instance-time"><p class="instance-time__time"><time datetime="2026-11-21T17:00:00Z">5.00pm</time></p></div>
    <div class="instance-listing__button"><button class="button btn btn-sold-out"><span>Sold out</span></button></div>
  </div>
  <div class="instance-listing">
    <div class="instance-time"><p class="instance-time__time"><time datetime="2026-11-21T20:30:00Z">8.30pm</time></p></div>
    <div class="instance-listing__button"><button class="button btn btn-book-now"><span>Book now</span></button></div>
  </div>
`;

const GOLDEN_BOY_FRAGMENT = `
  <div class="c-calendar-instance">
    <time datetime="2026-09-19 14:00:00" class="c-calendar-instance__time">Sat 19 Sep 2pm</time>
    <div class="c-calendar-instance__button">
      <span class="c-btn c-btn--disabled">Sold Out</span>
      <div class="c-availability-indicator c-availability-indicator--sold-out"></div>
    </div>
  </div>
`;

let failures = 0;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`);
  if (!pass) {
    console.log(`  expected: ${JSON.stringify(expected)}`);
    console.log(`  got:      ${JSON.stringify(actual)}`);
  }
}

check(
  'extractInstances finds both Barbican showtimes with correct sold-out flags',
  extractInstances(BARBICAN_FRAGMENT),
  [
    { datetime: '2026-11-21T17:00:00Z', soldOut: true },
    { datetime: '2026-11-21T20:30:00Z', soldOut: false },
  ]
);

check(
  'extractInstances reads a Golden Boy fragment as sold out',
  extractInstances(GOLDEN_BOY_FRAGMENT),
  [{ datetime: '2026-09-19 14:00:00', soldOut: true }]
);

check('extractInstances returns [] for text with no <time datetime> at all', extractInstances('<p>No shows</p>'), []);
check('extractInstances returns [] for empty/non-string input', extractInstances(''), []);

// Real bug found live (2026-09-21): Barbican's per-node instances response
// for a SINGLE performance ends with a "Join" (membership) tab whose own
// marketing copy mentions "sold-out shows" as a membership perk -- nothing
// to do with this performance's actual availability. Because there's only
// one <time> tag, that whole trailing tab used to get swept into the same
// "part" as the real (available) button, and the distant unrelated phrase
// made a genuinely bookable screening (Godzilla 2000: Millennium) read as
// sold out. MAX_INSTANCE_WINDOW must keep the real nearby button in scope
// while cutting off before that kind of distant, unrelated noise.
const BARBICAN_SINGLE_INSTANCE_WITH_JOIN_TAB_NOISE = `
  <div class="tab-content" data-tab="performances">
    <div class="instance-listing">
      <div class="instance-time"><p class="instance-time__time"><time datetime="2026-09-22T18:20:00Z">6.20pm</time></p></div>
      <div class="instance-listing__button">
        <a href="https://tickets.barbican.org.uk/choose-seats/3619201" class="button btn btn-login-to-book"><span>Choose seats</span></a>
      </div>
    </div>
  </div>
  <div class="tab-content" style="display: none;" data-tab="join">
    ${'padding text unrelated to any performance '.repeat(150)}
    <li><strong>Access to Sold-out Events:</strong> Gain the ability to secure tickets for sold-out shows, ensuring you never miss out.</li>
  </div>
`;
check(
  'extractInstances does not let the distant "Join" tab\'s unrelated "sold-out" copy poison a real, available performance',
  extractInstances(BARBICAN_SINGLE_INSTANCE_WITH_JOIN_TAB_NOISE),
  [{ datetime: '2026-09-22T18:20:00Z', soldOut: false }]
);

// Real investigation live (2026-09-24) on Barbican's Ronnie Scott's 100th
// Birthday: its per-performance booking link carries class
// "btn-login-to-book" during a members-only presale window, which looked
// at first like a reliable "not really open yet" signal -- until it
// turned up on Church of Sound 10th Birthday too, a fully on-sale event
// with no presale gate at all. That class just means "log in to
// checkout" on every Barbican booking link, unrelated to membership
// gating -- using it would have made every Barbican event read as
// perpetually "not really available". The real signal is the booking
// overlay's own "General" tier row, present only during a presale
// window and absent once (or if) the event is fully on public sale.
const RONNIE_SCOTT_PRESALE_FRAGMENT = `
  <div class="_row _row-priority" data-identifier="general">
    <div class="_column _column-booking-status">
      <h3 class="_title _title-priority-row">General</h3>
      <p>
        Book from 10.00am, Fri 25 Sep
      </p>
    </div>
  </div>
`;
check('isGeneralPresaleGated: true for a real members-presale "General" row', isGeneralPresaleGated(RONNIE_SCOTT_PRESALE_FRAGMENT), true);

const FULLY_ON_SALE_FRAGMENT = `
  <div class="instance-listing">
    <div class="instance-time"><p class="instance-time__time"><time datetime="2026-11-21T20:30:00Z">8.30pm</time></p></div>
    <div class="instance-listing__button">
      <a href="https://tickets.barbican.org.uk/choose-seats/3631201" class="btn btn-login-to-book"><span>Book tickets</span></a>
    </div>
  </div>
`;
check(
  'isGeneralPresaleGated: false for a fully on-sale event (no "General" tier row, even with the same login-to-book class)',
  isGeneralPresaleGated(FULLY_ON_SALE_FRAGMENT),
  false
);

check('formatLabel formats a Z-suffixed ISO datetime on the hour', formatLabel('2026-11-21T17:00:00Z'), '21 Nov 2026, 5pm');
check('formatLabel formats a space-separated datetime with minutes', formatLabel('2026-09-19 14:00:00'), '19 Sept 2026, 2pm');
check('formatLabel formats a half-past time', formatLabel('2026-11-21T20:30:00Z'), '21 Nov 2026, 8.30pm');
check('formatLabel falls back to the raw string when unparseable', formatLabel('not-a-date'), 'not-a-date');

if (failures > 0) {
  console.error(`\n${failures} htmlInstancesChecker test(s) failed.`);
  process.exit(1);
} else {
  console.log('\nAll htmlInstancesChecker tests passed.');
}

// test/royalCourtChecker.test.js -- run with: node test/royalCourtChecker.test.js
// Uses the REAL availability response captured from royalcourttheatre.com
// (Man to Man, 4 Oct 2026): 24 performances, all with 0 seats available.

const fs = require('fs');
const path = require('path');
const { parseAvailability, labelFor, spektrixLabel, performancesFromSpektrix } = require('../checkers/royalCourtChecker');
const { BROWSERLESS_MODES } = require('../checkers');

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

const real = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'royalcourt-availability-man-to-man.json'), 'utf8'));

const perfs = parseAvailability(real);
check('real response: all 24 performances are read', perfs.length, 24);
check('real response: a fully sold-out run reads sold_out throughout', [...new Set(perfs.map((p) => p.state))], ['sold_out']);
check('real response: labels carry the year so date-range blocking works', perfs[0].label, '5 Oct 2026, 7.30pm');
check('real response: afternoon performance label', perfs.find((p) => /2.30pm/.test(p.label)).label, '8 Oct 2026, 2.30pm');

// Seats appearing: flip one real performance to have 4 seats.
const open = JSON.parse(JSON.stringify(real));
open.availability.instances[2].availability.available = 4;
const after = parseAvailability(open);
check('seats appear: that performance reads available', after[2].state, 'available');
check('seats appear: the snippet says how many', after[2].snippet, '4 seats available');
check('seats appear: the others stay sold_out', after.filter((p, i) => i !== 2).every((p) => p.state === 'sold_out'), true);

const one = JSON.parse(JSON.stringify(real));
one.availability.instances[0].availability.available = 1;
check('seats appear: singular wording for one seat', parseAvailability(one)[0].snippet, '1 seat available');

// Locked (held in baskets) seats are NOT available -- they may come back,
// but until they do the show is sold out.
check('held seats alone do not make a show look available', real.availability.instances[0].availability.locked > 0 && perfs[0].state === 'sold_out', true);

// Wrong shapes are rejected, never guessed at.
check('a Cloudflare page / null is not data', parseAvailability(null), null);
check('an unexpected object is not data', parseAvailability({ availability: {} }), null);
check('labelFor: falls back gracefully without an ISO date', labelFor({ id: 9, date: { date: 'Mon 5 Oct', time: '7.30pm' } }), 'Mon 5 Oct, 7.30pm');


// --- Spektrix fallback (real captured responses) ------------------------------
{
  const mtm = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'spektrix-man-to-man.json'), 'utf8'));
  const now = Date.parse('2026-10-04T17:00:00Z');
  const sp = performancesFromSpektrix(mtm.instances, mtm.statuses, now);
  check('spektrix: only upcoming performances are listed (2 past ones dropped)', sp.length, 4);
  check('spektrix: label matches the Royal Court endpoint wording exactly', sp[0].label, '5 Oct 2026, 7.30pm');
  check('spektrix: Man to Man (capacity 0, available 0) reads sold out', [...new Set(sp.map((p) => p.state))], ['sold_out']);
  check('spektrix: the same dates and labels as the Royal Court endpoint', sp.map((p) => p.label), perfs.slice(0, 4).map((p) => p.label));

  // A show that really has seats: 4, 3 and 1 left on the first three dates.
  const blood = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'spektrix-blood-of-my-blood.json'), 'utf8'));
  const bp = performancesFromSpektrix(blood.instances, blood.statuses, Date.parse('2026-10-01T00:00:00Z'));
  check('spektrix (real seats): states', bp.map((p) => p.state), ['available', 'available', 'available', 'sold_out', 'sold_out', 'sold_out']);
  check('spektrix (real seats): the snippet counts seats', bp.slice(0, 3).map((p) => p.snippet), ['4 seats available', '3 seats available', '1 seat available']);

  // A failed status lookup must never be read as "sold out".
  const broken = { ...mtm.statuses, [mtm.instances[2].id]: null };
  const bpart = performancesFromSpektrix(mtm.instances, broken, now);
  check('spektrix: a failed seat lookup reads unknown, not sold out', bpart.filter((p) => p.state === 'unknown').length, 1);

  const cancelled = JSON.parse(JSON.stringify(mtm.instances));
  cancelled[2].cancelled = true;
  check('spektrix: cancelled performances are skipped', performancesFromSpektrix(cancelled, mtm.statuses, now).length, 3);

  check('spektrixLabel: evening and minutes', spektrixLabel('2026-10-24T18:30:00'), '24 Oct 2026, 6.30pm');
  check('spektrixLabel: afternoon', spektrixLabel('2026-10-08T14:30:00'), '8 Oct 2026, 2.30pm');
  check('spektrixLabel: on the hour has no minutes', spektrixLabel('2026-10-05T19:00:00'), '5 Oct 2026, 7pm');
}

// Mode wiring: this recipe must not launch a browser by default.
check('royal-court-api is a browserless mode', BROWSERLESS_MODES.has('royal-court-api'), true);
check('render mode still needs a browser', BROWSERLESS_MODES.has('render'), false);
check('intercept-api still needs a browser', BROWSERLESS_MODES.has('intercept-api'), false);

if (failures > 0) { console.error(`\n${failures} test(s) failed.`); process.exit(1); }
console.log('\nAll royalCourtChecker tests passed.');

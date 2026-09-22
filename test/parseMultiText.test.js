// test/parseMultiText.test.js -- run with: node test/parseMultiText.test.js
const assert = require('assert');
const { parseInstancesFromText } = require('../checkers/parseMultiText');

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

// --- Case 1: Barbican-style -- one date, two named showtimes, one sold
// out and one bookable, with door times that must NOT be picked up as
// their own slots.
{
  const text = `
    Haruki Murakami's Jazz at Peter Cat
    Saturday, 21 November 2026
    Matinee: 5pm (doors 4.30pm)
    Sold Out. Join the waiting list for returns.
    Evening: 8.30pm (doors 8pm)
    From £34. Book tickets.
  `;
  const result = parseInstancesFromText(text, 'Murakami Jazz').map((r) => ({ label: r.label, state: r.state }));
  check('Barbican: exactly two performances found', result.length, 2);
  const matinee = result.find((r) => /5pm/.test(r.label));
  const evening = result.find((r) => /8\.30pm/.test(r.label));
  check('Barbican: matinee is sold out', matinee?.state, 'sold_out');
  check('Barbican: evening is available', evening?.state, 'available');
  check('Barbican: no door-time entries leaked in', result.some((r) => /4\.30pm|8pm\b/.test(r.label) && !/8\.30pm/.test(r.label)), false);
}

// --- Case 2: Golden Boy-style -- a run of separate dates, each with its
// own status, no showtimes given (just dates).
{
  const text = `
    Golden Boy
    12 November 2026 -- Sold Out
    13 November 2026 -- Sold Out
    14 November 2026 -- Book tickets now, seats available
    15 November 2026 -- Sold Out
  `;
  const result = parseInstancesFromText(text, 'Golden Boy').map((r) => ({ label: r.label, state: r.state }));
  check('Golden Boy: four dates found', result.length, 4);
  const the14th = result.find((r) => r.label.startsWith('14'));
  check('Golden Boy: the 14th is available', the14th?.state, 'available');
  const the12th = result.find((r) => r.label.startsWith('12'));
  check('Golden Boy: the 12th is sold out', the12th?.state, 'sold_out');
}

// --- Case 3: plain single-performance page, no dates/times at all --
// must behave exactly like the old single-status classifier (regression
// safety for every event that doesn't need multi-performance handling).
{
  const text = 'This event is Sold Out. Join the waiting list for returns.';
  const result = parseInstancesFromText(text, 'Some Simple Event');
  check('Plain page: exactly one performance', result.length, 1);
  check('Plain page: uses the fallback label', result[0].label, 'Some Simple Event');
  check('Plain page: correctly sold out', result[0].state, 'sold_out');
}

// --- Case 4: garbage/empty text shouldn't crash and should fall back cleanly.
{
  const result = parseInstancesFromText('', 'Empty Page Event');
  check('Empty text: one fallback performance', result.length, 1);
  check('Empty text: state is unknown', result[0].state, 'unknown');
}

// --- Case 5: a "You might also like" related-events rail (real bug seen
// on the actual Barbican page -- an unrelated October screening showed
// up as a bogus extra "performance" of the Murakami Jazz show) must be
// cut off, not scanned as if it belonged to the event being watched.
{
  const text = `
    Haruki Murakami's Jazz at Peter Cat
    Saturday, 21 November 2026
    Matinee: 5pm (doors 4.30pm)
    Sold Out. Join the waiting list for returns.
    Evening: 8.30pm (doors 8pm)
    From £34. Book tickets.

    You might also like
    Battle Royale + Introduction by actor Tatsuya Fujiwara
    Sat 10 Oct 2026, 16:00. Sold Out.
    Haruki Murakami in Conversation + Tony Takitani
    Sun 11 Oct 2026, 17:45. Book tickets.
  `;
  const result = parseInstancesFromText(text, 'Murakami Jazz').map((r) => ({ label: r.label, state: r.state }));
  check('Related rail: only the real two performances found', result.length, 2);
  check('Related rail: no October date leaked in', result.some((r) => /oct/i.test(r.label)), false);
  const evening = result.find((r) => /8\.30pm/.test(r.label));
  check('Related rail: evening is still correctly available', evening?.state, 'available');
}

// --- Case 6: National Theatre-style -- marketing copy and a header date
// range BEFORE the real "Dates and times for <show>" list must not leak
// in as bogus performances, and a "Touch Tour at 5.30pm" access pre-show
// slot listed next to a real showtime must not be read as its own
// separate (wrongly "unknown") performance -- real bug seen on the
// Electra/Persona booking page.
{
  const text = `
    Electra/Persona
    Mon 21 September – Sat 10 October 2026
    Lyttelton Theatre
    Ticket update: Electra/Persona is now mostly sold out, however there
    are two further options to purchase tickets for sold out performances:
    1. £10 Friday Rush tickets available every Friday at 1pm.
    Member Plus late release tickets now available for performances from
    28 September - 10 October for Electra/Persona.

    Dates and times for Electra/Persona
    Mon 21 September 2026 at 7:00 pm
    Mon 21 September 2026
    7:00 pm
    + £4 booking fee
    Sold out
    Thu 08 October 2026 at 7:00 pm
    Thu 08 October 2026
    7:00 pm
    Touch Tour at 5.30pm
    Audio described
    + £4 booking fee
    Sold out
  `;
  const result = parseInstancesFromText(text, 'Electra/Persona').map((r) => ({ label: r.label, state: r.state }));
  check('National Theatre: only the two real showtimes found', result.length, 2);
  check('National Theatre: no header date-range leaked in', result.some((r) => /21 september.*10 october|28 september.*10 october/i.test(r.label)), false);
  check('National Theatre: no stray 5.30pm Touch Tour slot leaked in', result.some((r) => /5\.30pm/.test(r.label)), false);
  const oct08 = result.find((r) => /08 october/i.test(r.label));
  check('National Theatre: the access performance itself reads sold out (not "unknown")', oct08?.state, 'sold_out');
}

// --- Case 7: National Theatre's REAL bug, reproduced verbatim -- every
// performance's date+time is printed TWICE: once as a "Tue 22 September
// 2026 at 7:00 pm" heading, then again as two separate lines right
// before the actual status. Left untreated, this desynced which date
// each status got paired with -- same NUMBER of "available" results,
// but attached to the WRONG dates. This is exactly what happened live
// with the Electra/Persona test event: real notifications went out
// naming performances that were never actually the ones available.
// stripWeekdayDateAtTimeHeadings() must collapse the duplication so
// each status lands back on its own real date.
{
  const text = `
    Dates and times for Electra/Persona
    Mon 21 September 2026 at 7:00 pm
    Mon 21 September 2026
    7:00 pm
    + £4 booking fee
    Sold out
    Tue 22 September 2026 at 7:00 pm
    Tue 22 September 2026
    7:00 pm
    £120
    + £4 booking fee
    Book tickets
    Wed 23 September 2026 at 1:00 pm
    Wed 23 September 2026
    1:00 pm
    FILMED PERFORMANCE
    £120
    + £4 booking fee
    Book tickets
    Wed 23 September 2026 at 7:00 pm
    Wed 23 September 2026
    7:00 pm
    FILMED PERFORMANCE
    + £4 booking fee
    Sold out
    Thu 24 September 2026 at 6:30 pm
    Thu 24 September 2026
    6:30 pm
    + £4 booking fee
    Sold out
  `;
  const result = parseInstancesFromText(text, 'Electra/Persona').map((r) => ({ label: r.label, state: r.state }));
  check('NT duplicate-heading bug: exactly five real performances found', result.length, 5);
  const sep21 = result.find((r) => /21 september/i.test(r.label));
  const sep22 = result.find((r) => /22 september/i.test(r.label));
  const sep23_1pm = result.find((r) => /23 september.*1:00 pm/i.test(r.label));
  const sep23_7pm = result.find((r) => /23 september.*7:00 pm/i.test(r.label));
  const sep24 = result.find((r) => /24 september/i.test(r.label));
  check('NT duplicate-heading bug: 21 Sep correctly sold out', sep21?.state, 'sold_out');
  check('NT duplicate-heading bug: 22 Sep correctly available (not mislabeled)', sep22?.state, 'available');
  check('NT duplicate-heading bug: 23 Sep 1pm (filmed) correctly available (not mislabeled)', sep23_1pm?.state, 'available');
  check('NT duplicate-heading bug: 23 Sep 7pm (filmed) correctly sold out, distinct from the 1pm', sep23_7pm?.state, 'sold_out');
  check('NT duplicate-heading bug: 24 Sep correctly sold out', sep24?.state, 'sold_out');
}

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
} else {
  console.log('\nAll parseMultiText tests passed.');
}

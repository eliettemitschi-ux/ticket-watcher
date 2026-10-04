// test/owner.test.js -- run with: node test/owner.test.js
// Unit tests for the pure helpers in docs/owner.js (the owner-only Scanner tab).

const owner = require('../docs/owner.js');

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

const flagged = { key: 'a', qualifies: true, manual: false };
const plain = { key: 'b', qualifies: false, manual: false };
const manual = { key: 'c', qualifies: false, manual: true };

// --- which shows alert by default ------------------------------------------
check('autoEligible: a flagged show alerts by default', owner.autoEligible(flagged), true);
check('autoEligible: an unflagged show does not', owner.autoEligible(plain), false);
check('autoEligible: a hand-added show alerts by default', owner.autoEligible(manual), true);

// --- overrides ------------------------------------------------------------------
check('effectiveEligible: no override follows the automatic rule', owner.effectiveEligible(plain, {}), false);
check('effectiveEligible: ticked "on" alerts even if unflagged', owner.effectiveEligible(plain, { b: 'on' }), true);
check('effectiveEligible: unticked "off" silences a flagged show', owner.effectiveEligible(flagged, { a: 'off' }), false);

// --- what a tick stores -----------------------------------------------------------
check('nextSelection: ticking an unflagged show stores "on"', owner.nextSelection(plain, true), 'on');
check('nextSelection: unticking a flagged show stores "off"', owner.nextSelection(flagged, false), 'off');
check('nextSelection: ticking a flagged show clears any override', owner.nextSelection(flagged, true), null);
check('nextSelection: unticking an unflagged show clears any override', owner.nextSelection(plain, false), null);
check('nextSelection: unticking a hand-added show stores "off"', owner.nextSelection(manual, false), 'off');

check('withSelection: adds an override', owner.withSelection({}, 'b', 'on'), { b: 'on' });
check('withSelection: null removes it', owner.withSelection({ b: 'on', a: 'off' }, 'b', null), { a: 'off' });
const original = { a: 'off' };
owner.withSelection(original, 'b', 'on');
check('withSelection: does not mutate its input', original, { a: 'off' });

// --- ordering ------------------------------------------------------------------------
const exact = { opens: { at: '2026-10-09T09:00:00.000Z', precision: 'exact' } };
const date = { opens: { at: '2026-10-12T09:00:00.000Z', precision: 'date' } };
const month = { opens: { at: '2026-11-01T00:00:00.000Z', precision: 'month' } };
const none = { opens: null };
const sorted = [none, month, date, exact].sort((x, y) => owner.sortKey(x) - owner.sortKey(y));
check('sortKey: soonest exact, then dated, then month-only, then unknown', sorted, [exact, date, month, none]);

// --- encoding (accents must survive the trip to GitHub and back) ----------------------
const text = JSON.stringify({ 'esmé/x': 'on', 'a’b': 'off' });
check('base64: round-trips accents and curly quotes', owner.base64ToUtf8(owner.utf8ToBase64(text)), text);
check('base64: tolerates the newlines GitHub puts in content', owner.base64ToUtf8(owner.utf8ToBase64('hello').replace(/(.{4})/g, '$1\n')), 'hello');

// --- markup safety ---------------------------------------------------------------------
const nasty = { key: 'k', title: '<img src=x onerror=alert(1)>', venue: 'V', url: 'javascript:alert(1)', state: 'not_on_sale', opens: null, days: [], reasons: [], qualifies: false, manual: false };
const html = owner.upcomingCard(nasty, {}, Date.now());
check('markup: a hostile title is escaped', html.includes('<img'), false);
check('markup: a non-https link is neutralised', html.includes('javascript:'), false);

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
} else {
  console.log('\nAll owner tests passed.');
}

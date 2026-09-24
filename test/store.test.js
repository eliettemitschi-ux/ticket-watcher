// test/store.test.js -- run with: node test/store.test.js
//
// Exercises store.updatePerformances() against a temp data dir (never
// touches the real data/events.json) covering: first-sighting baseline,
// a genuine sold_out -> available flip, and the aggregate status rollup.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

// Point store.js at a throwaway temp directory before requiring it --
// DATA_DIR is computed once at require time from __dirname, so instead we
// copy the module's file into a temp project dir and require it from
// there. Simpler: just monkeypatch by requiring, then swapping its
// internal data dir via an env var isn't supported today, so we set up a
// temp cwd-independent copy.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-watcher-test-'));
fs.mkdirSync(path.join(tmpRoot, 'checkers'), { recursive: true });
fs.copyFileSync(path.join(__dirname, '../store.js'), path.join(tmpRoot, 'store.js'));
fs.copyFileSync(path.join(__dirname, '../notify.js'), path.join(tmpRoot, 'notify.js'));
fs.copyFileSync(path.join(__dirname, '../checkers/parseMultiText.js'), path.join(tmpRoot, 'checkers/parseMultiText.js'));
fs.copyFileSync(path.join(__dirname, '../checkers/classify.js'), path.join(tmpRoot, 'checkers/classify.js'));
// notify.js (required by store.js, for topicForEvent()) itself requires
// node-fetch/nodemailer -- a junction to the real node_modules lets that
// resolve without a slow full copy. Junctions don't need elevation on
// Windows, unlike symlinks.
fs.symlinkSync(path.join(__dirname, '../node_modules'), path.join(tmpRoot, 'node_modules'), 'junction');

const store = require(path.join(tmpRoot, 'store.js'));

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

const event = store.addEvent({
  name: 'Test Show',
  venue: 'Test Venue',
  url: 'https://example.com/test-show',
  recipe: { mode: 'render' },
  timeFilter: '8:30pm',
});

check('addEvent: timeFilter stored', event.timeFilter, '8:30pm');
check('addEvent: performances starts empty', event.performances, []);
// NTFY_TOPIC isn't set in this test process, so topicForEvent() returns
// null -- covered properly in test/notify.test.js instead, this just
// confirms addEvent() doesn't crash when it's unset.
check('addEvent: ntfyTopic is null when NTFY_TOPIC is unset', event.ntfyTopic, null);

// --- First sighting: two performances, both sold out. Should NOT appear
// in newlyAvailable (no prior baseline to have "changed" from).
{
  const { newlyAvailable, anyChanged, event: updated } = store.updatePerformances(event.id, [
    { label: '21 November 2026, 5pm', state: 'sold_out', snippet: 'Sold Out' },
    { label: '21 November 2026, 8.30pm', state: 'sold_out', snippet: 'Sold Out' },
  ]);
  check('first sighting: no newlyAvailable', newlyAvailable, []);
  check('first sighting: anyChanged is false', anyChanged, false);
  check('first sighting: aggregate state is sold_out', updated.status.state, 'sold_out');
  check('first sighting: two performances stored', updated.performances.length, 2);
}

// --- Re-check, still sold out both -- no change at all.
{
  const { newlyAvailable, anyChanged } = store.updatePerformances(event.id, [
    { label: '21 November 2026, 5pm', state: 'sold_out', snippet: 'Sold Out' },
    { label: '21 November 2026, 8.30pm', state: 'sold_out', snippet: 'Sold Out' },
  ]);
  check('re-check same state: no newlyAvailable', newlyAvailable, []);
  check('re-check same state: anyChanged is false', anyChanged, false);
}

// --- The 8.30pm slot flips to available -- THIS is the one that should
// be reported (matches the label the user cares about, for the
// timeFilter gating logic that lives in check.js/server.js).
{
  const { newlyAvailable, anyChanged, event: updated } = store.updatePerformances(event.id, [
    { label: '21 November 2026, 5pm', state: 'sold_out', snippet: 'Sold Out' },
    { label: '21 November 2026, 8.30pm', state: 'available', snippet: 'Book tickets' },
  ]);
  check('flip: exactly one newlyAvailable', newlyAvailable.length, 1);
  check('flip: newlyAvailable is the 8.30pm slot', newlyAvailable[0].label, '21 November 2026, 8.30pm');
  check('flip: anyChanged is true', anyChanged, true);
  check('flip: aggregate rolls up to available', updated.status.state, 'available');
  const matinee = updated.performances.find((p) => /5pm/.test(p.label));
  check('flip: the 5pm matinee is untouched (still sold_out)', matinee.state, 'sold_out');
}

// --- Flips back to sold out -- should NOT be in newlyAvailable (that
// array is only ever for -> available transitions), but should still
// register as a change.
{
  const { newlyAvailable, anyChanged, event: updated } = store.updatePerformances(event.id, [
    { label: '21 November 2026, 5pm', state: 'sold_out', snippet: 'Sold Out' },
    { label: '21 November 2026, 8.30pm', state: 'sold_out', snippet: 'Sold Out' },
  ]);
  check('flip back: no newlyAvailable', newlyAvailable, []);
  check('flip back: anyChanged is true', anyChanged, true);
  check('flip back: aggregate rolls back to sold_out', updated.status.state, 'sold_out');
}

// --- recordCheckError leaves performances alone.
{
  const before = store.getEvent(event.id).performances;
  const updated = store.recordCheckError(event.id, 'browser crashed');
  check('recordCheckError: performances untouched', updated.performances, before);
  check('recordCheckError: lastError recorded', updated.status.lastError, 'browser crashed');
}

fs.rmSync(tmpRoot, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
} else {
  console.log('\nAll store tests passed.');
}

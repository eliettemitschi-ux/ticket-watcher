// Tests store.recordSessions (new-show detection for listing pages).
// Uses a throwaway events file so the real data is never touched.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tw-sessions-')), 'events.json');
fs.writeFileSync(tmp, JSON.stringify([{ id: 'abc12345', name: 'Test listing', url: 'https://example.com', performances: [] }]));
process.env.EVENTS_FILE_PATH = tmp;
const store = require('../store');

// First sighting: baseline only, nothing "new".
let r = store.recordSessions('abc12345', ['Show A', 'Show B']);
assert.strictEqual(r.baseline, true);
assert.deepStrictEqual(r.added, []);

// Same list again: nothing new.
r = store.recordSessions('abc12345', ['Show A', 'Show B']);
assert.strictEqual(r.baseline, false);
assert.deepStrictEqual(r.added, []);

// A new title appears: reported once.
r = store.recordSessions('abc12345', ['Show A', 'Show B', 'Show C']);
assert.deepStrictEqual(r.added, ['Show C']);
r = store.recordSessions('abc12345', ['Show A', 'Show B', 'Show C']);
assert.deepStrictEqual(r.added, []);

// A session disappearing and coming back is NOT new (history is permanent).
store.recordSessions('abc12345', ['Show A']);
r = store.recordSessions('abc12345', ['Show A', 'Show B']);
assert.deepStrictEqual(r.added, []);

// The log keeps every title with when it was first seen.
const log = store.getEvent('abc12345').sessionHistory;
assert.deepStrictEqual(log.map((s) => s.label), ['Show A', 'Show B', 'Show C']);
assert.ok(log.every((s) => s.firstSeen));

console.log('All session-history tests passed.');

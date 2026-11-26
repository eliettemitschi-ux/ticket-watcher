// The "Quick answers" block at the top of the Stats tab.
const assert = require('assert');
const S = require('../docs/stats.js');

const NOW = Date.parse('2026-12-01T12:00:00Z');

// 12 travel days per direction: first seen not on sale, tickets appear 10 days
// before travel, price rises 2 days later, tickets gone 4 days before travel.
function history() {
  const events = [];
  const iso = (ms) => new Date(ms).toISOString().slice(0, 16) + 'Z';
  for (let d = 0; d < 12; d++) {
    const travel = Date.parse('2026-11-05T00:00:00Z') + d * 86400000;
    const date = new Date(travel).toISOString().slice(0, 10);
    for (const route of ['london-paris', 'paris-london']) {
      events.push([iso(travel - 14 * 86400000), route, date, null, 'i']);
      events.push([iso(travel - 10 * 86400000 + 3600000), route, date, 40, 'n']);
      events.push([iso(travel - 8 * 86400000), route, date, 55, 'c']);
      events.push([iso(travel - 4 * 86400000), route, date, null, 'g']);
    }
  }
  events.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return { since: '2026-10-22T00:00Z', events };
}

const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

// Empty history must not throw and still shows the three questions.
let html = S.html(S.analyse({ since: null, events: [] }, NOW));
for (const q of ['1. When should I book?', '2. Ticket available: wait or buy?', '3. Will tickets appear?']) assert.ok(html.includes(q), q);

// With data: tickets appear 10 days out, waiting never got cheaper, every date got tickets.
const out = text(S.html(S.analyse(history(), NOW)));
assert.ok(out.includes('about 10 days before travel'));
assert.ok(out.includes("Don't wait."));
assert.ok(out.includes('Yes, so far every date got tickets.'));
assert.ok(out.includes('the latest any date appeared was 10 days before travel') || out.includes('The latest any date appeared was 10 days before travel'));

console.log('All quick-answer tests passed.');

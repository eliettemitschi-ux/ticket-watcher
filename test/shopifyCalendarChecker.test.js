// parseCalendar / toPerformances for an artist tour calendar page.
const assert = require('assert');
const { parseCalendar, toPerformances } = require('../checkers/shopifyCalendarChecker');

const entry = (day, month, title, location, tickets) =>
  `<a href="https://tickets.example/x" target="_blank" class="calendar-date"><div class="calendar-day">${day}</div><div class="calendar-month">${month}</div><div class="calendar-title">${title}</div><div class="calendar-location">${location}</div><div class="calendar-tickets uppercase">${tickets}</div></a>`;

const html =
  entry('17th', 'OCT 2026', 'WTFR LISTENING SESSION', 'Friendly Pressure, London', 'SOLD OUT') +
  entry('24th', 'Oct 2026', 'ASIA TOUR', 'Nita Mukesh Ambani Cultural Centre, Mumbai', 'BUY TICKETS') +
  entry('5th', 'Mar 2027', 'EUROPE TOUR', 'Royal Albert Hall, London', 'BUY TICKETS');

const entries = parseCalendar(html);
assert.strictEqual(entries.length, 3);
assert.strictEqual(entries[0].location, 'Friendly Pressure, London');
assert.strictEqual(entries[1].tickets, 'BUY TICKETS');

const perfs = toPerformances(entries, 'london');
// London dates get a real ticket state and may alert; others are logged only.
assert.deepStrictEqual(perfs.map((p) => [p.state, p.alert]), [['sold_out', true], ['unknown', false], ['available', true]]);
assert.ok(perfs.every((p) => p.listing === true));
assert.strictEqual(perfs[2].label, '5th Mar 2027 - EUROPE TOUR - Royal Albert Hall, London');

// No pattern means every date is watched.
assert.strictEqual(toPerformances(entries)[1].state, 'available');

assert.deepStrictEqual(parseCalendar('<html>nothing</html>'), []);

console.log('All tour-calendar parser tests passed.');

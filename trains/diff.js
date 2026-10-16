// Pure logic for the Snap watcher: which dates to ask about, and what counts as
// "new tickets".

const { addDays } = require('./snap');

/**
 * Snap's date strip shows the chosen day plus two either side, so one request
 * covers five days. Returns the dates to request so every day in
 * [from, to] (and not in the past) is covered.
 */
function centersFor(from, to, today) {
  const start = from < today ? today : from;
  if (start > to) return [];
  const centers = [];
  for (let d = start; d <= to; d = addDays(d, 5)) centers.push(addDays(d, 2));
  return centers;
}

/**
 * Compares what was seen last run with now. `prev` is null on the first run
 * for a route (a silent baseline: tickets that already exist don't alert).
 *   prev / next: { 'YYYY-MM-DD': { price: number|null, slots: [{window, price}] } }
 * @returns {{date:string, kind:'day'|'slot', price:number, slots:object[], newSlots:object[]}[]}
 */
function diffDays(prev, next) {
  if (!prev) return [];
  const alerts = [];
  for (const date of Object.keys(next).sort()) {
    const now = next[date];
    if (now.price === null) continue;
    const before = prev[date];
    if (!before || before.price === null) {
      alerts.push({ date, kind: 'day', price: now.price, slots: now.slots, newSlots: now.slots });
      continue;
    }
    const known = new Set((before.slots || []).map((s) => s.window));
    const newSlots = (now.slots || []).filter((s) => !known.has(s.window));
    if (newSlots.length) alerts.push({ date, kind: 'slot', price: Math.min(...newSlots.map((s) => s.price)), slots: now.slots, newSlots });
  }
  return alerts;
}

module.exports = { centersFor, diffDays };

// Pure logic for the Snap watcher: which dates to ask about, and what counts as
// news. Shared by the Cloudflare Worker (cron-worker/src/snap.js) and tests.
//
// Trips are what the owner adds in the Trains tab (snap-trips.json in the
// private repo): { id, out: ['YYYY-MM-DD'], back: ['YYYY-MM-DD'] }. "out" is
// London to Paris, "back" is Paris to London; any date listed is watched.

const { addDays } = require('./snapParse');

const ROUTES = {
  'london-paris': { id: 'london-paris', name: 'London to Paris', origin: '7015400', destination: '8727100' },
  'paris-london': { id: 'paris-london', name: 'Paris to London', origin: '8727100', destination: '7015400' },
};

const isIsoDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/**
 * Every date still worth watching, per route.
 * @returns {{'london-paris': string[], 'paris-london': string[]}} sorted, unique, today or later
 */
function watchedDates(trips, today) {
  const sets = { 'london-paris': new Set(), 'paris-london': new Set() };
  for (const trip of trips || []) {
    for (const d of trip.out || []) if (isIsoDate(d) && d >= today) sets['london-paris'].add(d);
    for (const d of trip.back || []) if (isIsoDate(d) && d >= today) sets['paris-london'].add(d);
  }
  return { 'london-paris': [...sets['london-paris']].sort(), 'paris-london': [...sets['paris-london']].sort() };
}

// A trip can have a channel name ("pierre"): its alerts then go to
// <base>-pierre instead of the main channel. Letters, digits and dashes only.
const cleanChannel = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '').slice(0, 20);
const topicFor = (base, channel) => (channel ? `${base}-${channel}` : base);

/** The channels that should hear about one date: '' is the main channel. */
function channelsFor(trips, leg, date) {
  const found = new Set();
  for (const trip of trips || []) if ((trip[leg] || []).includes(date)) found.add(cleanChannel(trip.channel));
  return [...found];
}

/**
 * Snap's date strip shows the chosen day plus two either side, so one request
 * covers five days. Returns the fewest days to request so every date is on a
 * strip.
 */
function centersForDates(dates) {
  const centers = [];
  let coveredTo = null;
  for (const d of [...dates].sort()) {
    if (coveredTo && d <= coveredTo) continue;
    centers.push(addDays(d, 2));
    coveredTo = addDays(d, 4);
  }
  return centers;
}

/**
 * Compares what was seen last time with now. `prev` is null for a silent
 * baseline; pass {} to report tickets already on sale.
 *   prev / next: { 'YYYY-MM-DD': { price: number|null, slots: [{window, price}] } }
 * One alert per date at most, the most useful kind winning:
 *   day  -- had no tickets, now has some
 *   slot -- a new time window on a day that already had tickets
 *   drop -- the cheapest price went down
 * @returns {{date:string, kind:'day'|'slot'|'drop', price:number, was?:number, slots:object[], newSlots:object[]}[]}
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
    else if (now.price < before.price) alerts.push({ date, kind: 'drop', price: now.price, was: before.price, slots: now.slots, newSlots: [] });
  }
  return alerts;
}

const dayLabel = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${iso}T12:00:00Z`));
const slotText = (slots) => slots.map((s) => `£${s.price} (${s.window.replace('-', ' to ')})`).join(', ');

/** The notification for one alert. */
function alertText(route, a) {
  const what = { day: 'has tickets', slot: 'has a new time window', drop: `is now £${a.price}` }[a.kind];
  const detail = a.kind === 'drop'
    ? `was £${a.was}${a.slots.length ? ` · ${slotText(a.slots)}` : ''}`
    : slotText(a.kind === 'day' ? a.slots : a.newSlots) || `from £${a.price}`;
  return {
    title: `Snap ${route.name}: ${dayLabel(a.date)} ${what}`,
    message: `${detail}\nSnap trains are confirmed 48 hours before travel.`,
  };
}

module.exports = { ROUTES, cleanChannel, topicFor, channelsFor, watchedDates, centersForDates, diffDays, alertText, dayLabel };

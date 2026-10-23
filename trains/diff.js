// Pure logic for the Snap watcher: which dates to ask about, and what counts as
// news. Shared by the Cloudflare Worker (cron-worker/src/snap.js) and tests.
//
// Trips are what people add (snap-trips.json in the private repo). A leg is one
// journey on one day: { from: 'london', to: 'paris', date: 'YYYY-MM-DD' }, and a
// trip is { id, channel?, legs: [...] }. Trips saved earlier used
// { city, out: [dates], back: [dates] } (out = London to the city, back = the
// city to London, no city = Paris); legsOf() still reads those.

const { addDays } = require('./snapParse');

// Snap's station codes, read from snap.eurostar.com on 23 Oct 2026.
const STATIONS = {
  london: { name: 'London', code: '7015400' },
  paris: { name: 'Paris', code: '8727100' },
  brussels: { name: 'Brussels', code: '8814001' },
  amsterdam: { name: 'Amsterdam', code: '8400058' },
};

// Where Snap sells a journey to, from each station. Tested live on 23 Oct 2026:
// every pair with London, and Paris with Brussels and Amsterdam. Brussels to
// Amsterdam answers with a different kind of ticket and is left out.
const ALLOWED = {
  london: ['paris', 'brussels', 'amsterdam'],
  paris: ['london', 'brussels', 'amsterdam'],
  brussels: ['london', 'paris'],
  amsterdam: ['london', 'paris'],
};

// One route per direction, id "from-to": london-paris, paris-london, paris-brussels, ...
const ROUTES = {};
for (const [from, tos] of Object.entries(ALLOWED)) {
  for (const to of tos) {
    ROUTES[`${from}-${to}`] = {
      id: `${from}-${to}`,
      name: `${STATIONS[from].name} to ${STATIONS[to].name}`,
      origin: STATIONS[from].code,
      destination: STATIONS[to].code,
      from,
      to,
    };
  }
}

const isIsoDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Every leg of a trip, whichever way it was saved. Legs on routes Snap does not sell are ignored. */
function legsOf(trip) {
  const legs = [];
  if (!trip) return legs;
  for (const l of trip.legs || []) {
    if (l && ROUTES[`${l.from}-${l.to}`] && isIsoDate(l.date)) legs.push({ from: l.from, to: l.to, date: l.date });
  }
  const city = trip.city && trip.city !== 'london' && STATIONS[trip.city] ? trip.city : 'paris';
  for (const d of trip.out || []) if (isIsoDate(d)) legs.push({ from: 'london', to: city, date: d });
  for (const d of trip.back || []) if (isIsoDate(d)) legs.push({ from: city, to: 'london', date: d });
  return legs;
}

/**
 * Every date still worth watching, per route (every route is present, maybe empty).
 * @returns {Object<string, string[]>} route id -> sorted, unique dates, today or later
 */
function watchedDates(trips, today) {
  const sets = Object.fromEntries(Object.keys(ROUTES).map((id) => [id, new Set()]));
  for (const trip of trips || []) for (const l of legsOf(trip)) if (l.date >= today) sets[`${l.from}-${l.to}`].add(l.date);
  return Object.fromEntries(Object.entries(sets).map(([id, set]) => [id, [...set].sort()]));
}

// A trip can have a channel name ("pierre"): its alerts then go to
// <base>-pierre instead of the main channel. Letters, digits and dashes only.
const cleanChannel = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '').slice(0, 20);
const topicFor = (base, channel) => (channel ? `${base}-${channel}` : base);

/** The channels that should hear about one date on one route: '' is the main channel. */
function channelsFor(trips, routeId, date) {
  const found = new Set();
  if (!ROUTES[routeId]) return [];
  for (const trip of trips || []) if (legsOf(trip).some((l) => `${l.from}-${l.to}` === routeId && l.date === date)) found.add(cleanChannel(trip.channel));
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
 * @returns {{date:string, kind:'day'|'slot'|'drop', price:number, current:number, was?:number, slots:object[], newSlots:object[]}[]}
 */
function diffDays(prev, next) {
  if (!prev) return [];
  const alerts = [];
  for (const date of Object.keys(next).sort()) {
    const now = next[date];
    if (now.price === null) continue;
    const before = prev[date];
    if (!before || before.price === null) {
      alerts.push({ date, kind: 'day', price: now.price, current: now.price, slots: now.slots, newSlots: now.slots });
      continue;
    }
    const known = new Set((before.slots || []).map((s) => s.window));
    const newSlots = (now.slots || []).filter((s) => !known.has(s.window));
    if (newSlots.length) alerts.push({ date, kind: 'slot', price: Math.min(...newSlots.map((s) => s.price)), current: now.price, slots: now.slots, newSlots });
    else if (now.price < before.price) alerts.push({ date, kind: 'drop', price: now.price, current: now.price, was: before.price, slots: now.slots, newSlots: [] });
  }
  return alerts;
}

const dayLabel = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${iso}T12:00:00Z`));
const slotText = (slots) => slots.map((s) => `£${s.price} (${s.window.replace('-', ' to ')})`).join(', ');

// A move of this much or less since the last alert reads as "about the same".
const SIMILAR_WITHIN = 10;

/**
 * How today's cheapest price compares with an earlier one.
 * @param {number} current  the day's cheapest price now
 * @param {{price:number, kind:'alert'|'check'}|null} since  the last alerted price for
 *   this date, or (if it was never alerted) the price at the last check
 * @returns {string} '' when there is nothing to compare with
 */
function changeLine(current, since) {
  if (!since || typeof current !== 'number') return '';
  const when = since.kind === 'alert' ? 'the last alert' : 'the last check';
  const diff = current - since.price;
  if (Math.abs(diff) <= SIMILAR_WITHIN) return `About the same as ${when} (£${since.price})`;
  return `${diff > 0 ? 'Up' : 'Down'} £${Math.abs(diff)} since ${when} (was £${since.price})`;
}

/**
 * The notification for one alert. `since` is the last alerted price for this
 * date ({price, kind:'alert'}); for a price drop on a date never alerted, the
 * price at the last check is used instead ({price: a.was, kind:'check'}).
 */
function alertText(route, a, since) {
  const what = { day: 'has tickets', slot: 'has a new time window', drop: `is now £${a.price}` }[a.kind];
  const detail = a.kind === 'drop'
    ? slotText(a.slots) || `from £${a.price}`
    : slotText(a.kind === 'day' ? a.slots : a.newSlots) || `from £${a.price}`;
  const compare = since || (a.kind === 'drop' ? { price: a.was, kind: 'check' } : null);
  const change = changeLine(a.current, compare);
  return {
    title: `Snap ${route.name}: ${dayLabel(a.date)} ${what}`,
    message: [detail, change, 'Snap trains are confirmed 48 hours before travel.'].filter(Boolean).join('\n'),
  };
}

module.exports = { SIMILAR_WITHIN, changeLine, STATIONS, ALLOWED, legsOf, ROUTES, cleanChannel, topicFor, channelsFor, watchedDates, centersForDates, diffDays, alertText, dayLabel };

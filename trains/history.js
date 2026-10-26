// Pure logic for the Snap price history: which dates to watch and what counts as
// a change. Shared by the hourly Worker job (cron-worker/src/history.js) and tests.
//
// The job looks at the cheapest Snap price for every travel day in the next
// HORIZON_DAYS days, on London to Paris and Paris to London, and records only
// what CHANGES, so the log stays small. From that log docs/stats.js works out when
// tickets appear, how prices move and how long they last.
//
// Each event is a flat array: [time, route, date, price, kind]
//   time   'YYYY-MM-DDTHH:MMZ' (UTC)           route  'london-paris' | 'paris-london'
//   date   the travel day                       price  pounds, or null when nothing is on sale
//   kind   'i' first time this day was seen (price may be null: the "not on sale yet" start)
//          'n' tickets appeared on a day that had none      'g' tickets are gone (sold out or closed)
//          'c' the cheapest price changed                    'b' Snap stopped answering for this route
//          'o' Snap answers again (these two mark gaps in the data)

const { addDays } = require('./snapParse');

const HORIZON_DAYS = 21;
const ROUTES = ['london-paris', 'paris-london'];
// Stop adding events past this. At the expected few dozen events a day that is several
// months of data, and it keeps the hourly job inside Cloudflare's free-plan limit of
// about 10 ms of processing per run (measured: about 4 ms at 2,000 events, 16 ms at 8,000).
const MAX_EVENTS = 4000;

/** The travel days to look at: today and the 20 after it. */
const horizonDates = (today) => Array.from({ length: HORIZON_DAYS }, (_, i) => addDays(today, i));

/**
 * What changed between two looks at one route.
 * @param {Object<string, number|null>} prev  date -> price last time ({} the first time)
 * @param {Object<string, number|null>} next  date -> price now
 * @returns {Array} events in date order
 */
function diffPrices(prev, next, route, time) {
  const events = [];
  for (const date of Object.keys(next).sort()) {
    const was = prev[date];
    const now = next[date];
    if (was === undefined) events.push([time, route, date, now, 'i']);
    else if (was === null && now !== null) events.push([time, route, date, now, 'n']);
    else if (was !== null && now === null) events.push([time, route, date, null, 'g']);
    else if (was !== null && now !== null && was !== now) events.push([time, route, date, now, 'c']);
  }
  return events;
}

/** 'YYYY-MM-DDTHH:MMZ' for a Date. */
const stamp = (date) => `${date.toISOString().slice(0, 16)}Z`;

module.exports = { HORIZON_DAYS, ROUTES, MAX_EVENTS, horizonDates, diffPrices, stamp };

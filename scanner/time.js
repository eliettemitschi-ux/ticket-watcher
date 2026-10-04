// London-time helpers. Venues publish opening times in London wall-clock time
// ("10am, Fri 9 Oct"); the scanner stores and compares UTC instants, so the
// BST/GMT switch (last Sunday of October) has to be handled correctly.

const TZ = 'Europe/London';
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
});

function londonParts(utcMs) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const y = Number(p.year);
  const m0 = Number(p.month) - 1;
  const d = Number(p.day);
  return { y, m0, d, hh: Number(p.hour), mm: Number(p.minute), weekday: WEEKDAYS[new Date(Date.UTC(y, m0, d)).getUTCDay()] };
}

function offsetMinutes(utcMs) {
  const p = londonParts(utcMs);
  return (Date.UTC(p.y, p.m0, p.d, p.hh, p.mm) - Math.floor(utcMs / 60000) * 60000) / 60000;
}

// London wall-clock -> UTC milliseconds.
function londonToUtcMs(y, m0, d, hh = 0, mm = 0) {
  const guess = Date.UTC(y, m0, d, hh, mm);
  let utc = guess - offsetMinutes(guess) * 60000;
  const second = guess - offsetMinutes(utc) * 60000;
  if (second !== utc) utc = second;
  return utc;
}

// "Fri 9 Oct, 10am" (minutes only when non-zero)
function formatLondon(utcMs, { withTime = true } = {}) {
  const p = londonParts(utcMs);
  const day = `${p.weekday} ${p.d} ${MONTH_NAMES[p.m0]}`;
  if (!withTime) return day;
  const hour12 = ((p.hh + 11) % 12) + 1;
  const suffix = p.hh >= 12 ? 'pm' : 'am';
  return `${day}, ${hour12}${p.mm ? '.' + String(p.mm).padStart(2, '0') : ''}${suffix}`;
}

/**
 * When the "opens soon" heads-up should fire, and when it stops being useful.
 *   exact: `hoursBefore` before opening, but never earlier than 07:00 London
 *          on the day itself; useful until it opens.
 *   date : 08:00 London on the day (no time known); useful until that night.
 */
function headsUpWindow(opens, hoursBefore) {
  const at = new Date(opens.at).getTime();
  const day = londonParts(at);
  if (opens.precision === 'exact') {
    const earliest = londonToUtcMs(day.y, day.m0, day.d, 7, 0);
    return { from: Math.max(at - hoursBefore * 3600000, earliest), until: at };
  }
  return { from: londonToUtcMs(day.y, day.m0, day.d, 8, 0), until: londonToUtcMs(day.y, day.m0, day.d, 23, 59) };
}

module.exports = { londonParts, londonToUtcMs, formatLondon, headsUpWindow, MONTH_NAMES };

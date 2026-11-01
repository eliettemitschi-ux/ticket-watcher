// todaytixChecker.js
//
// TodayTix's show pages are server-rendered by Next.js and embed every
// performance as pageProps.initialShowtimes in the page's own
// __NEXT_DATA__ JSON -- no browser or private API needed, one plain GET.
// Each showtime carries:
//   regularTickets -- null when nothing is bookable, otherwise
//                     { lowPrice: {value, ...}, priceBands: [...] }
//   lotteryTickets -- a ticket lottery (a draw, not a guaranteed seat),
//                     with its own lowPrice
// Found live (2026-11-01) for The Lives of Others: 79 showtimes, 20 with
// regularTickets (£87-£225) and 16 with a £35 lottery. A showtime with
// neither is reported sold_out; it may equally be not yet released, which
// the page doesn't distinguish.
//
// Lottery entries are ignored unless recipe.includeLottery is true,
// because a lottery alert would fire every day for a draw the user may
// not win.

const fetch = require('node-fetch');
const { formatLabel } = require('./sohoplaceChecker');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Safari/537.36 ticket-watcher/1.0 (personal availability checker)';

const NEXT_DATA_RE = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/;

function formatPrice(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

// Pure parsing/classification, separate from the fetch so it can be unit
// tested against a captured fixture without touching the network.
function parseShowtimes(html, { includeLottery = false } = {}) {
  const m = NEXT_DATA_RE.exec(html);
  if (!m) throw new Error('Page has no __NEXT_DATA__ block (blocked, or TodayTix changed its page)');
  const showtimes = JSON.parse(m[1])?.props?.pageProps?.initialShowtimes;
  if (!Array.isArray(showtimes) || showtimes.length === 0) {
    throw new Error('No showtimes found in the page data');
  }

  return showtimes.map((s) => {
    const label = formatLabel(`${s.localDate}T${s.localTime}:00`);
    const regular = s.regularTickets?.lowPrice?.value;
    if (typeof regular === 'number') {
      return { label, state: 'available', snippet: `Regular tickets from £${formatPrice(regular)}` };
    }
    const lottery = s.lotteryTickets?.lowPrice?.value;
    if (includeLottery && typeof lottery === 'number') {
      return { label, state: 'available', snippet: `Lottery tickets from £${formatPrice(lottery)}` };
    }
    return { label, state: 'sold_out', snippet: 'No regular tickets listed' };
  });
}

/**
 * @param {object} recipe { mode: 'todaytix-page', pageUrl, includeLottery? }
 * @returns {Promise<{label,state,snippet}[] | {state:'error', error:string}>}
 */
async function checkTodaytix(recipe) {
  try {
    const res = await fetch(recipe.pageUrl, {
      headers: { Accept: 'text/html', 'User-Agent': USER_AGENT },
      timeout: 20000,
    });
    if (!res.ok) return { state: 'error', error: `TodayTix returned HTTP ${res.status}` };
    return parseShowtimes(await res.text(), { includeLottery: !!recipe.includeLottery });
  } catch (err) {
    return { state: 'error', error: err.message };
  }
}

module.exports = { checkTodaytix, parseShowtimes };

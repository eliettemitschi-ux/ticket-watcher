// interceptChecker.js
//
// For venues where the real per-performance data comes back as a clean
// JSON API call the page's own JavaScript fires on load, but the exact
// request (body shape, extra headers, maybe a cookie set by a bot-
// detection gate) couldn't be reverse-engineered well enough to replicate
// with a plain HTTP call -- Southbank Centre's Spektrix-style storefront
// is like this: its /api/products/productionseasons call 500s on every
// guessed request body, and the event page itself sits behind a queue-it
// virtual waiting room before it even loads.
//
// Loading the real page in a browser and reading the SAME response the
// page's own JS triggers sidesteps all of that -- and it's still far
// more reliable than scraping rendered text, since it reads the
// structured JSON the widget itself received (isOnSale,
// hasLimitedSeatingAvailable, performanceStatusMessage per performance),
// not a re-derived guess from prose.

const NAV_TIMEOUT_MS = 45000; // generous: queue-it can add a real delay before the page loads
const SETTLE_MS = 4000; // give the page's own JS a moment to fire its data call after networkidle

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Safari/537.36 ticket-watcher/1.0 (personal availability checker)';

// A queue-it wait or a slow page under memory pressure can transiently fail
// to fire (or let us observe) the data call even though the venue itself is
// fine -- worth one retry with a fresh context before giving up to the
// weaker render-mode fallback in checkers/index.js.
const ATTEMPTS = 2;

/**
 * @param {object} recipe { mode: 'intercept-api', pageUrl, apiUrlPattern, productionSeasonIds }
 * @param {import('playwright').Browser} browser  an already-launched Chromium browser
 * @returns {Promise<{label,state,snippet}[] | {state:'error', error:string}>}
 */
async function checkIntercept(recipe, browser) {
  let lastResult;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    lastResult = await attemptIntercept(recipe, browser);
    if (Array.isArray(lastResult)) return lastResult;
  }
  return lastResult;
}

async function attemptIntercept(recipe, browser) {
  const { pageUrl, apiUrlPattern, productionSeasonIds } = recipe;
  const context = await browser.newContext({ userAgent: USER_AGENT });
  const page = await context.newPage();

  const seen = [];
  page.on('response', async (res) => {
    try {
      if (!res.url().includes(apiUrlPattern)) return;
      const ct = res.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      const json = await res.json().catch(() => null);
      if (json) seen.push(json);
    } catch {
      /* ignore bodies we can't read */
    }
  });

  try {
    await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT_MS }).catch(() => {
      // A queue-it wait or a page that never fully idles shouldn't fail the
      // check outright -- whatever response we've already captured by now
      // (or catch in the settle window below) is still worth reading.
    });
    await page.waitForTimeout(SETTLE_MS);

    // The page can fire more than one call to this endpoint (e.g. one
    // unfiltered "upcoming events" listing before the one scoped to the
    // production seasons we actually asked for in the URL) -- prefer
    // whichever captured response actually contains one of them.
    const wanted = new Set((productionSeasonIds || []).map(String));
    const arrays = seen.filter((j) => Array.isArray(j));
    const match =
      arrays.find((seasons) => seasons.some((s) => wanted.has(String(s.productionSeasonId)))) || arrays[0];

    if (!match) {
      return { state: 'error', error: `No JSON response matching "${apiUrlPattern}" was observed` };
    }

    const seasons = wanted.size ? match.filter((s) => wanted.has(String(s.productionSeasonId))) : match;
    const multi = seasons.length > 1;
    const performances = [];
    for (const season of seasons) {
      for (const perf of season.performances || []) {
        const msg = perf.performanceStatusMessage || '';
        const soldOut = !perf.isOnSale && !perf.hasLimitedSeatingAvailable && /sold\s*out/i.test(msg);
        const label = multi
          ? `${season.productionTitle}, ${perf.displayDate}, ${perf.displayTime}`
          : `${perf.displayDate}, ${perf.displayTime}`;
        performances.push({
          label,
          state: soldOut ? 'sold_out' : 'available',
          snippet: msg || (soldOut ? 'Sold out' : 'On sale'),
        });
      }
    }

    if (performances.length === 0) {
      return { state: 'error', error: `${apiUrlPattern} response had no performances for the configured production season(s)` };
    }
    return performances;
  } catch (err) {
    return { state: 'error', error: err.message };
  } finally {
    await context.close().catch(() => {});
  }
}

module.exports = { checkIntercept };

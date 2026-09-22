// checkers/discover.js
//
// Best-effort "learn how to check this event cheaply" step, run once when
// an event is added. It loads the real page in a headless browser and
// watches the network traffic for a JSON response that looks like a
// ticket-availability payload (this is exactly what you'd find by hand
// with Chrome DevTools' Network tab -- see the README -- just automated).
//
// If it finds a plausible candidate, it calibrates the guess against the
// page's own rendered text (classify.js) for the CURRENT known state, and
// only keeps the API recipe if the two agree. That guards against a false
// positive (e.g. matching some unrelated boolean flag) silently telling
// you a show is available when it isn't.
//
// If nothing usable turns up, it returns a 'render' recipe -- which
// always works, just costs a real page load on every poll instead of a
// plain HTTP GET.

const { classify } = require('./classify');
const { evaluate } = require('./apiChecker');

const KEY_PATTERNS = /(available|avail|soldout|sold_out|unavailable|onsale|on_sale|instock|in_stock|remaining|seatsleft|seats_left|capacity|status)/i;
const NEGATIVE_KEY = /(soldout|sold_out|unavailable|waitlist)/i;
const URL_HINTS = /(spektrix|availab|seat|ticket|status|instance)/i;

// Walks a parsed JSON value looking for keys that plausibly encode
// availability, up to a shallow depth (these payloads are usually flat
// or one level of nesting -- deeper than that risks false matches).
function findCandidates(obj, pathPrefix = '', depth = 0, out = []) {
  if (obj == null || depth > 3 || out.length > 25) return out;
  if (Array.isArray(obj)) {
    obj.slice(0, 5).forEach((item, i) => findCandidates(item, `${pathPrefix}[${i}]`, depth + 1, out));
    return out;
  }
  if (typeof obj !== 'object') return out;

  for (const [key, value] of Object.entries(obj)) {
    const path = pathPrefix ? `${pathPrefix}.${key}` : key;
    if (KEY_PATTERNS.test(key) && (typeof value === 'boolean' || typeof value === 'number')) {
      out.push({ path, key, value, type: typeof value });
    }
    if (value && typeof value === 'object') {
      findCandidates(value, path, depth + 1, out);
    }
  }
  return out;
}

function guessAvailableWhen(candidate) {
  if (candidate.type === 'boolean') {
    return NEGATIVE_KEY.test(candidate.key) ? { type: 'falsy' } : { type: 'truthy' };
  }
  // numeric: "remaining"/"seatsAvailable"/"capacity" style -- available when > 0
  return { type: 'gt', value: 0 };
}

/**
 * @param {string} url
 * @param {import('playwright').Browser} browser
 * @returns {Promise<{recipe: object, currentState: string, debug: object}>}
 */
async function discoverRecipe(url, browser) {
  const responses = [];
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/120.0.0.0 Safari/537.36 ticket-watcher/1.0 (personal availability checker)',
  });
  const page = await context.newPage();

  page.on('response', async (res) => {
    try {
      const ct = res.headers()['content-type'] || '';
      if (!ct.includes('application/json')) return;
      if (responses.length > 40) return; // cap memory on chatty pages
      const json = await res.json().catch(() => null);
      if (json) responses.push({ url: res.url(), method: res.request().method(), json });
    } catch {
      /* ignore bodies we can't read (redirects, aborted, etc.) */
    }
  });

  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);

  // Ground truth: what does the rendered page actually say right now?
  const ticketFrame = page.frames().find((f) => /spektrix|ticket|booking/i.test(f.url()) && f.url() !== 'about:blank');
  let renderedText = '';
  if (ticketFrame) renderedText = await ticketFrame.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  if (!renderedText) renderedText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  const rendered = classify(renderedText);

  await context.close().catch(() => {});

  const debug = { responsesInspected: responses.length, renderedState: rendered.state };

  if (rendered.state !== 'sold_out' && rendered.state !== 'available') {
    // Can't calibrate against an unknown/pending ground truth -- play safe.
    return { recipe: { mode: 'render' }, currentState: rendered.state, debug };
  }

  // Prefer responses whose URL looks like a ticketing/availability call.
  const sorted = [...responses].sort((a, b) => URL_HINTS.test(b.url) - URL_HINTS.test(a.url));

  for (const resp of sorted) {
    const candidates = findCandidates(resp.json);
    for (const candidate of candidates) {
      const availableWhen = guessAvailableWhen(candidate);
      const wouldBeAvailable = evaluate(candidate.value, availableWhen);
      const wouldBeState = wouldBeAvailable ? 'available' : 'sold_out';
      if (wouldBeState === rendered.state) {
        return {
          recipe: {
            mode: 'api',
            apiUrl: resp.url,
            method: resp.method,
            jsonPath: candidate.path,
            availableWhen,
          },
          currentState: rendered.state,
          debug: { ...debug, matchedUrl: resp.url, matchedPath: candidate.path },
        };
      }
    }
  }

  // Nothing calibrated cleanly -- render mode it is. Still 100% functional,
  // just a bit heavier per check.
  return { recipe: { mode: 'render' }, currentState: rendered.state, debug };
}

module.exports = { discoverRecipe, findCandidates, guessAvailableWhen };

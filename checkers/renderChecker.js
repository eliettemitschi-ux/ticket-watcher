// renderChecker.js
//
// Fallback checker that works on ANY venue, including ones that aren't on
// Spektrix: it loads the real event page in a headless browser (because
// these ticket widgets fill in "Checking availability..." via JavaScript
// after the page loads -- a plain HTTP GET only ever sees that
// placeholder), waits for it to settle, and reads the rendered text.
//
// It's heavier than the API checker (a real Chromium page load per
// event) but it's the honest, always-works option, which is why it's the
// default for newly-added events until discover.js manages to find a
// lighter API recipe.
//
// It always returns an ARRAY of performances (one per date/time it could
// find on the page via parseMultiText.js, or exactly one -- labelled with
// the event's own name -- when the page has no date/time structure at
// all, which keeps a plain single-show page behaving exactly as before).

const { parseInstancesFromText } = require('./parseMultiText');

const NAV_TIMEOUT_MS = 30000;
const SETTLE_MS = 1500; // extra grace period after networkidle for slow widgets

// Some ticketing widgets (Barbican's included) show a "Checking
// availability..." placeholder that JavaScript replaces with the real
// answer a little *after* the page's network traffic has gone idle --
// networkidle plus one fixed settle isn't always enough. Rather than
// guess a bigger fixed number (and slow down every check, including the
// ones that were already done in 1.5s), re-read the text a couple more
// times, a little further apart, but only for as long as every
// performance we found still looks unresolved (pending/unknown).
const EXTRA_SETTLE_ROUNDS = 3;
const EXTRA_SETTLE_MS = 2500;

function stillUnresolved(performances) {
  return performances.every((p) => p.state === 'pending' || p.state === 'unknown');
}

/**
 * @param {string} url
 * @param {import('playwright').Browser} browser  an already-launched Chromium browser
 * @param {string} fallbackLabel  used when no date/time structure is found on the page
 * @returns {Promise<{label: string, state: string, matched: string|null, snippet: string|null}[] | {state: 'error', error: string}>}
 */
async function checkRender(url, browser, fallbackLabel) {
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/120.0.0.0 Safari/537.36 ticket-watcher/1.0 (personal availability checker)',
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT_MS }).catch(() => {
      // Some venue pages never truly go idle (analytics beacons, live chat
      // widgets polling in the background). Falling through and reading
      // whatever rendered so far is better than failing the whole check.
    });
    await page.waitForTimeout(SETTLE_MS);

    // Prefer the text inside a ticketing iframe/frame if one is present --
    // Spektrix (and similar platforms) embed the actual booking widget in
    // a frame from a different subdomain. Reading just that frame avoids
    // false matches from unrelated page furniture (nav links, footer,
    // "you might also like" sold-out suggestions elsewhere on the page).
    const ticketFrame = page
      .frames()
      .find((f) => /spektrix|ticket|booking/i.test(f.url()) && f.url() !== 'about:blank');

    async function readText() {
      let t = '';
      if (ticketFrame) {
        t = await ticketFrame.locator('body').innerText({ timeout: 5000 }).catch(() => '');
      }
      if (!t || t.trim().length < 5) {
        t = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
      }
      return t;
    }

    let text = await readText();
    let performances = parseInstancesFromText(text, fallbackLabel);

    for (let round = 0; round < EXTRA_SETTLE_ROUNDS && stillUnresolved(performances); round++) {
      await page.waitForTimeout(EXTRA_SETTLE_MS);
      text = await readText();
      performances = parseInstancesFromText(text, fallbackLabel);
    }

    return performances;
  } catch (err) {
    return { state: 'error', error: err.message };
  } finally {
    await context.close().catch(() => {});
  }
}

module.exports = { checkRender };

// tiquoChecker.js
//
// Reads a Tiquo booking page (book.tiquo.app/...), such as the 180 Studios
// listening-room one. Each bookable session is a card with an <h3> title,
// and a sold-out session carries a "Sold out" badge. There is no public data
// feed to read instead (the page's data arrives over a live connection), so
// this loads the page in the shared headless browser and reads the cards.
//
// Returns one performance per session -- label = the session title -- and
// marks each with `listing: true`, which tells runChecks.js to also compare
// the set of titles with what it has seen before and alert on a NEW one.
//
// Fails safe: no cards found (page changed, or still loading) returns an
// error, so the caller falls back to the generic render checker and, above
// all, never mistakes an empty page for "every session was removed".

const NAV_TIMEOUT_MS = 30000;
const CARD_WAIT_MS = 15000;
const RECHECK_ROUNDS = 3; // extra looks before believing an "available" reading
const RECHECK_MS = 5000;

function isTiquoUrl(url) {
  try {
    return new URL(url).hostname === 'book.tiquo.app';
  } catch {
    return false;
  }
}

// Runs inside the page. Cards are the closest ancestor of each session <h3>
// that holds only that one heading, so sibling cards never bleed together.
function readCards() {
  const out = [];
  for (const h of document.querySelectorAll('main h3, body h3')) {
    const title = h.innerText.trim();
    if (!title) continue;
    let card = h;
    while (card.parentElement && card.parentElement.querySelectorAll('h3').length === 1) {
      card = card.parentElement;
    }
    const text = card.innerText.replace(/\s+/g, ' ').trim();
    out.push({ title, soldOut: /\bsold out\b/i.test(text), text: text.slice(0, 160) });
  }
  return out;
}

/**
 * @param {string} url
 * @param {import('playwright').Browser} browser
 * @returns {Promise<{label:string,state:string,matched:string|null,snippet:string|null,listing:true}[] | {state:'error',error:string}>}
 */
async function checkTiquo(url, browser) {
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/120.0.0.0 Safari/537.36 ticket-watcher/1.0 (personal availability checker)',
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await page.waitForSelector('h3', { timeout: CARD_WAIT_MS }).catch(() => {});
    // Let the rest of the cards and their badges finish rendering.
    await page.waitForTimeout(2000);
    let cards = await page.evaluate(readCards);
    // A card with no "Sold out" badge reads as available. On 27 Nov 02:40 UTC all
    // six sessions read available for exactly one check and were sold out again at
    // the next, which looks like the page showing cards before its availability
    // data had loaded. So before trusting any "available", look again a few times
    // and only believe it if it holds.
    for (let round = 0; round < RECHECK_ROUNDS && cards.some((c) => !c.soldOut); round++) {
      await page.waitForTimeout(RECHECK_MS);
      const again = await page.evaluate(readCards);
      if (again.length > 0) cards = again;
    }
    if (cards.length === 0) return { state: 'error', error: 'no session cards found on the Tiquo page' };

    const seen = new Set();
    const performances = [];
    for (const c of cards) {
      if (seen.has(c.title)) continue;
      seen.add(c.title);
      performances.push({
        label: c.title,
        state: c.soldOut ? 'sold_out' : 'available',
        matched: c.soldOut ? 'Sold out' : null,
        snippet: c.text,
        listing: true,
      });
    }
    return performances;
  } catch (err) {
    return { state: 'error', error: err.message };
  } finally {
    await context.close().catch(() => {});
  }
}

module.exports = { checkTiquo, isTiquoUrl, readCards };

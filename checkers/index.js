// checkers/index.js
//
// Single entry point check.js and server.js call: given one event record
// from the store, run whichever checker its recipe calls for.
//
// Always resolves to EITHER an array of performances
// ({label, state, matched, snippet}[], one entry per date/time found --
// see checkers/parseMultiText.js) OR {state: 'error', error} on failure.
// api mode's single result gets wrapped into a one-item array (labelled
// with the event's own name) so every caller downstream only has to deal
// with one shape.

const { checkApi } = require('./apiChecker');
const { checkRender } = require('./renderChecker');
const { checkHtmlInstances } = require('./htmlInstancesChecker');
const { checkIntercept } = require('./interceptChecker');
const { checkSohoplace } = require('./sohoplaceChecker');

function wrapSingle(result, label) {
  if (result.state === 'error') return result;
  const { state, matched, snippet } = result;
  return [{ label, state, matched: matched ?? null, snippet: snippet ?? null }];
}

/**
 * @param {object} event   an event record from store.js (needs .name, .url, .recipe)
 * @param {object} [opts]  { browser } a shared Playwright browser, required
 *                          when the recipe (or the fallback) needs render mode
 */
async function checkEvent(event, opts = {}) {
  const recipe = event.recipe || { mode: 'render' };

  if (recipe.mode === 'api' && recipe.apiUrl) {
    const result = await checkApi(recipe);
    if (result.state !== 'error') return wrapSingle(result, event.name);
    // API recipe broke (endpoint changed, auth expired, etc.) -- don't just
    // report an error forever, fall back to the always-works render mode
    // for this one check so a redesigned booking page doesn't silently
    // stop watching itself.
    if (!opts.browser) return result;
    const fallback = await checkRender(event.url, opts.browser, event.name);
    if (fallback.state === 'error') return fallback;
    return fallback.map((p) => ({ ...p, note: `api recipe failed (${result.error}), used render fallback` }));
  }

  if (recipe.mode === 'html-instances') {
    const result = await checkHtmlInstances(recipe);
    if (Array.isArray(result)) return result;
    // Endpoint changed shape or went away -- fall back to render mode
    // rather than reporting an error forever (same principle as the
    // 'api' mode fallback above).
    if (!opts.browser) return result;
    const fallback = await checkRender(event.url, opts.browser, event.name);
    if (fallback.state === 'error') return fallback;
    return fallback.map((p) => ({ ...p, note: `html-instances recipe failed (${result.error}), used render fallback` }));
  }

  if (recipe.mode === 'sohoplace-api') {
    const result = await checkSohoplace(recipe);
    if (Array.isArray(result)) return result;
    // Same fallback principle as the other structured-API modes -- an
    // endpoint/shape change shouldn't degrade straight to a permanent
    // error when the always-works render mode can still say something.
    if (!opts.browser) return result;
    const fallback = await checkRender(event.url, opts.browser, event.name);
    if (fallback.state === 'error') return fallback;
    return fallback.map((p) => ({ ...p, note: `sohoplace-api recipe failed (${result.error}), used render fallback` }));
  }

  if (recipe.mode === 'intercept-api') {
    if (!opts.browser) {
      throw new Error(`Event "${event.name}" needs a browser for intercept-api mode`);
    }
    const result = await checkIntercept(recipe, opts.browser);
    if (Array.isArray(result)) return result;
    // Fall back to reading the SAME ticketing page's rendered text (not
    // event.url, which is usually just the venue's marketing page and
    // carries no real per-date status -- that's exactly why this event
    // needed intercept-api in the first place). recipe.pageUrl is the
    // actual booking page, and on this venue its visible text does
    // contain real per-date "Sold out" wording, so this fallback is
    // still worth something rather than degrading straight to "unknown".
    const fallback = await checkRender(recipe.pageUrl || event.url, opts.browser, event.name);
    if (fallback.state === 'error') return fallback;
    return fallback.map((p) => ({ ...p, note: `intercept-api recipe failed (${result.error}), used render fallback` }));
  }

  if (!opts.browser) {
    throw new Error(`Event "${event.name}" needs render mode but no browser was provided`);
  }
  // recipe.pageUrl lets a render-mode event check a different page than the
  // one shown to the user -- e.g. Dua Lipa & Patti Smith: event.url is the
  // venue's own "Book now" link (the right thing for a person to click),
  // but that marketing page sits behind Cloudflare bot-verification that
  // blocks GitHub Actions' datacenter IPs. The secure booking system's own
  // overview page carries the same real availability text without it.
  return checkRender(recipe.pageUrl || event.url, opts.browser, event.name);
}

module.exports = { checkEvent };

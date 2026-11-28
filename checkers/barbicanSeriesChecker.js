// barbicanSeriesChecker.js
//
// Watches a Barbican "series" page (e.g. /whats-on/series/screentalks) for
// NEW events being announced. The page is plain server-rendered HTML, so no
// browser is needed: the "Upcoming" tab holds one <article class="listing--event">
// per event, with its title, date and link.
//
// This says nothing about tickets (the listing carries no sold-out wording),
// so every row reads 'unknown' and only the `listing` flag matters: runChecks.js
// compares the titles with the ones already seen and alerts on a new one.
// Add an individual event to the tracker if you also want its ticket alerts.
//
// Only the first page of the Upcoming tab is in the HTML (the rest loads on
// scroll). That is fine for spotting new announcements, which list by date.

const fetch = require('node-fetch');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Safari/537.36 ticket-watcher/1.0 (personal availability checker)';

const decode = (s) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Pulls { title, date, href } out of the Upcoming tab of a series page. */
function parseUpcoming(html) {
  const tabs = html.split('data-tab-title="');
  const upcoming = tabs.find((t) => t.startsWith('Upcoming"'));
  if (!upcoming) return [];
  const section = upcoming.split('data-tab-title="')[0];
  const out = [];
  for (const m of section.matchAll(/<article class="listing--event">([\s\S]*?)<\/article>/g)) {
    const body = m[1];
    const title = /<h2[^>]*class="[^"]*listing-title[^"]*"[^>]*>([\s\S]*?)<\/h2>/.exec(body);
    const date = /<time[^>]*>([\s\S]*?)<\/time>/.exec(body);
    const href = /class="search-listing__link"\s+href="([^"]+)"/.exec(body);
    if (!title) continue;
    out.push({
      title: decode(title[1]),
      date: date ? decode(date[1]) : null,
      href: href ? href[1].replace(/^\/index%2Ephp/, '') : null,
    });
  }
  return out;
}

/**
 * @param {{seriesUrl: string}} recipe
 * @returns {Promise<{label:string,state:string,matched:null,snippet:string,listing:true}[] | {state:'error',error:string}>}
 */
async function checkBarbicanSeries(recipe) {
  try {
    const res = await fetch(recipe.seriesUrl, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return { state: 'error', error: `HTTP ${res.status} fetching the series page` };
    const events = parseUpcoming(await res.text());
    // An empty list is far more likely a changed page than "nothing is on".
    // Never report it as success, or the next real page would look all-new.
    if (events.length === 0) return { state: 'error', error: 'no upcoming events found on the series page' };
    const seen = new Set();
    const performances = [];
    for (const e of events) {
      if (seen.has(e.title)) continue;
      seen.add(e.title);
      performances.push({
        label: e.title,
        state: 'unknown',
        matched: null,
        snippet: [e.date, e.href ? `https://www.barbican.org.uk${e.href}` : null].filter(Boolean).join(' · '),
        listing: true,
      });
    }
    return performances;
  } catch (err) {
    return { state: 'error', error: err.message };
  }
}

module.exports = { checkBarbicanSeries, parseUpcoming };

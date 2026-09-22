// htmlInstancesChecker.js
//
// For venues that expose their real per-performance calendar as a plain
// HTTP call to their own booking widget's backend -- no browser needed,
// just the same request the page's own JavaScript makes. Two shapes are
// supported so far, both discovered by watching what a real page load
// actually fetches (see HANDOFF.md):
//
//   - 'golden-boy': Almeida's WordPress calendar widget. POST to
//     admin-ajax.php with `action=calendar&filters=event=<id>&date_range=`
//     returns { instances: [htmlFragment, ...] }, one fragment per
//     performance, each with a real <time datetime="..."> and a
//     sold-out/bookable button.
//   - 'barbican': Drupal's per-node instances endpoint. A plain GET to
//     /node/<id>/instances returns a JSON-encoded HTML string (not an
//     object) with the same kind of <time datetime="..."> + button
//     markup, one per showtime. This replaced text-scraping the event
//     page itself, which stopped carrying any sold-out/available wording
//     once the venue moved that into this lazily-loaded overlay.
//
// Either way, the venue's own markup is the source of truth for
// sold-out/available -- no guessing from page prose.

const fetch = require('node-fetch');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Safari/537.36 ticket-watcher/1.0 (personal availability checker)';

const SOLD_OUT_RE = /sold[\s-]*out/i;

// How far past a performance's own <time> tag to look for its sold-out
// marker. Real bug found live: Barbican's per-node instances response
// ends with a "Join" (membership) tab whose own marketing copy says
// "Access to Sold-out Events... secure tickets for sold-out shows" --
// completely unrelated to any specific performance's actual status. When
// a page lists only one performance (or the LAST one in a multi-performance
// page), splitting on <time> tags leaves that instance's "part" running
// all the way to the end of the string, which swallows that unrelated
// text and made a genuinely available screening (Godzilla 2000, 22 Sep)
// read as sold out. The real button/indicator always sits within a few
// hundred characters of its <time> tag (confirmed against live Barbican
// and Golden Boy responses) -- this cap is a generous multiple of that,
// comfortably clearing the ~6500-character gap out to the Join tab.
const MAX_INSTANCE_WINDOW = 1500;

// "2026-11-21T17:00:00Z" or "2026-09-19 14:00:00" -> "21 Nov 2026, 5pm"
function formatLabel(dtString) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(dtString);
  if (!m) return dtString;
  const [, y, mo, d, hh, mm] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  const dateLabel = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const hour = Number(hh);
  const minute = Number(mm);
  const period = hour >= 12 ? 'pm' : 'am';
  const hour12 = ((hour + 11) % 12) + 1;
  const timeLabel = minute === 0 ? `${hour12}${period}` : `${hour12}.${String(minute).padStart(2, '0')}${period}`;
  return `${dateLabel}, ${timeLabel}`;
}

// Splits an HTML blob on each <time datetime="..."> it finds and reads a
// sold-out verdict from the chunk of markup that follows -- deliberately
// simple (a real per-instance button, not prose to interpret) since this
// is the venue's own structured widget markup, not free text.
function extractInstances(html) {
  if (typeof html !== 'string' || !html) return [];
  const parts = html.split(/(?=<time[^>]*\sdatetime=")/i);
  const results = [];
  for (const part of parts) {
    const dtMatch = part.match(/<time[^>]*\sdatetime="([^"]+)"/i);
    if (!dtMatch) continue;
    const window = part.slice(0, MAX_INSTANCE_WINDOW);
    results.push({ datetime: dtMatch[1], soldOut: SOLD_OUT_RE.test(window) });
  }
  return results;
}

async function fetchGoldenBoyInstances(recipe) {
  const { ajaxUrl, filters } = recipe;
  const body = new URLSearchParams({ action: 'calendar', filters: filters || '' }).toString();
  const res = await fetch(ajaxUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
    body,
    timeout: 15000,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${ajaxUrl}`);
  const json = await res.json();
  const fragments = Array.isArray(json.instances) ? json.instances : [];
  return fragments.flatMap(extractInstances);
}

async function fetchBarbicanInstances(recipe) {
  const { instancesUrl } = recipe;
  const res = await fetch(instancesUrl, {
    headers: {
      Accept: 'application/json, text/html',
      'User-Agent': USER_AGENT,
    },
    timeout: 15000,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${instancesUrl}`);
  const raw = await res.text();
  // The endpoint returns a JSON-encoded string (the HTML fragment as a
  // JSON string literal), not a plain HTML response or a wrapper object.
  let html = raw;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'string') html = parsed;
  } catch {
    // Already plain HTML (or something unexpected) -- use as-is.
  }
  return extractInstances(html);
}

const FETCHERS = {
  'golden-boy': fetchGoldenBoyInstances,
  barbican: fetchBarbicanInstances,
};

/**
 * @param {object} recipe { mode: 'html-instances', venue: 'golden-boy'|'barbican', ...venue-specific fields }
 * @returns {Promise<{label,state,snippet}[] | {state:'error', error:string}>}
 */
async function checkHtmlInstances(recipe) {
  const fetcher = FETCHERS[recipe.venue];
  if (!fetcher) {
    return { state: 'error', error: `Unknown html-instances venue "${recipe.venue}"` };
  }
  try {
    const instances = await fetcher(recipe);
    if (instances.length === 0) {
      return { state: 'error', error: 'No performance instances found in API response' };
    }
    return instances.map(({ datetime, soldOut }) => ({
      label: formatLabel(datetime),
      state: soldOut ? 'sold_out' : 'available',
      snippet: soldOut ? 'Sold out' : 'Not marked sold out',
    }));
  } catch (err) {
    return { state: 'error', error: err.message };
  }
}

module.exports = { checkHtmlInstances, extractInstances, formatLabel };

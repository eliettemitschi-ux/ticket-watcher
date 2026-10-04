// National Theatre source for the scanner. The NT's ticketing front end
// (events.nationaltheatre.org.uk) is a JavaScript app over a plain JSON API:
//   GET /api/v1/events/       -> every event currently in the booking system
//   GET /api/v1/events/<id>   -> that event with ALL its performances
// Each performance carries price rows per "mode of sale" (mos); mos 11 is the
// public sale, and each row's `percentage` is the share of seats still
// unsold at that price. Other mos values are member / patron / promo access.
//
// Unlike Barbican's per-show endpoint, one /events/<id> call is both the
// discovery and the status read, so there is no separate read step.

const fetch = require('node-fetch');

const API = 'https://events.nationaltheatre.org.uk/api/v1';
const VENUE = 'National Theatre';
const PUBLIC_MOS = '11';
const USER_AGENT = 'Mozilla/5.0 (compatible; ticket-watcher/1.0; personal availability scanner)';

function pct(row) {
  const n = parseFloat(row.percentage);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Pure: classifies one event (as returned by /events/<id>, with instances).
 * @returns {{state:'bookable'|'sold_out'|'gated'|'not_on_sale', publicFrom:number|null}}
 */
function classifyEvent(event) {
  const instances = event.instances || [];
  if (instances.length === 0) return { state: 'not_on_sale', publicFrom: null };

  const rows = instances.flatMap((i) => i.prices || []);
  const publicRows = rows.filter((r) => String(r.mos) === PUBLIC_MOS);

  const publicOpen = publicRows.filter((r) => pct(r) > 0);
  if (publicOpen.length > 0) {
    const prices = publicOpen.map((r) => parseFloat(r.price)).filter(Number.isFinite);
    return { state: 'bookable', publicFrom: prices.length ? Math.min(...prices) : null };
  }

  // Nothing open to the public. Either it is sold out, or a priority phase
  // (members / patrons) is open before general sale.
  // Nothing open to the public: sold out. Non-public availability is ignored
  // on purpose -- running shows keep standing promo / access allocations
  // (e.g. mode 124 on Some Woman) that would otherwise make them look like
  // they were still waiting for general sale. A genuinely NEW show that first
  // reads sold out is still treated as waiting by decide.js.
  if (publicRows.length === 0) return { state: 'gated', publicFrom: null };
  return { state: 'sold_out', publicFrom: null };
}

function listingFor(event) {
  const instances = event.instances || [];
  const days = [...new Set(instances.map((i) => String(i.datetime).slice(0, 10)))].sort();
  const classified = classifyEvent(event);
  const venueSignals = /dorfman/i.test(event.venueLabel || '') ? ['Dorfman Theatre (smallest auditorium)'] : [];
  return {
    key: `nt-${event._id}`,
    venue: VENUE,
    url: `https://events.nationaltheatre.org.uk/events/${event._id}`,
    nodeId: null,
    title: event.title,
    tags: [event.venueLabel].filter(Boolean),
    text: '',
    days,
    venueSignals,
    reading: {
      state: classified.state,
      generalSaleText: classified.publicFrom ? `from £${classified.publicFrom}` : null,
    },
    bookingUrl: instances[0] && instances[0].bookingURL,
  };
}

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }, timeout: 30000 });
  if (!res.ok) throw new Error(`National Theatre API returned HTTP ${res.status} for ${url}`);
  return res.json();
}

async function crawl(config) {
  const list = await getJson(`${API}/events/`);
  if (!Array.isArray(list)) throw new Error('National Theatre events list was not an array');
  const skip = new RegExp(config.nationalTheatre.excludeTitlePattern, 'i');
  const listings = new Map();
  for (const summary of list.filter((e) => !skip.test(e.title || ''))) {
    const event = await getJson(`${API}/events/${summary._id}`);
    const listing = listingFor(event);
    listings.set(listing.key, listing);
  }
  return listings;
}

module.exports = { crawl, classifyEvent, listingFor, VENUE, PUBLIC_MOS };

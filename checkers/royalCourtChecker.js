// royalCourtChecker.js
//
// Royal Court Theatre's event pages sit behind Cloudflare bot verification
// that blocks GitHub Actions' datacenter IPs ("Just a moment... we're
// verifying you are human"), so reading the rendered page there only ever
// produced "unknown" (seen live for Man to Man, Sept-Oct 2026). The page
// itself gets its availability from a plain JSON endpoint on the same site:
//
//   GET /actions/event-manager/availability/event?id=<craft entry id>
//
// which returns one entry per performance with real seat counts
// (available / locked / sold / capacity). No browser needed. The entry id
// is the number in that request (Man to Man = 45811), found by loading the
// event page once and watching its network calls -- it goes in the recipe:
//   { mode: 'royal-court-api', eventId: 45811 }

const fetch = require('node-fetch');

const ENDPOINT = 'https://royalcourttheatre.com/actions/event-manager/availability/event';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "2026-10-05T19:30:00+01:00" + "7.30pm" -> "5 Oct 2026, 7.30pm" (the same
// shape Barbican labels use, so date-range blocking can read the date).
function labelFor(instance) {
  const iso = instance.date && instance.date.dateTime && instance.date.dateTime.date;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  const time = (instance.date && instance.date.time) || '';
  if (!m) return [instance.date && instance.date.date, time].filter(Boolean).join(', ') || `Performance ${instance.id}`;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}, ${time}`.replace(/,\s*$/, '');
}

/**
 * Pure: turns the endpoint's JSON into performances, or null if it isn't the
 * shape we expect (e.g. a Cloudflare challenge page parsed as nothing).
 */
function parseAvailability(json) {
  const instances = json && json.availability && json.availability.instances;
  if (!Array.isArray(instances)) return null;
  return instances.map((inst) => {
    const seats = (inst.availability && inst.availability.available) || 0;
    return {
      label: labelFor(inst),
      state: seats > 0 ? 'available' : 'sold_out',
      snippet: seats > 0 ? `${seats} seat${seats === 1 ? '' : 's'} available` : 'Sold out',
    };
  });
}

/**
 * @param {object} recipe { mode: 'royal-court-api', eventId }
 * @returns {Promise<{label,state,snippet}[] | {state:'error', error:string}>}
 */
async function checkRoyalCourt(recipe) {
  if (!recipe.eventId) return { state: 'error', error: 'royal-court-api recipe has no eventId' };
  try {
    const res = await fetch(`${ENDPOINT}?id=${encodeURIComponent(recipe.eventId)}`, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, 'Accept-Language': 'en-GB,en;q=0.9', Referer: 'https://royalcourttheatre.com/' },
      timeout: 20000,
    });
    if (!res.ok) return { state: 'error', error: `HTTP ${res.status} from the Royal Court availability endpoint` };
    const body = await res.text();
    let json = null;
    try {
      json = JSON.parse(body);
    } catch {
      return { state: 'error', error: `Royal Court returned non-JSON (${/verifying you are human|Just a moment/i.test(body) ? 'a Cloudflare challenge page' : 'unexpected content'})` };
    }
    const performances = parseAvailability(json);
    if (!performances) return { state: 'error', error: 'Royal Court availability response had an unexpected shape' };
    if (performances.length === 0) return { state: 'error', error: 'Royal Court availability response listed no performances' };
    return performances;
  } catch (err) {
    return { state: 'error', error: err.message };
  }
}

module.exports = { checkRoyalCourt, parseAvailability, labelFor };

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
// event page once and watching its network calls -- it goes in the recipe.
//
// Observed 4 Oct 2026: after Man to Man was switched to this endpoint it still
// read "unknown" on GitHub Actions (it worked from a home connection), so it
// appears to be refused from GitHub's servers too. The recipe may therefore
// carry a `spektrix` fallback: the
// ticketing system behind the Royal Court (system.spektrix.com, a public API,
// not behind the Royal Court's Cloudflare) lists every performance and its
// seat status. Caveat found when comparing: for Man to Man Spektrix reports
// capacity 0 (it doesn't expose that plan), so only its `available` count is
// used -- 0 means sold out, >0 means seats. Recipe shape:
//   { mode: 'royal-court-api', eventId: 45811,
//     spektrix: { client: 'royalcourt', eventId: '118056AKTS...' } }

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
async function fromRoyalCourtEndpoint(recipe) {
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

// --- Spektrix fallback -------------------------------------------------------

const SPEKTRIX_BASE = 'https://system.spektrix.com';

// "2026-10-06T19:30:00" (London wall-clock) -> "6 Oct 2026, 7.30pm". Same label
// shape as labelFor(), so switching sources never looks like a change.
function spektrixLabel(start) {
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})/.exec(start || '');
  if (!m) return start || 'Performance';
  const hh = Number(m[4]);
  const hour12 = ((hh + 11) % 12) + 1;
  const time = `${hour12}${m[5] === '00' ? '' : '.' + m[5]}${hh >= 12 ? 'pm' : 'am'}`;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}, ${time}`;
}

/**
 * Pure: future, non-cancelled performances with their seat status.
 * @param {object[]} instances  from GET /events/<id>/instances
 * @param {Object<string, object|null>} statusById  from GET /instances/<id>/status (null = fetch failed)
 */
function performancesFromSpektrix(instances, statusById, nowMs) {
  return instances
    .filter((i) => !i.cancelled && Date.parse(`${String(i.startUtc).replace(/Z$/, '')}Z`) >= nowMs)
    .sort((a, b) => String(a.startUtc).localeCompare(String(b.startUtc)))
    .map((i) => {
      const status = statusById[i.id];
      const label = spektrixLabel(i.start);
      if (!status || typeof status.available !== 'number') return { label, state: 'unknown', snippet: 'Seat status unavailable' };
      const seats = status.available;
      return { label, state: seats > 0 ? 'available' : 'sold_out', snippet: seats > 0 ? `${seats} seat${seats === 1 ? '' : 's'} available` : 'Sold out' };
    });
}

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }, timeout: 20000 });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

async function checkSpektrix({ client, eventId }, nowMs = Date.now()) {
  if (!client || !eventId) return { state: 'error', error: 'spektrix fallback needs client and eventId' };
  try {
    const base = `${SPEKTRIX_BASE}/${client}/api/v3`;
    const instances = await getJson(`${base}/events/${encodeURIComponent(eventId)}/instances`);
    if (!Array.isArray(instances)) return { state: 'error', error: 'Spektrix instances response was not a list' };
    const upcoming = instances.filter((i) => !i.cancelled && Date.parse(`${String(i.startUtc).replace(/Z$/, '')}Z`) >= nowMs);
    const statusById = {};
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(6, upcoming.length) }, async () => {
        while (next < upcoming.length) {
          const inst = upcoming[next++];
          statusById[inst.id] = await getJson(`${base}/instances/${inst.id}/status`).catch(() => null);
        }
      })
    );
    const performances = performancesFromSpektrix(instances, statusById, nowMs);
    if (performances.length === 0) return { state: 'error', error: 'Spektrix listed no upcoming performances' };
    return performances;
  } catch (err) {
    return { state: 'error', error: err.message };
  }
}

// The Royal Court's own endpoint first (exact seat counts); Spektrix if that
// is refused (as it is from GitHub's servers).
async function checkRoyalCourt(recipe) {
  const primary = await fromRoyalCourtEndpoint(recipe);
  if (Array.isArray(primary) || !recipe.spektrix) return primary;
  const fallback = await checkSpektrix(recipe.spektrix);
  if (Array.isArray(fallback)) {
    return fallback.map((p) => ({ ...p, note: `Royal Court endpoint failed (${primary.error}); read from Spektrix instead` }));
  }
  return { state: 'error', error: `${primary.error}; Spektrix fallback also failed: ${fallback.error}` };
}

module.exports = { checkRoyalCourt, checkSpektrix, parseAvailability, labelFor, spektrixLabel, performancesFromSpektrix };

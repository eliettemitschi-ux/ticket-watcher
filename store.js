// store.js
//
// Tiny JSON-file "database" for the list of watched events and their last
// known status. A real DB is overkill for a personal watcher with a
// handful of events checked every few minutes -- a JSON file is easy to
// back up, diff, and hand-edit if you ever need to.
//
// Writes are atomic (write to a temp file, then rename over the target) so
// a crash mid-write never leaves you with a half-written, corrupt file.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeLabel } = require('./checkers/parseMultiText');
const { topicForEvent } = require('./notify');

// EVENTS_FILE_PATH lets the exact same checker/store code serve a second
// deployment (the GitHub Actions + Pages setup) without forking any
// logic: there, it points at docs/events.json so the one file the
// checker reads/writes IS the file GitHub Pages serves as the static
// dashboard's data -- no separate copy/sync step needed. Unset (the
// normal case, e.g. the local pm2 deployment), behaviour is unchanged.
const EVENTS_FILE = process.env.EVENTS_FILE_PATH
  ? path.resolve(__dirname, process.env.EVENTS_FILE_PATH)
  : path.join(__dirname, 'data', 'events.json');
const DATA_DIR = path.dirname(EVENTS_FILE);

// Sibling to whichever events file is active, so the same
// EVENTS_FILE_PATH override that lets one codebase serve both
// deployments (see above) carries settings along with it automatically.
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

function getSettings() {
  if (!fs.existsSync(SETTINGS_FILE)) return { blockedDateRanges: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8') || '{}');
    return { blockedDateRanges: [], ...parsed };
  } catch (err) {
    throw new Error(`settings.json is not valid JSON (${err.message}).`);
  }
}

function setBlockedDateRanges(ranges) {
  const settings = getSettings();
  settings.blockedDateRanges = ranges || [];
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmpFile = SETTINGS_FILE + '.tmp' + process.pid;
  fs.writeFileSync(tmpFile, JSON.stringify(settings, null, 2));
  fs.renameSync(tmpFile, SETTINGS_FILE);
  return settings;
}

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(EVENTS_FILE)) {
    // First run: seed from events.seed.json if present, else start empty.
    const seedFile = path.join(DATA_DIR, 'events.seed.json');
    const initial = fs.existsSync(seedFile)
      ? JSON.parse(fs.readFileSync(seedFile, 'utf8'))
      : [];
    writeAll(initial);
  }
}

function readAll() {
  ensureDataFile();
  const raw = fs.readFileSync(EVENTS_FILE, 'utf8');
  try {
    return JSON.parse(raw || '[]');
  } catch (err) {
    throw new Error(
      `data/events.json is not valid JSON (${err.message}). ` +
        `Fix or delete it (a fresh one will be created) before continuing.`
    );
  }
}

function writeAll(events) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmpFile = EVENTS_FILE + '.tmp' + process.pid;
  fs.writeFileSync(tmpFile, JSON.stringify(events, null, 2));
  fs.renameSync(tmpFile, EVENTS_FILE);
}

function newId() {
  return crypto.randomBytes(4).toString('hex');
}

function listEvents() {
  return readAll();
}

function getEvent(id) {
  return readAll().find((e) => e.id === id) || null;
}

function addEvent({ name, venue, url, recipe, timeFilter, maxPrice }) {
  const events = readAll();
  const id = newId();
  const event = {
    id,
    name,
    venue: venue || null,
    url,
    recipe: recipe || { mode: 'render' },
    // Computed once, here, and never recomputed -- see notify.js's
    // topicForEvent() for why stability matters (a subscriber's saved
    // link must keep working forever). null when ntfy isn't configured
    // at all (NTFY_TOPIC unset).
    ntfyTopic: topicForEvent(name, id),
    // Optional substring (e.g. "8.30pm") -- when set, only performances
    // whose label contains it (matched loosely, see normalizeLabel) will
    // ever trigger a notification. Every performance is still checked and
    // shown on the dashboard regardless; this only gates the alert.
    timeFilter: timeFilter || null,
    // Optional price cap in GBP -- when set, only performances whose
    // snippet mentions a price at or below it will ever trigger a
    // notification. A performance with no extractable price still
    // notifies (failing open, since blocking it entirely risks silently
    // missing a genuinely cheap ticket the whole tool exists to catch) --
    // see runChecks.js's priceAllows().
    maxPrice: maxPrice || null,
    addedAt: new Date().toISOString(),
    // One entry per date/time found on the page (almost always more than
    // one for a full run, exactly one for a single-performance show).
    performances: [],
    status: {
      state: 'unknown', // 'unknown' | 'sold_out' | 'available' | 'pending' | 'error'
      lastChecked: null,
      lastChanged: null,
      lastError: null,
      snippet: null,
    },
  };
  events.push(event);
  writeAll(events);
  return event;
}

function removeEvent(id) {
  const events = readAll();
  const next = events.filter((e) => e.id !== id);
  writeAll(next);
  return next.length !== events.length;
}

// Updates one event's status. Returns { event, changed } where `changed`
// is true only when the availability STATE flipped (not just re-checked).
function updateStatus(id, patch) {
  const events = readAll();
  const idx = events.findIndex((e) => e.id === id);
  if (idx === -1) throw new Error(`No event with id ${id}`);

  const prevState = events[idx].status.state;
  const nextState = patch.state !== undefined ? patch.state : prevState;
  const changed = prevState !== nextState;

  events[idx].status = {
    ...events[idx].status,
    ...patch,
    lastChecked: new Date().toISOString(),
    lastChanged: changed ? new Date().toISOString() : events[idx].status.lastChanged,
  };
  // Recipe can be refined over time (e.g. render -> api once discovered).
  if (patch.recipe) {
    events[idx].recipe = patch.recipe;
    delete events[idx].status.recipe;
  }

  writeAll(events);
  return { event: events[idx], changed };
}

function setRecipe(id, recipe) {
  const events = readAll();
  const idx = events.findIndex((e) => e.id === id);
  if (idx === -1) throw new Error(`No event with id ${id}`);
  events[idx].recipe = recipe;
  writeAll(events);
  return events[idx];
}

function setTimeFilter(id, timeFilter) {
  const events = readAll();
  const idx = events.findIndex((e) => e.id === id);
  if (idx === -1) throw new Error(`No event with id ${id}`);
  events[idx].timeFilter = timeFilter || null;
  writeAll(events);
  return events[idx];
}

function setMaxPrice(id, maxPrice) {
  const events = readAll();
  const idx = events.findIndex((e) => e.id === id);
  if (idx === -1) throw new Error(`No event with id ${id}`);
  events[idx].maxPrice = maxPrice || null;
  writeAll(events);
  return events[idx];
}

// One-off backfill for events added before per-event ntfy topics
// existed -- addEvent() computes this for every new event on its own.
function backfillNtfyTopics() {
  const events = readAll();
  let filled = 0;
  for (const event of events) {
    if (!event.ntfyTopic) {
      event.ntfyTopic = topicForEvent(event.name, event.id);
      filled += 1;
    }
  }
  if (filled > 0) writeAll(events);
  return { filled, total: events.length };
}

// The main update path now that every checker returns an array of
// performances (one per date/time -- see checkers/parseMultiText.js).
// Matches each new performance to what was stored last time by its
// (normalized) label, so a date that keeps appearing sold-out-then-
// sold-out doesn't get treated as "changed" just because it was
// re-checked, while a date that genuinely flips to available does.
//
// Returns { event, newlyAvailable, anyChanged }. `newlyAvailable` is
// exactly the set of performances worth notifying about: those that had
// a *previous* non-available reading and are available now. A
// performance appearing for the very first time is recorded as a
// baseline, never treated as "newly available" -- same principle as the
// original single-status design, just applied per date/time now.
function updatePerformances(id, newPerformances) {
  const events = readAll();
  const idx = events.findIndex((e) => e.id === id);
  if (idx === -1) throw new Error(`No event with id ${id}`);
  const event = events[idx];
  const now = new Date().toISOString();

  const prevByKey = new Map((event.performances || []).map((p) => [normalizeLabel(p.label), p]));
  const newlyAvailable = [];
  let anyChanged = false;

  const merged = newPerformances.map((p) => {
    const key = normalizeLabel(p.label);
    const prev = prevByKey.get(key);
    const isFirstSighting = !prev;
    const changed = !isFirstSighting && prev.state !== p.state;
    if (changed) anyChanged = true;
    if (changed && p.state === 'available') newlyAvailable.push({ label: p.label, state: p.state, snippet: p.snippet ?? p.matched ?? null });

    return {
      label: p.label,
      state: p.state,
      lastChecked: now,
      lastChanged: changed || isFirstSighting ? now : prev.lastChanged,
      snippet: p.snippet ?? p.matched ?? null,
    };
  });

  event.performances = merged;

  // A rollup kept at event.status too, so the dashboard's card header and
  // anything that only cares about "is ANYTHING bookable right now" (not
  // the full per-date breakdown) keeps working without change.
  const anyAvailable = merged.some((p) => p.state === 'available');
  const anyPending = merged.some((p) => p.state === 'pending');
  const anyUnknown = merged.some((p) => p.state === 'unknown');
  const aggregateState = anyAvailable ? 'available' : anyPending ? 'pending' : anyUnknown ? 'unknown' : 'sold_out';
  const availableOne = merged.find((p) => p.state === 'available');

  event.status = {
    state: aggregateState,
    lastChecked: now,
    lastChanged: anyChanged ? now : event.status?.lastChanged || null,
    lastError: null,
    snippet: availableOne
      ? `${availableOne.label}: ${availableOne.snippet || 'bookable'}`
      : merged.length > 1
        ? `${merged.length} performances checked`
        : merged[0]?.snippet || null,
  };

  writeAll(events);
  return { event, newlyAvailable, anyChanged };
}

// For a total check failure (network down, browser crashed, etc.) --
// leaves whatever performances were last recorded alone and just notes
// the error, rather than wiping out known-good data because one poll
// happened to fail.
function recordCheckError(id, message) {
  const events = readAll();
  const idx = events.findIndex((e) => e.id === id);
  if (idx === -1) throw new Error(`No event with id ${id}`);
  events[idx].status = {
    ...events[idx].status,
    lastError: message,
    lastChecked: new Date().toISOString(),
  };
  writeAll(events);
  return events[idx];
}

module.exports = {
  listEvents,
  getEvent,
  addEvent,
  removeEvent,
  updateStatus,
  setRecipe,
  setTimeFilter,
  setMaxPrice,
  backfillNtfyTopics,
  getSettings,
  setBlockedDateRanges,
  updatePerformances,
  recordCheckError,
};

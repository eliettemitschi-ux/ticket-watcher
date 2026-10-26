// docs/owner.js -- the private "Scanner" tab. Only loaded when the owner has
// unlocked this device (a token in localStorage) or asks to (#owner in the URL).
//
// Nothing private lives in this file: the scanner's data sits in a PRIVATE
// GitHub repo and is read through the GitHub API with a token that only exists
// in this browser. Visitors without the token see no trace of any of this.
//
// The tab lists every show the scanner knows about. Ticking a show puts it in
// "Watching": a show that isn't on sale yet alerts you when it opens; a show
// that is on sale alerts you when sold-out dates get tickets back. Ticks are
// saved to that same private repo as selections.json, which the scanner reads
// on its next run.

(function (root) {
  'use strict';

  const REPO = 'eliettemitschi-ux/ticket-watcher-private';
  const API = `https://api.github.com/repos/${REPO}`;
  const TOKEN_KEY = 'twOwnerToken';
  const TZ = 'Europe/London';
  const WAITING = new Set(['gated', 'not_on_sale']);
  const REFRESH_MS = 60000;

  // --- Pure helpers (unit tested in test/owner.test.js) ----------------------

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function safeUrl(url) {
    return /^https:\/\//.test(url || '') ? url : '#';
  }

  const isWaiting = (record) => WAITING.has(record.state);

  // Would this show alert with NO override from you? Only shows that haven't
  // opened yet can be flagged automatically; on-sale shows alert only if you
  // tick them.
  function autoEligible(record) {
    return isWaiting(record) && Boolean(record.manual || record.qualifies);
  }

  // Alert state once your override is applied.
  function effectiveEligible(record, selections) {
    const sel = selections[record.key];
    if (sel === 'on') return true;
    if (sel === 'off') return false;
    return autoEligible(record);
  }

  // The override to store for a tick. Ticking a show that would alert anyway
  // just clears any override, so selections.json only holds real differences.
  function nextSelection(record, wantOn) {
    if (wantOn === autoEligible(record)) return null;
    return wantOn ? 'on' : 'off';
  }

  function withSelection(selections, key, selection) {
    const next = { ...selections };
    if (selection === null) delete next[key];
    else next[key] = selection;
    return next;
  }

  // Which of the three buckets a show falls in.
  function statusOf(record) {
    if (isWaiting(record)) return 'upcoming';
    return record.state === 'sold_out' ? 'sold_out' : 'on_sale';
  }

  const STATUS_LABEL = { upcoming: 'Not on sale yet', sold_out: 'Sold out', on_sale: 'On sale' };

  // What ticking a show means, in words.
  function watchLabel(record) {
    return isWaiting(record)
      ? 'Alerts when it goes on sale, with a heads-up before'
      : 'Alerts when sold-out dates get tickets back';
  }

  function matchesQuery(record, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return true;
    const hay = `${record.title || ''} ${record.venue || ''} ${(record.tags || []).join(' ')}`.toLowerCase();
    return q.split(/\s+/).every((word) => hay.includes(word));
  }

  function filterRecords(records, { query = '', venue = 'all', status = 'all' } = {}) {
    return records.filter(
      (r) => matchesQuery(r, query) && (venue === 'all' || r.venue === venue) && (status === 'all' || statusOf(r) === status)
    );
  }

  // Soonest known opening first; month-only next; unknown last.
  function sortKey(record) {
    const o = record.opens;
    if (!o) return 3e15;
    if (o.precision === 'month') return 2e15 + new Date(o.at).getTime() / 1000;
    return new Date(o.at).getTime();
  }

  const ORDER = { upcoming: 0, sold_out: 1, on_sale: 2 };

  // Watching on top; everything else below, not-yet-on-sale first (soonest
  // opening first), then sold out, then on sale (each A to Z).
  function groupRecords(records, selections) {
    const open = records.filter((r) => !r.alertedAt);
    const watching = open.filter((r) => effectiveEligible(r, selections));
    const rest = open.filter((r) => !effectiveEligible(r, selections));
    const order = (a, b) => {
      const sa = statusOf(a);
      const sb = statusOf(b);
      if (sa !== sb) return ORDER[sa] - ORDER[sb];
      if (sa === 'upcoming') return sortKey(a) - sortKey(b);
      return String(a.title).localeCompare(String(b.title));
    };
    return { watching: watching.sort(order), rest: rest.sort(order) };
  }

  function utf8ToBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin);
  }

  function base64ToUtf8(b64) {
    const bin = atob(String(b64).replace(/\s/g, ''));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  }

  function fmtDay(iso) {
    return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(iso));
  }

  function fmtTime(iso) {
    return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true })
      .format(new Date(iso))
      .replace(':00', '')
      .replace(' ', '');
  }

  function inDays(iso, nowMs) {
    const days = Math.ceil((new Date(iso).getTime() - nowMs) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'tomorrow';
    return `in ${days} days`;
  }

  function opensLine(opens, nowMs) {
    if (!opens) return 'No booking date announced yet';
    if (opens.precision === 'month') return `Booking opens ${escapeHtml(opens.label)}`;
    if (opens.precision === 'exact') return `General sale <strong>${fmtDay(opens.at)}, ${fmtTime(opens.at)}</strong> (${inDays(opens.at, nowMs)})`;
    return `General sale <strong>${fmtDay(opens.at)}</strong> (${inDays(opens.at, nowMs)})`;
  }

  function timeAgo(iso, nowMs) {
    if (!iso) return 'never';
    const mins = Math.round((nowMs - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  function reasonText(record, selections) {
    const sel = selections[record.key];
    if (sel === 'on') return 'You ticked this';
    if (sel === 'off') return 'You unticked this';
    if (record.manual) return 'Added by you';
    if (autoEligible(record)) return `Flagged: ${(record.reasons || []).map(escapeHtml).join('; ')}`;
    return "Doesn't match your criteria";
  }

  function datesNote(record) {
    const n = (record.days || []).length;
    return n ? ` · ${n} date${n === 1 ? '' : 's'}` : '';
  }

  function badge(record) {
    const s = statusOf(record);
    const cls = s === 'upcoming' ? 'pending' : s === 'sold_out' ? 'sold_out' : 'available';
    const text = s === 'upcoming' && record.state === 'gated' ? 'Presale / general sale pending' : STATUS_LABEL[s];
    return `<span class="badge ${cls}">${text}</span>`;
  }

  // Full card, used in "Watching".
  function watchingCard(record, selections, nowMs) {
    const members =
      record.opens && record.opens.membersAt && new Date(record.opens.membersAt) < new Date(record.opens.at)
        ? `<div class="event-meta">Members' presale ${fmtDay(record.opens.membersAt)}</div>`
        : '';
    const when = isWaiting(record) ? `<div class="event-meta">${opensLine(record.opens, nowMs)}</div>${members}` : '';
    return `
      <div class="event-card">
        <div class="event-main">
          <p class="event-name"><a href="${escapeHtml(safeUrl(record.url))}" target="_blank" rel="noopener">${escapeHtml(record.title)}</a></p>
          <p class="event-venue">${escapeHtml(record.venue)}${datesNote(record)}</p>
          ${badge(record)}
          ${when}
          <label class="alarm-toggle">
            <input type="checkbox" data-key="${escapeHtml(record.key)}" checked />
            <span>🔔 Alert me</span>
            <small>${watchLabel(record)} · ${reasonText(record, selections)}</small>
          </label>
        </div>
      </div>`;
  }

  // One compact line, used in the long list.
  function compactRow(record, nowMs) {
    const extra = isWaiting(record) ? ` · ${opensLine(record.opens, nowMs)}` : '';
    return `
      <div class="owner-row">
        <input type="checkbox" data-key="${escapeHtml(record.key)}" aria-label="Alert me about ${escapeHtml(record.title)}" />
        <div class="owner-row-main">
          <a class="owner-row-title" href="${escapeHtml(safeUrl(record.url))}" target="_blank" rel="noopener">${escapeHtml(record.title)}</a>
          <div class="owner-row-sub">${escapeHtml(record.venue)}${datesNote(record)} ${badge(record)}${extra}</div>
        </div>
      </div>`;
  }

  function openedCard(record, nowMs) {
    return `
      <div class="event-card">
        <div class="event-main">
          <p class="event-name"><a href="${escapeHtml(safeUrl(record.url))}" target="_blank" rel="noopener">${escapeHtml(record.title)}</a></p>
          <p class="event-venue">${escapeHtml(record.venue)}</p>
          <span class="badge available">Went on sale</span>
          <div class="event-meta">Alerted ${timeAgo(record.alertedAt, nowMs)}</div>
        </div>
      </div>`;
  }

  // --- Trains (Eurostar Snap) ------------------------------------------------
  // Trips live in snap-trips.json: { trips: [{ id, channel?, legs: [{from, to, date}] }] }.
  // A leg is one journey on one day. Trips saved earlier used { city, out, back };
  // legsOf reads both (same rules as trains/diff.js). The Cloudflare Worker
  // (cron-worker/src/snap.js) checks them every 5 minutes and writes what it saw
  // to snap-state.json.

  const STATION_NAMES = { london: 'London', paris: 'Paris', brussels: 'Brussels', amsterdam: 'Amsterdam' };
  // Where Snap sells a journey to, from each station (tested live 23 Oct 2026; see trains/diff.js).
  const ALLOWED = {
    london: ['paris', 'brussels', 'amsterdam'],
    paris: ['london', 'brussels', 'amsterdam'],
    brussels: ['london', 'paris'],
    amsterdam: ['london', 'paris'],
  };
  const isRoute = (from, to) => Boolean(ALLOWED[from] && ALLOWED[from].includes(to));
  const routeLabel = (from, to) => `${STATION_NAMES[from]} → ${STATION_NAMES[to]}`;
  const WATCHER_SILENT_MS = 7 * 60 * 60 * 1000; // it reports at least every 6h

  const fmtDate = (iso) => fmtDay(`${iso}T12:00:00Z`);
  const isIsoDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

  // Every journey in a trip, whichever way it was saved.
  function legsOf(trip) {
    const legs = [];
    if (!trip) return legs;
    for (const l of trip.legs || []) if (l && isRoute(l.from, l.to) && isIsoDate(l.date)) legs.push({ from: l.from, to: l.to, date: l.date });
    const city = trip.city && trip.city !== 'london' && STATION_NAMES[trip.city] ? trip.city : 'paris';
    for (const d of trip.out || []) if (isIsoDate(d)) legs.push({ from: 'london', to: city, date: d });
    for (const d of trip.back || []) if (isIsoDate(d)) legs.push({ from: city, to: 'london', date: d });
    return legs;
  }

  // Trips with at least one journey still to come.
  function liveTrips(trips, today) {
    return (trips || []).filter((t) => legsOf(t).some((l) => l.date >= today));
  }

  function dateStatus(snapState, routeId, date) {
    const route = snapState && snapState.routes && snapState.routes[routeId];
    const day = route && route.days && route.days[date];
    if (!day) return { cls: 'unknown', text: 'Not checked yet' };
    if (day.price === null) return { cls: 'pending', text: 'No Snap tickets yet' };
    const n = (day.slots || []).length;
    return { cls: 'available', text: `From £${day.price}${n ? ` · ${n} time window${n === 1 ? '' : 's'}` : ''}` };
  }

  // A trip's channel name, as the Worker reads it (trains/diff.js cleanChannel).
  const cleanChannel = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '').slice(0, 20);
  const TRAINS_TOPIC = 'BARBICAN-1999-trains';
  const topicOf = (trip) => (cleanChannel(trip.channel) ? `${TRAINS_TOPIC}-${cleanChannel(trip.channel)}` : TRAINS_TOPIC);

  // A trip: each route it covers with its dates and what the watcher last saw.
  function tripCard(trip, snapState, today) {
    const byRoute = new Map();
    for (const l of legsOf(trip)) {
      const id = `${l.from}-${l.to}`;
      if (!byRoute.has(id)) byRoute.set(id, { from: l.from, to: l.to, dates: [] });
      byRoute.get(id).dates.push(l.date);
    }
    const blocks = [...byRoute.entries()].map(([id, r]) => {
      const lines = [...new Set(r.dates)].sort().map((date) => {
        if (date < today) return `<div class="event-meta trip-past">${fmtDate(date)} · gone</div>`;
        const s = dateStatus(snapState, id, date);
        return `<div class="event-meta">${fmtDate(date)} <span class="badge ${s.cls}">${s.text}</span></div>`;
      }).join('');
      return `<p class="event-venue trip-leg">${routeLabel(r.from, r.to)}</p>${lines}`;
    }).join('');
    return `
      <div class="event-card">
        <div class="event-main">
          ${blocks}
          <p class="event-meta">Alerts go to <code>${escapeHtml(topicOf(trip))}</code>${cleanChannel(trip.channel) ? '' : ' (your main channel)'}</p>
          <button type="button" class="settings-btn trip-remove" data-trip-remove="${escapeHtml(trip.id)}">Stop watching</button>
        </div>
      </div>`;
  }


  // One line on whether the watcher itself is healthy.
  function watcherLine(snapState, nowMs) {
    if (!snapState || !snapState.checkedAt) return "The watcher hasn't reported yet. It checks every 5 minutes.";
    if (snapState.blocked) return `⚠️ Snap has been refusing checks since ${fmtDay(snapState.blocked.since)}, ${fmtTime(snapState.blocked.since)}. Alerts may be missed.`;
    if (nowMs - new Date(snapState.checkedAt).getTime() > WATCHER_SILENT_MS) return `⚠️ No report from the watcher since ${timeAgo(snapState.checkedAt, nowMs)}. It may have stopped.`;
    return `Watcher OK · checks every 5 minutes · last update ${timeAgo(snapState.checkedAt, nowMs)}`;
  }

  // Turns what GitHub answered into a plain-English reason, or null if the
  // token is fine. repoStatus / fileStatus are HTTP codes (null = no answer).
  function diagnoseToken(token, repoStatus, fileStatus) {
    if (repoStatus === null || repoStatus === undefined) return "Couldn't reach GitHub. Check your connection and try again.";
    if (!/^(github_pat_|ghp_)/.test(token)) return "That doesn't look like a GitHub token. It should start with github_pat_ . Copy it again from GitHub.";
    if (token.startsWith('github_pat_') && token.length < 80) return `That looks cut off (${token.length} characters; a full token is about 93). Copy the whole thing again.`;
    if (repoStatus === 401) return 'GitHub says this token is not valid or has expired (401). Generate a new one and paste the whole thing.';
    if (repoStatus === 404) return "The token is valid but can't see the private repo (404). When creating it, under Repository access choose 'Only select repositories' and tick ticket-watcher-private.";
    if (repoStatus !== 200) return `GitHub refused this token (${repoStatus}).`;
    if (fileStatus === 401 || fileStatus === 403) return "The token can see the repo but isn't allowed to read its files. Under Permissions, set Contents to 'Read and write'.";
    return null;
  }

  const helpers = {
    diagnoseToken, autoEligible, effectiveEligible, nextSelection, withSelection, statusOf, watchLabel,
    matchesQuery, filterRecords, groupRecords, sortKey, utf8ToBase64, base64ToUtf8, opensLine,
    watchingCard, compactRow, openedCard,
    legsOf, liveTrips, dateStatus, tripCard, watcherLine, cleanChannel, routeLabel,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = helpers;
  if (typeof document === 'undefined') return;

  // --- Browser-only ---------------------------------------------------------

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
  }
  function setToken(token) {
    try { if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
  }

  async function gh(path, { method = 'GET', body, raw = false } = {}) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${getToken()}`,
        Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    return res;
  }

  // A JSON file in the private repo, with the sha needed to save it back.
  async function readJsonFile(name, fallback) {
    const res = await gh(`/contents/${name}`);
    if (res.status === 404) return { data: fallback, sha: null };
    if (!res.ok) throw Object.assign(new Error(`GitHub said ${res.status}`), { status: res.status });
    const file = await res.json();
    return { data: JSON.parse(base64ToUtf8(file.content) || 'null') || fallback, sha: file.sha };
  }

  async function writeJsonFile(name, data, sha, message) {
    const res = await gh(`/contents/${name}`, {
      method: 'PUT',
      body: {
        message,
        content: utf8ToBase64(JSON.stringify(data, null, 2) + '\n'),
        ...(sha ? { sha } : {}),
      },
    });
    if (!res.ok) throw Object.assign(new Error(`GitHub said ${res.status}`), { status: res.status });
    return (await res.json()).content.sha;
  }

  async function readSelections() {
    const { data, sha: fileSha } = await readJsonFile('selections.json', {});
    return { selections: data, sha: fileSha };
  }

  const writeSelections = (selections, fileSha) => writeJsonFile('selections.json', selections, fileSha, 'Update alert selections');

  // Applies one tick against the freshest copy of selections.json, retrying
  // once if it changed underneath us (e.g. a tick from another device).
  async function saveTick(key, selection) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { selections, sha } = await readSelections();
      try {
        const newSha = await writeSelections(withSelection(selections, key, selection), sha);
        return { selections: withSelection(selections, key, selection), sha: newSha };
      } catch (err) {
        if (attempt === 1 || (err.status !== 409 && err.status !== 422)) throw err;
      }
    }
    return null;
  }

  // --- Unlock dialog ----------------------------------------------------------

  function promptForToken() {
    return new Promise((resolve) => {
      const dlg = document.createElement('dialog');
      dlg.className = 'settings-dialog';
      dlg.innerHTML = `
        <h2>Owner access</h2>
        <p>Paste your access token to unlock the private Scanner and Trains tabs on this device.</p>
        <input type="password" id="owner-token-input" class="owner-input" placeholder="github_pat_…" autocomplete="off" autocapitalize="off" spellcheck="false" />
        <p class="hint" id="owner-token-msg"></p>
        <button type="button" class="install-btn" id="owner-token-save">Unlock</button>
        <button type="button" class="settings-btn" id="owner-token-cancel">Cancel</button>`;
      document.body.appendChild(dlg);
      const msg = dlg.querySelector('#owner-token-msg');
      const input = dlg.querySelector('#owner-token-input');
      const done = (ok) => { dlg.close(); dlg.remove(); resolve(ok); };
      dlg.querySelector('#owner-token-cancel').addEventListener('click', () => done(false));
      dlg.querySelector('#owner-token-save').addEventListener('click', async () => {
        const candidate = input.value.trim();
        if (!candidate) return;
        msg.textContent = 'Checking…';
        const headers = { Authorization: `Bearer ${candidate}`, Accept: 'application/vnd.github+json' };
        // Two checks, so the message can say exactly what's wrong: can the
        // token see the repo at all, and can it read the repo's files?
        const repo = await fetch(API, { headers }).catch(() => null);
        const file = repo && repo.ok
          ? await fetch(`${API}/contents/scanner.json`, { headers: { ...headers, Accept: 'application/vnd.github.raw+json' } }).catch(() => null)
          : null;
        const problem = diagnoseToken(candidate, repo && repo.status, file && file.status);
        if (problem) { msg.textContent = problem; return; }
        setToken(candidate);
        done(true);
      });
      dlg.showModal();
      input.focus();
    });
  }

  // --- The Scanner tab ------------------------------------------------------

  let state = null;
  let selections = {};
  let sha = null;
  let timer = null;
  let started = false;
  const view = { query: '', venue: 'all', status: 'all' };

  const $ = (id) => document.getElementById(id);

  function chipsHtml(name, options, current) {
    return options
      .map(([value, label]) => `<button type="button" class="chip${value === current ? ' active' : ''}" data-${name}="${escapeHtml(value)}">${escapeHtml(label)}</button>`)
      .join('');
  }

  function buildChrome() {
    if ($('owner-tabs')) return;
    const nav = document.createElement('nav');
    nav.id = 'owner-tabs';
    nav.className = 'owner-tabs';
    nav.innerHTML = '<button type="button" data-tab="watchlist" class="active">Watchlist</button><button type="button" data-tab="scanner">Scanner</button><button type="button" data-tab="trains">Trains</button><button type="button" data-tab="stats">Stats</button>';
    document.querySelector('header').insertAdjacentElement('afterend', nav);

    const section = document.createElement('section');
    section.id = 'owner-view';
    section.className = 'owner-view';
    section.hidden = true;
    section.innerHTML = `
      <p class="subtitle" id="owner-subtitle">Loading…</p>
      <p class="hint" id="owner-msg"></p>
      <div class="owner-filters">
        <input type="search" id="owner-search" class="owner-input" placeholder="Search shows…" autocomplete="off" />
        <div class="chips" id="owner-venue-chips"></div>
        <div class="chips" id="owner-status-chips"></div>
      </div>
      <h2 class="section-title">Watching <span class="count" id="owner-watching-count"></span></h2>
      <p class="hint">Tick any show below and it moves up here. A show that isn't on sale yet alerts you when it opens; one that is on sale alerts you when sold-out dates get tickets back. Changes apply within about 5 minutes.</p>
      <section id="owner-watching"></section>
      <h2 class="section-title">All shows <span class="count" id="owner-rest-count"></span></h2>
      <section id="owner-rest" class="owner-list"></section>
      <h2 class="section-title">Already opened <span class="count" id="owner-opened-count"></span></h2>
      <section id="owner-opened"></section>
      <p class="hint"><button type="button" class="settings-btn" id="owner-lock">Lock this device</button></p>`;
    nav.insertAdjacentElement('afterend', section);

    const trains = document.createElement('section');
    trains.id = 'owner-trains';
    trains.className = 'owner-view';
    trains.hidden = true;
    trains.innerHTML = `
      <p class="subtitle" id="trains-status">Loading…</p>
      <h2 class="section-title">Add a journey</h2>
      <p class="hint">Choose where you are travelling from and to, pick the date, and tap <strong>Add</strong>. It is saved straight away. For a return, swap the stations (⇄) and add the other date. You get an alert when Snap tickets appear, when a new time window opens, or when the price drops. A journey for someone else can have its own channel, so they only hear about their dates.</p>
      <div class="trip-form">
        <p class="event-venue trip-leg">Who should be alerted?</p>
        <input type="text" id="trip-channel" class="owner-input" placeholder="Leave empty for you, or a name like pierre" maxlength="20" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Channel name for this journey" />
        <p class="hint" id="trip-channel-hint"></p>
        <div class="route-row">
          <label class="city-pick" for="trip-from">From
            <select id="trip-from" class="owner-input"></select>
          </label>
          <button type="button" class="chip swap-btn" id="trip-swap" aria-label="Swap From and To">⇄</button>
          <label class="city-pick" for="trip-to">To
            <select id="trip-to" class="owner-input"></select>
          </label>
        </div>
        <div class="trip-date-row"><input type="date" id="trip-date" class="owner-input" aria-label="Date of travel" /><button type="button" class="chip" data-add>Add</button></div>
        <p class="form-msg" id="trains-msg" role="status" aria-live="polite"></p>
      </div>
      <h2 class="section-title">Watching <span class="count" id="trips-count"></span></h2>
      <p class="form-msg" id="trips-msg" role="status" aria-live="polite"></p>
      <section id="trips-list"></section>`;
    section.insertAdjacentElement('afterend', trains);

    const stats = document.createElement('section');
    stats.id = 'owner-stats';
    stats.className = 'owner-view';
    stats.hidden = true;
    stats.innerHTML = `
      <p class="form-msg" id="stats-msg" role="status" aria-live="polite"></p>
      <div id="stats-body"><div class="empty-state">Loading…</div></div>`;
    trains.insertAdjacentElement('afterend', stats);
    trains.addEventListener('click', onTrainsClick);
    trains.addEventListener('input', (e) => { if (e.target.id === 'trip-channel') renderChannelHint(); });
    trains.addEventListener('change', (e) => { if (e.target.id === 'trip-from') fillTripSelects(); });
    fillTripSelects();

    nav.addEventListener('click', (e) => {
      const tab = e.target.closest('button[data-tab]');
      if (tab) showTab(tab.dataset.tab);
    });
    section.addEventListener('change', onTick);
    section.addEventListener('click', onChip);
    $('owner-search').addEventListener('input', (e) => { view.query = e.target.value; render(); });
    $('owner-lock').addEventListener('click', lock);
    renderChips();
  }

  function renderChips() {
    const venues = [['all', 'All venues'], ...Array.from(new Set(Object.values((state && state.events) || {}).map((r) => r.venue))).sort().map((v) => [v, v])];
    $('owner-venue-chips').innerHTML = chipsHtml('venue', venues, view.venue);
    $('owner-status-chips').innerHTML = chipsHtml('status', [['all', 'Any status'], ['upcoming', 'Not on sale yet'], ['sold_out', 'Sold out'], ['on_sale', 'On sale']], view.status);
  }

  function onChip(event) {
    const chip = event.target.closest('button.chip');
    if (!chip) return;
    if (chip.dataset.venue !== undefined) view.venue = chip.dataset.venue;
    if (chip.dataset.status !== undefined) view.status = chip.dataset.status;
    renderChips();
    render();
  }

  function showTab(name) {
    const ownerTab = name !== 'watchlist';
    document.querySelectorAll('#owner-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $('owner-view').hidden = name !== 'scanner';
    $('owner-trains').hidden = name !== 'trains';
    $('owner-stats').hidden = name !== 'stats';
    const note = document.querySelector('.golden-note');
    const main = document.querySelector('main');
    if (note) note.hidden = ownerTab;
    if (main) main.hidden = ownerTab;
    if (name === 'scanner') refresh();
    if (name === 'trains') refreshTrains();
    if (name === 'stats') refreshStats();
  }

  function setMessage(text, isError) {
    const el = $('owner-msg');
    if (!el) return;
    el.textContent = text || '';
    el.className = `hint${isError ? ' error' : ''}`;
  }

  function render() {
    if (!state) return;
    const now = Date.now();
    const all = Object.values(state.events || {}).filter((e) => e.state !== 'expired');
    const opened = all.filter((e) => e.alertedAt).sort((a, b) => new Date(b.alertedAt) - new Date(a.alertedAt));
    const shown = filterRecords(all, view);
    const { watching, rest } = groupRecords(shown, selections);
    const watchingTotal = groupRecords(all, selections).watching.length;

    $('owner-subtitle').textContent = `Last scan ${timeAgo(state.updatedAt, now)} · ${all.length} shows tracked · ${watchingTotal} watched`;
    $('owner-watching-count').textContent = `(${watching.length})`;
    $('owner-rest-count').textContent = `(${rest.length})`;
    $('owner-opened-count').textContent = `(${opened.length})`;
    $('owner-watching').innerHTML = watching.length
      ? watching.map((e) => watchingCard(e, selections, now)).join('')
      : `<div class="empty-state">${view.query || view.venue !== 'all' || view.status !== 'all' ? 'No watched shows match.' : 'Nothing watched yet. Tick a show below.'}</div>`;
    $('owner-rest').innerHTML = rest.length
      ? rest.map((e) => compactRow(e, now)).join('')
      : '<div class="empty-state">No shows match.</div>';
    $('owner-opened').innerHTML = opened.length
      ? opened.map((e) => openedCard(e, now)).join('')
      : '<div class="empty-state">No shows have opened since the scanner started.</div>';
  }

  async function refresh() {
    try {
      const [scan, sel] = await Promise.all([gh('/contents/scanner.json', { raw: true }), readSelections()]);
      if (scan.status === 404) { setMessage('No scan results yet. The first scan hasn\'t run.', false); return; }
      if (scan.status === 401 || scan.status === 403) { setMessage('Your token was rejected. Lock this device and unlock again with a new one.', true); return; }
      if (!scan.ok) throw new Error(`GitHub said ${scan.status}`);
      state = await scan.json();
      selections = sel.selections;
      sha = sel.sha;
      setMessage('', false);
      renderChips();
      render();
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        setMessage('Your token was rejected. Lock this device and unlock again with a new one.', true);
        return;
      }
      setMessage(`Couldn't refresh (${err.message}). Showing the last data.`, true);
    }
  }

  async function onTick(event) {
    const box = event.target.closest('input[type="checkbox"][data-key]');
    if (!box || !state) return;
    const record = state.events[box.dataset.key];
    if (!record) return;
    const selection = nextSelection(record, box.checked);
    const before = selections;
    selections = withSelection(selections, record.key, selection);
    render();
    setMessage('Saving…', false);
    try {
      const saved = await saveTick(record.key, selection);
      selections = saved.selections;
      sha = saved.sha;
      setMessage('Saved. It takes effect on the next scan (within about 5 minutes).', false);
    } catch (err) {
      selections = before;
      setMessage(`Couldn't save that tick (${err.message}). Nothing was changed.`, true);
    }
    render();
  }

  // --- The Stats tab --------------------------------------------------------
  // The maths and the page are in stats.js, loaded the first time this tab opens.
  // It reads snap-history.json (the hourly price log) from the private repo.

  function loadStatsScript() {
    if (root.SnapStats) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = './stats.js';
      script.onload = resolve;
      script.onerror = () => reject(new Error("couldn't load the stats code"));
      document.head.appendChild(script);
    });
  }

  // The "when will tickets appear for my date?" box. The date you pick is kept
  // when the tab refreshes; it starts two weeks ahead.
  let estimateDate = '';

  function bindEstimate(stats) {
    const input = $('est-date');
    if (!input) return;
    const today = londonToday();
    input.min = today;
    if (!estimateDate) estimateDate = new Date(Date.parse(`${today}T12:00:00Z`) + 14 * 86400000).toISOString().slice(0, 10);
    input.value = estimateDate;
    const show = () => { $('est-body').innerHTML = root.SnapStats.estimateHtml(stats, input.value, today); };
    input.addEventListener('input', () => { estimateDate = input.value; show(); });
    show();
  }

  async function refreshStats() {
    const msg = $('stats-msg');
    try {
      await loadStatsScript();
      const res = await gh('/contents/snap-history.json', { raw: true });
      if (res.status === 404) {
        $('stats-body').innerHTML = '<div class="empty-state">No history yet. The hourly job records its first look within the hour.</div>';
        msg.textContent = '';
        return;
      }
      if (res.status === 401 || res.status === 403) throw Object.assign(new Error('rejected'), { status: res.status });
      if (!res.ok) throw new Error(`GitHub said ${res.status}`);
      const stats = root.SnapStats.analyse(await res.json(), Date.now());
      // Don't redraw under your finger while the date box is open.
      if (!(document.activeElement && document.activeElement.id === 'est-date')) {
        $('stats-body').innerHTML = root.SnapStats.html(stats);
        bindEstimate(stats);
      }
      msg.textContent = '';
      msg.className = 'form-msg';
    } catch (err) {
      msg.className = 'form-msg error';
      msg.textContent = err.status === 401 || err.status === 403
        ? 'Your token was rejected. Lock this device and unlock again with a new one.'
        : `Couldn't load the stats (${err.message}).`;
    }
  }

  // --- The Trains tab -------------------------------------------------------

  let trips = [];
  let snapState = null;
  let trainsBusy = false; // an add or removal is in flight

  const londonToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

  // Messages sit right under what caused them ('trains-msg' under Add, 'trips-msg'
  // under the Watching heading), so they are never off-screen.
  function setTrainsMessage(text, kind, where) {
    const el = $(where || 'trains-msg');
    el.textContent = text || '';
    el.className = `form-msg${kind ? ` ${kind}` : ''}`;
  }

  function renderChannelHint() {
    $('trip-channel-hint').textContent = `Alerts for this journey go to ${topicOf({ channel: $('trip-channel').value })}${cleanChannel($('trip-channel').value) ? '. Send that name to your friend: they subscribe to it in ntfy.' : ', your own channel.'}`;
  }

  const stationOptions = (ids) => ids.map((id) => `<option value="${id}">${STATION_NAMES[id]}</option>`).join('');

  // From lists every station; To lists only where Snap goes from there. Both keep
  // what you chose if it is still allowed.
  function fillTripSelects() {
    const from = $('trip-from');
    const to = $('trip-to');
    const prevFrom = from.value;
    const prevTo = to.value;
    from.innerHTML = stationOptions(Object.keys(STATION_NAMES));
    from.value = STATION_NAMES[prevFrom] ? prevFrom : 'london';
    const choices = ALLOWED[from.value];
    to.innerHTML = stationOptions(choices);
    to.value = choices.includes(prevTo) ? prevTo : choices[0];
  }

  function swapStations() {
    const from = $('trip-from').value;
    const to = $('trip-to').value;
    $('trip-from').value = to;
    fillTripSelects();
    if (ALLOWED[to].includes(from)) $('trip-to').value = from;
  }

  function renderTrains() {
    renderChannelHint();
    const today = londonToday();
    $('trip-date').min = today;
    for (const id of ['trip-from', 'trip-to', 'trip-swap']) $(id).disabled = trainsBusy;
    document.querySelector('#owner-trains button[data-add]').disabled = trainsBusy;
    $('trains-status').textContent = watcherLine(snapState, Date.now());
    const live = liveTrips(trips, today);
    $('trips-count').textContent = `(${live.length})`;
    $('trips-list').innerHTML = live.length
      ? live.map((t) => tripCard(t, snapState, today)).join('')
      : '<div class="empty-state">Nothing watched. Add a journey above.</div>';
    document.querySelectorAll('#trips-list button').forEach((b) => { b.disabled = trainsBusy; });
  }

  async function refreshTrains() {
    if (trainsBusy) return; // never fight with a change in progress
    try {
      const [t, s] = await Promise.all([readJsonFile('snap-trips.json', { trips: [] }), gh('/contents/snap-state.json', { raw: true })]);
      if (s.status === 401 || s.status === 403) throw Object.assign(new Error('rejected'), { status: s.status });
      if (trainsBusy) return;
      trips = t.data.trips || [];
      snapState = s.status === 404 ? null : s.ok ? await s.json() : snapState;
    } catch (err) {
      setTrainsMessage(err.status === 401 || err.status === 403
        ? 'Your token was rejected. Lock this device and unlock again with a new one.'
        : `Couldn't refresh (${err.message}). Showing the last data.`, 'error');
    }
    renderTrains();
  }

  // Applies one change to the freshest copy of snap-trips.json (dropping trips
  // that are over), retrying once if it changed underneath us.
  async function saveTrips(change) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { data, sha: fileSha } = await readJsonFile('snap-trips.json', { trips: [] });
      const next = liveTrips(change(data.trips || []), londonToday());
      try {
        await writeJsonFile('snap-trips.json', { trips: next }, fileSha, 'Update Snap trips');
        return next;
      } catch (err) {
        if (attempt === 1 || (err.status !== 409 && err.status !== 422)) throw err;
      }
    }
    return null;
  }

  // Runs one change and shows the result next to where it was made.
  async function changeTrips(where, working, run, done, failed) {
    if (trainsBusy) return false;
    trainsBusy = true;
    setTrainsMessage(working, '', where);
    renderTrains();
    let ok = false;
    try {
      trips = await run();
      setTrainsMessage(done, 'ok', where);
      ok = true;
    } catch (err) {
      setTrainsMessage(`${failed}: ${err.message}. Nothing was changed.`, 'error', where);
    } finally {
      trainsBusy = false;
      renderTrains();
    }
    return ok;
  }

  function onTrainsClick(event) {
    const btn = event.target.closest('button');
    if (!btn) return;
    if (btn.id === 'trip-swap') { swapStations(); return; }
    if (btn.dataset.add !== undefined) {
      const from = $('trip-from').value;
      const to = $('trip-to').value;
      const date = $('trip-date').value;
      if (!date) { setTrainsMessage('Pick a date first, then tap Add.', 'error'); return; }
      if (date < londonToday()) { setTrainsMessage('That date has already gone.', 'error'); return; }
      const channel = cleanChannel($('trip-channel').value);
      const trip = { id: `t${Date.now().toString(36)}`, ...(channel ? { channel } : {}), legs: [{ from, to, date }], addedAt: new Date().toISOString() };
      changeTrips('trains-msg', 'Adding…', () => saveTrips((list) => [...list, trip]), `Added ${routeLabel(from, to)} on ${fmtDate(date)}. The first check runs within about 5 minutes.`, 'Not added')
        .then((ok) => { if (ok) $('trip-date').value = ''; }); // a failed add keeps the date so it can be retried
    } else if (btn.dataset.tripRemove) {
      changeTrips('trips-msg', 'Removing…', () => saveTrips((list) => list.filter((t) => t.id !== btn.dataset.tripRemove)), 'Stopped watching that trip.', 'Not removed');
    }
  }


  function lock() {
    setToken(null);
    if (timer) clearInterval(timer);
    location.hash = '';
    location.reload();
  }

  async function start({ prompt } = {}) {
    if (started) return;
    if (!getToken()) {
      if (!prompt) return;
      if (!(await promptForToken())) return;
    }
    started = true;
    buildChrome();
    timer = setInterval(() => {
      if (!$('owner-view').hidden) refresh();
      if (!$('owner-trains').hidden) refreshTrains();
      if (!$('owner-stats').hidden) refreshStats();
    }, REFRESH_MS);
    showTab('scanner');
  }

  root.TWOwner = { start, lock, promptForToken };
})(typeof window !== 'undefined' ? window : globalThis);

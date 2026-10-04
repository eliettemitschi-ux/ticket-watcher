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

  async function readSelections() {
    const res = await gh('/contents/selections.json');
    if (res.status === 404) return { selections: {}, sha: null };
    if (!res.ok) throw Object.assign(new Error(`GitHub said ${res.status}`), { status: res.status });
    const file = await res.json();
    return { selections: JSON.parse(base64ToUtf8(file.content) || '{}'), sha: file.sha };
  }

  async function writeSelections(selections, sha) {
    const res = await gh('/contents/selections.json', {
      method: 'PUT',
      body: {
        message: 'Update alert selections',
        content: utf8ToBase64(JSON.stringify(selections, null, 2) + '\n'),
        ...(sha ? { sha } : {}),
      },
    });
    if (!res.ok) throw Object.assign(new Error(`GitHub said ${res.status}`), { status: res.status });
    return (await res.json()).content.sha;
  }

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
        <p>Paste your access token to unlock the private Scanner tab on this device.</p>
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
    nav.innerHTML = '<button type="button" data-tab="watchlist" class="active">Watchlist</button><button type="button" data-tab="scanner">Scanner</button>';
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
    const scanner = name === 'scanner';
    document.querySelectorAll('#owner-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $('owner-view').hidden = !scanner;
    const note = document.querySelector('.golden-note');
    const main = document.querySelector('main');
    if (note) note.hidden = scanner;
    if (main) main.hidden = scanner;
    if (scanner) refresh();
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
    timer = setInterval(() => { if (!$('owner-view').hidden) refresh(); }, REFRESH_MS);
    showTab('scanner');
  }

  root.TWOwner = { start, lock, promptForToken };
})(typeof window !== 'undefined' ? window : globalThis);

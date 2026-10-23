// docs/friend.js -- the friend page: add and remove your own Snap dates.
//
// Pick a date, tap Add, and it is saved and watched straight away. There is
// nothing private in this file. You open a personal link that carries a key
// (friend.html#key=...); the key is kept on this device, removed from the
// address bar, and sent to the Worker, which only lets it touch its own
// channel's dates (cron-worker/src/friend.js).

(function (root) {
  'use strict';

  const API = 'https://ticket-watcher-cron.eliettemitschi.workers.dev/friend';
  const KEY = 'twFriendKey';
  const TZ = 'Europe/London';
  const TIMEOUT_MS = 25000;
  const LEGS = [['out', 'London → Paris'], ['back', 'Paris → London']];

  // --- Pure helpers (unit tested in test/friend.test.js) ----------------------

  const escapeHtml = (str) => String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${iso}T12:00:00Z`));

  function seenBadge(entry) {
    if (!entry || entry.state === 'unknown') return '<span class="badge unknown">Not checked yet</span>';
    if (entry.state === 'none') return '<span class="badge pending">No Snap tickets yet</span>';
    return `<span class="badge available">From £${escapeHtml(entry.price)}</span>`;
  }

  // One watched date with its status and a button to stop watching it.
  function dateRow(leg, entry) {
    return `
      <div class="owner-row watch-row">
        <div class="owner-row-main">
          <span class="owner-row-title">${fmtDate(entry.date)}</span>
          <div class="owner-row-sub">${seenBadge(entry)}</div>
        </div>
        <button type="button" class="settings-btn" data-remove-leg="${leg}" data-remove-date="${escapeHtml(entry.date)}" aria-label="Stop watching ${fmtDate(entry.date)}">Remove</button>
      </div>`;
  }

  // Both directions, or an empty-state line.
  function watchList(data) {
    const groups = LEGS
      .filter(([leg]) => (data[leg] || []).length)
      .map(([leg, label]) => `<p class="event-venue trip-leg">${label}</p><div class="owner-list">${data[leg].map((e) => dateRow(leg, e)).join('')}</div>`);
    return groups.length ? groups.join('') : '<div class="empty-state">Nothing watched yet. Pick a date above and tap Add.</div>';
  }

  const usedDates = (data) => (data.out || []).length + (data.back || []).length;

  // "Pierre Express": the page title for a friend, or the plain title when there is no name.
  const titleFor = (name) => (name ? `${name} Express` : 'Snap train alerts');

  // "You can watch up to 4 dates at once (1 used)."
  const capLine = (data) => `You can watch up to ${data.maxDates} dates at once (${usedDates(data)} used).`;

  function statusLine(data) {
    if (data.blocked) return '⚠️ Eurostar is refusing checks right now, so alerts may be late.';
    return `Alerts go to ${data.topic} · checks every 5 minutes`;
  }

  const helpers = { escapeHtml, fmtDate, seenBadge, dateRow, watchList, usedDates, titleFor, capLine, statusLine };
  if (typeof module !== 'undefined' && module.exports) module.exports = helpers;
  if (typeof document === 'undefined') return;

  // --- Browser-only ---------------------------------------------------------

  const $ = (id) => document.getElementById(id);
  let data = null;
  let busy = false; // an add or removal is in flight
  let sessionKey = null;

  const getKey = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const setKey = (k) => { try { localStorage.setItem(KEY, k); } catch { /* private mode */ } };
  const londonToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

  async function call(method, { query = '', body } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${API}${query}`, {
        method,
        headers: { Authorization: `Bearer ${sessionKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch (err) {
      throw new Error(err && err.name === 'AbortError'
        ? 'That took too long. Check your connection and try again.'
        : "Couldn't reach the server. Check your connection and try again.");
    } finally {
      clearTimeout(timer);
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.error || `Error ${res.status}`), { status: res.status });
    return json;
  }

  // Messages sit right under what caused them ('msg' under the Add buttons,
  // 'trips-msg' under the Watching heading), so they are never off-screen.
  function setMessage(text, kind, where) {
    const el = $(where || 'msg');
    el.textContent = text || '';
    el.className = `form-msg${kind ? ` ${kind}` : ''}`;
  }

  function render() {
    const today = (data && data.today) || londonToday();
    for (const [leg] of LEGS) {
      $(`${leg}-date`).min = today;
      document.querySelector(`button[data-add="${leg}"]`).disabled = busy;
    }
    if (!data) return;
    $('personal-note').hidden = !data.note;
    $('passport-note').hidden = !data.passport;
    $('cap-note').textContent = capLine(data);
    if (data.name) {
      $('title').textContent = titleFor(data.name);
      document.title = titleFor(data.name);
    }
    $('status').textContent = statusLine(data);
    document.querySelectorAll('.topic-name').forEach((el) => { el.textContent = data.topic; });
    $('count').textContent = `(${usedDates(data)})`;
    $('trips').innerHTML = watchList(data);
    document.querySelectorAll('#trips button').forEach((b) => { b.disabled = busy; });
  }

  function badLink() {
    $('friend-view').hidden = true;
    $('no-key').hidden = false;
    $('status').textContent = 'This link is not valid.';
  }

  async function refresh() {
    if (busy) return; // never fight with a change in progress
    try {
      const fresh = await call('GET');
      if (busy) return; // a change started while this was loading: its answer is newer
      data = fresh;
    } catch (err) {
      if (err.status === 401) { try { localStorage.removeItem(KEY); } catch { /* ignore */ } badLink(); return; }
      // A failed background refresh keeps the last data quietly, unless there is none yet.
      if (!data) setMessage(err.message, 'error');
    }
    render();
  }

  // Runs one change (add or remove) and shows the result next to where it was made.
  async function change(where, working, run, done, failed) {
    if (busy) return;
    busy = true;
    setMessage(working, '', where);
    render();
    let ok = false;
    try {
      data = await run();
      setMessage(done, 'ok', where);
      ok = true;
    } catch (err) {
      setMessage(`${failed}: ${err.message}`, 'error', where);
    } finally {
      busy = false;
      render();
    }
    return ok;
  }

  function onClick(event) {
    const btn = event.target.closest('button');
    if (!btn) return;
    if (btn.dataset.add) {
      const leg = btn.dataset.add;
      const input = $(`${leg}-date`);
      if (!input.value) { setMessage('Pick a date first, then tap Add.', 'error'); return; }
      if (input.value < ((data && data.today) || londonToday())) { setMessage('That date has already gone.', 'error'); return; }
      const date = input.value;
      change('msg', 'Adding…', () => call('POST', { body: { [leg]: [date] } }), `Added ${fmtDate(date)}. You are now watching it. The first check runs within about 5 minutes.`, 'Not added')
        .then((ok) => { if (ok) input.value = ''; }); // a failed add keeps the date so it can be retried
    } else if (btn.dataset.removeLeg) {
      const { removeLeg: leg, removeDate: date } = btn.dataset;
      change('trips-msg', 'Removing…', () => call('DELETE', { query: `?leg=${encodeURIComponent(leg)}&date=${encodeURIComponent(date)}` }), `Stopped watching ${fmtDate(date)}.`, 'Not removed');
    }
  }

  // Copies the channel name; falls back to selecting it where the clipboard is blocked.
  function onCopy() {
    const el = document.querySelector('.topic-name');
    const done = (text) => { $('copied').textContent = text; };
    const select = () => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      done('Selected. Press copy.');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(el.textContent).then(() => done('Copied'), select);
    else select();
  }

  function start() {
    const fromLink = /^#key=([A-Za-z0-9_-]{16,})$/.exec(location.hash);
    if (fromLink) {
      setKey(fromLink[1]);
      sessionKey = fromLink[1];
      history.replaceState(null, '', location.pathname + location.search); // keep the key out of the address bar
    } else {
      sessionKey = getKey();
    }
    if (!sessionKey) { badLink(); return; }
    $('friend-view').hidden = false;
    $('friend-view').addEventListener('click', onClick);
    $('copy-topic').addEventListener('click', onCopy);
    render();
    refresh();
    setInterval(refresh, 60000);
  }

  start();
})(typeof window !== 'undefined' ? window : globalThis);
